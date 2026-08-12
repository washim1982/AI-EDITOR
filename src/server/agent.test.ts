import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { __testables } from "./agent.js";
import { assertSafeRelativePath, createSnapshot, setWorkspaceRoot, workspaceRoot } from "./workspace.js";
import type { ExecutionBrief } from "../shared/types.js";

test("workspace paths reject traversal and discussion content", () => {
  assert.equal(assertSafeRelativePath("src/client/App.tsx"), "src/client/App.tsx");
  assert.throws(() => assertSafeRelativePath("../outside.txt"), /outside|escapes/i);
  assert.throws(() => assertSafeRelativePath("discussion/notes.md"), /outside|scope/i);
  assert.throws(() => assertSafeRelativePath("src/discussion/notes.md"), /outside|scope/i);
  assert.throws(() => assertSafeRelativePath("vendor/code-oss/product.json"), /outside|scope/i);
  assert.throws(() => assertSafeRelativePath("release/application.exe"), /outside|scope/i);
});

test("Apply output must match the declared write set exactly", () => {
  const brief: ExecutionBrief = {
    version: 1,
    task_id: "task",
    snapshot_id: "snap",
    objective: "Change one file",
    evidence: [],
    changes: [{
      id: "c1",
      path: "src/example.ts",
      operation: "modify",
      intent: "Update behavior",
      preimage_sha: "abc",
      evidence_ids: ["ev1"],
      depends_on: [],
    }],
    invariants: [],
    validation: { required_checks: [], suggested_commands: [] },
    blockers: [],
    risk: { level: "low", reasons: [] },
  };

  const accepted = __testables.validateMutations({
    mutations: [{ change_id: "c1", path: "src/example.ts", operation: "modify", content: "export {};" }],
  }, brief);
  assert.equal(accepted.mutations[0].path, "src/example.ts");

  assert.throws(() => __testables.validateMutations({
    mutations: [{ change_id: "c1", path: "src/other.ts", operation: "modify", content: "" }],
  }, brief), /declared path/i);
});

test("Forge v2 planner accepts only bounded ordered tasks", () => {
  const plan = __testables.validateTaskPlan({
    tasks: [
      {
        id: "foundation",
        title: "Update foundation",
        objective: "Change the shared contract",
        scope_hint: ["src/shared/types.ts"],
        acceptance_criteria: ["The contract typechecks"],
        depends_on: [],
      },
      {
        id: "client",
        title: "Update client",
        objective: "Consume the shared contract",
        scope_hint: ["src/client/App.tsx"],
        acceptance_criteria: ["The client builds"],
        depends_on: ["foundation"],
      },
    ],
  }, "Implement Forge v2", 4);
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks[1].depends_on, ["foundation"]);

  assert.throws(() => __testables.validateTaskPlan({
    tasks: [{ id: "bad", title: "Bad", objective: "Bad dependency", scope_hint: ["src"], acceptance_criteria: ["Done"], depends_on: ["future"] }],
  }, "Bad plan", 4), /earlier task/i);
});

test("Forge v2 Apply requests cannot silently widen the write set", () => {
  const brief: ExecutionBrief = {
    version: 1,
    task_id: "task",
    snapshot_id: "snap",
    objective: "Change one file",
    evidence: [],
    changes: [{ id: "c1", path: "src/example.ts", operation: "modify", intent: "Update", preimage_sha: "abc", evidence_ids: ["ev1"], depends_on: [] }],
    invariants: [],
    validation: { required_checks: [], suggested_commands: [] },
    blockers: [],
    risk: { level: "low", reasons: [] },
  };
  const snapshot = { id: "snap", createdAt: new Date(0).toISOString(), files: [{ path: "src/example.ts", sha: "abc", size: 1 }] };
  const context = __testables.validateApplyOutcome({ status: "context_request", queries: ["Example signature"], file_hints: ["src/example.ts"] }, brief, snapshot);
  assert.equal(context.kind, "context");
  const amendment = __testables.validateApplyOutcome({ status: "scope_amendment", paths: ["src/helper.ts"], reason: "Helper is required" }, brief, snapshot);
  assert.equal(amendment.kind, "scope");
  assert.throws(() => __testables.validateApplyOutcome({ status: "mutations", mutations: [{ change_id: "c1", path: "src/other.ts", operation: "modify", content: "" }] }, brief, snapshot), /declared path/i);
});

