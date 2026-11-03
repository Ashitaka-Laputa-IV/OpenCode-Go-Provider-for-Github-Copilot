import * as vscode from "vscode";

export interface OpenAITextPart {
  type: "text";
  text: string;
}

export interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function dataPartConstructor(): typeof vscode.LanguageModelDataPart | undefined {
  return (vscode as unknown as { LanguageModelDataPart?: typeof vscode.LanguageModelDataPart }).LanguageModelDataPart;
}

function isImagePart(part: unknown): part is vscode.LanguageModelDataPart {
  const DataPart = dataPartConstructor();
  if (!DataPart || !(part instanceof DataPart)) {
    return false;
  }
  return typeof part.mimeType === "string" && part.mimeType.startsWith("image/");
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function bestEffortText(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (part && typeof part === "object" && "value" in part) {
    const value = (part as { value: unknown }).value;
    if (typeof value === "string") {
      return value;
    }
  }
  return stringifyUnknown(part);
}

function toolResultText(content: readonly unknown[]): string {
  return content.map((part) => bestEffortText(part)).filter((text) => text.length > 0).join("\n");
}

function imageDataUrl(part: vscode.LanguageModelDataPart): string {
  return `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`;
}

/**
 * Convert VS Code chat messages into OpenAI chat-completions messages.
 *
 * Tool results are emitted as `tool` messages before any remaining user text,
 * which matches how OpenAI-compatible APIs expect a tool round trip.
 */
export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const message of messages) {
    const isUser = message.role === vscode.LanguageModelChatMessageRole.User;
    const texts: string[] = [];
    const images: OpenAIImagePart[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        texts.push(part.value);
      } else if (isImagePart(part)) {
        images.push({ type: "image_url", image_url: { url: imageDataUrl(part) } });
      } else if (!isUser && part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: "function",
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
      } else if (isUser && part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          callId: part.callId,
          content: toolResultText(part.content as readonly unknown[]),
        });
      } else {
        const text = bestEffortText(part);
        if (text.length > 0) {
          texts.push(text);
        }
      }
    }

    const text = texts.join("");

    if (isUser) {
      for (const toolResult of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: toolResult.callId,
          content: toolResult.content,
        });
      }

      if (images.length > 0) {
        const content: OpenAIContentPart[] = [];
        if (text.length > 0) {
          content.push({ type: "text", text });
        }
        content.push(...images);
        result.push({ role: "user", content });
      } else if (text.length > 0) {
        result.push({ role: "user", content: text });
      }
    } else if (toolCalls.length > 0) {
      result.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        tool_calls: toolCalls,
      });
    } else if (text.length > 0) {
      result.push({ role: "assistant", content: text });
    }
  }

  return result;
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  toolMode: vscode.LanguageModelChatToolMode | undefined,
): { tools?: OpenAITool[]; toolChoice?: "auto" | "required" } {
  if (!tools || tools.length === 0) {
    return {};
  }

  const mapped: OpenAITool[] = tools.map((tool) => {
    const schema =
      tool.inputSchema && typeof tool.inputSchema === "object"
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} };
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: { type: "object", ...schema },
      },
    };
  });

  return {
    tools: mapped,
    toolChoice: toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto",
  };
}

export function firstUserText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
  for (const message of messages) {
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }
    const text = message.content
      .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
      .map((part) => part.value)
      .join("");
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}
