export type ProviderKind = "ollama" | "lmstudio" | "llamacpp";

export interface ProviderConfig {
  kind: ProviderKind;
  endpoint: string;
  model: string;
  temperature: number;
}

export interface RuntimeStatus {
  kind: ProviderKind;
  label: string;
  endpoint: string;
  reachable: boolean;
  models: string[];
  latencyMs: number;
  error?: string;
}

export type ChangeOperation = "create" | "modify" | "delete";

export interface ExecutionBrief {
  version: 1;
  task_id: string;
  snapshot_id: string;
  objective: string;
  evidence: Array<{
    id: string;
    source: "workspace" | "index" | "mcp" | "artifact";
    path_or_uri: string;
    reason: string;
    sha?: string;
    start_line?: number;
    end_line?: number;
    trust: "trusted-workspace" | "derived" | "external-untrusted";
  }>;
  changes: Array<{
    id: string;
    path: string;
    operation: ChangeOperation;
    intent: string;
    preimage_sha?: string;
    evidence_ids: string[];
    depends_on: string[];
  }>;
  invariants: string[];
  validation: {
    required_checks: string[];
    suggested_commands: string[];
  };
  blockers: Array<{
    code: string;
    message: string;
    needs?: string[];
  }>;
  risk: {
    level: "low" | "medium" | "high";
    reasons: string[];
  };
}

export interface MutationSet {
  mutations: Array<{
    change_id: string;
    path: string;
    operation: ChangeOperation;
    content?: string;
  }>;
}

export type AgentEventKind =
  | "run.started"
  | "snapshot.created"
  | "gather.started"
  | "retrieval.complete"
  | "brief.validated"
  | "hydration.complete"
  | "apply.started"
  | "mutation.staged"
  | "verification.command"
  | "verification.result"
  | "repair.started"
  | "promotion.complete"
  | "run.completed"
  | "run.failed";

export interface AgentEvent {
  id: string;
  runId: string;
  kind: AgentEventKind;
  phase: "system" | "gather" | "apply" | "verify" | "promote";
  title: string;
  message: string;
  status: "running" | "success" | "error" | "info";
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface AgentRunRequest {
  prompt: string;
  provider: ProviderConfig;
  maxRepairCycles?: number;
}

export interface ChatRequest {
  prompt: string;
  provider: ProviderConfig;
  history?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export interface WorkspaceFile {
  path: string;
  content: string;
  sha: string;
  language: string;
}
