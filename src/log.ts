import type * as vscode from "vscode";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/oc_sk_[A-Za-z0-9_]+/g, "oc_sk_[redacted]"],
  [/(Bearer\s+)[^\s"']+/gi, "$1[redacted]"],
];

export function redact(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export class Logger {
  constructor(private readonly channel: vscode.OutputChannel) {}

  info(message: string, data?: unknown): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write("warn", message, data);
  }

  error(message: string, error?: unknown): void {
    this.write("error", message, error);
  }

  private write(level: string, message: string, data?: unknown): void {
    let suffix = "";
    if (data !== undefined) {
      try {
        suffix = ` ${typeof data === "string" ? data : JSON.stringify(data)}`;
      } catch {
        suffix = " [unserializable]";
      }
    }
    this.channel.appendLine(`[${new Date().toISOString()}] [${level}] ${redact(message + suffix)}`);
  }
}
