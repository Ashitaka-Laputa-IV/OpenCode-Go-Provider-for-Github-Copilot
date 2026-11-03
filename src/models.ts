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

export interface TokenLimits {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly context: number;
}

/**
 * VS Code displays "Max context" as maxInputTokens + maxOutputTokens, so the
 * two values must add up to the model's real context window.
 */
export function resolveTokenLimits(model: OpenCodeModel, contextWindowOverride = 0): TokenLimits {
  const modelContext = Math.max(1, model.limit?.context ?? model.limit?.input ?? 128_000);
  let maxOutputTokens = Math.max(
    1,
    Math.min(model.limit?.output ?? Math.min(16_384, modelContext), modelContext - 1),
  );
  let maxInputTokens = model.limit?.input ?? Math.max(1, modelContext - maxOutputTokens);

  // Some catalog entries list an input limit that, combined with the output
  // limit, exceeds the context window. Prefer keeping the output limit and
  // reducing the input budget so VS Code's "Max context" stays accurate.
  if (maxInputTokens + maxOutputTokens > modelContext) {
    maxInputTokens = Math.max(1, modelContext - maxOutputTokens);
  }

  if (maxInputTokens < modelContext * 0.05) {
    maxInputTokens = Math.max(1, Math.floor(modelContext * 0.25));
    maxOutputTokens = Math.max(1, modelContext - maxInputTokens);
  }

  const target =
    contextWindowOverride > 0 ? Math.min(contextWindowOverride, modelContext) : modelContext;
  if (target < modelContext) {
    const minInput = Math.max(1, Math.floor(target * 0.25));
    maxOutputTokens = Math.min(maxOutputTokens, Math.max(1, target - minInput));
    maxInputTokens = Math.min(maxInputTokens, Math.max(1, target - maxOutputTokens));
    if (maxInputTokens + maxOutputTokens > target) {
      maxOutputTokens = Math.max(1, target - maxInputTokens);
    }
  }

  return {
    maxInputTokens,
    maxOutputTokens,
    context: maxInputTokens + maxOutputTokens,
  };
}

export interface LanguageModelConfigurationSchema {
  properties?: Record<string, Record<string, unknown>>;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

export function buildReasoningConfiguration(
  model: OpenCodeModel,
): LanguageModelConfigurationSchema | undefined {
  if (model.capabilities?.reasoning?.supported !== true) {
    return undefined;
  }
  const efforts = [
    ...new Set((model.capabilities.reasoning.effort ?? []).map((effort) => effort.toLowerCase())),
  ].filter((effort) => effort !== "auto");
  if (efforts.length === 0) {
    return undefined;
  }

  const values = ["auto", ...efforts];
  return {
    properties: {
      reasoningEffort: {
        type: "string",
        title: "Thinking",
        description: "Reasoning effort for this model",
        enum: values,
        enumItemLabels: values.map((value) => capitalize(value)),
        default: "auto",
        group: "navigation",
      },
    },
  };
}

export interface ChatInformationVariant {
  readonly id: string;
  readonly name: string;
}

export interface ModelPreset {
  readonly key: "compact" | "deep";
  readonly label: string;
  readonly contextWindowTokens?: number;
  readonly reasoningEffort?: string;
}

function chooseEffort(supported: readonly string[], targets: readonly string[]): string | undefined {
  for (const target of targets) {
    if (supported.includes(target)) {
      return target;
    }
  }
  return undefined;
}

/**
 * Build a small set of picker presets. The stable VS Code API has no per-model
 * settings panel for third-party providers, so each preset is a separate model
 * entry with its own context and reasoning settings.
 */
export function buildModelPresets(model: OpenCodeModel, baseContext: number): ModelPreset[] {
  const efforts = (model.capabilities?.reasoning?.effort ?? []).map((effort) =>
    effort.toLowerCase(),
  );
  const canReason = model.capabilities?.reasoning?.supported === true && efforts.length > 0;
  const compactContext = Math.min(baseContext, 200_000);
  const compactEffort = chooseEffort(efforts, ["minimal", "low"]);
  const deepEffort = chooseEffort(efforts, ["max", "xhigh", "high"]);
  const presets: ModelPreset[] = [];

  if (compactContext < baseContext || compactEffort !== undefined) {
    presets.push({
      key: "compact",
      label: "Compact",
      contextWindowTokens: compactContext,
      reasoningEffort: compactEffort,
    });
  }

  if (baseContext > compactContext || (deepEffort !== undefined && deepEffort !== compactEffort)) {
    presets.push({
      key: "deep",
      label: canReason ? "Deep Think" : "Full Context",
      contextWindowTokens: baseContext,
      reasoningEffort: deepEffort,
    });
  }

  return presets;
}

export function toChatInformation(
  model: OpenCodeModel,
  contextWindowOverride = 0,
  variant?: ChatInformationVariant,
): vscode.LanguageModelChatInformation {
  const limits = resolveTokenLimits(model, contextWindowOverride);
  const toolCalling = supportsToolCalling(model);
  const imageInput = supportsImageInput(model);

  const info: vscode.LanguageModelChatInformation & {
    configurationSchema?: LanguageModelConfigurationSchema;
  } = {
    id: variant?.id ?? model.id,
    name: variant?.name ?? model.name ?? model.id,
    family: model.family ?? model.canonical_id?.split("/")[0] ?? model.id,
    version: "1.0.0",
    detail: `${formatTokenCount(limits.context)} context`,
    tooltip: model.description ?? model.name ?? model.id,
    maxInputTokens: limits.maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
    capabilities: {
      toolCalling,
      imageInput,
    },
  };

  const configurationSchema = buildReasoningConfiguration(model);
  if (configurationSchema) {
    info.configurationSchema = configurationSchema;
  }
  return info;
}
