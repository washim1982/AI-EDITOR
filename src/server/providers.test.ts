import assert from "node:assert/strict";
import test from "node:test";
import { chatWithLocalModel } from "./providers.js";

test("Ollama structured requests disable thinking output", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ message: { content: "{\"ok\":true}" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await chatWithLocalModel(
      { kind: "ollama", endpoint: "http://127.0.0.1:11434", model: "test-model", temperature: 0 },
      [{ role: "user", content: "Return JSON" }],
    );
    assert.equal(result, "{\"ok\":true}");
    assert.equal(requestBody?.think, false);
    assert.equal(requestBody?.format, "json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Conversational Ollama requests do not force JSON output", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ message: { content: "Hello!" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await chatWithLocalModel(
      { kind: "ollama", endpoint: "http://127.0.0.1:11434", model: "test-model", temperature: 0 },
      [{ role: "user", content: "hi" }],
      undefined,
      { structured: false },
    );
    assert.equal(result, "Hello!");
    assert.equal(requestBody?.think, false);
    assert.equal("format" in (requestBody ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
