import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

await import("./build-forge-extension.mjs");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "..");
const token = "forge-chat-integration-test";
const worker = new Worker(path.join(workspace, "extensions", "forge-agent", "server", "forge-worker.mjs"), {
  env: {
    ...process.env,
    FORGE_API_TOKEN: token,
    FORGE_CODE_OSS: "1",
    PORT: "0",
    WORKSPACE_ROOT: workspace,
  },
});

const apiUrl = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Forge chat integration test timed out starting the sidecar.")), 20_000);
  worker.once("error", reject);
  worker.on("message", (message) => {
    if (message?.type === "ready") {
      clearTimeout(timeout);
      resolve(message.url);
    } else if (message?.type === "error") {
      clearTimeout(timeout);
      reject(new Error(message.message));
    }
  });
});

try {
  const headers = { authorization: `Bearer ${token}` };
  const runtimeResponse = await fetch(`${apiUrl}/api/runtimes`, { headers });
  assert.equal(runtimeResponse.status, 200);
  const runtimePayload = await runtimeResponse.json();
  const runtime = runtimePayload.runtimes?.find((candidate) => candidate.reachable && candidate.models?.length);
  if (!runtime) {
    console.log("Forge chat integration skipped: no reachable local runtime with a loaded model.");
    process.exitCode = 0;
  } else {
    const response = await fetch(`${apiUrl}/api/chat`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "hi",
        provider: {
          kind: runtime.kind,
          endpoint: runtime.endpoint,
          model: runtime.models[0],
          temperature: 0.1,
        },
        history: [],
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, payload.error);
    assert.equal(typeof payload.message, "string");
    assert.ok(payload.message.trim().length > 0);
    console.log(`Forge chat integration passed with ${runtime.label}/${runtime.models[0]}: ${payload.message.trim().slice(0, 120)}`);

    const reviewResponse = await fetch(`${apiUrl}/api/agent/review`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "review project and suggest enhancement",
        provider: {
          kind: runtime.kind,
          endpoint: runtime.endpoint,
          model: runtime.models[0],
          temperature: 0.1,
        },
      }),
    });
    const reviewPayload = await reviewResponse.json();
    assert.equal(reviewResponse.status, 200, reviewPayload.error);
    assert.equal(typeof reviewPayload.message, "string");
    assert.ok(reviewPayload.message.trim().length > 0);
    assert.ok(reviewPayload.fileCount > 0);
    console.log(`Forge read-only review integration passed for ${reviewPayload.fileCount} source files: ${reviewPayload.message.trim().slice(0, 120)}`);
  }
} finally {
  await worker.terminate();
}
