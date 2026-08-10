import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const [app, agent, workbench, api, server] = await Promise.all([
  readFile(path.join(root, "src/client/App.tsx"), "utf8"),
  readFile(path.join(root, "src/client/AgentPanel.tsx"), "utf8"),
  readFile(path.join(root, "src/client/WorkbenchPanel.tsx"), "utf8"),
  readFile(path.join(root, "src/client/api.ts"), "utf8"),
  readFile(path.join(root, "src/server/index.ts"), "utf8"),
]);

for (const view of ["explorer", "search", "source", "run", "extensions", "security"]) {
  assert.match(app, new RegExp(`activateWorkbench\\(\"${view}\"\\)`), `activity view ${view} must be wired`);
}
assert.match(app, /className="command-center" onClick=/, "command center must be interactive");
assert.match(app, /navigateFileHistory\(-1\)/, "back navigation must be wired");
assert.match(app, /navigateFileHistory\(1\)/, "forward navigation must be wired");
assert.match(agent, /aria-label="Local model"/, "model selection must be interactive");
assert.match(agent, /aria-label="Forge mode"/, "Chat and Agent modes must be selectable");
assert.match(agent, /markdown\.render\(message\.content\)/, "assistant messages must render Markdown");
assert.match(app, /await sendChat\(/, "Chat mode must use the conversational endpoint");
assert.match(workbench, /searchWorkspace\(query/, "workspace content search must be wired");
assert.match(workbench, /fetchWorkspaceStatus\(\)/, "source control must be wired");
assert.match(workbench, /runProjectCheck\(name/, "trusted checks must be wired");
for (const route of ["/api/search", "/api/workspace/status", "/api/project/scripts", "/api/project/check", "/api/chat"]) {
  assert.ok(server.includes(route), `server route ${route} must exist`);
}
assert.match(api, /export async function sendChat/, "chat API client must exist");

console.log("Forge Electron UI contract passed: navigation, workbench, model chat, Markdown, and checks are wired.");
