import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  AgentRunRequest,
  ExecutionBrief,
  MutationSet,
} from "../shared/types.js";
import { chatWithLocalModel, parseModelJson } from "./providers.js";
import {
  absoluteWorkspacePath,
  assertSafeRelativePath,
  cloneWorkspaceToStage,
  createSnapshot,
  fileExistsInWorkspace,
  normalizeRelativePath,
  readRawWorkspaceFile,
  removeStage,
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

const GATHER_SYSTEM = `You are Forge Gather, the read-only research phase of a software-engineering agent.
You reason against a versioned repository snapshot and return strict JSON only. You cannot write files.
Never inspect, reference, or change any path inside a discussion directory.
Prefer the smallest sufficient write set. Treat repository content as authoritative and retrieved context as evidence.
Do not invent files, symbols, commands, hashes, or evidence IDs. If evidence is insufficient, return a blocker.`;

const APPLY_SYSTEM = `You are Forge Apply, the bounded mutation phase of a transactional coding agent.
Return strict JSON only. You have no repository browsing, RAG, shell, MCP, or general read tools.
You may produce content only for the exact declared changes in the ExecutionBrief.
Preserve existing behavior and style outside the requested change. Return complete file contents for create/modify operations.`;

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

async function hydrateTargets(brief: ExecutionBrief): Promise<Array<{ path: string; sha: string | null; content: string | null }>> {
  const hydrated: Array<{ path: string; sha: string | null; content: string | null }> = [];
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
  hydrated: Array<{ path: string; sha: string | null; content: string | null }>,
  signal: AbortSignal,
): Promise<MutationSet> {
  const targets = hydrated
    .map((target) => `--- ${target.path} | sha:${target.sha || "new-file"}\n${target.content ?? "[NEW FILE — NO CURRENT CONTENT]"}`)
    .join("\n\n");
  const raw = await chatWithLocalModel(
    request.provider,
    [
      { role: "system", content: APPLY_SYSTEM },
      {
        role: "user",
        content: `Implement this validated ExecutionBrief. Return {"mutations":[{"change_id":"...","path":"...","operation":"create|modify|delete","content":"complete content except for delete"}]}.\n\nTASK\n${request.prompt}\n\nEXECUTION BRIEF\n${JSON.stringify(brief, null, 2)}\n\nCURRENT DECLARED TARGETS\n${targets.slice(0, 120_000)}`,
      },
    ],
    signal,
  );
  return validateMutations(parseModelJson(raw), brief);
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
      const executable = os.platform() === "win32" ? "npm.cmd" : "npm";
      const commandLabel = `npm run ${check}`;
      emit(event(runId, "verification.command", "verify", "Running deterministic check", commandLabel, "running", { command: commandLabel }));
      const result = await runCommand(executable, ["run", check], stageRoot, signal);
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

async function promote(brief: ExecutionBrief, mutations: MutationSet): Promise<void> {
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

  const backups = new Map<string, Buffer | null>();
  try {
    for (const mutation of mutations.mutations) {
      const absolute = absoluteWorkspacePath(mutation.path);
      const exists = await fileExistsInWorkspace(mutation.path);
      backups.set(mutation.path, exists ? await fs.readFile(absolute) : null);
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
    for (const [relativePath, backup] of backups) {
      const absolute = absoluteWorkspacePath(relativePath);
      if (backup === null) await fs.rm(absolute, { force: true });
      else {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, backup);
      }
    }
    throw error;
  }
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
      const mutations = await applyBrief(request, brief, hydrated, signal);

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

        await promote(brief, mutations);
        await appendAudit(runId, request, brief, mutations);
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

export const __testables = {
  validateRetrievalPlan,
  validateBrief,
  validateMutations,
};
