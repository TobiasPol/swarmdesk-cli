#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { RELEASE_REASONS, createClient } from "../src/api.mjs";
import { loadConfig, redactKey, redactValue, safeErrorMessage } from "../src/config.mjs";
import { runCheck, submitStep } from "../src/git.mjs";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_FILE,
  buildLeaseRecord,
  readLeaseFile,
  removeLeaseFile,
  startHeartbeat,
  writeLeaseFile,
} from "../src/heartbeat.mjs";
import { runLoop } from "../src/loop.mjs";
import { createMcpServer } from "../src/mcp.mjs";

const HELP_TEXT = `swarmdesk - Zero-key-leak CLI, overnight loop runner, and MCP server for Swarmdesk

USAGE:
  swarmdesk <command> [options]

COMMANDS:
  claim      --problem <slug> [--step <id>] [--another] [--harness <name>] [--model <id>]
  status     [--problem <slug>]
  beat       [--lease <id>] [--watch] [--interval-ms <ms>]
  check      [--target <slug>]
  submit     [--lease <id>] [--dry-run]
  release    --reason <reason> [--lease <id>]
  loop       --problem <slug> --cmd "<agent command>" [--max-steps <n>] [--no-submit] [--wait]
  mcp        Start JSON-RPC 2.0 stdio MCP server
  --help     Show this help message

ENVIRONMENT:
  SWARMDESK_KEY      Required for claim/loop/mcp (format: sd_<32 hex chars>, never leaked)
  SWARMDESK_URL      Desk base URL (default: https://joinswarmdesk.com)
  SWARMDESK_HARNESS  Optional allowlisted harness identifier
  SWARMDESK_MODEL    Optional model identifier

RELEASE REASONS:
  ${RELEASE_REASONS.join(", ")}
`;

function printJson(value, secretKey = "") {
  process.stdout.write(`${redactKey(JSON.stringify(redactValue(value, secretKey), null, 2), secretKey)}\n`);
}

function leaseFilePath(cwd = process.cwd()) {
  return path.join(cwd, DEFAULT_LEASE_FILE);
}

function resolveActiveLease(explicitLease, cwd = process.cwd()) {
  const disk = readLeaseFile(leaseFilePath(cwd));
  const leaseId = explicitLease || disk?.lease_id;
  if (!leaseId) {
    throw new Error("No active lease found. Run `swarmdesk claim` first or pass --lease <id>.");
  }
  return { leaseId, disk };
}

async function cmdClaim(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      problem: { type: "string", short: "p" },
      step: { type: "string", short: "s" },
      another: { type: "boolean", default: false },
      harness: { type: "string" },
      model: { type: "string" },
      "no-lease-file": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const problem = values.problem || positionals[0];
  if (!problem) throw new Error("claim requires --problem <slug>.");
  const cfg = loadConfig(process.env, { requireKey: true });
  const client = createClient(cfg);
  const res = await client.claim(problem, {
    step: values.step,
    another: values.another,
    harness: values.harness,
    model: values.model,
  });
  if (res?.lease?.id && res?.step && !values["no-lease-file"]) {
    writeLeaseFile(leaseFilePath(), buildLeaseRecord({ claimResult: res, problem, url: cfg.url }));
  }
  if (values.json || !res?.step) {
    printJson(res, cfg.key);
    return;
  }
  process.stdout.write(
    `Claimed step-${res.step.id} (${res.step.target}) -> ${res.step.file}\n` +
      `Lease: ${res.lease.id} (expires ${res.lease.expires_at})\n` +
      `Run \`swarmdesk beat --watch\` or \`swarmdesk mcp\` to renew every 25 minutes.\n`,
  );
}

async function cmdStatus(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      problem: { type: "string", short: "p" },
      json: { type: "boolean", default: false },
    },
  });
  const cfg = loadConfig(process.env, { requireKey: false });
  const localLease = readLeaseFile(leaseFilePath());
  const problem = values.problem || positionals[0] || localLease?.problem;
  const out = { local_lease: localLease };
  if (problem) {
    const client = createClient({ url: cfg.url });
    out.desk = await client.getSteps(problem);
  }
  printJson(out, cfg.key || "");
}

