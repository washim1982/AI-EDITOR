import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentDecisionRequest,
  AgentEvent,
  AgentRunRequest,
  ExecutionBrief,
  ForgeRunManifest,
  ForgeTask,
  MutationSet,
} from "../shared/types.js";
import { chatWithLocalModel, parseModelJson } from "./providers.js";
import { readRunManifest, saveRunManifest } from "./run-store.js";
import {
  absoluteWorkspacePath,
  assertSafeRelativePath,
  cloneWorkspaceToStage,
  createSnapshot,
  fileExistsInWorkspace,
  normalizeRelativePath,
  readRawWorkspaceFile,
  removeStage,
  removeStagesForRun,
  repositoryMap,
  retrieveEvidence,
  sha256,
  workspaceRoot,
  type RetrievedEvidence,
  type WorkspaceSnapshot,
} from "./workspace.js";

type EventSink = (event: AgentEvent) => void;

interface RetrievalPlan {
  queries: string[];
  file_hints: string[];
  reasoning_summary: string;
}

interface VerificationResult {
  passed: boolean;
  diagnostics: string;
  commands: Array<{ command: string; passed: boolean; output: string }>;
}

interface StagedMutation {
  path: string;
  operation: "create" | "modify" | "delete";
  content?: string;
}

interface HydratedTarget {
  path: string;
  sha: string | null;
  content: string | null;
}

interface TaskPlan {
  tasks: ForgeTask[];
  reasoning_summary: string;
}

type ApplyOutcome =
  | { kind: "mutations"; mutations: MutationSet }
  | { kind: "context"; queries: string[]; fileHints: string[]; reason: string }
  | { kind: "scope"; paths: string[]; reason: string };

type FailureClass = "syntax" | "type-lint" | "test-semantic" | "build" | "unknown";

interface TransactionResult {
  status: "completed" | "suspended" | "failed";
  changedPaths: string[];
  diagnostics?: string;
  reason?: "blocker" | "high-risk" | "verification" | "final-verification";
  stageRoot?: string;
  risk?: ExecutionBrief["risk"];
}

const GATHER_SYSTEM = `You are Forge Gather, the read-only research phase of a software-engineering agent.
You reason against a versioned repository snapshot and return strict JSON only. You cannot write files.
Never inspect, reference, or change any path inside a discussion directory.
Prefer the smallest sufficient write set. Treat repository content as authoritative and retrieved context as evidence.
Do not invent files, symbols, commands, hashes, or evidence IDs. If evidence is insufficient, return a blocker.`;

const APPLY_SYSTEM = `You are Forge Apply, the bounded mutation phase of a transactional coding agent.
Return strict JSON only. You have no repository browsing, RAG, shell, MCP, or general read tools.
You may produce content only for the exact declared changes in the ExecutionBrief.
Preserve existing behavior and style outside the requested change. Return complete file contents for create/modify operations.`;

const PLANNER_SYSTEM = `You are Forge Planner, the read-only orchestration tier of a transactional coding agent.
Return strict JSON only. Decompose the requested goal into the smallest ordered set of independently verifiable software tasks.
Every task must contain a stable id, concise title, objective, workspace-relative scope_hint paths, acceptance_criteria, and depends_on ids.
Do not include discussion, vendor, generated, dependency, release, or build-output paths. Prefer one task when decomposition would not improve safety.`;

