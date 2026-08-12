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
assert.match(app, /className="explorer-resizer"/, "Explorer/editor resize handle must be rendered");
assert.match(app, /className="agent-resizer"/, "editor/Agent resize handle must be rendered");
assert.match(app, /localStorage\.setItem\(PANE_LAYOUT_KEY/, "pane sizes must persist across restarts");
assert.match(app, /role="separator"/, "pane resize handles must expose accessible separator semantics");
assert.match(agent, /aria-label="Local model"/, "model selection must be interactive");
assert.match(agent, /aria-label="Forge mode"/, "Chat and Agent modes must be selectable");
assert.match(agent, /markdown\.render\(message\.content\)/, "assistant messages must render Markdown");
assert.match(agent, /agentRequest/, "Agent mode must render the submitted user request");
assert.match(agent, /composer-progress/, "the composer must show in-place processing feedback");
assert.match(agent, /Forge is processing your request/, "Agent mode must explain its busy state");
assert.match(agent, /aria-busy=\{running\}/, "the composer must expose its busy state accessibly");
assert.match(app, /await sendChat\(/, "Chat mode must use the conversational endpoint");
assert.match(app, /setAgentRequest\(userRequest\)/, "Agent mode must persist the visible request before streaming");
assert.match(app, /setTask\(""\)/, "the submitted composer text must be cleared");
assert.match(workbench, /searchWorkspace\(query/, "workspace content search must be wired");
assert.match(workbench, /fetchWorkspaceStatus\(\)/, "source control must be wired");
assert.match(workbench, /runProjectCheck\(name/, "trusted checks must be wired");
for (const route of ["/api/search", "/api/workspace/status", "/api/project/scripts", "/api/project/check", "/api/chat"]) {
  assert.ok(server.includes(route), `server route ${route} must exist`);
}
assert.match(api, /export async function sendChat/, "chat API client must exist");

console.log("Forge Electron UI contract passed: navigation, workbench, model chat, Markdown, and checks are wired.");
