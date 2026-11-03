import type { OpenCodeModel } from "./models";
import type { OpenAIMessage, OpenAITool } from "./convert";
import { SseParser } from "./sse";

export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "OpenCodeHttpError";
  }
}

interface ChatChunk {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

interface ChatChoice {
  index?: number;
  delta?: {
    content?: string | Array<{ type?: string; text?: string }>;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason?: string | null;
}

export interface ChatStreamRequest {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  userAgent: string;
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  toolChoice?: "auto" | "required";
  modelOptions?: Record<string, unknown>;
  signal: AbortSignal;
  onText: (text: string) => void;
  onToolCall: (call: { id: string; name: string; input: object }) => void;
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function errorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return "Empty response from server.";
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string; error?: { message?: string } };
      message?: string;
    };
    return (
      parsed.error?.message ??
      parsed.error?.error?.message ??
      parsed.message ??
      trimmed
    ).slice(0, 800);
  } catch {
    return trimmed.slice(0, 800);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", abort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !parentSignal.aborted) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

export async function fetchModelCatalog(
  baseUrl: string,
  userAgent: string,
  signal: AbortSignal,
): Promise<OpenCodeModel[]> {
  const response = await fetchWithTimeout(
    joinUrl(baseUrl, "/v1/models"),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent,
      },
    },
    signal,
    15_000,
  );

  if (!response.ok) {
    throw new OpenCodeHttpError(response.status, errorDetail(await response.text()));
  }

  const body = (await response.json()) as { data?: OpenCodeModel[] };
  return Array.isArray(body.data) ? body.data : [];
}

function textFromDelta(choice: ChatChoice | undefined): string {
  const value = choice?.delta?.content;
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function safeModelOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!options) {
    return {};
  }
  const allowed = [
    "temperature",
    "top_p",
    "max_tokens",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "reasoning_effort",
  ];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (options[key] !== undefined) {
      result[key] = options[key];
    }
  }
  return result;
}

/**
 * Stream a chat completion from the OpenCode OpenAI-compatible endpoint.
 *
 * The gateway requires `x-opencode-session`; requests without it fail with
 * `400 MissingSessionID`.
 */
export async function streamChat(request: ChatStreamRequest): Promise<void> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    ...safeModelOptions(request.modelOptions),
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = request.toolChoice ?? "auto";
  }

  const response = await fetchWithTimeout(
    joinUrl(request.baseUrl, "/openai/v1/chat/completions"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": request.userAgent,
        "x-opencode-session": request.sessionId,
      },
      body: JSON.stringify(body),
    },
    request.signal,
    300_000,
  );

  if (!response.ok) {
    throw new OpenCodeHttpError(response.status, errorDetail(await response.text()));
  }
  if (!response.body) {
    throw new Error("OpenCode Go returned an empty response body.");
  }

  const pending = new Map<number, { id: string; name: string; arguments: string }>();

  const flushToolCalls = (): void => {
    const entries = [...pending.entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, call] of entries) {
      const name = call.name.trim();
      if (name.length === 0) {
        continue;
      }
      let input: object = {};
      if (call.arguments.trim().length > 0) {
        try {
          const parsed: unknown = JSON.parse(call.arguments);
          input = parsed && typeof parsed === "object" ? (parsed as object) : {};
        } catch {
          throw new Error(`OpenCode Go returned invalid JSON arguments for tool "${name}".`);
        }
      }
      request.onToolCall({
        id: call.id || `call_${index}_${Date.now()}`,
        name,
        input,
      });
    }
    pending.clear();
  };

  const handleEvent = (data: string): void => {
    if (data === "[DONE]") {
      return;
    }

    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(data) as ChatChunk;
    } catch {
      return;
    }

    if (chunk.error?.message) {
      throw new Error(chunk.error.message);
    }

    for (const choice of chunk.choices ?? []) {
      const text = textFromDelta(choice);
      if (text.length > 0) {
        request.onText(text);
      }

      for (const toolCall of choice.delta?.tool_calls ?? []) {
        const index = toolCall.index ?? 0;
        const current = pending.get(index) ?? { id: "", name: "", arguments: "" };
        if (toolCall.id) {
          current.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          current.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          current.arguments += toolCall.function.arguments;
        }
        pending.set(index, current);
      }
    }

    if (chunk.usage) {
      request.onUsage?.({
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      });
    }
  };

  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      for (const data of parser.push(decoder.decode(value, { stream: true }))) {
        handleEvent(data);
      }
    }

    const tail = decoder.decode();
    if (tail.length > 0) {
      for (const data of parser.push(tail)) {
        handleEvent(data);
      }
    }
    for (const data of parser.end()) {
      handleEvent(data);
    }

    flushToolCalls();
  } finally {
    reader.releaseLock();
  }
}
