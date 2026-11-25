import { spawn } from "node:child_process";
import path from "node:path";
import { KEY_RE, redactKey, safeErrorMessage, validateSlug } from "./config.mjs";
import { runCheck, submitStep } from "./git.mjs";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_FILE,
  buildLeaseRecord,
  removeLeaseFile,
  startHeartbeat,
  writeLeaseFile,
} from "./heartbeat.mjs";

/**
 * Builds the child process environment for `--cmd`, explicitly deleting `SWARMDESK_KEY`
 * (and any other env variable holding an `sd_` key) while injecting step metadata.
 */
export function buildChildEnv(baseEnv = process.env, step = {}) {
  const childEnv = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (k === "SWARMDESK_KEY") continue;
    if (typeof v === "string" && KEY_RE.test(v.trim())) continue;
    if (v !== undefined) childEnv[k] = v;
  }
  delete childEnv.SWARMDESK_KEY;

  const stepId = step?.id !== undefined && step?.id !== null ? String(step.id) : "";
  childEnv.SWARMDESK_STEP_ID = stepId;
  childEnv.SWARMDESK_STEP_TARGET = String(step?.target ?? "");
  childEnv.SWARMDESK_STEP_FILE = String(step?.file ?? "");
  childEnv.SWARMDESK_STEP_BRANCH = String(step?.branch || (stepId ? `step-${stepId}` : ""));
  childEnv.SWARMDESK_STEP_APPROACH = String(step?.approach ?? "");
  childEnv.SWARMDESK_STEP_KIND = String(step?.kind ?? "");
  return childEnv;
}

export function spawnAgentCommand(cmd, { cwd = process.cwd(), env = process.env, onStdout, onStderr } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = redactKey(chunk.toString("utf8"));
      stdout += text;
      onStdout?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = redactKey(chunk.toString("utf8"));
      stderr += text;
      onStderr?.(text);
    });
    child.on("error", (err) => {
      resolve({ code: 1, signal: null, stdout, stderr: redactKey(err.message) });
    });
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
    });
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function releaseSafely(client, leaseId, reason, leaseFile) {
  try {
    await client.release(leaseId, reason);
  } finally {
    if (leaseFile) removeLeaseFile(leaseFile);
  }
}

function checkLoopArgs(client, problem, cmd, maxSteps) {
  if (!client) throw new Error("runLoop requires an API client.");
  const slug = validateSlug(problem, "problem");
  if (typeof cmd !== "string" || !cmd.trim()) {
    throw new Error("runLoop requires a non-empty --cmd command.");
  }
  const limit = Number(maxSteps);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("maxSteps must be a positive finite number.");
  }
  return { slug, limit };
}

/** Gives the lease back and returns the outcome that records it. */
async function giveBack(ctx, lease, outcome, reason, extra = {}) {
  await releaseSafely(ctx.client, lease.id, reason, ctx.leaseFile);
  return { ...outcome, status: "released", reason, ...extra };
}

/** What happens to a step after the agent command ran: give it back, or check and submit. */
async function settleStep(ctx, step, lease, cmdRes, childEnv, outcome) {
  if (ctx.state.interrupted) return giveBack(ctx, lease, outcome, "out_of_time");
  if (cmdRes.code !== 0) {
    ctx.log(`Agent command exited with code ${cmdRes.code} on step-${step.id}; releasing.`);
    return giveBack(ctx, lease, outcome, "approach_blocked", { cmdCode: cmdRes.code });
  }
  const checkRes = await ctx.runCheckFn({ cwd: ctx.cwd, target: step.target, env: childEnv });
  if (!checkRes.ok) {
    ctx.log(`Check failed for step-${step.id} (${step.target}); releasing.`);
    return giveBack(ctx, lease, outcome, "approach_blocked", { checkOk: false });
  }
  if (!ctx.submit) return giveBack(ctx, lease, outcome, "other", { checkOk: true });
  const subRes = await ctx.submitFn({
    cwd: ctx.cwd,
    step,
    leaseId: lease.id,
    client: ctx.client,
    leaseFile: ctx.leaseFile,
    env: childEnv,
  });
  const prUrl = subRes.prUrl || "";
  return { ...outcome, status: "submitted", reason: "submitted", checkOk: true, prUrl };
}

