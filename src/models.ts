import type * as vscode from "vscode";

export const VENDOR = "opencode-go";
export const DEFAULT_BASE_URL = "https://opencode.ai/inference/go";
export const MODELS_CACHE_MS = 10 * 60 * 1000;

/** Subset of the OpenCode model catalog we care about. */
export interface OpenCodeModel {
  id: string;
  object?: string;
  type?: string;
  name?: string;
  canonical_id?: string;
  family?: string;
  description?: string;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  capabilities?: {
    tools?: {
      supported?: boolean;
    };
    reasoning?: {
      supported?: boolean;
      effort?: string[];
    };
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  cost?: {
    text?: {
      input?: { price?: number };
      output?: { price?: number };
    };
  };
  api?: Record<string, { base_url?: string }>;
}

export interface ModelCatalog {
  readonly models: OpenCodeModel[];
  readonly fetchedAt: number;
  readonly baseUrl: string;
}

/**
 * Offline fallback used when the catalog endpoint cannot be reached. Keep this
 * list small; the live catalog is the source of truth.
 */
export const FALLBACK_MODELS: readonly OpenCodeModel[] = [
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    family: "deepseek-flash",
    description: "Fast DeepSeek model for reasoning and agentic coding.",
    modalities: { input: ["text", "image/jpeg", "image/png"] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    limit: { context: 1_000_000, output: 384_000 },
    api: { "chat-completions": {} },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    family: "deepseek-thinking",
    description: "Flagship DeepSeek model for coding, reasoning, and agentic work.",
    modalities: { input: ["text"] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    limit: { context: 1_000_000, output: 384_000 },
    api: { "chat-completions": {} },
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    family: "glm-flash",
    description: "Native multimodal GLM model for efficient coding and long-horizon agent tasks.",
    modalities: { input: ["text", "image/png", "image/jpeg", "video/mp4"] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    limit: { context: 1_000_000, output: 131_072 },
    api: { "chat-completions": {} },
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    family: "kimi-k3",
    description: "Multimodal Kimi model with 1M context for long-horizon agent work.",
    modalities: { input: ["text", "image/png", "image/jpeg"] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    limit: { context: 1_048_576, output: 131_072 },
    api: { "chat-completions": {} },
  },
  {
    id: "kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    family: "kimi-k3",
    description: "Multimodal Kimi model with always-on reasoning for coding and agentic work.",
    modalities: { input: ["text", "image/png", "image/jpeg"] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    limit: { context: 1_048_576, output: 131_072 },
    api: { "chat-completions": {} },
  },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    family: "claude-haiku",
    description: "Fast Claude model for responsive assistance and lightweight agents.",
    modalities: { input: ["text", "image/png", "image/jpeg", "application/pdf"] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    limit: { context: 1_000_000, output: 128_000 },
    api: { messages: {} },
  },
  {
    id: "qwen3.8-max",
    name: "Qwen3.8 Max",
    family: "qwen3.8-max",
    description: "Multimodal flagship for coding, professional work, and long-horizon agents.",
    modalities: { input: ["text", "image/png", "image/jpeg"] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    limit: { context: 1_000_000, output: 131_072 },
    api: { messages: {} },
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    family: "gpt-luna",
    description: "OpenAI's most efficient model for focused, high-volume tasks.",
    modalities: { input: ["text", "image/png", "image/jpeg", "application/pdf"] },
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    api: { responses: {} },
  },
];

export function supportsImageInput(model: OpenCodeModel): boolean {
  const hasImageModality = (model.modalities?.input ?? []).some((mime) => mime.startsWith("image/"));
  if (!hasImageModality) {
    return false;
  }

  // The gateway translates text between APIs, but image translation is not
  // guaranteed. Only advertise vision when the model natively speaks chat
  // completions, which is the API this provider uses.
  if (model.api && !Object.prototype.hasOwnProperty.call(model.api, "chat-completions")) {
    return false;
  }

  return true;
}

export function supportsToolCalling(model: OpenCodeModel): boolean {
  return model.capabilities?.tools?.supported === true;
}

export function isFreeModel(model: OpenCodeModel): boolean {
  const input = model.cost?.text?.input?.price;
  const output = model.cost?.text?.output?.price;
  return input === 0 && output === 0;
}

export function selectModels(models: readonly OpenCodeModel[], includeFree: boolean): OpenCodeModel[] {
  return models.filter((model) => {
    if (model.type && model.type !== "chat") {
      return false;
    }
    if (!model.id) {
      return false;
    }
    if (!includeFree && isFreeModel(model)) {
      return false;
    }
    return true;
  });
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const rounded = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

export function toChatInformation(model: OpenCodeModel): vscode.LanguageModelChatInformation {
  const context = model.limit?.context ?? model.limit?.input ?? 128_000;
  const maxOutputTokens = model.limit?.output ?? Math.min(16_384, context);
  const maxInputTokens = model.limit?.input ?? context;
  const toolCalling = supportsToolCalling(model);
  const imageInput = supportsImageInput(model);

  return {
    id: model.id,
    name: model.name ?? model.id,
    family: model.family ?? model.canonical_id?.split("/")[0] ?? model.id,
    version: "1.0.0",
    detail: `${formatTokenCount(context)} context`,
    tooltip: model.description ?? model.name ?? model.id,
    maxInputTokens,
    maxOutputTokens,
    capabilities: {
      toolCalling,
      imageInput,
    },
  };
}