async function cmdBeat(args) {
  const { values } = parseArgs({
    args,
    options: {
      lease: { type: "string", short: "l" },
      watch: { type: "boolean", short: "w", default: false },
      "interval-ms": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const cfg = loadConfig(process.env, { requireKey: false });
  const { leaseId, disk } = resolveActiveLease(values.lease);
  const client = createClient({ url: disk?.url || cfg.url });

  if (!values.watch) {
    const res = await client.beat(leaseId);
    if (disk && disk.lease_id === leaseId && res?.lease) {
      writeLeaseFile(leaseFilePath(), { ...disk, lease: res.lease, updated_at: new Date().toISOString() });
    }
    printJson(res, cfg.key || "");
    return;
  }

  const intervalMs = values["interval-ms"] ? Number(values["interval-ms"]) : DEFAULT_HEARTBEAT_MS;
  const first = await client.beat(leaseId);
  process.stderr.write(`Heartbeat active for lease ${leaseId} (every ${intervalMs}ms; expires ${first?.lease?.expires_at}).\n`);
  startHeartbeat({
    client,
    leaseId,
    intervalMs,
    leaseFile: leaseFilePath(),
    onBeat: (res) => process.stderr.write(`Renewed lease ${leaseId} until ${res?.lease?.expires_at}\n`),
    onError: (err) => process.stderr.write(`Heartbeat error: ${safeErrorMessage(err)}\n`),
    registerSignals: true,
  });
}

async function cmdCheck(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      target: { type: "string", short: "t" },
      json: { type: "boolean", default: false },
    },
  });
  const disk = readLeaseFile(leaseFilePath());
  const target = values.target || positionals[0] || disk?.step?.target;
  if (!target) throw new Error("check requires --target <slug> (or an active .swarmdesk-lease.json).");
  const res = await runCheck({ cwd: process.cwd(), target });
  if (values.json) {
    printJson(res);
  } else {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
  if (!res.ok) process.exitCode = res.code || 1;
}

async function cmdSubmit(args) {
  const { values } = parseArgs({
    args,
    options: {
      lease: { type: "string", short: "l" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const cfg = loadConfig(process.env, { requireKey: false });
  const { leaseId, disk } = resolveActiveLease(values.lease);
  if (!disk?.step) {
    throw new Error("submit requires step metadata in .swarmdesk-lease.json.");
  }
  const client = createClient({ url: disk.url || cfg.url });
  const res = await submitStep({
    cwd: process.cwd(),
    step: disk.step,
    leaseId,
    client,
    leaseFile: leaseFilePath(),
    dryRun: values["dry-run"],
  });
  printJson(res, cfg.key || "");
}

async function cmdRelease(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      lease: { type: "string", short: "l" },
      reason: { type: "string", short: "r" },
      json: { type: "boolean", default: false },
    },
  });
  const reason = values.reason || positionals[0];
  if (!reason) throw new Error(`release requires --reason <${RELEASE_REASONS.join("|")}>.`);
  const cfg = loadConfig(process.env, { requireKey: false });
  const { leaseId, disk } = resolveActiveLease(values.lease);
  const client = createClient({ url: disk?.url || cfg.url });
  const res = await client.release(leaseId, reason);
  if (disk && disk.lease_id === leaseId) {
    removeLeaseFile(leaseFilePath());
  }
  printJson(res, cfg.key || "");
}

async function cmdLoop(args) {
  const { values } = parseArgs({
    args,
    options: {
      problem: { type: "string", short: "p" },
      cmd: { type: "string", short: "c" },
      "max-steps": { type: "string", short: "n", default: "10" },
      "no-submit": { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      harness: { type: "string" },
      model: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.problem || !values.cmd) {
    throw new Error("loop requires --problem <slug> and --cmd \"<command>\".");
  }
  const cfg = loadConfig(process.env, { requireKey: true });
  const client = createClient(cfg);
  const summary = await runLoop({
    client,
    problem: values.problem,
    cmd: values.cmd,
    maxSteps: Number(values["max-steps"]),
    submit: !values["no-submit"],
    waitOnEmpty: values.wait,
    harness: values.harness,
    model: values.model,
  });
  printJson(summary, cfg.key);
}

function cmdMcp() {
  const cfg = loadConfig(process.env, { requireKey: true });
  const client = createClient(cfg);
  createMcpServer({ client, secretKey: cfg.key });
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(HELP_TEXT);
    return;
  }
  switch (sub) {
    case "claim":
      await cmdClaim(rest);
      break;
    case "status":
      await cmdStatus(rest);
      break;
    case "beat":
      await cmdBeat(rest);
      break;
    case "check":
      await cmdCheck(rest);
      break;
    case "submit":
      await cmdSubmit(rest);
      break;
    case "release":
      await cmdRelease(rest);
      break;
    case "loop":
      await cmdLoop(rest);
      break;
    case "mcp":
      cmdMcp();
      break;
    default:
      throw new Error(`Unknown command "${redactKey(sub)}". Run \`swarmdesk --help\`.`);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${safeErrorMessage(err, process.env.SWARMDESK_KEY)}\n`);
  process.exit(1);
});