/** After an error: give the lease back if it may still be held, never throwing again. */
async function giveBackAfterError(ctx, lease) {
  try {
    await releaseSafely(ctx.client, lease.id, "other", ctx.leaseFile);
  } catch {
    if (ctx.leaseFile) removeLeaseFile(ctx.leaseFile);
  }
}

/** Runs the agent command on one claimed step, renewing its lease meanwhile. */
async function runOneStep(ctx, claimRes) {
  const { step, lease } = claimRes;
  if (ctx.leaseFile) {
    const record = buildLeaseRecord({ claimResult: claimRes, problem: ctx.slug, url: ctx.client.baseUrl });
    writeLeaseFile(ctx.leaseFile, record);
  }
  const hb = startHeartbeat({
    client: ctx.client,
    leaseId: lease.id,
    intervalMs: ctx.heartbeatIntervalMs,
    leaseFile: ctx.leaseFile,
    registerSignals: false,
    onError: (err) => ctx.log(`Heartbeat warning for step-${step.id}: ${safeErrorMessage(err)}`),
  });
  const outcome = { stepId: step.id, target: step.target, leaseId: lease.id, status: "released", reason: "other" };
  let settled = false;
  try {
    const childEnv = buildChildEnv(ctx.baseEnv, step);
    ctx.log(`Claimed step-${step.id} (${step.target}); running agent command...`);
    const cmdRes = await ctx.spawnCmdFn(ctx.cmd, { cwd: ctx.cwd, env: childEnv });
    const result = await settleStep(ctx, step, lease, cmdRes, childEnv, outcome);
    settled = true;
    return result;
  } catch (err) {
    ctx.log(`Loop step-${step.id} error: ${safeErrorMessage(err)}`);
    if (!settled) await giveBackAfterError(ctx, lease);
    return { ...outcome, status: "error", error: safeErrorMessage(err) };
  } finally {
    hb.stop();
  }
}

/** True when the loop should wait for a step to open; false when it should stop. */
async function waitForOpenStep(ctx, claimRes) {
  if (!ctx.waitOnEmpty || ctx.state.emptyPolls >= ctx.maxEmptyPolls || ctx.state.interrupted) {
    return false;
  }
  ctx.state.emptyPolls += 1;
  const waitSec = Number(claimRes?.retry_after_seconds) || 180;
  ctx.log(`No open steps available; waiting ${waitSec}s...`);
  await ctx.sleepFn(waitSec * 1000);
  return true;
}

async function loopSteps(ctx, limit) {
  const results = [];
  const done = (stoppedReason) => ({ completedSteps: results.length, results, stoppedReason });
  while (results.length < limit && !ctx.state.interrupted) {
    const claimRes = await ctx.client.claim(ctx.slug, { harness: ctx.harness, model: ctx.model });
    if (!claimRes?.step || !claimRes?.lease) {
      if (await waitForOpenStep(ctx, claimRes)) continue;
      return done(ctx.state.interrupted ? "interrupted" : "no_open_steps");
    }
    ctx.state.emptyPolls = 0;
    results.push(await runOneStep(ctx, claimRes));
  }
  return done(ctx.state.interrupted ? "interrupted" : "max_steps_reached");
}

export async function runLoop({
  client,
  problem,
  cmd,
  maxSteps = 10,
  submit = true,
  waitOnEmpty = false,
  maxEmptyPolls = 5,
  harness,
  model,
  cwd = process.cwd(),
  leaseFile = path.join(cwd, DEFAULT_LEASE_FILE),
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
  baseEnv = process.env,
  spawnCmdFn = spawnAgentCommand,
  runCheckFn = runCheck,
  submitFn = submitStep,
  sleepFn = defaultSleep,
  log = (msg) => process.stderr.write(`${redactKey(msg)}\n`),
} = {}) {
  const { slug, limit } = checkLoopArgs(client, problem, cmd, maxSteps);
  const state = { interrupted: false, emptyPolls: 0 };
  const ctx = {
    client, slug, cmd, submit, waitOnEmpty, maxEmptyPolls, harness, model, cwd, leaseFile,
    heartbeatIntervalMs, baseEnv, spawnCmdFn, runCheckFn, submitFn, sleepFn, log, state,
  };
  const onSignal = () => {
    state.interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await loopSteps(ctx, limit);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
