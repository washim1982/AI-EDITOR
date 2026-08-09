import type { ProviderConfig, ProviderKind, RuntimeStatus } from "../shared/types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function endpointWithoutSlash(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

export const DEFAULT_PROVIDER_ENDPOINTS: Record<ProviderKind, string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
  llamacpp: "http://127.0.0.1:8080",
};

const PROVIDER_LABELS: Record<ProviderKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
};

function openAiBase(endpoint: string): string {
  const base = endpointWithoutSlash(endpoint);
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  return new Error(`Local model server returned ${response.status}: ${text.slice(0, 500) || response.statusText}`);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 4500): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortParent = () => controller.abort();
  init.signal?.addEventListener("abort", abortParent, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new Error(`Timed out connecting to ${new URL(url).origin}. Start the local model server and try again.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortParent);
  }
}

export async function chatWithLocalModel(
  config: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  options: { structured?: boolean } = {},
): Promise<string> {
  if (!config.model.trim()) throw new Error("Choose a local model before starting the agent.");
  const endpoint = endpointWithoutSlash(config.endpoint);
  const structured = options.structured ?? true;

  if (config.kind === "ollama") {
    const response = await fetchWithTimeout(`${endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        ...(structured ? { format: "json" } : {}),
        think: false,
        options: { temperature: config.temperature },
      }),
      signal,
    }, 300_000);
    if (!response.ok) throw await responseError(response);
    const payload = (await response.json()) as { message?: { content?: string; thinking?: string } };
    const content = payload.message?.content;
    if (!content && payload.message?.thinking) {
      throw new Error("Ollama returned reasoning without a final answer. Disable thinking for this model or select a completion model.");
    }
    if (!content) throw new Error("Ollama returned an empty response. Confirm that the selected model supports chat completions.");
    return content;
  }

  const requestBody = {
    model: config.model,
    messages,
    temperature: config.temperature,
    stream: false,
    ...(structured ? { response_format: { type: "json_object" } } : {}),
  };
  let response = await fetchWithTimeout(`${openAiBase(endpoint)}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    signal,
  }, 300_000);
  if (structured && (response.status === 400 || response.status === 422)) {
    response = await fetchWithTimeout(`${openAiBase(endpoint)}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...requestBody, response_format: undefined }),
      signal,
    }, 300_000);
  }
  if (!response.ok) throw await responseError(response);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("The local OpenAI-compatible server returned an empty response.");
  return content;
}

export function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    const first = unfenced.indexOf("{");
    const last = unfenced.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(unfenced.slice(first, last + 1));
    }
    throw new Error("The model response was not valid JSON.");
  }
}

export async function listLocalModels(config: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  const endpoint = endpointWithoutSlash(config.endpoint);
  if (config.kind === "ollama") {
    const response = await fetchWithTimeout(`${endpoint}/api/tags`, { signal });
    if (!response.ok) throw await responseError(response);
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    return (payload.models || []).map((model) => model.name || "").filter(Boolean);
  }

  const response = await fetchWithTimeout(`${openAiBase(endpoint)}/models`, { signal });
  if (!response.ok) throw await responseError(response);
  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  return (payload.data || []).map((model) => model.id || "").filter(Boolean);
}

export async function discoverLocalRuntimes(signal?: AbortSignal): Promise<RuntimeStatus[]> {
  const kinds: ProviderKind[] = ["ollama", "lmstudio", "llamacpp"];
  return Promise.all(kinds.map(async (kind): Promise<RuntimeStatus> => {
    const endpoint = DEFAULT_PROVIDER_ENDPOINTS[kind];
    const started = performance.now();
    try {
      const models = await listLocalModels({ kind, endpoint, model: "", temperature: 0.1 }, signal);
      return {
        kind,
        label: PROVIDER_LABELS[kind],
        endpoint,
        reachable: true,
        models,
        latencyMs: Math.round(performance.now() - started),
        error: models.length ? undefined : "Server is running, but it has no loaded or installed models.",
      };
    } catch (error) {
      return {
        kind,
        label: PROVIDER_LABELS[kind],
        endpoint,
        reachable: false,
        models: [],
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : "Runtime is unavailable.",
      };
    }
  }));
}
