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
  if (!client) throw new Error("runLoop requires an API client.");
  const slug = validateSlug(problem, "problem");
  if (typeof cmd !== "string" || !cmd.trim()) {
    throw new Error("runLoop requires a non-empty --cmd command.");
  }
  const limit = Number(maxSteps);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("maxSteps must be a positive finite number.");
  }

  let interrupted = false;
  let emptyPolls = 0;
  const results = [];
  const onSignal = () => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    for (let i = 0; i < limit && !interrupted; i++) {
      const claimRes = await client.claim(slug, { harness, model });
      if (!claimRes?.step || !claimRes?.lease) {
        if (!waitOnEmpty || emptyPolls >= maxEmptyPolls || interrupted) {
          return {
            completedSteps: results.length,
            results,
            stoppedReason: interrupted ? "interrupted" : "no_open_steps",
          };
        }
        emptyPolls += 1;
        const waitSec = Number(claimRes?.retry_after_seconds) || 180;
        log(`No open steps available; waiting ${waitSec}s...`);
        await sleepFn(waitSec * 1000);
        i -= 1;
        continue;
      }

      emptyPolls = 0;
      const { step, lease } = claimRes;
      if (leaseFile) {
        writeLeaseFile(leaseFile, buildLeaseRecord({ claimResult: claimRes, problem: slug, url: client.baseUrl }));
      }

      const hb = startHeartbeat({
        client,
        leaseId: lease.id,
        intervalMs: heartbeatIntervalMs,
        leaseFile,
        registerSignals: false,
        onError: (err) => log(`Heartbeat warning for step-${step.id}: ${safeErrorMessage(err)}`),
      });

      let outcome = { stepId: step.id, target: step.target, leaseId: lease.id, status: "released", reason: "other" };
      let leased = true;

      try {
        const childEnv = buildChildEnv(baseEnv, step);
        log(`Claimed step-${step.id} (${step.target}); running agent command...`);
        const cmdRes = await spawnCmdFn(cmd, { cwd, env: childEnv });

        if (interrupted) {
          await releaseSafely(client, lease.id, "out_of_time", leaseFile);
          leased = false;
          outcome = { ...outcome, status: "released", reason: "out_of_time" };
        } else if (cmdRes.code !== 0) {
          log(`Agent command exited with code ${cmdRes.code} on step-${step.id}; releasing.`);
          await releaseSafely(client, lease.id, "approach_blocked", leaseFile);
          leased = false;
          outcome = { ...outcome, status: "released", reason: "approach_blocked", cmdCode: cmdRes.code };
        } else {
          const checkRes = await runCheckFn({ cwd, target: step.target, env: childEnv });
          if (!checkRes.ok) {
            log(`Check failed for step-${step.id} (${step.target}); releasing.`);
            await releaseSafely(client, lease.id, "approach_blocked", leaseFile);
            leased = false;
            outcome = { ...outcome, status: "released", reason: "approach_blocked", checkOk: false };
          } else if (submit) {
            const subRes = await submitFn({
              cwd,
              step,
              leaseId: lease.id,
              client,
              leaseFile,
              env: childEnv,
            });
            leased = false;
            outcome = {
              ...outcome,
              status: "submitted",
              reason: "submitted",
              checkOk: true,
              prUrl: subRes.prUrl || "",
            };
          } else {
            await releaseSafely(client, lease.id, "other", leaseFile);
            leased = false;
            outcome = { ...outcome, status: "released", reason: "other", checkOk: true };
          }
        }
      } catch (err) {
        log(`Loop step-${step.id} error: ${safeErrorMessage(err)}`);
        if (leased) {
          try {
            await releaseSafely(client, lease.id, "other", leaseFile);
          } catch {
            if (leaseFile) removeLeaseFile(leaseFile);
          }
        }
        outcome = { ...outcome, status: "error", error: safeErrorMessage(err) };
      } finally {
        hb.stop();
      }

      results.push(outcome);
    }

    return {
      completedSteps: results.length,
      results,
      stoppedReason: interrupted ? "interrupted" : "max_steps_reached",
    };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
