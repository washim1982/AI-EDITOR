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
