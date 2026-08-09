import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "..");
const extensionRoot = path.join(workspace, "extensions", "forge-agent");

await mkdir(path.join(extensionRoot, "out"), { recursive: true });
await mkdir(path.join(extensionRoot, "server"), { recursive: true });

await Promise.all([
  build({
    absWorkingDir: workspace,
    entryPoints: [path.join(extensionRoot, "src", "extension.ts")],
    outfile: path.join(extensionRoot, "out", "extension.js"),
    bundle: true,
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: true,
    logLevel: "info",
  }),
  build({
    absWorkingDir: workspace,
    entryPoints: [path.join(workspace, "src", "server", "index.ts")],
    outfile: path.join(extensionRoot, "server", "forge-server.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap: true,
    banner: {
      js: "import { createRequire as __forgeCreateRequire } from 'node:module'; const require = __forgeCreateRequire(import.meta.url);",
    },
    logLevel: "info",
  }),
  copyFile(
    path.join(extensionRoot, "src", "forge-worker.mjs"),
    path.join(extensionRoot, "server", "forge-worker.mjs"),
  ),
]);

console.log(`Forge Code-OSS extension built at ${extensionRoot}`);
