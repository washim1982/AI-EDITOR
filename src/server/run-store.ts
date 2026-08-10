import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ForgeRunManifest } from "../shared/types.js";
import { workspaceRoot } from "./workspace.js";

const RUN_ID = /^[a-zA-Z0-9_-]{8,100}$/;

function assertRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error("Invalid Forge run identifier.");
  return runId;
}

function runsRoot(): string {
  return path.join(workspaceRoot(), ".forge", "runs");
}

function manifestPath(runId: string): string {
  return path.join(runsRoot(), `${assertRunId(runId)}.json`);
}

export async function saveRunManifest(manifest: ForgeRunManifest): Promise<ForgeRunManifest> {
  const updated: ForgeRunManifest = { ...manifest, updatedAt: new Date().toISOString() };
  const target = manifestPath(updated.runId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
  return updated;
}

export async function readRunManifest(runId: string): Promise<ForgeRunManifest> {
  const raw = await fs.readFile(manifestPath(runId), "utf8");
  const manifest = JSON.parse(raw) as ForgeRunManifest;
  if (manifest.version !== 2 || manifest.runId !== runId) throw new Error("The Forge run manifest is invalid.");
  return manifest;
}

export async function listRunManifests(limit = 30): Promise<ForgeRunManifest[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const manifests: ForgeRunManifest[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).slice(0, 200)) {
    try {
      const runId = name.slice(0, -5);
      manifests.push(await readRunManifest(runId));
    } catch {
      // Ignore incomplete manifests; a later run can safely overwrite only its own file.
    }
  }
  return manifests
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

export async function recoverInterruptedRuns(): Promise<string[]> {
  const manifests = await listRunManifests(100);
  const recovered: string[] = [];
  for (const manifest of manifests) {
    if (manifest.status === "planning") {
      manifest.status = "failed";
      await saveRunManifest(manifest);
      recovered.push(manifest.runId);
      continue;
    }
    if (manifest.status !== "running") continue;
    const task = manifest.tasks.find((item) => item.id === manifest.currentTaskId)
      || manifest.tasks.find((item) => item.status === "running");
    if (!task) {
      manifest.status = "failed";
      await saveRunManifest(manifest);
      recovered.push(manifest.runId);
      continue;
    }
    task.status = "suspended";
    manifest.currentTaskId = task.id;
    manifest.status = "suspended";
    manifest.suspension = {
      reason: "verification",
      message: "The previous Forge process stopped before this task completed. Retry restarts it from a fresh snapshot.",
      taskId: task.id,
      changedPaths: task.changed_paths || [],
      diagnostics: "Interrupted local process; no retained candidate will be promoted.",
      allowedActions: ["retry", "discard"],
    };
    await saveRunManifest(manifest);
    recovered.push(manifest.runId);
  }
  return recovered;
}
