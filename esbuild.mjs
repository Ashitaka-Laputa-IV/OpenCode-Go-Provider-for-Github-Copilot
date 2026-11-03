import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("[watch] building extension...");
} else {
  await esbuild.build(options);
}
