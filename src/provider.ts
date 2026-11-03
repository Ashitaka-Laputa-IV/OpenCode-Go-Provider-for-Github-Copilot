import * as vscode from "vscode";
import { fetchModelCatalog, OpenCodeHttpError, streamChat } from "./client";
import { convertMessages, convertTools, firstUserText } from "./convert";
import type { Logger } from "./log";
import {
  DEFAULT_BASE_URL,
  MODELS_CACHE_MS,
  selectModels,
  toChatInformation,
  VENDOR,
  type ModelCatalog,
  type OpenCodeModel,
} from "./models";
import { sessionIdFor, sessionSeed } from "./session";

const SECRET_KEY = "opencodeGo.apiKey";
const CONFIG_SECTION = "opencodeGo";
const CATALOG_STORAGE_KEY = "opencodeGo.catalog.v1";
const MODEL_OVERRIDES_KEY = "opencodeGo.modelOverrides.v1";
const REASONING_EFFORTS = ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface ModelOverride {
  contextWindowTokens?: number;
  reasoningEffort?: string;
}

type ModelOverrides = Record<string, ModelOverride>;

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
  private lastGoodCatalog: ModelCatalog | undefined;
  private catalogLoadedFromStorage = false;
  private lastUpdateCheck = 0;
  private cachedApiKey: string | undefined;
  private modelOverrides: ModelOverrides = {};
  private modelOverridesLoaded = false;
  private readonly modelMetadata = new Map<string, OpenCodeModel>();

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
    const apiKey = await this.resolveApiKey(configuration, options.silent, configuration !== undefined);
    if (!apiKey) {
      return [];
    }

    const models = await this.getCatalog(token);
    const visible = selectModels(models, this.includeFreeModels());
    const unique = visible.filter(
      (model, index, list) => list.findIndex((candidate) => candidate.id === model.id) === index,
    );
    this.logger.info("models resolved", {
      total: models.length,
      visible: unique.length,
      baseUrl: this.getBaseUrl(),
    });
    this.modelMetadata.clear();
    for (const model of unique) {
      this.modelMetadata.set(model.id, model);
    }
    const globalContext = this.getContextWindowTokens();
    return unique.map((model) =>
      toChatInformation(model, this.getModelContextWindow(model.id, globalContext)),
    );
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
        modelOptions: this.requestModelOptions(
          model.id,
          options.modelOptions as Record<string, unknown> | undefined,
        ),
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

  async setReasoningEffort(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const current = configuration.get<string>("reasoningEffort", "auto");
    const options = REASONING_EFFORTS.map((value) => ({
      label: value,
      description: value === current ? "Current setting" : undefined,
    }));
    const picked = await vscode.window.showQuickPick(options, {
      title: "OpenCode Go: Reasoning Effort",
      placeHolder: "Auto lets each model decide",
    });
    if (!picked) {
      return;
    }
    await configuration.update("reasoningEffort", picked.label, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      `OpenCode Go reasoning effort set to "${picked.label}".`,
    );
  }

  async setContextWindow(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const current = configuration.get<number>("contextWindowTokens", 0);
    const value = await vscode.window.showInputBox({
      title: "OpenCode Go: Max Context Window",
      prompt: "Maximum context window (input + output) reported to VS Code. Use 0 for the model default.",
      value: String(current),
      ignoreFocusOut: true,
      validateInput: (input) => {
        const parsed = Number(input.trim());
        return Number.isFinite(parsed) && parsed >= 0
          ? undefined
          : "Enter 0 or a positive number of tokens.";
      },
    });
    if (value === undefined) {
      return;
    }
    const parsed = Number(value.trim());
    await configuration.update("contextWindowTokens", parsed, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      parsed === 0
        ? "OpenCode Go now uses each model's native context window."
        : `OpenCode Go context window capped at ${parsed.toLocaleString()} tokens.`,
    );
  }

  async configureModelSettings(): Promise<void> {
    const models = await this.getModelsForSettings();
    if (models.length === 0) {
      void vscode.window.showWarningMessage(
        "OpenCode Go: no models available. Add an API key or refresh models first.",
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      models.map((model) => ({
        label: model.name ?? model.id,
        description: model.id,
        detail: this.describeModelOverride(model.id),
        model,
      })),
      {
        title: "OpenCode Go: Configure Model",
        placeHolder: "Select a model to configure",
      },
    );
    if (!picked) {
      return;
    }

    const action = await vscode.window.showQuickPick(
      [
        { label: "Context window", description: "Cap input + output tokens for this model" },
        { label: "Reasoning effort", description: "Thinking level for this model" },
        { label: "Reset this model", description: "Use the global settings" },
      ],
      { title: `OpenCode Go: ${picked.label}` },
    );
    if (!action) {
      return;
    }

    if (action.label === "Reset this model") {
      this.removeModelOverride(picked.model.id);
      return;
    }
    if (action.label === "Context window") {
      await this.configureModelContext(picked.model);
      return;
    }
    await this.configureModelReasoning(picked.model);
  }

  async resetModelSettings(): Promise<void> {
    const overrides = this.ensureModelOverrides();
    const ids = Object.keys(overrides);
    if (ids.length === 0) {
      void vscode.window.showInformationMessage("OpenCode Go: no per-model settings to reset.");
      return;
    }

    const models = await this.getModelsForSettings().catch(() => [] as OpenCodeModel[]);
    const picked = await vscode.window.showQuickPick(
      ids.map((id) => {
        const model = models.find((candidate) => candidate.id === id);
        return {
          label: model?.name ?? id,
          description: id,
          detail: this.describeModelOverride(id),
          id,
        };
      }),
      {
        title: "OpenCode Go: Reset Model Settings",
        placeHolder: "Select a model",
      },
    );
    if (!picked) {
      return;
    }
    this.removeModelOverride(picked.id);
  }

  refreshModels(notify = true): void {
    this.catalog = undefined;
    this.changeEmitter.fire();
    if (notify) {
      void vscode.window.showInformationMessage("OpenCode Go models refreshed.");
    }
  }

  async checkForModelUpdates(): Promise<void> {
    const now = Date.now();
    if (now - this.lastUpdateCheck < 5 * 60 * 1000) {
      return;
    }
    this.lastUpdateCheck = now;

    const before = this.catalogSignature();
    this.catalog = undefined;
    const source = new vscode.CancellationTokenSource();
    try {
      await this.getCatalog(source.token);
    } finally {
      source.dispose();
    }
    if (this.catalogSignature() !== before) {
      this.logger.info("model catalog changed, refreshing VS Code model list");
      this.changeEmitter.fire();
    }
  }

  private async resolveApiKey(
    configuration: ProviderConfiguration | undefined,
    silent: boolean,
    allowCached = true,
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

    if (allowCached && this.cachedApiKey) {
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

    if (!this.catalogLoadedFromStorage) {
      this.catalogLoadedFromStorage = true;
      const stored = this.context.globalState.get<ModelCatalog>(CATALOG_STORAGE_KEY);
      if (
        stored &&
        stored.baseUrl === baseUrl &&
        Array.isArray(stored.models) &&
        stored.models.length > 0 &&
        typeof stored.fetchedAt === "number"
      ) {
        this.catalog = stored;
        this.lastGoodCatalog = stored;
        this.logger.info("loaded cached model catalog", { count: stored.models.length });
      }
    }

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
        this.lastGoodCatalog = this.catalog;
        void Promise.resolve(this.context.globalState.update(CATALOG_STORAGE_KEY, this.catalog)).catch(
          () => undefined,
        );
        this.logger.info("model catalog loaded", { count: models.length, baseUrl });
        return models;
      }
      this.logger.warn("model catalog was empty");
    } catch (error) {
      this.logger.warn("model catalog request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      cancellation.dispose();
    }

    // Prefer the last catalog that actually worked. Go plan changes are picked
    // up from the live endpoint; there is no hard-coded model list.
    if (this.lastGoodCatalog && this.lastGoodCatalog.baseUrl === baseUrl) {
      this.catalog = {
        ...this.lastGoodCatalog,
        fetchedAt: Date.now() - MODELS_CACHE_MS + 60_000,
      };
      this.logger.warn("using last known model catalog");
      return this.lastGoodCatalog.models;
    }

    // Retry the live catalog soon, but avoid a 15 second stall on every model
    // resolution while the network is down.
    this.catalog = {
      models: [],
      fetchedAt: Date.now() - MODELS_CACHE_MS + 60_000,
      baseUrl,
    };
    return [];
  }

  private catalogSignature(): string {
    return (this.catalog?.models ?? [])
      .map((model) =>
        [
          model.id,
          model.name ?? "",
          model.limit?.context ?? "",
          model.limit?.input ?? "",
          model.limit?.output ?? "",
          model.capabilities?.tools?.supported ? "tools" : "",
          (model.capabilities?.reasoning?.effort ?? []).join(","),
          (model.modalities?.input ?? []).join(","),
        ].join(":"),
      )
      .join("|");
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

  private getContextWindowTokens(): number {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<number>("contextWindowTokens", 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  private ensureModelOverrides(): ModelOverrides {
    if (!this.modelOverridesLoaded) {
      this.modelOverridesLoaded = true;
      const stored = this.context.globalState.get<ModelOverrides>(MODEL_OVERRIDES_KEY);
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        this.modelOverrides = stored;
      }
    }
    return this.modelOverrides;
  }

  private getModelContextWindow(modelId: string, globalContext: number): number {
    const override = this.ensureModelOverrides()[modelId]?.contextWindowTokens;
    return typeof override === "number" && override > 0 ? override : globalContext;
  }

  private describeModelOverride(modelId: string): string {
    const override = this.ensureModelOverrides()[modelId];
    if (!override) {
      return "Using global settings";
    }
    const parts: string[] = [];
    if (override.contextWindowTokens) {
      parts.push(`context ${override.contextWindowTokens.toLocaleString()}`);
    }
    if (override.reasoningEffort) {
      parts.push(`effort ${override.reasoningEffort}`);
    }
    return parts.length > 0 ? parts.join(" · ") : "Using global settings";
  }

  private saveModelOverrides(): void {
    void Promise.resolve(
      this.context.globalState.update(MODEL_OVERRIDES_KEY, this.modelOverrides),
    ).catch(() => undefined);
  }

  private removeModelOverride(modelId: string): void {
    delete this.ensureModelOverrides()[modelId];
    this.saveModelOverrides();
    this.changeEmitter.fire();
    void vscode.window.showInformationMessage(`OpenCode Go: reset settings for ${modelId}.`);
  }

  private async getModelsForSettings(): Promise<OpenCodeModel[]> {
    const source = new vscode.CancellationTokenSource();
    try {
      const models = await this.getCatalog(source.token);
      return selectModels(models, this.includeFreeModels());
    } finally {
      source.dispose();
    }
  }

  private async configureModelContext(model: OpenCodeModel): Promise<void> {
    const current = this.ensureModelOverrides()[model.id]?.contextWindowTokens ?? 0;
    const value = await vscode.window.showInputBox({
      title: `OpenCode Go: ${model.name ?? model.id} Context`,
      prompt:
        "Maximum context window (input + output) for this model. Use 0 to inherit the global setting.",
      value: String(current),
      ignoreFocusOut: true,
      validateInput: (input) => {
        const parsed = Number(input.trim());
        return Number.isFinite(parsed) && parsed >= 0
          ? undefined
          : "Enter 0 or a positive number of tokens.";
      },
    });
    if (value === undefined) {
      return;
    }
    const parsed = Math.floor(Number(value.trim()));
    const existing = { ...(this.modelOverrides[model.id] ?? {}) };
    if (parsed === 0) {
      delete existing.contextWindowTokens;
    } else {
      existing.contextWindowTokens = parsed;
    }
    this.storeModelOverride(model.id, existing);
  }

  private async configureModelReasoning(model: OpenCodeModel): Promise<void> {
    const reasoning = model.capabilities?.reasoning;
    if (reasoning?.supported !== true) {
      void vscode.window.showInformationMessage(
        `OpenCode Go: ${model.name ?? model.id} does not expose reasoning effort settings.`,
      );
      return;
    }

    const supported = [...new Set((reasoning.effort ?? []).map((effort) => effort.toLowerCase()))];
    const items: Array<{ label: string; description?: string; value?: string }> = [
      {
        label: "Use global setting",
        description: "Inherit the global reasoning effort",
        value: undefined,
      },
      { label: "auto", description: "Let the model decide", value: "auto" },
      ...supported.map((effort) => ({ label: effort, value: effort })),
    ];

    const current = this.ensureModelOverrides()[model.id]?.reasoningEffort;
    const picked = await vscode.window.showQuickPick(items, {
      title: `OpenCode Go: ${model.name ?? model.id} Reasoning`,
      placeHolder: current ? `Current: ${current}` : "Using global setting",
    });
    if (!picked) {
      return;
    }

    const existing = { ...(this.modelOverrides[model.id] ?? {}) };
    if (picked.value === undefined) {
      delete existing.reasoningEffort;
    } else {
      existing.reasoningEffort = picked.value;
    }
    this.storeModelOverride(model.id, existing);
  }

  private storeModelOverride(modelId: string, override: ModelOverride): void {
    if (override.contextWindowTokens === undefined && override.reasoningEffort === undefined) {
      delete this.modelOverrides[modelId];
    } else {
      this.modelOverrides[modelId] = override;
    }
    this.saveModelOverrides();
    this.changeEmitter.fire();
    void vscode.window.showInformationMessage(`OpenCode Go: updated settings for ${modelId}.`);
  }

  private requestModelOptions(
    modelId: string,
    options: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const merged = { ...(options ?? {}) };
    const effort = this.resolveReasoningEffort(modelId);
    if (effort) {
      merged.reasoning_effort = effort;
    }
    return merged;
  }

  private resolveReasoningEffort(modelId: string): string | undefined {
    const globalSetting = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>("reasoningEffort", "auto");
    const override = this.ensureModelOverrides()[modelId]?.reasoningEffort;
    const setting = (override ?? globalSetting).trim().toLowerCase();
    if (setting.length === 0 || setting === "auto") {
      return undefined;
    }

    const model = this.modelMetadata.get(modelId);
    if (!model) {
      return undefined;
    }
    const reasoning = model.capabilities?.reasoning;
    if (reasoning?.supported !== true) {
      return undefined;
    }

    const supported = (reasoning.effort ?? []).map((effort) => effort.toLowerCase());
    if (supported.length === 0) {
      // The catalog did not advertise configurable effort levels. Do not send
      // an unknown parameter to models that may reject it.
      return undefined;
    }
    if (supported.includes(setting)) {
      return setting;
    }
    if (setting === "none") {
      return undefined;
    }

    const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
    const target = order.indexOf(setting);
    if (target < 0) {
      return undefined;
    }

    let best = supported[0];
    for (const candidate of supported) {
      if (Math.abs(order.indexOf(candidate) - target) < Math.abs(order.indexOf(best) - target)) {
        best = candidate;
      }
    }
    return best;
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
