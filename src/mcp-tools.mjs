import { RELEASE_REASONS } from "./api.mjs";
import { ALLOWED_HARNESSES, ALLOWED_MODELS, redactValue } from "./config.mjs";
import { buildLeaseRecord, readLeaseFile, removeLeaseFile, startHeartbeat, writeLeaseFile } from "./heartbeat.mjs";

const leaseParam = { type: "string", description: "Optional lease id (defaults to active lease)" };

export const MCP_TOOLS = Object.freeze([
  {
    name: "swarmdesk_claim",
    description:
      "Claim an open step from a Swarmdesk problem and start automatic background lease renewal.",
    inputSchema: {
      type: "object",
      properties: {
        problem: { type: "string", description: "Problem slug (e.g. open-math or speed-race)" },
        step: { type: "integer", description: "Optional specific step id to claim" },
        another: { type: "boolean", description: "Claim an additional concurrent step" },
        harness: { type: "string", enum: ALLOWED_HARNESSES, description: "Optional harness" },
        model: { type: "string", enum: ALLOWED_MODELS, description: "Optional model family" },
      },
      required: ["problem"],
      additionalProperties: false,
    },
  },
  {
    name: "swarmdesk_status",
    description: "Inspect currently held lease(s) and optionally list open steps from steps.json.",
    inputSchema: {
      type: "object",
      properties: {
        problem: { type: "string", description: "Optional problem slug to fetch steps.json" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "swarmdesk_check",
    description: "Run local scripts/check.sh <target> verification without pushing or submitting.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target slug (defaults to active lease target)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "swarmdesk_submit",
    description:
      "Verify single-file git diff, run scripts/check.sh, create branch step-<id>, commit, push, open PR, and release as submitted.",
    inputSchema: {
      type: "object",
      properties: { lease: leaseParam },
      additionalProperties: false,
    },
  },
  {
    name: "swarmdesk_release",
    description: "Release an active step lease back to the desk with an honest reason.",
    inputSchema: {
      type: "object",
      properties: { lease: leaseParam, reason: { type: "string", enum: RELEASE_REASONS } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
]);

export function toolOk(payload) {
  const safe = redactValue(payload);
  return { content: [{ type: "text", text: JSON.stringify(safe, null, 2) }] };
}

export function toolErr(message, extra = {}) {
  const safe = redactValue({ error: message, ...extra });
  return { content: [{ type: "text", text: JSON.stringify(safe, null, 2) }], isError: true };
}

/** The lease a tool call means: the named one, the only active one, or the one on disk. */
function resolveLeaseRecord(ctx, requestedLeaseId) {
  if (requestedLeaseId) {
    const entry = ctx.activeLeases.get(requestedLeaseId);
    if (entry) return entry.record;
    const disk = readLeaseFile(ctx.leaseFile);
    if (disk && disk.lease_id === requestedLeaseId) return disk;
    return { lease_id: requestedLeaseId };
  }
  if (ctx.activeLeases.size === 1) return ctx.activeLeases.values().next().value.record;
  if (ctx.activeLeases.size > 1) {
    throw new Error("Multiple leases are active; specify the lease parameter.");
  }
  const disk = readLeaseFile(ctx.leaseFile);
  if (disk?.lease_id) return disk;
  throw new Error("No active lease found. Claim a step first with swarmdesk_claim.");
}

/** Stops renewing a lease and, when asked, removes its lease file if it is this lease's. */
export function stopLease(ctx, leaseId, removeFile = false) {
  const entry = ctx.activeLeases.get(leaseId);
  if (entry) {
    entry.heartbeat?.stop();
    ctx.activeLeases.delete(leaseId);
  }
  if (removeFile && ctx.leaseFile) {
    const disk = readLeaseFile(ctx.leaseFile);
    if (!disk || !disk.lease_id || disk.lease_id === leaseId) removeLeaseFile(ctx.leaseFile);
  }
}

function trackLease(ctx, res, problem) {
  const record = buildLeaseRecord({ claimResult: res, problem, url: ctx.client.baseUrl });
  if (ctx.leaseFile) writeLeaseFile(ctx.leaseFile, record);
  const heartbeat = startHeartbeat({
    client: ctx.client,
    leaseId: res.lease.id,
    intervalMs: ctx.heartbeatIntervalMs,
    leaseFile: ctx.leaseFile,
    registerSignals: false,
    onBeat: (beatRes) => {
      const cur = ctx.activeLeases.get(res.lease.id);
      if (cur && beatRes?.lease) {
        cur.record = { ...cur.record, lease: beatRes.lease, updated_at: new Date().toISOString() };
      }
    },
  });
  ctx.activeLeases.set(res.lease.id, { record, heartbeat });
}

async function claim(ctx, args) {
  if (!args || typeof args.problem !== "string") {
    return toolErr("swarmdesk_claim requires a problem slug.");
  }
  const { step, another, harness, model } = args;
  const res = await ctx.client.claim(args.problem, { step, another, harness, model });
  if (res?.lease?.id && res?.step) trackLease(ctx, res, args.problem);
  return toolOk(res);
}

async function status(ctx, args) {
  const leases = Array.from(ctx.activeLeases.values()).map((e) => e.record);
  const disk = ctx.leaseFile ? readLeaseFile(ctx.leaseFile) : null;
  if (disk?.lease_id && !ctx.activeLeases.has(disk.lease_id)) leases.push(disk);
  const payload = { active_leases: redactValue(leases, ctx.secretKey) };
  if (args?.problem) payload.steps = await ctx.client.getSteps(args.problem);
  return toolOk(payload);
}

async function check(ctx, args) {
  const target = args?.target || resolveLeaseRecord(ctx)?.step?.target;
  if (!target) {
    return toolErr("swarmdesk_check requires target or an active lease with step.target.");
  }
  const res = await ctx.runCheckFn({ cwd: ctx.cwd, target });
  const summary = {
    ok: res.ok,
    code: res.code,
    target: res.target,
    stdout: (res.stdout || "").slice(-4000),
    stderr: (res.stderr || "").slice(-4000),
  };
  return res.ok ? toolOk(summary) : toolErr("Check failed", summary);
}

async function submit(ctx, args) {
  const record = resolveLeaseRecord(ctx, args?.lease);
  if (!record?.step || !record?.lease_id) {
    return toolErr("No complete step metadata available for active lease.");
  }
  const { cwd, client, leaseFile } = ctx;
  const res = await ctx.submitFn({ cwd, step: record.step, leaseId: record.lease_id, client, leaseFile });
  stopLease(ctx, record.lease_id, true);
  return toolOk(res);
}

async function release(ctx, args) {
  if (!args || typeof args.reason !== "string") {
    return toolErr(`swarmdesk_release requires reason (${RELEASE_REASONS.join(", ")}).`);
  }
  const record = resolveLeaseRecord(ctx, args?.lease);
  const res = await ctx.client.release(record.lease_id, args.reason);
  stopLease(ctx, record.lease_id, true);
  return toolOk(res);
}

const HANDLERS = {
  swarmdesk_claim: claim,
  swarmdesk_status: status,
  swarmdesk_check: check,
  swarmdesk_submit: submit,
  swarmdesk_release: release,
};

export async function handleToolCall(ctx, name, args = {}) {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  return handler ? handler(ctx, args) : toolErr(`Unknown tool: ${String(name)}`);
}
