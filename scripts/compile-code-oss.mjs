import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

await import("./sync-code-oss.mjs");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["--prefix", path.join(workspace, "vendor", "code-oss"), "run", "compile"], {
  cwd: workspace,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