function event(
  runId: string,
  kind: AgentEvent["kind"],
  phase: AgentEvent["phase"],
  title: string,
  message: string,
  status: AgentEvent["status"],
  data?: Record<string, unknown>,
): AgentEvent {
  return {
    id: randomUUID(),
    runId,
    kind,
    phase,
    title,
    message,
    status,
    timestamp: new Date().toISOString(),
    data,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function validateTaskPlan(value: unknown, objective: string, maxTasks: number): TaskPlan {
  const record = asRecord(value);
  if (!record) throw new Error("The Forge v2 plan must be a JSON object.");
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : null;
  if (!rawTasks?.length) throw new Error("The Forge v2 plan must contain at least one task.");
  if (rawTasks.length > maxTasks) throw new Error(`The Forge v2 plan exceeds the ${maxTasks}-task limit.`);

  const tasks: ForgeTask[] = [];
  const knownIds = new Set<string>();
  for (const [index, rawTask] of rawTasks.entries()) {
    const task = asRecord(rawTask);
    if (!task) throw new Error(`Planner task ${index + 1} must be an object.`);
    const id = typeof task.id === "string" ? task.id.trim() : "";
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || knownIds.has(id)) {
      throw new Error(`Planner task ${index + 1} needs a unique stable id.`);
    }
    const title = typeof task.title === "string" ? task.title.trim().slice(0, 120) : "";
    const taskObjective = typeof task.objective === "string" ? task.objective.trim().slice(0, 4000) : "";
    if (!title || !taskObjective) throw new Error(`Planner task ${id} requires a title and objective.`);
    const acceptanceCriteria = (stringArray(task.acceptance_criteria) || [])
      .map((item) => item.trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 8);
    if (!acceptanceCriteria.length) throw new Error(`Planner task ${id} requires acceptance criteria.`);
    const dependencies = (stringArray(task.depends_on) || []).filter((dependency) => knownIds.has(dependency));
    if ((stringArray(task.depends_on) || []).some((dependency) => !knownIds.has(dependency))) {
      throw new Error(`Planner task ${id} may depend only on an earlier task.`);
    }
    const scopeHints = (stringArray(task.scope_hint) || []).flatMap((candidate) => {
      try {
        return [assertSafeRelativePath(candidate)];
      } catch {
        return [];
      }
    }).slice(0, 16);
    knownIds.add(id);
    tasks.push({
      id,
      title,
      objective: taskObjective,
      scope_hint: scopeHints,
      acceptance_criteria: acceptanceCriteria,
      depends_on: dependencies,
      status: "pending",
      attempts: 0,
    });
  }

  return {
    tasks,
    reasoning_summary: typeof record.reasoning_summary === "string"
      ? record.reasoning_summary.trim().slice(0, 1600)
      : `Plan for ${objective.slice(0, 200)}`,
  };
}

function validateRetrievalPlan(value: unknown, snapshot: WorkspaceSnapshot): RetrievalPlan {
  const record = asRecord(value);
  if (!record) throw new Error("Retrieval plan must be a JSON object.");
  const queries = stringArray(record.queries);
  const fileHints = stringArray(record.file_hints);
  if (!queries?.length || !fileHints) {
    throw new Error("Retrieval plan requires non-empty queries and a file_hints array.");
  }
  const knownPaths = new Set(snapshot.files.map((file) => file.path));
  const safeHints = fileHints
    .map(normalizeRelativePath)
    .filter((filePath) => knownPaths.has(filePath) && !filePath.toLowerCase().split("/").includes("discussion"))
    .slice(0, 12);
  return {
    queries: queries.slice(0, 6),
    file_hints: safeHints,
    reasoning_summary:
      typeof record.reasoning_summary === "string" ? record.reasoning_summary.slice(0, 1200) : "",
  };
}

function validateBrief(
  value: unknown,
  snapshot: WorkspaceSnapshot,
  objective: string,
  availableEvidence: RetrievedEvidence[],
): ExecutionBrief {
  const record = asRecord(value);
  const errors: string[] = [];
  if (!record) throw new Error("ExecutionBrief must be a JSON object.");

  if (record.version !== 1) errors.push("version must equal 1");
  if (record.snapshot_id !== snapshot.id) errors.push(`snapshot_id must equal ${snapshot.id}`);
  if (typeof record.task_id !== "string" || !record.task_id.trim()) errors.push("task_id is required");
  if (typeof record.objective !== "string" || !record.objective.trim()) errors.push("objective is required");

  const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];
  const evidenceIds = new Set(availableEvidence.map((item) => item.id));
  const evidence: ExecutionBrief["evidence"] = [];
  for (const item of rawEvidence) {
    const evidenceRecord = asRecord(item);
    if (!evidenceRecord || typeof evidenceRecord.id !== "string" || !evidenceIds.has(evidenceRecord.id)) {
      errors.push("evidence may only reference supplied evidence IDs");
      continue;
    }
    const source = availableEvidence.find((candidate) => candidate.id === evidenceRecord.id)!;
    evidence.push({
      id: source.id,
      source: "workspace",
      path_or_uri: source.path,
      reason: typeof evidenceRecord.reason === "string" ? evidenceRecord.reason : "Repository evidence",
      sha: source.sha,
      start_line: source.startLine,
      end_line: source.endLine,
      trust: "trusted-workspace",
    });
  }

  const snapshotByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const rawChanges = Array.isArray(record.changes) ? record.changes : [];
  const changes: ExecutionBrief["changes"] = [];
  const changeIds = new Set<string>();
  for (const item of rawChanges) {
    const change = asRecord(item);
    if (!change) {
      errors.push("each change must be an object");
      continue;
    }
    if (typeof change.id !== "string" || !change.id.trim() || changeIds.has(change.id)) {
      errors.push("every change needs a unique id");
      continue;
    }
    changeIds.add(change.id);
    if (typeof change.path !== "string") {
      errors.push(`change ${change.id} needs a path`);
      continue;
    }
    let safePath: string;
    try {
      safePath = assertSafeRelativePath(change.path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `unsafe path for ${change.id}`);
      continue;
    }
    if (!(["create", "modify", "delete"] as unknown[]).includes(change.operation)) {
      errors.push(`change ${change.id} has an invalid operation`);
      continue;
    }
    const operation = change.operation as "create" | "modify" | "delete";
    const existing = snapshotByPath.get(safePath);
    if (operation === "create" && existing) errors.push(`${safePath} already exists and cannot be created`);
    if (operation !== "create" && !existing) errors.push(`${safePath} does not exist in the snapshot`);
    if (operation !== "create" && change.preimage_sha !== existing?.sha) {
      errors.push(`${safePath} preimage_sha must equal ${existing?.sha || "the snapshot hash"}`);
    }
    const referencedEvidence = stringArray(change.evidence_ids) || [];
    if (!referencedEvidence.length || referencedEvidence.some((id) => !evidenceIds.has(id))) {
      errors.push(`change ${change.id} must cite supplied evidence IDs`);
    }
    changes.push({
      id: change.id,
      path: safePath,
      operation,
      intent: typeof change.intent === "string" ? change.intent : "",
      preimage_sha: operation === "create" ? undefined : existing?.sha,
      evidence_ids: referencedEvidence,
      depends_on: stringArray(change.depends_on) || [],
    });
  }

  for (const change of changes) {
    if (change.depends_on.some((dependency) => !changeIds.has(dependency) || dependency === change.id)) {
      errors.push(`change ${change.id} has an invalid dependency`);
    }
  }

  const rawBlockers = Array.isArray(record.blockers) ? record.blockers : [];
  const blockers: ExecutionBrief["blockers"] = rawBlockers.flatMap((item) => {
    const blocker = asRecord(item);
    if (!blocker || typeof blocker.code !== "string" || typeof blocker.message !== "string") return [];
    return [{ code: blocker.code, message: blocker.message, needs: stringArray(blocker.needs) || undefined }];
  });
  if (!changes.length && !blockers.length) errors.push("brief must contain changes or a blocker");

  const validationRecord = asRecord(record.validation);
  const riskRecord = asRecord(record.risk);
  const riskLevel = riskRecord?.level;
  if (!(["low", "medium", "high"] as unknown[]).includes(riskLevel)) errors.push("risk.level is invalid");
  if (!riskRecord || !stringArray(riskRecord.reasons)) errors.push("risk.reasons must be an array");

  if (errors.length) throw new Error(`ExecutionBrief validation failed:\n- ${[...new Set(errors)].join("\n- ")}`);

  return {
    version: 1,
    task_id: String(record.task_id),
    snapshot_id: snapshot.id,
    objective: typeof record.objective === "string" ? record.objective : objective,
    evidence,
    changes,
    invariants: stringArray(record.invariants) || [],
    validation: {
      required_checks: stringArray(validationRecord?.required_checks) || [],
      suggested_commands: stringArray(validationRecord?.suggested_commands) || [],
    },
    blockers,
    risk: {
      level: riskLevel as "low" | "medium" | "high",
      reasons: stringArray(riskRecord?.reasons) || [],
    },
  };
}

function validateMutations(value: unknown, brief: ExecutionBrief): MutationSet {
  const record = asRecord(value);
  const rawMutations = record && Array.isArray(record.mutations) ? record.mutations : null;
  if (!rawMutations) throw new Error("Apply output must contain a mutations array.");
  if (rawMutations.length !== brief.changes.length) {
    throw new Error("Apply must return exactly one mutation for every declared change.");
  }

  const byId = new Map(brief.changes.map((change) => [change.id, change]));
  const seen = new Set<string>();
  const mutations: MutationSet["mutations"] = [];
  for (const item of rawMutations) {
    const mutation = asRecord(item);
    if (!mutation || typeof mutation.change_id !== "string") throw new Error("Mutation change_id is required.");
    const change = byId.get(mutation.change_id);
    if (!change || seen.has(change.id)) throw new Error(`Mutation ${mutation.change_id} is undeclared or duplicated.`);
    seen.add(change.id);
    if (mutation.path !== change.path || mutation.operation !== change.operation) {
      throw new Error(`Mutation ${change.id} does not match its declared path and operation.`);
    }
    if (change.operation !== "delete" && typeof mutation.content !== "string") {
      throw new Error(`Mutation ${change.id} requires complete file content.`);
    }
    mutations.push({
      change_id: change.id,
      path: change.path,
      operation: change.operation,
      content: change.operation === "delete" ? undefined : String(mutation.content),
    });
  }
  return { mutations };
}

function validateApplyOutcome(value: unknown, brief: ExecutionBrief, snapshot: WorkspaceSnapshot): ApplyOutcome {
  const record = asRecord(value);
  if (!record) throw new Error("Apply output must be a JSON object.");
  const status = typeof record.status === "string" ? record.status : Array.isArray(record.mutations) ? "mutations" : "";
  if (status === "mutations") return { kind: "mutations", mutations: validateMutations(record, brief) };
  if (status === "context_request") {
    const queries = (stringArray(record.queries) || []).map((item) => item.trim()).filter(Boolean).slice(0, 4);
    if (!queries.length) throw new Error("A context request needs at least one query.");
    const knownPaths = new Set(snapshot.files.map((file) => file.path));
    const fileHints = (stringArray(record.file_hints) || [])
      .map(normalizeRelativePath)
      .filter((item) => knownPaths.has(item))
      .slice(0, 8);
    return {
      kind: "context",
      queries,
      fileHints,
      reason: typeof record.reason === "string" ? record.reason.slice(0, 1000) : "Apply requested additional read-only context.",
    };
  }
  if (status === "scope_amendment") {
    const paths = (stringArray(record.paths) || []).flatMap((candidate) => {
      try {
        return [assertSafeRelativePath(candidate)];
      } catch {
        return [];
      }
    }).slice(0, 6);
    if (!paths.length) throw new Error("A scope amendment needs at least one safe workspace path.");
    return {
      kind: "scope",
      paths,
      reason: typeof record.reason === "string" ? record.reason.slice(0, 1200) : "Apply requested a larger write set.",
    };
  }
  throw new Error("Apply must return mutations, a context_request, or a scope_amendment.");
}

