import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "..");
const runtimeRoot = path.resolve(process.argv[2] || "");
const applicationRoot = path.join(runtimeRoot, "resources", "app");
const executable = path.join(runtimeRoot, "VSCodium.exe");
const productPath = path.join(applicationRoot, "product.json");

await Promise.all([
  stat(executable).then((metadata) => {
    if (!metadata.isFile() || metadata.size < 1_000_000) throw new Error("The portable Code-OSS executable is incomplete.");
  }),
  readFile(path.join(applicationRoot, "package.json"), "utf8").then((content) => {
    const manifest = JSON.parse(content);
    if (!manifest.name || !manifest.main) throw new Error("The runtime is not a recognizable Code-OSS application.");
  }),
]);

const sourceExtension = path.join(workspace, "extensions", "forge-agent");
const targetExtension = path.join(applicationRoot, "extensions", "forge-agent");
const expectedParent = path.join(applicationRoot, "extensions") + path.sep;
if (!targetExtension.startsWith(expectedParent)) {
  throw new Error("Resolved extension destination escaped the portable Code-OSS application.");
}
await rm(targetExtension, { recursive: true, force: true });
await cp(sourceExtension, targetExtension, {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}src${path.sep}`) && !source.endsWith("tsconfig.json") && !source.endsWith(".map"),
});
await Promise.all([
  cp(path.join(workspace, "code-oss", "Forge.cmd"), path.join(runtimeRoot, "Forge.cmd")),
  cp(path.join(workspace, "code-oss", "Forge.Installed.cmd"), path.join(runtimeRoot, "Forge.Installed.cmd")),
  cp(path.join(workspace, "code-oss", "README_FORGE.txt"), path.join(runtimeRoot, "README_FORGE.txt")),
  cp(path.join(workspace, "build", "icon.ico"), path.join(runtimeRoot, "forge.ico")),
  cp(path.join(workspace, "build", "icon.ico"), path.join(applicationRoot, "resources", "win32", "code.ico")),
  cp(path.join(workspace, "build", "code_150x150.png"), path.join(applicationRoot, "resources", "win32", "code_150x150.png")),
  cp(path.join(workspace, "build", "code_70x70.png"), path.join(applicationRoot, "resources", "win32", "code_70x70.png")),
]);

const [product, overrides] = await Promise.all([
  readFile(productPath, "utf8").then(JSON.parse),
  readFile(path.join(workspace, "code-oss", "product-overrides.json"), "utf8").then(JSON.parse),
]);
Object.assign(product, overrides);
await writeFile(productPath, `${JSON.stringify(product, null, "\t")}\n`, "utf8");
console.log(`Integrated Forge into portable Code-OSS runtime at ${runtimeRoot}`);
