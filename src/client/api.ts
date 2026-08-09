import type {
  AgentEvent,
  AgentRunRequest,
  ProviderConfig,
  RuntimeStatus,
  TreeNode,
  WorkspaceFile,
} from "../shared/types";

async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

export async function fetchTree(): Promise<{ nodes: TreeNode[]; root: string }> {
  return jsonResponse(await fetch("/api/tree"));
}

export async function fetchFile(path: string): Promise<WorkspaceFile> {
  return jsonResponse(await fetch(`/api/file?path=${encodeURIComponent(path)}`));
}

export async function saveFile(file: WorkspaceFile, content: string): Promise<WorkspaceFile> {
  return jsonResponse(await fetch("/api/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: file.path, content, expectedSha: file.sha }),
  }));
}

export async function fetchModels(config: ProviderConfig): Promise<string[]> {
  const payload = await jsonResponse<{ models: string[] }>(await fetch("/api/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  }));
  return payload.models;
}

export async function fetchRuntimes(): Promise<RuntimeStatus[]> {
  const payload = await jsonResponse<{ runtimes: RuntimeStatus[] }>(await fetch("/api/runtimes"));
  return payload.runtimes;
}

export async function streamAgentRun(
  request: AgentRunRequest,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(payload.error || "Could not start the agent run.");
  }
  if (!response.body) throw new Error("The agent stream was unavailable.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as AgentEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as AgentEvent);
}
