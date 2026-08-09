import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "..");
const requestedSource = process.argv[2] || path.join(workspace, "vendor", "code-oss");
const codeOssRoot = path.resolve(requestedSource);
const packagePath = path.join(codeOssRoot, "package.json");
const productPath = path.join(codeOssRoot, "product.json");

const upstreamPackage = JSON.parse(await readFile(packagePath, "utf8"));
if (upstreamPackage.name !== "code-oss-dev") {
  throw new Error(`Refusing to modify ${codeOssRoot}: package name is not code-oss-dev.`);
}

const sourceExtension = path.join(workspace, "extensions", "forge-agent");
const targetExtension = path.join(codeOssRoot, "extensions", "forge-agent");
const expectedParent = path.join(codeOssRoot, "extensions") + path.sep;
if (!targetExtension.startsWith(expectedParent)) {
  throw new Error("Resolved extension destination escaped the Code-OSS extensions directory.");
}

await rm(targetExtension, { recursive: true, force: true });
await cp(sourceExtension, targetExtension, {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}src${path.sep}`) && !source.endsWith("tsconfig.json"),
});

const [product, overrides] = await Promise.all([
  readFile(productPath, "utf8").then(JSON.parse),
  readFile(path.join(workspace, "code-oss", "product-overrides.json"), "utf8").then(JSON.parse),
]);
Object.assign(product, overrides);
await writeFile(productPath, `${JSON.stringify(product, null, "\t")}\n`, "utf8");

console.log(`Integrated Forge into Code-OSS at ${codeOssRoot}`);
console.log("Extension gallery: Open VSX (VSIX installation remains available from the Extensions view). ");
