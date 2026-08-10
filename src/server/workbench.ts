import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ProjectCheckResult,
  ProjectScripts,
  WorkspaceSearchResult,
  WorkspaceStatus,
} from "../shared/types.js";
import { absoluteWorkspacePath, createSnapshot, workspaceRoot } from "./workspace.js";

const TRUSTED_CHECKS = ["typecheck", "lint", "test", "build"] as const;

function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot(),
      env: process.env,
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const append = (chunk: Buffer) => {
      if (output.length < 60_000) output += chunk.toString("utf8");
    };
    const finish = (code: number | null, suffix = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ code, output: `${output}${suffix}`.trim() });
    };
    const abort = () => {
      child.kill();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new DOMException("Workbench command cancelled", "AbortError"));
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => finish(null, `\n${error.message}`));
    child.once("close", (code) => finish(code));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `\nCommand timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }, timeoutMs);
  });
}

export async function searchWorkspace(query: string, limit = 80): Promise<WorkspaceSearchResult[]> {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return [];
  const snapshot = await createSnapshot();
  const results: WorkspaceSearchResult[] = [];
  for (const file of snapshot.files) {
    if (file.size > 800_000) continue;
    if (file.path.toLowerCase().includes(normalized)) {
      results.push({ path: file.path, line: 1, preview: file.path });
    }
    if (results.length >= limit) break;
    let content: string;
    try {
      content = await fs.readFile(absoluteWorkspacePath(file.path), "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(normalized)) continue;
      results.push({
        path: file.path,
        line: index + 1,
        preview: lines[index].trim().slice(0, 240),
      });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }
  return results;
}

export async function readWorkspaceStatus(): Promise<WorkspaceStatus> {
  const result = await runProcess("git", ["status", "--short", "--branch"], undefined, 10_000);
  if (result.code !== 0) {
    const notRepository = /not a git repository/i.test(result.output);
    return {
      isRepository: false,
      branch: "",
      changes: [],
      error: notRepository ? undefined : result.output || "Git is unavailable.",
    };
  }
  const lines = result.output.split(/\r?\n/).filter((line) => line && !/^warning:/i.test(line));
  const branchIndex = lines.findIndex((line) => line.startsWith("##"));
  const branchLine = branchIndex >= 0 ? lines.splice(branchIndex, 1)[0] : "";
  const branch = branchLine.replace(/^##\s*/, "").split(/[.\s]/)[0] || "detached";
  return {
    isRepository: true,
    branch,
    changes: lines.map((line) => ({
      status: line.slice(0, 2).trim() || "?",
      path: line.slice(3).trim(),
    })).filter((item) => item.path),
  };
}

export async function readProjectScripts(): Promise<ProjectScripts> {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(workspaceRoot(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return { checks: TRUSTED_CHECKS.filter((name) => Boolean(packageJson.scripts?.[name])) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { checks: [] };
    throw error;
  }
}

export async function runProjectCheck(name: string, signal?: AbortSignal): Promise<ProjectCheckResult> {
  const scripts = await readProjectScripts();
  if (!TRUSTED_CHECKS.includes(name as typeof TRUSTED_CHECKS[number]) || !scripts.checks.includes(name)) {
    throw new Error("Only configured typecheck, lint, test, and build scripts can run from this panel.");
  }
  const windows = os.platform() === "win32";
  const executable = windows ? process.env.ComSpec || "cmd.exe" : "npm";
  const args = windows ? ["/d", "/s", "/c", "npm.cmd", "run", name] : ["run", name];
  const result = await runProcess(executable, args, signal);
  return {
    name,
    command: `npm run ${name}`,
    passed: result.code === 0,
    output: result.output,
  };
}
