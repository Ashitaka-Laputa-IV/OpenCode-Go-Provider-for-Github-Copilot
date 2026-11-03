import * as vscode from "vscode";
import { Logger } from "./log";
import { OpenCodeProvider, VENDOR } from "./provider";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("OpenCode Go");
  const logger = new Logger(channel);
  const version = String(context.extension.packageJSON.version ?? "0.0.0");
  const provider = new OpenCodeProvider(context, logger, version);
  const catalogTimer = setInterval(() => void provider.checkForModelUpdates(), 30 * 60 * 1000);

  context.subscriptions.push(
    channel,
    provider,
    { dispose: () => clearInterval(catalogTimer) },
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void provider.checkForModelUpdates();
      }
    }),
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.commands.registerCommand("opencodeGo.setApiKey", () => provider.setApiKey()),
    vscode.commands.registerCommand("opencodeGo.clearApiKey", () => provider.clearApiKey()),
    vscode.commands.registerCommand("opencodeGo.refreshModels", () => provider.refreshModels()),
    vscode.commands.registerCommand("opencodeGo.setReasoningEffort", () =>
      provider.setReasoningEffort(),
    ),
    vscode.commands.registerCommand("opencodeGo.setContextWindow", () =>
      provider.setContextWindow(),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("opencodeGo.baseUrl") ||
        event.affectsConfiguration("opencodeGo.includeFreeModels") ||
        event.affectsConfiguration("opencodeGo.contextWindowTokens")
      ) {
        provider.refreshModels(false);
      }
    }),
  );

  logger.info(`OpenCode Go extension ${version} activated`);
}

export function deactivate(): void {
  // Nothing to clean up beyond the disposables registered above.
}