async function planTasks(
  request: AgentRunRequest,
  snapshot: WorkspaceSnapshot,
  signal: AbortSignal,
  maxTasks: number,
  replanContext?: string,
): Promise<TaskPlan> {
  const schema = `{"tasks":[{"id":"task-1","title":"...","objective":"...","scope_hint":["src/path.ts"],"acceptance_criteria":["..."],"depends_on":[]}],"reasoning_summary":"..."}`;
  const prompt = `Create the Forge v2 execution plan. Return JSON only using this shape:\n${schema}\n\nRules:\n- Use at most ${maxTasks} tasks.\n- Tasks run serially and each must be independently verifiable.\n- Dependencies may reference only earlier task ids.\n- scope_hint contains only safe workspace-relative paths from the map or precise paths expected to be created.\n- Include concrete acceptance criteria.\n\nGOAL\n${request.prompt}\n\n${replanContext ? `REPLAN CONTEXT\n${replanContext.slice(0, 12000)}\n\n` : ""}REPOSITORY MAP\n${repositoryMap(snapshot, 700)}`;
  let raw = await chatWithLocalModel(
    request.provider,
    [{ role: "system", content: PLANNER_SYSTEM }, { role: "user", content: prompt }],
    signal,
  );
  try {
    return validateTaskPlan(parseModelJson(raw), request.prompt, maxTasks);
  } catch (firstError) {
    const diagnostics = firstError instanceof Error ? firstError.message : "Invalid planner response";
    raw = await chatWithLocalModel(
      request.provider,
      [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: prompt },
        { role: "assistant", content: raw },
        { role: "user", content: `The plan was rejected. Correct it once and return only the complete JSON object.\n\nVALIDATION ERRORS\n${diagnostics}` },
      ],
      signal,
    );
    return validateTaskPlan(parseModelJson(raw), request.prompt, maxTasks);
  }
}

function taskRequest(request: AgentRunRequest, task: ForgeTask, guidance?: string): AgentRunRequest {
  const acceptance = task.acceptance_criteria.map((item) => `- ${item}`).join("\n");
  const scope = task.scope_hint.length ? task.scope_hint.join(", ") : "Gather must determine the minimal safe scope";
  return {
    ...request,
    prompt: `OVERALL GOAL\n${request.prompt}\n\nCURRENT FORGE V2 TASK\n${task.title}\n${task.objective}\n\nACCEPTANCE CRITERIA\n${acceptance}\n\nEXPECTED SCOPE\n${scope}${guidance ? `\n\nHUMAN GUIDANCE\n${guidance}` : ""}`,
  };
}

function scopeAmendmentAllowed(task: ForgeTask, requestedPaths: string[]): boolean {
  if (!task.scope_hint.length) return false;
  return requestedPaths.every((requested) => task.scope_hint.some((hint) => {
    const normalizedHint = normalizeRelativePath(hint).replace(/\/$/, "");
    return requested === normalizedHint || requested.startsWith(`${normalizedHint}/`) || normalizedHint.startsWith(`${requested}/`);
  }));
}

async function gatherBrief(
  request: AgentRunRequest,
  snapshot: WorkspaceSnapshot,
  repairDiagnostics: string | undefined,
  signal: AbortSignal,
  runId: string,
  emit: EventSink,
): Promise<{ brief: ExecutionBrief; evidence: RetrievedEvidence[] }> {
  emit(event(runId, "gather.started", "gather", "Gathering repository context", "Planning a focused, read-only search against the current snapshot.", "running"));

  const planRaw = await chatWithLocalModel(
    request.provider,
    [
      { role: "system", content: GATHER_SYSTEM },
      {
        role: "user",
        content: `Create a retrieval plan for this task. Return JSON with keys queries (1-6 strings), file_hints (exact paths from the map), and reasoning_summary.\n\nTASK\n${request.prompt}\n\nSNAPSHOT\n${snapshot.id}\n\nREPOSITORY MAP\n${repositoryMap(snapshot)}`,
      },
    ],
    signal,
  );
  const plan = validateRetrievalPlan(parseModelJson(planRaw), snapshot);
  const evidence = await retrieveEvidence([...plan.queries, request.prompt], plan.file_hints);
  emit(event(
    runId,
    "retrieval.complete",
    "gather",
    "Repository evidence collected",
    `${evidence.length} focused regions across ${new Set(evidence.map((item) => item.path)).size} files.`,
    "success",
    { queries: plan.queries, files: [...new Set(evidence.map((item) => item.path))] },
  ));

  const evidenceText = evidence
    .map((item) => `--- ${item.id} | ${item.path}:${item.startLine}-${item.endLine} | sha:${item.sha}\n${item.content}`)
    .join("\n\n");
  const schema = `{
  "version": 1,
  "task_id": "short-id",
  "snapshot_id": "${snapshot.id}",
  "objective": "...",
  "evidence": [{"id":"supplied-id","reason":"..."}],
  "changes": [{"id":"c1","path":"exact/relative/path","operation":"create|modify|delete","intent":"...","preimage_sha":"required exact snapshot sha except create","evidence_ids":["supplied-id"],"depends_on":[]}],
  "invariants": ["..."],
  "validation": {"required_checks":["..."],"suggested_commands":["..."]},
  "blockers": [],
  "risk": {"level":"low|medium|high","reasons":["..."]}
}`;
  const gatherUserPrompt = `Produce the final ExecutionBrief for the task. Return JSON only and follow this shape exactly:\n${schema}\n\nRules:\n- Use only supplied evidence IDs.\n- Use exact snapshot paths and hashes.\n- Do not target discussion folders.\n- Keep the write set minimal.\n- If blocked, return no changes and at least one blocker.\n- Suggested commands are advisory; trusted infrastructure chooses what runs.\n\nTASK\n${request.prompt}\n\n${repairDiagnostics ? `PREVIOUS VERIFICATION DIAGNOSTICS\n${repairDiagnostics.slice(0, 12000)}\n\n` : ""}REPOSITORY EVIDENCE\n${evidenceText.slice(0, 80_000)}`;

  let briefRaw = await chatWithLocalModel(
    request.provider,
    [{ role: "system", content: GATHER_SYSTEM }, { role: "user", content: gatherUserPrompt }],
    signal,
  );
  let parsed = parseModelJson(briefRaw);
  try {
    const brief = validateBrief(parsed, snapshot, request.prompt, evidence);
    return { brief, evidence };
  } catch (firstError) {
    const validationError = firstError instanceof Error ? firstError.message : "Unknown validation error";
    briefRaw = await chatWithLocalModel(
      request.provider,
      [
        { role: "system", content: GATHER_SYSTEM },
        { role: "user", content: gatherUserPrompt },
        { role: "assistant", content: briefRaw },
        { role: "user", content: `Your brief was rejected. Correct it once and return only the complete JSON object.\n\nVALIDATION ERRORS\n${validationError}` },
      ],
      signal,
    );
    parsed = parseModelJson(briefRaw);
    return { brief: validateBrief(parsed, snapshot, request.prompt, evidence), evidence };
  }
}