test("Forge v2 classifies deterministic verification failures", () => {
  assert.equal(__testables.classifyVerificationFailure({ passed: false, diagnostics: "npm run typecheck failed", commands: [] }), "type-lint");
  assert.equal(__testables.classifyVerificationFailure({ passed: false, diagnostics: "npm run test failed", commands: [] }), "test-semantic");
  assert.equal(__testables.classifyVerificationFailure({ passed: false, diagnostics: "invalid JSON", commands: [] }), "syntax");
});

test("empty workspaces provide derived evidence for create-only briefs", () => {
  const snapshot = { id: "snap_empty", createdAt: new Date(0).toISOString(), files: [] };
  const evidence = __testables.createEmptyWorkspaceEvidence("Create a web application", snapshot);
  const brief = __testables.validateBrief({
    version: 1,
    task_id: "bootstrap",
    snapshot_id: snapshot.id,
    objective: "Create a web application",
    evidence: [],
    changes: [{
      id: "c1",
      path: "package.json",
      operation: "create",
      intent: "Create the project manifest",
      evidence_ids: [],
      depends_on: [],
    }],
    invariants: ["Create files only inside the selected workspace"],
    validation: { required_checks: [], suggested_commands: [] },
    blockers: [],
    risk: { level: "low", reasons: [] },
  }, snapshot, "Create a web application", [evidence]);

  assert.equal(brief.evidence[0].source, "artifact");
  assert.equal(brief.evidence[0].path_or_uri, "forge://empty-workspace");
  assert.equal(brief.changes[0].operation, "create");
  assert.deepEqual(brief.changes[0].evidence_ids, [evidence.id]);
});

test("new projects defer package gates until dependencies are installed", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-bootstrap-verification-"));
  const packageContent = JSON.stringify({
    scripts: { build: "vite build" },
    dependencies: { vite: "^6.0.0" },
  });
  try {
    await fs.writeFile(path.join(fixtureRoot, "package.json"), packageContent, "utf8");
    const result = await __testables.verifyStage(
      fixtureRoot,
      [{ path: "package.json", operation: "create", content: packageContent }],
      new AbortController().signal,
      "run",
      () => undefined,
    );
    assert.equal(result.passed, true);
    assert.deepEqual(result.deferredChecks, ["npm run build"]);
    assert.match(result.diagnostics, /npm install/i);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("workspace snapshots exclude generated, vendored, and discussion trees", async () => {
  const originalRoot = workspaceRoot();
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-snapshot-test-"));
  try {
    await Promise.all([
      fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true }),
      fs.mkdir(path.join(fixtureRoot, "vendor", "runtime", "data"), { recursive: true }),
      fs.mkdir(path.join(fixtureRoot, "release"), { recursive: true }),
      fs.mkdir(path.join(fixtureRoot, "discussion"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(fixtureRoot, "src", "index.ts"), "export const ok = true;", "utf8"),
      fs.writeFile(path.join(fixtureRoot, "vendor", "runtime", "data", "Cookies"), "locked profile", "utf8"),
      fs.writeFile(path.join(fixtureRoot, "release", "artifact.txt"), "generated", "utf8"),
      fs.writeFile(path.join(fixtureRoot, "discussion", "notes.md"), "excluded", "utf8"),
    ]);
    await setWorkspaceRoot(fixtureRoot);
    const snapshot = await createSnapshot();
    assert.deepEqual(snapshot.files.map((file) => file.path), ["src/index.ts"]);
  } finally {
    await setWorkspaceRoot(originalRoot);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
