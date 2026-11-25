import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redactKey } from "./config.mjs";
import { removeLeaseFile } from "./heartbeat.mjs";

const TARGET_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

export function normalizeRepoPath(filePath) {
  if (typeof filePath !== "string") return "";
  let p = filePath.trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    p = p.slice(1, -1);
  }
  p = p.replace(/\\/g, "/");
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  return p;
}

export function scrubDeskKeyEnv(baseEnv = process.env) {
  const clean = { ...baseEnv };
  delete clean.SWARMDESK_KEY;
  return clean;
}

export function parseGitStatusPorcelain(output) {
  if (typeof output !== "string" || !output) return [];
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  const entries = [];
  for (const line of lines) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const rawPath = line.slice(3);
    const isRename = status.includes("R") || status.includes("C");
    const filePath = isRename && rawPath.includes(" -> ")
      ? normalizeRepoPath(rawPath.split(" -> ").pop())
      : normalizeRepoPath(rawPath);
    entries.push({ status, path: filePath, isRename });
  }
  return entries;
}

/**
 * Pure validator verifying git working tree contains ONLY the single modified `expectedFile`.
 */
export function validateSingleChangedFile(
  porcelainOutput,
  expectedFile,
  { ignoreFiles = [] } = {},
) {
  const expected = normalizeRepoPath(expectedFile);
  if (!expected || expected.startsWith("/") || expected.split("/").includes("..")) {
    return { ok: false, error: `Invalid expected step file path: "${expectedFile}"`, files: [] };
  }

  const ignored = new Set(ignoreFiles.map(normalizeRepoPath));
  const entries = parseGitStatusPorcelain(porcelainOutput).filter((e) => !ignored.has(e.path));

  if (entries.length === 0) {
    return {
      ok: false,
      error: `No modified files found; expected modification to ${expected}.`,
      files: [],
    };
  }
  if (entries.length > 1) {
    const listed = entries.map((e) => `${e.status.trim() || "?"}:${e.path}`).join(", ");
    return {
      ok: false,
      error: `Working tree must modify ONLY ${expected}; found ${entries.length} entries (${listed}).`,
      files: entries,
    };
  }

  const [only] = entries;
  if (only.isRename) {
    return {
      ok: false,
      error: `Renames/copies are not permitted; expected only ${expected} to be modified.`,
      files: entries,
    };
  }
  if (only.status.includes("U") || only.status === "AA" || only.status === "DD") {
    return {
      ok: false,
      error: `Unmerged conflict state on ${only.path}.`,
      files: entries,
    };
  }
  if (only.status.includes("D")) {
    return {
      ok: false,
      error: `File deletion is not permitted (${only.path}); expected modified ${expected}.`,
      files: entries,
    };
  }
  if (only.path !== expected) {
    return {
      ok: false,
      error: `Expected only ${expected} to be modified, found ${only.path}.`,
      files: entries,
    };
  }

  return { ok: true, file: expected, status: only.status, files: entries };
}

export function assertSingleChangedFile(porcelainOutput, expectedFile, opts) {
  const result = validateSingleChangedFile(porcelainOutput, expectedFile, opts);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result;
}

export function runExecFile(cmd, args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, env: scrubDeskKeyEnv(env), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({
          code,
          stdout: redactKey(stdout || ""),
          stderr: redactKey(stderr || (err && !stdout && !stderr ? err.message : "")),
        });
      },
    );
  });
}

async function execOrThrow(execFn, cmd, args, opts) {
  const res = await execFn(cmd, args, opts);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(
      redactKey(`${cmd} ${args.join(" ")} failed (exit ${res.code})${detail ? `: ${detail}` : ""}`),
    );
  }
  return res;
}

export async function runCheck({
  cwd = process.cwd(),
  target,
  execFn = runExecFile,
  env = process.env,
} = {}) {
  if (typeof target !== "string" || !TARGET_RE.test(target)) {
    throw new Error(`Invalid check target "${redactKey(String(target ?? ""))}".`);
  }
  const scriptPath = path.resolve(cwd, "scripts", "check.sh");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`scripts/check.sh not found in ${cwd}.`);
  }
  const res = await execFn("bash", ["scripts/check.sh", target], {
    cwd,
    env: scrubDeskKeyEnv(env),
  });
  return {
    ok: res.code === 0,
    code: res.code,
    target,
    stdout: redactKey(res.stdout),
    stderr: redactKey(res.stderr),
  };
}

export async function submitStep({
  cwd = process.cwd(),
  step,
  leaseId,
  client,
  leaseFile = null,
  dryRun = false,
  execFn = runExecFile,
  env = process.env,
} = {}) {
  if (!step || !Number.isInteger(Number(step.id)) || Number(step.id) <= 0) {
    throw new Error("submitStep requires a valid step.id.");
  }
  if (!step.file || typeof step.file !== "string") {
    throw new Error("submitStep requires step.file.");
  }
  if (!step.target || !TARGET_RE.test(step.target)) {
    throw new Error("submitStep requires a valid step.target.");
  }
  if (!dryRun && (!step.repo || !REPO_RE.test(step.repo))) {
    throw new Error(`Invalid repository slug "${redactKey(String(step.repo ?? ""))}".`);
  }
  if (!dryRun && (!client || typeof client.release !== "function")) {
    throw new Error("submitStep requires an API client.");
  }

  const stepId = Number(step.id);
  const branch = `step-${stepId}`;
  const commitMessage = `step-${stepId}`;
  const cleanEnv = scrubDeskKeyEnv(env);

  const statusRes = await execOrThrow(execFn, "git", ["status", "--porcelain", "-uall"], {
    cwd,
    env: cleanEnv,
  });
  assertSingleChangedFile(statusRes.stdout, step.file, {
    ignoreFiles: [".swarmdesk-lease.json"],
  });

  const checkRes = await runCheck({ cwd, target: step.target, execFn, env: cleanEnv });
  if (!checkRes.ok) {
    const detail = (checkRes.stderr || checkRes.stdout).trim();
    throw new Error(`scripts/check.sh ${step.target} failed: ${detail}`);
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      branch,
      commitMessage,
      file: normalizeRepoPath(step.file),
      target: step.target,
      check: checkRes,
    };
  }

  const curBranchRes = await execOrThrow(
    execFn,
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd, env: cleanEnv },
  );
  if (curBranchRes.stdout.trim() !== branch) {
    const refRes = await execFn("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      env: cleanEnv,
    });
    const checkoutArgs = refRes.code === 0 ? ["checkout", branch] : ["checkout", "-b", branch];
    await execOrThrow(execFn, "git", checkoutArgs, { cwd, env: cleanEnv });
  }

  const normalizedFile = normalizeRepoPath(step.file);
  await execOrThrow(execFn, "git", ["add", "--", normalizedFile], { cwd, env: cleanEnv });
  await execOrThrow(execFn, "git", ["commit", "-m", commitMessage], { cwd, env: cleanEnv });
  await execOrThrow(execFn, "git", ["push", "-u", "origin", branch], { cwd, env: cleanEnv });

  const prRes = await execOrThrow(
    execFn,
    "gh",
    ["pr", "create", "--repo", step.repo, "--title", commitMessage, "--body", ""],
    { cwd, env: cleanEnv },
  );

  const releaseRes = await client.release(leaseId, "submitted");
  if (leaseFile) {
    removeLeaseFile(leaseFile);
  }

  return {
    ok: true,
    branch,
    commitMessage,
    file: normalizedFile,
    target: step.target,
    prUrl: prRes.stdout.trim(),
    released: releaseRes,
  };
}