async function hydrateTargets(brief: ExecutionBrief): Promise<HydratedTarget[]> {
  const hydrated: HydratedTarget[] = [];
  for (const change of brief.changes) {
    const exists = await fileExistsInWorkspace(change.path);
    if (change.operation === "create") {
      if (exists) throw new Error(`CAS rejected: ${change.path} was created after Gather.`);
      hydrated.push({ path: change.path, sha: null, content: null });
      continue;
    }
    if (!exists) throw new Error(`CAS rejected: ${change.path} no longer exists.`);
    const raw = await readRawWorkspaceFile(change.path);
    const currentSha = sha256(raw);
    if (currentSha !== change.preimage_sha) {
      throw new Error(`CAS rejected: ${change.path} changed after Gather.`);
    }
    hydrated.push({ path: change.path, sha: currentSha, content: raw.toString("utf8") });
  }
  return hydrated;
}

async function applyBrief(
  request: AgentRunRequest,
  brief: ExecutionBrief,
  hydrated: HydratedTarget[],
  signal: AbortSignal,
  snapshot: WorkspaceSnapshot,
  supplementalEvidence = "",
  repairDiagnostics = "",
): Promise<ApplyOutcome> {
  const targets = hydrated
    .map((target) => `--- ${target.path} | sha:${target.sha || "new-file"}\n${target.content ?? "[NEW FILE — NO CURRENT CONTENT]"}`)
    .join("\n\n");
  const raw = await chatWithLocalModel(
    request.provider,
    [
      { role: "system", content: APPLY_SYSTEM },
      {
        role: "user",
        content: `Implement this validated ExecutionBrief. Return exactly one of these JSON objects:\n1. {"status":"mutations","mutations":[{"change_id":"...","path":"...","operation":"create|modify|delete","content":"complete content except for delete"}]}\n2. {"status":"context_request","queries":["..."],"file_hints":["safe/existing/path"],"reason":"..."}\n3. {"status":"scope_amendment","paths":["safe/path"],"reason":"..."}\n\nUse context_request only for missing read-only signatures, definitions, or imports. Use scope_amendment instead of writing an undeclared file. Never return partial mutations.\n\nTASK\n${request.prompt}\n\nEXECUTION BRIEF\n${JSON.stringify(brief, null, 2)}\n\n${repairDiagnostics ? `REPAIR DIAGNOSTICS\n${repairDiagnostics.slice(0, 16000)}\n\n` : ""}${supplementalEvidence ? `APPROVED READ-ONLY CONTEXT\n${supplementalEvidence.slice(0, 30000)}\n\n` : ""}CURRENT DECLARED TARGETS\n${targets.slice(0, 120_000)}`,
      },
    ],
    signal,
  );
  return validateApplyOutcome(parseModelJson(raw), brief, snapshot);
}

async function stageMutations(stageRoot: string, mutations: MutationSet): Promise<StagedMutation[]> {
  const staged: StagedMutation[] = [];
  for (const mutation of mutations.mutations) {
    const safe = assertSafeRelativePath(mutation.path);
    const target = path.resolve(stageRoot, ...safe.split("/"));
    if (!target.startsWith(`${path.resolve(stageRoot)}${path.sep}`)) throw new Error(`Unsafe staged path: ${safe}`);
    if (mutation.operation === "delete") {
      await fs.rm(target, { force: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, mutation.content || "", "utf8");
    }
    staged.push({ path: safe, operation: mutation.operation, content: mutation.content });
  }
  return staged;
}

async function hydrateStageTargets(stageRoot: string, brief: ExecutionBrief): Promise<HydratedTarget[]> {
  const targets: HydratedTarget[] = [];
  for (const change of brief.changes) {
    const safe = assertSafeRelativePath(change.path);
    const absolute = path.resolve(stageRoot, ...safe.split("/"));
    if (!absolute.startsWith(`${path.resolve(stageRoot)}${path.sep}`)) throw new Error(`Unsafe staged path: ${safe}`);
    try {
      const raw = await fs.readFile(absolute);
      targets.push({ path: safe, sha: sha256(raw), content: raw.toString("utf8") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      targets.push({ path: safe, sha: null, content: null });
    }
  }
  return targets;
}

async function validateEvidenceCas(brief: ExecutionBrief): Promise<void> {
  const checked = new Set<string>();
  for (const evidence of brief.evidence) {
    if (evidence.source !== "workspace" || !evidence.sha || checked.has(evidence.path_or_uri)) continue;
    const safe = assertSafeRelativePath(evidence.path_or_uri);
    if (!await fileExistsInWorkspace(safe)) throw new Error(`Evidence CAS failed: ${safe} disappeared.`);
    const currentSha = sha256(await readRawWorkspaceFile(safe));
    if (currentSha !== evidence.sha) throw new Error(`Evidence CAS failed: ${safe} changed after Gather.`);
    checked.add(safe);
  }
}

function classifyVerificationFailure(result: VerificationResult): FailureClass {
  const text = `${result.diagnostics}\n${result.commands.map((item) => item.command).join("\n")}`.toLowerCase();
  if (/invalid json|syntax|parse error/.test(text)) return "syntax";
  if (/typecheck|lint|typescript|eslint/.test(text)) return "type-lint";
  if (/npm run test|test failed|assert/.test(text)) return "test-semantic";
  if (/npm run build|build failed/.test(text)) return "build";
  return "unknown";
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true });
    let output = "";
    let settled = false;
    const append = (chunk: Buffer) => {
      if (output.length < 30_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const finish = (result: { passed: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      child.kill();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new DOMException("Agent run cancelled", "AbortError"));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      child.kill();
      finish({ passed: false, output: `${output}\nCommand timed out after ${timeoutMs / 1000}s.` });
    }, timeoutMs);
    child.on("error", (error) => finish({ passed: false, output: `${output}\n${error.message}` }));
    child.on("close", (code) => finish({ passed: code === 0, output: output.trim() }));
  });
}

