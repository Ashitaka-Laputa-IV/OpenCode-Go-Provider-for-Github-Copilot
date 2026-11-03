import * as esbuild from "esbuild";
import { runTests } from "@vscode/test-electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = process.env.OPENCODE_API_KEY;

if (!apiKey) {
  console.error("Set OPENCODE_API_KEY before running the integration tests.");
  process.exit(1);
}

await esbuild.build({
  entryPoints: [path.join(root, "test/integration/index.ts")],
  outfile: path.join(root, "out/integration/index.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  logLevel: "info",
});

const candidates = [
  process.env.VSCODE_EXECUTABLE,
  process.platform === "win32"
    ? "C:\\Users\\Ashit\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"
    : undefined,
  process.platform === "win32" ? "C:\\Program Files\\Microsoft VS Code\\Code.exe" : undefined,
  "/usr/share/code/code",
  "/usr/bin/code",
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
].filter((candidate) => typeof candidate === "string");

const vscodeExecutablePath = candidates.find((candidate) => existsSync(candidate));
if (vscodeExecutablePath) {
  console.log(`[integration] using VS Code at ${vscodeExecutablePath}`);
} else {
  console.log("[integration] no local VS Code found, test-electron will download one");
}

/** @type {Record<string, string>} */
const extensionTestsEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") {
    extensionTestsEnv[key] = value;
  }
}
extensionTestsEnv.OPENCODE_API_KEY = apiKey;

await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "out/integration/index.js"),
  launchArgs: ["--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-gpu"],
  extensionTestsEnv,
});
