import { createHash } from "node:crypto";

/**
 * OpenCode Go requires a stable `x-opencode-session` per conversation.
 * VS Code does not expose conversation identity to language model providers,
 * so we derive one from the workspace, model, and the first user message,
 * which stays constant while history is re-sent each turn.
 */
export function sessionIdFor(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `ses_${digest.slice(0, 32)}`;
}

export function sessionSeed(workspace: string, modelId: string, firstUserText: string): string {
  return `${workspace}\n${modelId}\n${firstUserText}`;
}
