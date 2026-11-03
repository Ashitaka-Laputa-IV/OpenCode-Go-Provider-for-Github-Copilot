import * as vscode from "vscode";
import { fetchModelCatalog, OpenCodeHttpError, streamChat } from "./client";
import { convertMessages, convertTools, firstUserText } from "./convert";
import type { Logger } from "./log";
import {
  DEFAULT_BASE_URL,
  FALLBACK_MODELS,
  MODELS_CACHE_MS,
  selectModels,
  toChatInformation,
  VENDOR,
  type ModelCatalog,
} from "./models";
import { sessionIdFor, sessionSeed } from "./session";

const SECRET_KEY = "opencodeGo.apiKey";
const CONFIG_SECTION = "opencodeGo";

interface ProviderConfiguration {
  apiKey?: unknown;
  [key: string]: unknown;
}

type InfoOptions = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: ProviderConfiguration;
};

function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 3));
}

function isImagePart(part: unknown): part is vscode.LanguageModelDataPart {
  const DataPart = (vscode as unknown as { LanguageModelDataPart?: typeof vscode.LanguageModelDataPart })
    .LanguageModelDataPart;
  return (
    !!DataPart &&
    part instanceof DataPart &&
    typeof part.mimeType === "string" &&
    part.mimeType.startsWith("image/")
  );
}

