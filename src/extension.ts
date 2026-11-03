import * as vscode from "vscode";
import { Logger } from "./log";
import { OpenCodeProvider, VENDOR } from "./provider";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("OpenCode Go");
  const logger = new Logger(channel);
  const version = String(context.extension.packageJSON.version ?? "0.0.0");
  const provider = new OpenCodeProvider(context, logger, version);

  context.subscriptions.push(
    channel,
    provider,
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.commands.registerCommand("opencodeGo.setApiKey", () => provider.setApiKey()),
    vscode.commands.registerCommand("opencodeGo.clearApiKey", () => provider.clearApiKey()),
    vscode.commands.registerCommand("opencodeGo.refreshModels", () => provider.refreshModels()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("opencodeGo.baseUrl") ||
        event.affectsConfiguration("opencodeGo.includeFreeModels")
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