async function verifyStage(
  stageRoot: string,
  staged: StagedMutation[],
  signal: AbortSignal,
  runId: string,
  emit: EventSink,
): Promise<VerificationResult> {
  const commandResults: VerificationResult["commands"] = [];
  const diagnostics: string[] = [];

  for (const mutation of staged) {
    if (mutation.operation !== "delete" && mutation.path.endsWith(".json")) {
      try {
        JSON.parse(mutation.content || "");
      } catch (error) {
        diagnostics.push(`${mutation.path}: invalid JSON — ${error instanceof Error ? error.message : "parse error"}`);
      }
    }
  }
  if (diagnostics.length) return { passed: false, diagnostics: diagnostics.join("\n"), commands: [] };

  const packagePath = path.join(stageRoot, "package.json");
  try {
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts || {};
    const checks = ["typecheck", "lint", "test", "build"].filter((name) => Boolean(scripts[name]));
    for (const check of checks) {
      const commandLabel = `npm run ${check}`;
      emit(event(runId, "verification.command", "verify", "Running deterministic check", commandLabel, "running", { command: commandLabel }));
      const windows = os.platform() === "win32";
      const executable = windows ? process.env.ComSpec || "cmd.exe" : "npm";
      const args = windows ? ["/d", "/s", "/c", "npm.cmd", "run", check] : ["run", check];
      const result = await runCommand(executable, args, stageRoot, signal);
      commandResults.push({ command: commandLabel, passed: result.passed, output: result.output });
      if (!result.passed) {
        diagnostics.push(`${commandLabel} failed:\n${result.output}`);
        break;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push(`Could not inspect package.json: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return {
    passed: diagnostics.length === 0,
    diagnostics: diagnostics.join("\n") || "All configured deterministic checks passed.",
    commands: commandResults,
  };
}

interface PromotionJournal {
  version: 1;
  runId: string;
  taskId: string;
  phase: "prepared" | "promoting" | "promoted" | "committed" | "rolled_back";
  entries: Array<{ path: string; existed: boolean }>;
  updatedAt: string;
}

async function writePromotionJournal(transactionRoot: string, journal: PromotionJournal): Promise<void> {
  await fs.mkdir(transactionRoot, { recursive: true });
  const target = path.join(transactionRoot, "transaction.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  journal.updatedAt = new Date().toISOString();
  await fs.writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

async function restorePromotion(transactionRoot: string, journal: PromotionJournal): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    const absolute = absoluteWorkspacePath(entry.path);
    if (!entry.existed) {
      await fs.rm(absolute, { force: true });
      continue;
    }
    const backup = path.join(transactionRoot, "backups", ...entry.path.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.copyFile(backup, absolute);
  }
}

export async function recoverInterruptedPromotions(): Promise<string[]> {
  const root = path.join(workspaceRoot(), ".forge", "transactions");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const recovered: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transactionRoot = path.join(root, entry.name);
    try {
      const journal = JSON.parse(await fs.readFile(path.join(transactionRoot, "transaction.json"), "utf8")) as PromotionJournal;
      if (!["prepared", "promoting"].includes(journal.phase)) continue;
      await restorePromotion(transactionRoot, journal);
      journal.phase = "rolled_back";
      await writePromotionJournal(transactionRoot, journal);
      recovered.push(`${journal.runId}/${journal.taskId}`);
    } catch {
      // Leave an unreadable journal untouched for manual inspection.
    }
  }
  return recovered;
}

async function promote(brief: ExecutionBrief, mutations: MutationSet, runId: string, taskId: string): Promise<string> {
  for (const change of brief.changes) {
    const exists = await fileExistsInWorkspace(change.path);
    if (change.operation === "create") {
      if (exists) throw new Error(`Promotion CAS failed: ${change.path} now exists.`);
    } else {
      if (!exists) throw new Error(`Promotion CAS failed: ${change.path} disappeared.`);
      const currentSha = sha256(await readRawWorkspaceFile(change.path));
      if (currentSha !== change.preimage_sha) throw new Error(`Promotion CAS failed: ${change.path} changed.`);
    }
  }

  const transactionRoot = path.join(workspaceRoot(), ".forge", "transactions", `${runId}-${taskId}-${randomUUID().slice(0, 8)}`);
  const journal: PromotionJournal = {
    version: 1,
    runId,
    taskId,
    phase: "prepared",
    entries: [],
    updatedAt: new Date().toISOString(),
  };
  for (const mutation of mutations.mutations) {
    const absolute = absoluteWorkspacePath(mutation.path);
    const exists = await fileExistsInWorkspace(mutation.path);
    journal.entries.push({ path: mutation.path, existed: exists });
    if (exists) {
      const backup = path.join(transactionRoot, "backups", ...mutation.path.split("/"));
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(absolute, backup);
    }
  }
  await writePromotionJournal(transactionRoot, journal);
  try {
    journal.phase = "promoting";
    await writePromotionJournal(transactionRoot, journal);
    for (const mutation of mutations.mutations) {
      const absolute = absoluteWorkspacePath(mutation.path);
      if (mutation.operation === "delete") {
        await fs.rm(absolute, { force: true });
      } else {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        const temporary = `${absolute}.forge-${randomUUID()}.tmp`;
        await fs.writeFile(temporary, mutation.content || "", "utf8");
        await fs.rename(temporary, absolute);
      }
    }
  } catch (error) {
    await restorePromotion(transactionRoot, journal);
    journal.phase = "rolled_back";
    await writePromotionJournal(transactionRoot, journal);
    throw error;
  }
  journal.phase = "promoted";
  await writePromotionJournal(transactionRoot, journal);
  return transactionRoot;
}

async function commitPromotion(transactionRoot: string): Promise<void> {
  const journal = JSON.parse(await fs.readFile(path.join(transactionRoot, "transaction.json"), "utf8")) as PromotionJournal;
  journal.phase = "committed";
  await writePromotionJournal(transactionRoot, journal);
  await fs.rm(path.join(transactionRoot, "backups"), { recursive: true, force: true });
}

async function appendAudit(runId: string, request: AgentRunRequest, brief: ExecutionBrief, mutations: MutationSet): Promise<void> {
  const auditDir = path.join(workspaceRoot(), ".forge");
  await fs.mkdir(auditDir, { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    run_id: runId,
    provider: request.provider.kind,
    model: request.provider.model,
    task: request.prompt,
    brief,
    mutation_hashes: mutations.mutations.map((mutation) => ({
      path: mutation.path,
      operation: mutation.operation,
      sha: mutation.content === undefined ? null : sha256(mutation.content),
    })),
  };
  await fs.appendFile(path.join(auditDir, "audit.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

async function runTaskTransaction(
  request: AgentRunRequest,
  task: ForgeTask,
  runId: string,
  emit: EventSink,
  signal: AbortSignal,
  maxRepairCycles: number,
  riskApproved: boolean,
  guidance?: string,
): Promise<TransactionResult> {
  let deepDiagnostics = guidance || "";
  let scopeAmendments = 0;
  const maxFastRepairs = Math.max(1, maxRepairCycles);

  deepLoop: for (let deepCycle = 0; deepCycle <= maxRepairCycles; deepCycle += 1) {
    if (signal.aborted) throw new DOMException("Agent run cancelled", "AbortError");
    const snapshot = await createSnapshot();
    emit(event(runId, "snapshot.created", "system", "Workspace snapshot captured", `${snapshot.files.length} files · ${snapshot.id}`, "success", { taskId: task.id, snapshotId: snapshot.id, fileCount: snapshot.files.length }));
    const scopedRequest = taskRequest(request, task, guidance);
    const { brief } = await gatherBrief(scopedRequest, snapshot, deepDiagnostics || undefined, signal, runId, emit);
    if (brief.blockers.length) {
      return { status: "suspended", reason: "blocker", changedPaths: [], diagnostics: brief.blockers.map((blocker) => blocker.message).join("; ") };
    }
    if (brief.risk.level === "high" && !riskApproved) {
      return { status: "suspended", reason: "high-risk", changedPaths: brief.changes.map((change) => change.path), diagnostics: brief.risk.reasons.join("; "), risk: brief.risk };
    }
    emit(event(runId, "brief.validated", "gather", "Execution brief validated", `${brief.changes.length} declared change${brief.changes.length === 1 ? "" : "s"} · ${brief.risk.level} risk`, "success", {
      taskId: task.id,
      changes: brief.changes.map((change) => ({ path: change.path, operation: change.operation })),
      risk: brief.risk,
    }));

    let hydrated = await hydrateTargets(brief);
    emit(event(runId, "hydration.complete", "apply", "Fresh targets hydrated", `${hydrated.length} declared target${hydrated.length === 1 ? "" : "s"} passed target CAS.`, "success", { taskId: task.id }));
    let supplementalEvidence = "";
    let contextRequests = 0;
    let fastRepairs = 0;
    let fastDiagnostics = "";
    let stageRoot: string | undefined;

    while (true) {
      if (signal.aborted) throw new DOMException("Agent run cancelled", "AbortError");
      emit(event(runId, "apply.started", "apply", "Applying bounded changes", "A fresh model request can edit only the validated write set.", "running", { taskId: task.id, fastRepairs, deepCycle }));
      const outcome = await applyBrief(scopedRequest, brief, hydrated, signal, snapshot, supplementalEvidence, fastDiagnostics);
      if (outcome.kind === "context") {
        if (contextRequests >= 2) {
          return { status: "suspended", reason: "blocker", changedPaths: [], diagnostics: "Apply exhausted its bounded read-only context requests." };
        }
        const extra = await retrieveEvidence(outcome.queries, outcome.fileHints, 8, snapshot);
        supplementalEvidence += `\n${extra.map((item) => `--- ${item.id} | ${item.path}:${item.startLine}-${item.endLine} | sha:${item.sha}\n${item.content}`).join("\n\n")}`;
        contextRequests += 1;
        emit(event(runId, "context.requested", "gather", "Bounded context supplied", `${extra.length} read-only evidence regions returned to a fresh Apply request.`, "success", { taskId: task.id, reason: outcome.reason, files: [...new Set(extra.map((item) => item.path))] }));
        continue;
      }
      if (outcome.kind === "scope") {
        if (scopeAmendments >= 1 || !scopeAmendmentAllowed(task, outcome.paths)) {
          if (stageRoot) await removeStage(stageRoot).catch(() => undefined);
          return { status: "suspended", reason: "blocker", changedPaths: outcome.paths, diagnostics: `Scope amendment requires human guidance: ${outcome.reason}` };
        }
        scopeAmendments += 1;
        deepDiagnostics = `Apply requested a validated scope amendment for ${outcome.paths.join(", ")}: ${outcome.reason}. Gather must retrieve evidence and produce a new complete ExecutionBrief before any mutation.`;
        emit(event(runId, "scope.amendment", "gather", "Scope amendment returned to Gather", outcome.reason, "info", { taskId: task.id, paths: outcome.paths }));
        if (stageRoot) await removeStage(stageRoot).catch(() => undefined);
        deepCycle -= 1;
        continue deepLoop;
      }

      const mutations = outcome.mutations;
      stageRoot ??= await cloneWorkspaceToStage(`${runId}-${task.id}`);
      const staged = await stageMutations(stageRoot, mutations);
      emit(event(runId, "mutation.staged", "apply", "Candidate isolated in staging", `${staged.length} file mutation${staged.length === 1 ? "" : "s"}; live files are untouched.`, "success", {
        taskId: task.id,
        files: staged.map((item) => ({ path: item.path, operation: item.operation })),
      }));
      const verification = await verifyStage(stageRoot, staged, signal, runId, emit);
      const failureClass = verification.passed ? undefined : classifyVerificationFailure(verification);
      emit(event(runId, "verification.result", "verify", verification.passed ? "Verification passed" : "Verification found issues", verification.passed ? "All configured checks passed in the isolated workspace." : verification.diagnostics.slice(0, 1000), verification.passed ? "success" : "error", {
        taskId: task.id,
        failureClass,
        commands: verification.commands,
      }));

      if (verification.passed) {
        await validateEvidenceCas(brief);
        const transactionRoot = await promote(brief, mutations, runId, task.id);
        let auditStatus: "recorded" | "degraded" = "recorded";
        try {
          await appendAudit(runId, scopedRequest, brief, mutations);
        } catch (error) {
          auditStatus = "degraded";
          emit(event(runId, "verification.result", "promote", "Audit write degraded", error instanceof Error ? error.message : "The promoted change could not be appended to the audit log.", "error", { taskId: task.id, filesPromoted: true }));
        } finally {
          await commitPromotion(transactionRoot);
        }
        const changedPaths = mutations.mutations.map((mutation) => mutation.path);
        emit(event(runId, "promotion.complete", "promote", "Verified change promoted", "Evidence and target CAS passed; the accepted mutation set is live.", "success", { taskId: task.id, files: changedPaths, auditStatus }));
        await removeStage(stageRoot).catch(() => undefined);
        return { status: "completed", changedPaths };
      }

      const canFastRepair = (failureClass === "syntax" || failureClass === "type-lint") && fastRepairs < maxFastRepairs;
      if (canFastRepair) {
        fastRepairs += 1;
        fastDiagnostics = verification.diagnostics;
        hydrated = await hydrateStageTargets(stageRoot, brief);
        emit(event(runId, "repair.fast", "apply", "Starting fast repair", `A fresh Apply request receives compact ${failureClass} diagnostics without repeating Gather.`, "running", { taskId: task.id, attempt: fastRepairs }));
        continue;
      }
      if (deepCycle < maxRepairCycles) {
        deepDiagnostics = verification.diagnostics;
        emit(event(runId, "repair.deep", "gather", "Starting deep repair", "Verification diagnostics return to a fresh snapshot and Gather cycle.", "running", { taskId: task.id, attempt: deepCycle + 1, failureClass }));
        await removeStage(stageRoot).catch(() => undefined);
        continue deepLoop;
      }
      return { status: "failed", reason: "verification", changedPaths: mutations.mutations.map((mutation) => mutation.path), diagnostics: verification.diagnostics, stageRoot };
    }
  }
  return { status: "failed", reason: "verification", changedPaths: [], diagnostics: "The transaction exhausted its repair budget." };
}

async function finalRunVerification(manifest: ForgeRunManifest, emit: EventSink, signal: AbortSignal): Promise<VerificationResult> {
  emit(event(manifest.runId, "final.verification.started", "verify", "Running aggregate verification", "Checking the combined result of every completed Forge v2 task.", "running"));
  const stageRoot = await cloneWorkspaceToStage(`${manifest.runId}-final`);
  try {
    const result = await verifyStage(stageRoot, [], signal, manifest.runId, emit);
    emit(event(manifest.runId, "final.verification.result", "verify", result.passed ? "Aggregate verification passed" : "Aggregate verification failed", result.passed ? "The combined workspace passed all configured deterministic gates." : result.diagnostics.slice(0, 1200), result.passed ? "success" : "error", {
      commands: result.commands,
      acceptanceCriteria: manifest.tasks.flatMap((task) => task.acceptance_criteria),
    }));
    return result;
  } finally {
    await removeStage(stageRoot).catch(() => undefined);
  }
}

function suspensionActions(reason: NonNullable<TransactionResult["reason"]>): Array<"approve" | "retry" | "discard"> {
  return reason === "high-risk" ? ["approve", "retry", "discard"] : ["retry", "discard"];
}

async function suspendRun(manifest: ForgeRunManifest, task: ForgeTask | undefined, result: TransactionResult, emit: EventSink): Promise<ForgeRunManifest> {
  const reason = result.reason || "verification";
  if (task) task.status = "suspended";
  manifest.status = "suspended";
  manifest.currentTaskId = task?.id;
  manifest.suspension = {
    reason,
    message: result.diagnostics || "Forge paused for a human decision.",
    taskId: task?.id,
    stageRoot: result.stageRoot,
    changedPaths: result.changedPaths,
    diagnostics: result.diagnostics,
    allowedActions: suspensionActions(reason),
  };
  const suspension = manifest.suspension;
  const saved = await saveRunManifest(manifest);
  emit(event(saved.runId, "run.suspended", "human", "Forge v2 suspended", suspension.message, "error", {
    runId: saved.runId,
    taskId: task?.id,
    reason,
    changedPaths: result.changedPaths,
    allowedActions: suspension.allowedActions,
  }));
  return saved;
}

async function executeManifest(manifest: ForgeRunManifest, emit: EventSink, signal: AbortSignal): Promise<ForgeRunManifest> {
  const baseRequest: AgentRunRequest = {
    prompt: manifest.objective,
    provider: manifest.provider,
    maxRepairCycles: manifest.maxRepairCycles,
    maxReplans: manifest.maxReplans,
    maxTasks: manifest.tasks.length || 6,
    architecture: "v2",
  };
  while (true) {
    const task = manifest.tasks.find((candidate) => candidate.status === "pending" || candidate.status === "running");
    if (!task) break;
    task.status = "running";
    task.attempts = (task.attempts || 0) + 1;
    manifest.status = "running";
    manifest.currentTaskId = task.id;
    manifest.suspension = undefined;
    manifest = await saveRunManifest(manifest);
    emit(event(manifest.runId, "task.started", "plan", `Task ${manifest.tasks.indexOf(task) + 1}/${manifest.tasks.length}: ${task.title}`, task.objective, "running", {
      taskId: task.id,
      scopeHint: task.scope_hint,
      acceptanceCriteria: task.acceptance_criteria,
    }));

    let result: TransactionResult;
    try {
      result = await runTaskTransaction(baseRequest, task, manifest.runId, emit, signal, manifest.maxRepairCycles, manifest.approvedRiskTaskIds.includes(task.id), manifest.guidance?.[task.id]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      await removeStagesForRun(`${manifest.runId}-${task.id}`).catch(() => undefined);
      result = { status: "failed", changedPaths: [], diagnostics: error instanceof Error ? error.message : "Unknown transaction error", reason: "verification" };
    }

    if (result.status === "completed") {
      task.status = "completed";
      task.changed_paths = result.changedPaths;
      task.diagnostics = undefined;
      manifest.currentTaskId = undefined;
      manifest = await saveRunManifest(manifest);
      emit(event(manifest.runId, "task.completed", "plan", `${task.title} completed`, `${result.changedPaths.length} path${result.changedPaths.length === 1 ? "" : "s"} accepted.`, "success", { taskId: task.id, changedPaths: result.changedPaths }));
      continue;
    }

    if (result.status === "failed" && manifest.replansUsed < manifest.maxReplans) {
      if (result.stageRoot) await removeStage(result.stageRoot).catch(() => undefined);
      task.status = "failed";
      task.diagnostics = result.diagnostics;
      manifest.replansUsed += 1;
      const snapshot = await createSnapshot();
      const completed = manifest.tasks.filter((candidate) => candidate.status === "completed");
      const plan = await planTasks(baseRequest, snapshot, signal, Math.max(1, Math.min(baseRequest.maxTasks ?? 6, 8)), `Completed tasks:\n${completed.map((item) => `- ${item.title}`).join("\n") || "None"}\n\nFailed task:\n${task.title}\n${result.diagnostics || "Unknown failure"}\n\nCreate only the remaining corrective tasks.`);
      const prefix = `r${manifest.replansUsed}-`;
      const replanned = plan.tasks.map((item) => ({ ...item, id: `${prefix}${item.id}`, depends_on: item.depends_on.map((dependency) => `${prefix}${dependency}`) }));
      manifest.tasks = [...completed, ...replanned];
      manifest.currentTaskId = undefined;
      manifest = await saveRunManifest(manifest);
      emit(event(manifest.runId, "plan.replanned", "plan", "Remaining work replanned", `${replanned.length} corrective task${replanned.length === 1 ? "" : "s"} created from verification diagnostics.`, "info", {
        replan: manifest.replansUsed,
        tasks: replanned.map((item) => ({ id: item.id, title: item.title })),
      }));
      continue;
    }
    return suspendRun(manifest, task, result, emit);
  }

  const aggregate = await finalRunVerification(manifest, emit, signal);
  if (!aggregate.passed) {
    return suspendRun(manifest, undefined, { status: "suspended", reason: "final-verification", changedPaths: manifest.tasks.flatMap((task) => task.changed_paths || []), diagnostics: aggregate.diagnostics }, emit);
  }
  manifest.status = "completed";
  manifest.currentTaskId = undefined;
  manifest.suspension = undefined;
  manifest = await saveRunManifest(manifest);
  const changedPaths = [...new Set(manifest.tasks.flatMap((task) => task.changed_paths || []))];
  emit(event(manifest.runId, "run.completed", "system", "Forge v2 run completed", `${manifest.tasks.length} task${manifest.tasks.length === 1 ? "" : "s"} completed; ${changedPaths.length} workspace path${changedPaths.length === 1 ? "" : "s"} changed.`, "success", { runId: manifest.runId, changedPaths }));
  return manifest;
}

let activeRunId: string | undefined;

export async function runAgentLoopV2(
  request: AgentRunRequest,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  if (activeRunId) throw new Error(`Forge run ${activeRunId} is already active in this workspace.`);
  const runId = randomUUID();
  activeRunId = runId;
  const now = new Date().toISOString();
  let manifest: ForgeRunManifest = {
    version: 2,
    runId,
    objective: request.prompt,
    provider: request.provider,
    status: "planning",
    tasks: [],
    maxRepairCycles: Math.max(0, Math.min(request.maxRepairCycles ?? 1, 2)),
    maxReplans: Math.max(0, Math.min(request.maxReplans ?? 1, 2)),
    replansUsed: 0,
    approvedRiskTaskIds: [],
    createdAt: now,
    updatedAt: now,
  };
  try {
    manifest = await saveRunManifest(manifest);
    emit(event(runId, "run.started", "system", "Forge v2 started", `Using ${request.provider.model} through ${request.provider.kind}; transaction state is persisted.`, "running", { runId, architecture: "v2" }));
    emit(event(runId, "planner.started", "plan", "Planning ordered transactions", "The read-only orchestrator is decomposing the goal into bounded tasks.", "running"));
    const snapshot = await createSnapshot();
    const maxTasks = Math.max(1, Math.min(request.maxTasks ?? 6, 8));
    const plan = await planTasks(request, snapshot, signal, maxTasks);
    manifest.tasks = plan.tasks;
    manifest.status = "running";
    manifest = await saveRunManifest(manifest);
    emit(event(runId, "plan.validated", "plan", "Forge v2 plan validated", `${plan.tasks.length} ordered task${plan.tasks.length === 1 ? "" : "s"} queued.`, "success", {
      runId,
      reasoningSummary: plan.reasoning_summary,
      tasks: plan.tasks.map((task) => ({ id: task.id, title: task.title, scopeHint: task.scope_hint, acceptanceCriteria: task.acceptance_criteria })),
    }));
    await executeManifest(manifest, emit, signal);
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    manifest.status = "failed";
    await removeStagesForRun(runId).catch(() => undefined);
    await saveRunManifest(manifest).catch(() => undefined);
    emit(event(runId, "run.failed", "system", cancelled ? "Forge v2 cancelled" : "Forge v2 stopped safely", cancelled ? "The active local-model request or verification command was cancelled." : error instanceof Error ? error.message : "Unknown agent error", "error", { runId }));
  } finally {
    activeRunId = undefined;
  }
}

export async function runAgentLoop(
  request: AgentRunRequest,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  const runId = randomUUID();
  const maxRepairCycles = Math.max(0, Math.min(request.maxRepairCycles ?? 1, 2));
  let repairDiagnostics: string | undefined;
  emit(event(runId, "run.started", "system", "Agent loop started", `Using ${request.provider.model} through ${request.provider.kind}.`, "running"));

  try {
    for (let cycle = 0; cycle <= maxRepairCycles; cycle += 1) {
      if (signal.aborted) throw new DOMException("Agent run cancelled", "AbortError");
      const snapshot = await createSnapshot();
      emit(event(runId, "snapshot.created", "system", "Workspace snapshot captured", `${snapshot.files.length} files · ${snapshot.id}`, "success", { snapshotId: snapshot.id, fileCount: snapshot.files.length }));

      const { brief } = await gatherBrief(request, snapshot, repairDiagnostics, signal, runId, emit);
      if (brief.blockers.length) {
        throw new Error(`Gather stopped safely: ${brief.blockers.map((blocker) => blocker.message).join("; ")}`);
      }
      if (brief.risk.level === "high") {
        throw new Error(`High-risk plan requires human approval: ${brief.risk.reasons.join("; ")}`);
      }
      emit(event(runId, "brief.validated", "gather", "Execution brief validated", `${brief.changes.length} declared change${brief.changes.length === 1 ? "" : "s"} · ${brief.risk.level} risk`, "success", {
        changes: brief.changes.map((change) => ({ path: change.path, operation: change.operation })),
        risk: brief.risk,
      }));

      const hydrated = await hydrateTargets(brief);
      emit(event(runId, "hydration.complete", "apply", "Fresh targets hydrated", `${hydrated.length} declared target${hydrated.length === 1 ? "" : "s"} passed the pre-Apply CAS gate.`, "success"));
      emit(event(runId, "apply.started", "apply", "Applying bounded changes", "A fresh model context can edit only the declared targets.", "running"));
      const applyOutcome = await applyBrief(request, brief, hydrated, signal, snapshot);
      if (applyOutcome.kind !== "mutations") throw new Error("Legacy Forge runs do not support Apply context or scope requests.");
      const mutations = applyOutcome.mutations;

      const stageRoot = await cloneWorkspaceToStage(runId);
      try {
        const staged = await stageMutations(stageRoot, mutations);
        emit(event(runId, "mutation.staged", "apply", "Candidate isolated in staging", `${staged.length} file mutation${staged.length === 1 ? "" : "s"}; live files are untouched.`, "success", {
          files: staged.map((item) => ({ path: item.path, operation: item.operation })),
        }));
        const verification = await verifyStage(stageRoot, staged, signal, runId, emit);
        emit(event(
          runId,
          "verification.result",
          "verify",
          verification.passed ? "Verification passed" : "Verification found issues",
          verification.passed ? "All configured checks passed in the isolated workspace." : verification.diagnostics.slice(0, 1000),
          verification.passed ? "success" : "error",
          { commands: verification.commands },
        ));

        if (!verification.passed) {
          if (cycle < maxRepairCycles) {
            repairDiagnostics = verification.diagnostics;
            emit(event(runId, "repair.started", "gather", "Starting bounded repair cycle", `Returning structured diagnostics to Gather (${cycle + 1}/${maxRepairCycles}).`, "running"));
            continue;
          }
          throw new Error(`Verification failed after ${cycle + 1} attempt${cycle === 0 ? "" : "s"}: ${verification.diagnostics.slice(0, 2000)}`);
        }

        const transactionRoot = await promote(brief, mutations, runId, "legacy");
        await appendAudit(runId, request, brief, mutations);
        await commitPromotion(transactionRoot);
        emit(event(runId, "promotion.complete", "promote", "Verified change promoted", "Final CAS passed; the live workspace now contains the accepted mutation set.", "success", {
          files: mutations.mutations.map((mutation) => mutation.path),
        }));
        emit(event(runId, "run.completed", "system", "Task completed", `Changed ${mutations.mutations.length} file${mutations.mutations.length === 1 ? "" : "s"} safely.`, "success"));
        return;
      } finally {
        await removeStage(stageRoot).catch(() => undefined);
      }
    }
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    emit(event(
      runId,
      "run.failed",
      "system",
      cancelled ? "Agent run cancelled" : "Agent stopped safely",
      cancelled ? "The active local-model request was cancelled." : error instanceof Error ? error.message : "Unknown agent error",
      "error",
    ));
  }
}

export async function resumeAgentLoop(
  decision: AgentDecisionRequest,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  if (activeRunId) throw new Error(`Forge run ${activeRunId} is already active in this workspace.`);
  let manifest = await readRunManifest(decision.runId);
  if (manifest.status !== "suspended" || !manifest.suspension) throw new Error("Only a suspended Forge v2 run can be resumed or discarded.");
  if (!manifest.suspension.allowedActions.includes(decision.decision)) throw new Error(`Decision ${decision.decision} is not valid for this suspension.`);
  activeRunId = manifest.runId;
  try {
    if (decision.decision === "discard") {
      if (manifest.suspension.stageRoot) await removeStage(manifest.suspension.stageRoot).catch(() => undefined);
      const task = manifest.tasks.find((item) => item.id === manifest.currentTaskId);
      if (task) task.status = "abandoned";
      manifest.status = "discarded";
      manifest.suspension = undefined;
      manifest = await saveRunManifest(manifest);
      emit(event(manifest.runId, "run.discarded", "human", "Suspended run discarded", "Retained staging data was removed; completed transactions remain in the workspace.", "info", { runId: manifest.runId }));
      return;
    }

    if (manifest.suspension.stageRoot) await removeStage(manifest.suspension.stageRoot).catch(() => undefined);
    const task = manifest.tasks.find((item) => item.id === manifest.currentTaskId);
    if (decision.decision === "approve") {
      if (!task || manifest.suspension.reason !== "high-risk") throw new Error("Approval is available only for a high-risk task.");
      manifest.approvedRiskTaskIds = [...new Set([...manifest.approvedRiskTaskIds, task.id])];
    }
    if (decision.decision === "retry") {
      const guidance = decision.guidance?.trim() || manifest.suspension.diagnostics || "Retry from a fresh snapshot and address the prior diagnostics.";
      if (task) {
        manifest.guidance = { ...(manifest.guidance || {}), [task.id]: guidance.slice(0, 8000) };
      } else {
        const id = `final-repair-${manifest.tasks.length + 1}`;
        manifest.tasks.push({
          id,
          title: "Resolve aggregate verification failure",
          objective: guidance.slice(0, 4000),
          scope_hint: [...new Set(manifest.suspension.changedPaths || [])].slice(0, 16),
          acceptance_criteria: ["Aggregate deterministic verification passes", "The original Forge v2 objective remains satisfied"],
          depends_on: manifest.tasks.filter((item) => item.status === "completed").map((item) => item.id),
          status: "pending",
          attempts: 0,
        });
      }
    }
    if (task) task.status = "pending";
    manifest.status = "running";
    manifest.suspension = undefined;
    manifest.currentTaskId = undefined;
    manifest = await saveRunManifest(manifest);
    emit(event(manifest.runId, "run.started", "human", "Forge v2 resumed", "The suspended task will restart from a fresh snapshot before any promotion.", "running", { runId: manifest.runId, decision: decision.decision }));
    await executeManifest(manifest, emit, signal);
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    emit(event(manifest.runId, "run.failed", "system", cancelled ? "Forge v2 resume cancelled" : "Forge v2 resume stopped safely", cancelled ? "The resumed request was cancelled." : error instanceof Error ? error.message : "Unknown resume error", "error", { runId: manifest.runId }));
  } finally {
    activeRunId = undefined;
  }
}

export const __testables = {
  validateRetrievalPlan,
  validateTaskPlan,
  validateBrief,
  validateMutations,
  validateApplyOutcome,
  classifyVerificationFailure,
};