export class OpenCodeProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly userAgent: string;
  private catalog: ModelCatalog | undefined;
  private cachedApiKey: string | undefined;

  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    version: string,
  ) {
    this.userAgent = `opencode-go-copilot/${version}`;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const configuration = (options as InfoOptions).configuration;
    const apiKey = await this.resolveApiKey(configuration, options.silent);
    if (!apiKey) {
      return [];
    }

    const models = await this.getCatalog(token);
    const visible = selectModels(models, this.includeFreeModels());
    this.logger.info("models resolved", {
      total: models.length,
      visible: visible.length,
      baseUrl: this.getBaseUrl(),
    });
    return visible.map(toChatInformation);
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const apiKey = await this.resolveApiKey(undefined, true);
    if (!apiKey) {
      throw vscode.LanguageModelError.NoPermissions(
        "OpenCode Go needs an API key. Open the model picker, choose Manage Models, and set an API key for OpenCode Go.",
      );
    }

    const converted = convertMessages(messages);
    const { tools, toolChoice } = convertTools(options.tools, options.toolMode);
    const workspace = (vscode.workspace.workspaceFolders ?? [])
      .map((folder) => folder.uri.toString())
      .join("|");
    const sessionId = sessionIdFor(sessionSeed(workspace, model.id, firstUserText(messages)));

    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    if (token.isCancellationRequested) {
      abort.abort();
    }
    const started = Date.now();

    this.logger.info("chat request", {
      model: model.id,
      messages: converted.length,
      tools: tools?.length ?? 0,
      session: sessionId.slice(0, 12),
    });

    try {
      await streamChat({
        baseUrl: this.getBaseUrl(),
        apiKey,
        sessionId,
        userAgent: this.userAgent,
        model: model.id,
        messages: converted,
        tools,
        toolChoice,
        modelOptions: options.modelOptions as Record<string, unknown> | undefined,
        signal: abort.signal,
        onText: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
        onToolCall: (call) =>
          progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, call.input)),
        onUsage: (usage) =>
          this.logger.info("chat usage", {
            input: usage.inputTokens,
            output: usage.outputTokens,
          }),
      });
      this.logger.info("chat completed", { model: model.id, ms: Date.now() - started });
    } catch (error) {
      if (token.isCancellationRequested || abort.signal.aborted) {
        throw new vscode.CancellationError();
      }
      this.logger.error("chat failed", {
        model: model.id,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.toUserFacingError(error);
    } finally {
      cancellation.dispose();
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") {
      return estimateTokens(text);
    }

    let total = 4;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += estimateTokens(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        total += estimateTokens(part.name) + estimateTokens(JSON.stringify(part.input ?? {})) + 8;
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        for (const item of part.content as readonly unknown[]) {
          if (item instanceof vscode.LanguageModelTextPart) {
            total += estimateTokens(item.value);
          } else if (isImagePart(item)) {
            total += 1_000;
          } else {
            const raw = typeof item === "string" ? item : (JSON.stringify(item) ?? "");
            total += estimateTokens(raw);
          }
        }
      } else if (isImagePart(part)) {
        total += 1_000;
      } else if (typeof part === "string") {
        total += estimateTokens(part);
      }
    }
    return total;
  }

  async setApiKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: "OpenCode Go API Key",
      prompt: "Paste your OpenCode Go API key. It is stored in VS Code's encrypted secret storage.",
      placeHolder: "oc_sk_...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim().length === 0 ? "API key is required." : undefined),
    });

    if (value === undefined) {
      return;
    }

    const apiKey = value.trim();
    await this.context.secrets.store(SECRET_KEY, apiKey);
    this.cachedApiKey = apiKey;
    this.changeEmitter.fire();
    void vscode.window.showInformationMessage("OpenCode Go API key saved.");
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    this.cachedApiKey = undefined;
    this.changeEmitter.fire();
    void vscode.window.showInformationMessage("OpenCode Go API key cleared.");
  }

  refreshModels(notify = true): void {
    this.catalog = undefined;
    this.changeEmitter.fire();
    if (notify) {
      void vscode.window.showInformationMessage("OpenCode Go models refreshed.");
    }
  }

  private async resolveApiKey(
    configuration: ProviderConfiguration | undefined,
    silent: boolean,
  ): Promise<string | undefined> {
    const configured = typeof configuration?.apiKey === "string" ? configuration.apiKey.trim() : "";
    if (configured.length > 0) {
      this.cachedApiKey = configured;
      return configured;
    }

    // A configuration object without a key means the user removed the key in
    // VS Code's model provider UI. Drop the cached copy before falling back.
    if (configuration) {
      this.cachedApiKey = undefined;
    }

    if (this.cachedApiKey) {
      return this.cachedApiKey;
    }

    const environmentKey = process.env.OPENCODE_API_KEY?.trim();
    if (environmentKey) {
      this.cachedApiKey = environmentKey;
      return environmentKey;
    }

    const stored = await this.context.secrets.get(SECRET_KEY);
    if (stored) {
      this.cachedApiKey = stored;
      return stored;
    }

    if (silent) {
      return undefined;
    }

    const entered = await vscode.window.showInputBox({
      title: "OpenCode Go API Key",
      prompt: "Paste your OpenCode Go API key to add OpenCode Go models.",
      placeHolder: "oc_sk_...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim().length === 0 ? "API key is required." : undefined),
    });

    if (entered === undefined) {
      return undefined;
    }

    const apiKey = entered.trim();
    await this.context.secrets.store(SECRET_KEY, apiKey);
    this.cachedApiKey = apiKey;
    return apiKey;
  }

  private async getCatalog(token: vscode.CancellationToken): Promise<ModelCatalog["models"]> {
    const baseUrl = this.getBaseUrl();
    if (
      this.catalog &&
      this.catalog.baseUrl === baseUrl &&
      Date.now() - this.catalog.fetchedAt < MODELS_CACHE_MS
    ) {
      return this.catalog.models;
    }

    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());

    try {
      const models = await fetchModelCatalog(baseUrl, this.userAgent, abort.signal);
      if (models.length > 0) {
        this.catalog = { models, fetchedAt: Date.now(), baseUrl };
        this.logger.info("model catalog loaded", { count: models.length, baseUrl });
        return models;
      }
      this.logger.warn("model catalog was empty, using fallback models");
    } catch (error) {
      this.logger.warn("model catalog request failed, using fallback models", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      cancellation.dispose();
    }

    // Retry the live catalog soon, but avoid a 15 second stall on every model
    // resolution while the network is down.
    this.catalog = {
      models: [...FALLBACK_MODELS],
      fetchedAt: Date.now() - MODELS_CACHE_MS + 60_000,
      baseUrl,
    };
    return [...FALLBACK_MODELS];
  }

  private getBaseUrl(): string {
    const configured = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>("baseUrl", DEFAULT_BASE_URL)
      .trim();
    try {
      const url = new URL(configured);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("unsupported protocol");
      }
      return configured.replace(/\/+$/, "");
    } catch {
      this.logger.warn("invalid baseUrl, falling back to default", { configured });
      return DEFAULT_BASE_URL;
    }
  }

  private includeFreeModels(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("includeFreeModels", false);
  }

  private toUserFacingError(error: unknown): Error {
    if (error instanceof OpenCodeHttpError) {
      if (error.status === 401 || error.status === 403) {
        return vscode.LanguageModelError.NoPermissions(
          `OpenCode Go rejected the API key (HTTP ${error.status}). Update it in the model picker under Manage Models > OpenCode Go. ${error.detail}`,
        );
      }
      if (error.status === 429) {
        return new Error(`OpenCode Go rate limit reached. ${error.detail}`);
      }
      return new Error(`OpenCode Go request failed (HTTP ${error.status}): ${error.detail}`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

export { VENDOR };
