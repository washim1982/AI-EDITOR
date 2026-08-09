import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "..");
const extensionRoot = path.join(workspace, "extensions", "forge-agent");
const manifest = JSON.parse(readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
const output = path.join(workspace, "release", `forge-agent-${manifest.version}.vsix`);
const vsce = path.join(workspace, "node_modules", "@vscode", "vsce", "vsce");

await import("./build-forge-extension.mjs");
mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(process.execPath, [
  vsce,
  "package",
  "--no-dependencies",
  "--allow-missing-repository",
  "--skip-license",
  "--out",
  output,
], {
  cwd: extensionRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Forge VSIX created at ${output}`);
