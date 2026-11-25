import path from "node:path";
import { createClient } from "./api.mjs";
import { loadConfig, redactKey, redactValue, safeErrorMessage } from "./config.mjs";
import { runCheck, submitStep } from "./git.mjs";
import { DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_FILE } from "./heartbeat.mjs";
import { MCP_TOOLS, handleToolCall, stopLease, toolErr } from "./mcp-tools.mjs";

export { MCP_TOOLS };

const PROTOCOL_VERSION = "2024-11-05";

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { code, message: redactKey(message) };
  if (data !== undefined) err.data = redactValue(data);
  return { jsonrpc: "2.0", id: id ?? null, error: err };
}

function initializeResult(msg) {
  const requested = msg.params?.protocolVersion;
  const version =
    typeof requested === "string" && requested.length <= 32 ? requested : PROTOCOL_VERSION;
  return jsonRpcResult(msg.id, {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: "swarmdesk", version: "0.1.0" },
  });
}

async function callTool(ctx, msg) {
  const toolName = msg.params?.name;
  if (typeof toolName !== "string") {
    return jsonRpcError(msg.id, -32602, "tools/call requires params.name");
  }
  try {
    const result = await handleToolCall(ctx, toolName, msg.params?.arguments || {});
    return jsonRpcResult(msg.id, redactValue(result, ctx.secretKey));
  } catch (err) {
    return jsonRpcResult(msg.id, toolErr(safeErrorMessage(err, ctx.secretKey)));
  }
}

async function routeMethod(ctx, msg, isNotification) {
  if (msg.method === "initialize") return initializeResult(msg);
  if (msg.method.startsWith("notifications/")) return null;
  if (msg.method === "ping") return isNotification ? null : jsonRpcResult(msg.id, {});
  if (msg.method === "tools/list") return jsonRpcResult(msg.id, { tools: MCP_TOOLS });
  if (msg.method === "tools/call") return callTool(ctx, msg);
  if (isNotification) return null;
  return jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
}

/** Answers one JSON-RPC message, or returns null when no answer is due. */
async function dispatchMessage(ctx, msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && msg.id !== undefined ? jsonRpcError(msg.id, -32600, "Invalid Request") : null;
  }
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    return await routeMethod(ctx, msg, isNotification);
  } catch (err) {
    return isNotification ? null : jsonRpcError(msg.id, -32603, safeErrorMessage(err, ctx.secretKey));
  }
}

/** Takes one framed message off the front of the buffer, or null when it is incomplete. */
function takeFrame(io) {
  const preview = io.buffer.slice(0, Math.min(io.buffer.length, 64)).toString("utf8");
  if (/^\s*Content-Length:/i.test(preview)) {
    const headerEnd = io.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    io.framing = "content-length";
    const match = io.buffer.slice(0, headerEnd).toString("utf8").match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      io.buffer = io.buffer.slice(headerEnd + 4);
      return { error: "Invalid Content-Length header" };
    }
    const bodyStart = headerEnd + 4;
    const end = bodyStart + Number(match[1]);
    if (io.buffer.length < end) return null;
    const body = io.buffer.slice(bodyStart, end).toString("utf8");
    io.buffer = io.buffer.slice(end);
    return { text: body };
  }
  const nlIndex = io.buffer.indexOf("\n");
  if (nlIndex === -1) return null;
  io.framing = "ndjson";
  const line = io.buffer.slice(0, nlIndex).toString("utf8");
  io.buffer = io.buffer.slice(nlIndex + 1);
  return { text: line };
}

function createStdio(ctx, output) {
  const io = { buffer: Buffer.alloc(0), framing: "ndjson", closed: false };
  io.write = (payload) => {
    if (!payload || io.closed) return;
    const json = redactKey(JSON.stringify(redactValue(payload, ctx.secretKey)), ctx.secretKey);
    if (io.framing === "content-length") {
      output.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
    } else {
      output.write(`${json}\n`);
    }
  };
  io.processing = Promise.resolve();
  const handleText = async (rawText) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      io.write(jsonRpcError(null, -32700, "Parse error"));
      return;
    }
    io.write(await dispatchMessage(ctx, msg));
  };
  io.onData = (chunk) => {
    io.buffer = Buffer.concat([io.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (let frame = takeFrame(io); frame; frame = takeFrame(io)) {
      if (frame.error) io.write(jsonRpcError(null, -32700, frame.error));
      else if (frame.text.trim()) io.processing = io.processing.then(() => handleText(frame.text));
    }
  };
  return io;
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
  const ctx = { client, secretKey, cwd, leaseFile, heartbeatIntervalMs, runCheckFn, submitFn, activeLeases };
  const io = createStdio(ctx, output);
  const close = () => {
    if (io.closed) return;
    io.closed = true;
    for (const id of Array.from(activeLeases.keys())) stopLease(ctx, id, false);
    input.off("data", io.onData);
    input.off("end", close);
    if (registerSignals) {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
    }
  };
  input.on("data", io.onData);
  input.on("end", close);
  if (registerSignals) {
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  }
  return {
    activeLeases,
    close,
    flush: () => io.processing,
    handleMessage: (msg) => dispatchMessage(ctx, msg),
  };
}
