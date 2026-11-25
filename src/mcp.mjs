import path from "node:path";
import { RELEASE_REASONS, createClient } from "./api.mjs";
import { loadConfig, redactKey, redactValue, safeErrorMessage } from "./config.mjs";
import { runCheck, submitStep } from "./git.mjs";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_FILE,
  buildLeaseRecord,
  readLeaseFile,
  removeLeaseFile,
  startHeartbeat,
  writeLeaseFile,
} from "./heartbeat.mjs";

const PROTOCOL_VERSION = "2024-11-05";

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
        harness: { type: "string", description: "Optional allowlisted harness identifier" },
        model: { type: "string", description: "Optional model identifier" },
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
      properties: {
        lease: { type: "string", description: "Optional lease id (defaults to active lease)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "swarmdesk_release",
    description: "Release an active step lease back to the desk with an honest reason.",
    inputSchema: {
      type: "object",
      properties: {
        lease: { type: "string", description: "Optional lease id (defaults to active lease)" },
        reason: { type: "string", enum: RELEASE_REASONS },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
]);

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { code, message: redactKey(message) };
  if (data !== undefined) err.data = redactValue(data);
  return { jsonrpc: "2.0", id: id ?? null, error: err };
}

function toolOk(payload) {
  const safe = redactValue(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
  };
}

function toolErr(message, extra = {}) {
  const safe = redactValue({ error: message, ...extra });
  return {
    content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
    isError: true,
  };
}

/**
 * Creates a zero-dependency JSON-RPC 2.0 stdio MCP server that holds SWARMDESK_KEY in-process
 * and auto-renews active leases in memory.
 */
export function createMcpServer({
  client,
  secretKey = "",
  cwd = process.cwd(),
  leaseFile = path.join(cwd, DEFAULT_LEASE_FILE),
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
  runCheckFn = runCheck,
  submitFn = submitStep,
  input = process.stdin,
  output = process.stdout,
  registerSignals = true,
} = {}) {
  if (!client) {
    const cfg = loadConfig(process.env, { requireKey: true });
    secretKey = cfg.key;
    client = createClient(cfg);
  }

  const activeLeases = new Map();
  let buffer = Buffer.alloc(0);
  let framing = "ndjson";
  let closed = false;

  function resolveLeaseRecord(requestedLeaseId) {
    if (requestedLeaseId) {
      const entry = activeLeases.get(requestedLeaseId);
      if (entry) return entry.record;
      const disk = readLeaseFile(leaseFile);
      if (disk && disk.lease_id === requestedLeaseId) return disk;
      return { lease_id: requestedLeaseId };
    }
    if (activeLeases.size === 1) {
      return activeLeases.values().next().value.record;
    }
    if (activeLeases.size > 1) {
      throw new Error("Multiple leases are active; specify the lease parameter.");
    }
    const disk = readLeaseFile(leaseFile);
    if (disk?.lease_id) return disk;
    throw new Error("No active lease found. Claim a step first with swarmdesk_claim.");
  }

  function stopLease(leaseId, removeFile = false) {
    const entry = activeLeases.get(leaseId);
    if (entry) {
      entry.heartbeat?.stop();
      activeLeases.delete(leaseId);
    }
    if (removeFile && leaseFile) {
      const disk = readLeaseFile(leaseFile);
      if (!disk || !disk.lease_id || disk.lease_id === leaseId) {
        removeLeaseFile(leaseFile);
      }
    }
  }

  async function handleToolCall(name, args = {}) {
    if (name === "swarmdesk_claim") {
      if (!args || typeof args.problem !== "string") {
        return toolErr("swarmdesk_claim requires a problem slug.");
      }
      const res = await client.claim(args.problem, {
        step: args.step,
        another: args.another,
        harness: args.harness,
        model: args.model,
      });
      if (res?.lease?.id && res?.step) {
        const record = buildLeaseRecord({
          claimResult: res,
          problem: args.problem,
          url: client.baseUrl,
        });
        if (leaseFile) writeLeaseFile(leaseFile, record);
        const hb = startHeartbeat({
          client,
          leaseId: res.lease.id,
          intervalMs: heartbeatIntervalMs,
          leaseFile,
          registerSignals: false,
          onBeat: (beatRes) => {
            const cur = activeLeases.get(res.lease.id);
            if (cur && beatRes?.lease) {
              cur.record = {
                ...cur.record,
                lease: beatRes.lease,
                updated_at: new Date().toISOString(),
              };
            }
          },
        });
        activeLeases.set(res.lease.id, { record, heartbeat: hb });
      }
      return toolOk(res);
    }

    if (name === "swarmdesk_status") {
      const leases = Array.from(activeLeases.values()).map((e) => e.record);
      const disk = leaseFile ? readLeaseFile(leaseFile) : null;
      if (disk?.lease_id && !activeLeases.has(disk.lease_id)) {
        leases.push(disk);
      }
      const payload = { active_leases: redactValue(leases, secretKey) };
      if (args?.problem) {
        payload.steps = await client.getSteps(args.problem);
      }
      return toolOk(payload);
    }

    if (name === "swarmdesk_check") {
      let target = args?.target;
      if (!target) {
        const record = resolveLeaseRecord();
        target = record?.step?.target;
      }
      if (!target) {
        return toolErr("swarmdesk_check requires target or an active lease with step.target.");
      }
      const checkRes = await runCheckFn({ cwd, target });
      const summary = {
        ok: checkRes.ok,
        code: checkRes.code,
        target: checkRes.target,
        stdout: (checkRes.stdout || "").slice(-4000),
        stderr: (checkRes.stderr || "").slice(-4000),
      };
      return checkRes.ok ? toolOk(summary) : toolErr("Check failed", summary);
    }

    if (name === "swarmdesk_submit") {
      const record = resolveLeaseRecord(args?.lease);
      if (!record?.step || !record?.lease_id) {
        return toolErr("No complete step metadata available for active lease.");
      }
      const subRes = await submitFn({
        cwd,
        step: record.step,
        leaseId: record.lease_id,
        client,
        leaseFile,
      });
      stopLease(record.lease_id, true);
      return toolOk(subRes);
    }

    if (name === "swarmdesk_release") {
      if (!args || typeof args.reason !== "string") {
        return toolErr(`swarmdesk_release requires reason (${RELEASE_REASONS.join(", ")}).`);
      }
      const record = resolveLeaseRecord(args?.lease);
      const res = await client.release(record.lease_id, args.reason);
      stopLease(record.lease_id, true);
      return toolOk(res);
    }

    return toolErr(`Unknown tool: ${String(name)}`);
  }

  async function dispatchMessage(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      if (msg && msg.id !== undefined) {
        return jsonRpcError(msg.id, -32600, "Invalid Request");
      }
      return null;
    }

    const isNotification = msg.id === undefined || msg.id === null;
    try {
      if (msg.method === "initialize") {
        const requestedVersion = msg.params?.protocolVersion;
        const version =
          typeof requestedVersion === "string" && requestedVersion.length <= 32
            ? requestedVersion
            : PROTOCOL_VERSION;
        return jsonRpcResult(msg.id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "swarmdesk", version: "0.1.0" },
        });
      }
      if (msg.method === "notifications/initialized" || msg.method.startsWith("notifications/")) {
        return null;
      }
      if (msg.method === "ping") {
        return isNotification ? null : jsonRpcResult(msg.id, {});
      }
      if (msg.method === "tools/list") {
        return jsonRpcResult(msg.id, { tools: MCP_TOOLS });
      }
      if (msg.method === "tools/call") {
        const toolName = msg.params?.name;
        const toolArgs = msg.params?.arguments || {};
        if (typeof toolName !== "string") {
          return jsonRpcError(msg.id, -32602, "tools/call requires params.name");
        }
        try {
          const result = await handleToolCall(toolName, toolArgs);
          return jsonRpcResult(msg.id, redactValue(result, secretKey));
        } catch (err) {
          return jsonRpcResult(msg.id, toolErr(safeErrorMessage(err, secretKey)));
        }
      }
      if (isNotification) return null;
      return jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    } catch (err) {
      if (isNotification) return null;
      return jsonRpcError(msg.id, -32603, safeErrorMessage(err, secretKey));
    }
  }

  function writeResponse(payload) {
    if (!payload || closed) return;
    const safe = redactValue(payload, secretKey);
    const json = redactKey(JSON.stringify(safe), secretKey);
    if (framing === "content-length") {
      const byteLen = Buffer.byteLength(json, "utf8");
      output.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      output.write(`${json}\n`);
    }
  }

  async function processJsonText(rawText) {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      writeResponse(jsonRpcError(null, -32700, "Parse error"));
      return;
    }
    const resp = await dispatchMessage(msg);
    if (resp) writeResponse(resp);
  }

  let processing = Promise.resolve();
  const enqueue = (rawText) => {
    processing = processing.then(() => processJsonText(rawText));
  };

  function drainBuffer() {
    while (buffer.length > 0) {
      const preview = buffer.slice(0, Math.min(buffer.length, 64)).toString("utf8");
      if (/^\s*Content-Length:/i.test(preview)) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        framing = "content-length";
        const headers = buffer.slice(0, headerEnd).toString("utf8");
        const match = headers.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          writeResponse(jsonRpcError(null, -32700, "Invalid Content-Length header"));
          continue;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) break;
        const body = buffer.slice(bodyStart, bodyStart + length).toString("utf8");
        buffer = buffer.slice(bodyStart + length);
        enqueue(body);
        continue;
      }

      const nlIndex = buffer.indexOf("\n");
      if (nlIndex === -1) break;
      framing = "ndjson";
      const line = buffer.slice(0, nlIndex).toString("utf8");
      buffer = buffer.slice(nlIndex + 1);
      if (line.trim()) enqueue(line);
    }
  }

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    drainBuffer();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const id of Array.from(activeLeases.keys())) {
      stopLease(id, false);
    }
    input.off("data", onData);
    input.off("end", close);
    if (registerSignals) {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
    }
  };

  input.on("data", onData);
  input.on("end", close);
  if (registerSignals) {
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  }

  return {
    activeLeases,
    close,
    flush: () => processing,
    handleMessage: dispatchMessage,
  };
}
