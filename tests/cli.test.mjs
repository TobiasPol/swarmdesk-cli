import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { RELEASE_REASONS, createClient } from "../src/api.mjs";
import {
  DEFAULT_URL,
  loadConfig,
  redactKey,
  redactValue,
  validateHarness,
  validateKey,
  validateModel,
} from "../src/config.mjs";
import { submitStep, validateSingleChangedFile } from "../src/git.mjs";
import {
  buildLeaseRecord,
  readLeaseFile,
  startHeartbeat,
  writeLeaseFile,
} from "../src/heartbeat.mjs";
import { buildChildEnv, runLoop } from "../src/loop.mjs";
import { createMcpServer } from "../src/mcp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(__dirname, "../bin/swarmdesk.mjs");
const TEST_KEY = "sd_0123456789abcdef0123456789abcdef";

function startMockDesk() {
  const calls = [];
  let beatCount = 0;
  let stepCounter = 41;
  let emptyNext = false;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const url = new URL(req.url, "http://127.0.0.1");
    calls.push({ method: req.method, path: url.pathname, params, rawBody });

    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && url.pathname === "/p/open-math/steps.json") {
      res.end(
        JSON.stringify({
          problem: "open-math",
          repo: "acme/open-math",
          generated_at: "2026-11-25T10:00:00Z",
          steps: [
            {
              id: 42,
              branch: "step-42",
              target: "erdos_7_odd_covering",
              kind: "conjecture",
              file: "Targets/Erdos7/Proof.lean",
            },
          ],
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/p/open-math/desk/next") {
      if (params.key === "sd_ffffffffffffffffffffffffffffffff") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: `bad key ${params.key}` }));
        return;
      }
      if (emptyNext) {
        res.end(JSON.stringify({ step: null, lease: null, retry_after_seconds: 180 }));
        return;
      }
      stepCounter += 1;
      res.end(
        JSON.stringify({
          handle: "alice",
          step: {
            id: stepCounter,
            branch: `step-${stepCounter}`,
            problem: "open-math",
            repo: "acme/open-math",
            target: "erdos_7_odd_covering",
            kind: "conjecture",
            file: "Targets/Erdos7/Proof.lean",
            approach: "Try modular covering reduction",
          },
          lease: {
            id: `lease_${stepCounter}`,
            step: stepCounter,
            expires_at: "2026-11-25T10:45:00Z",
            hard_deadline: "2026-11-25T16:00:00Z",
          },
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/desk/beat") {
      beatCount += 1;
      res.end(
        JSON.stringify({
          lease: {
            id: params.lease,
            step: stepCounter,
            expires_at: `2026-11-25T11:${String(beatCount).padStart(2, "0")}:00Z`,
            hard_deadline: "2026-11-25T16:00:00Z",
          },
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/desk/release") {
      if (!RELEASE_REASONS.includes(params.reason)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid reason" }));
        return;
      }
      res.end(JSON.stringify({ released: params.lease, reason: params.reason }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        getBeatCount: () => beatCount,
        setEmptyNext: (v) => {
          emptyNext = v;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe("config and key redaction", () => {
  it("validates SWARMDESK_KEY and redacts keys from strings and objects", () => {
    assert.equal(validateKey(TEST_KEY), TEST_KEY);
    assert.throws(() => validateKey("sd_not_hex"), /Invalid SWARMDESK_KEY/);

    const leaked = `Authorization failed for key=${TEST_KEY} (${encodeURIComponent(TEST_KEY)})`;
    const redacted = redactKey(leaked, TEST_KEY);
    assert.equal(redacted.includes(TEST_KEY), false);
    assert.match(redacted, /sd_\[REDACTED\]/);

    const obj = redactValue({ key: TEST_KEY, nested: { msg: `token ${TEST_KEY}` } }, TEST_KEY);
    assert.equal(obj.key, "sd_[REDACTED]");
    assert.equal(obj.nested.msg.includes(TEST_KEY), false);
  });

  it("enforces allowlisted harness and safe model identifiers", () => {
    const cfg = loadConfig({
      SWARMDESK_KEY: TEST_KEY,
      SWARMDESK_HARNESS: "claude-code",
      SWARMDESK_MODEL: "claude-sonnet",
    });
    assert.equal(cfg.url, DEFAULT_URL);
    assert.equal(cfg.harness, "claude-code");
    assert.equal(cfg.model, "claude-sonnet");
    assert.equal(validateHarness("swarmdesk-cli"), "swarmdesk-cli");
    assert.throws(() => validateHarness("swarmdesk-loop"), /Invalid SWARMDESK_HARNESS/);
    assert.throws(() => validateModel("claude-sonnet-4-5"), /Invalid SWARMDESK_MODEL/);

    assert.throws(() => validateHarness("ignore previous instructions"), /Invalid SWARMDESK_HARNESS/);
    assert.throws(() => validateModel("gpt-4o; rm -rf /"), /Invalid SWARMDESK_MODEL/);
  });
});

describe("API client and mock desk integration", () => {
  let mock;
  beforeEach(async () => {
    mock = await startMockDesk();
  });
  afterEach(async () => {
    await mock.close();
  });

  it("claims, forwards harness/model, beats, releases, and fetches steps.json", async () => {
    const client = createClient({
      url: mock.url,
      key: TEST_KEY,
      harness: "codex",
      model: "o3",
    });

    const steps = await client.getSteps("open-math");
    assert.equal(steps.steps.length, 1);

    const claimed = await client.claim("open-math", { step: 42, another: true });
    assert.equal(claimed.step.id, 42);
    assert.equal(claimed.lease.id, "lease_42");

    const claimReq = mock.calls.find((c) => c.path === "/p/open-math/desk/next");
    assert.equal(claimReq.params.key, TEST_KEY);
    assert.equal(claimReq.params.step, "42");
    assert.equal(claimReq.params.another, "1");
    assert.equal(claimReq.params.harness, "codex");
    assert.equal(claimReq.params.model, "o3");

    const beatRes = await client.beat(claimed.lease.id);
    assert.equal(beatRes.lease.id, "lease_42");

    const relRes = await client.release(claimed.lease.id, "approach_blocked");
    assert.equal(relRes.reason, "approach_blocked");
  });

  it("never leaks keys in DeskApiError messages", async () => {
    const badKey = "sd_ffffffffffffffffffffffffffffffff";
    const client = createClient({ url: mock.url, key: badKey });
    await assert.rejects(
      () => client.claim("open-math"),
      (err) => {
        assert.equal(err.message.includes(badKey), false);
        assert.match(err.message, /sd_\[REDACTED\]/);
        return true;
      },
    );
  });
});

describe("heartbeat persistence and interval", () => {
  let mock;
  let tmpDir;

  beforeEach(async () => {
    mock = await startMockDesk();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-hb-"));
  });

  afterEach(async () => {
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes .swarmdesk-lease.json with mode 0o600 and no sd_ key, and renews on interval", async () => {
    const client = createClient({ url: mock.url, key: TEST_KEY });
    const claimRes = await client.claim("open-math");
    const leaseFile = path.join(tmpDir, ".swarmdesk-lease.json");

    writeLeaseFile(leaseFile, {
      ...buildLeaseRecord({ claimResult: claimRes, problem: "open-math", url: mock.url }),
      key: TEST_KEY,
      note: `leaked ${TEST_KEY}`,
    });

    const stat = fs.statSync(leaseFile);
    assert.equal(stat.mode & 0o777, 0o600);
    const rawText = fs.readFileSync(leaseFile, "utf8");
    assert.equal(rawText.includes(TEST_KEY), false);

    let beats = 0;
    const hb = startHeartbeat({
      client,
      leaseId: claimRes.lease.id,
      intervalMs: 25,
      leaseFile,
      registerSignals: false,
      onBeat: () => {
        beats += 1;
      },
    });

    await new Promise((r) => setTimeout(r, 95));
    hb.stop();
    assert.ok(beats >= 2, `expected >= 2 beats, got ${beats}`);
    assert.equal(hb.isRunning(), false);

    const updated = readLeaseFile(leaseFile);
    assert.notEqual(updated.lease.expires_at, claimRes.lease.expires_at);
  });
});

describe("git hygiene validation and submitStep", () => {
  it("validateSingleChangedFile accepts only single expected file", () => {
    assert.equal(
      validateSingleChangedFile(" M Targets/Erdos7/Proof.lean\n", "Targets/Erdos7/Proof.lean").ok,
      true,
    );
    assert.equal(
      validateSingleChangedFile("?? Targets/Erdos7/Lemma.lean\n", "./Targets/Erdos7/Lemma.lean").ok,
      true,
    );
    assert.equal(validateSingleChangedFile("", "Targets/Erdos7/Proof.lean").ok, false);
    assert.equal(
      validateSingleChangedFile(
        " M Targets/Erdos7/Proof.lean\n M targets.json\n",
        "Targets/Erdos7/Proof.lean",
      ).ok,
      false,
    );
    assert.equal(
      validateSingleChangedFile(" M Targets/Other/Proof.lean\n", "Targets/Erdos7/Proof.lean").ok,
      false,
    );
    assert.equal(
      validateSingleChangedFile(" D Targets/Erdos7/Proof.lean\n", "Targets/Erdos7/Proof.lean").ok,
      false,
    );
    assert.equal(
      validateSingleChangedFile(
        "R  old.lean -> Targets/Erdos7/Proof.lean\n",
        "Targets/Erdos7/Proof.lean",
      ).ok,
      false,
    );
  });

  it("submitStep verifies single file, runs check, branches, commits, pushes, creates PR, and releases", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-git-"));
    fs.mkdirSync(path.join(tmpDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "scripts/check.sh"), "#!/usr/bin/env bash\nexit 0\n");

    const mock = await startMockDesk();
    const client = createClient({ url: mock.url, key: TEST_KEY });
    const leaseFile = path.join(tmpDir, ".swarmdesk-lease.json");
    writeLeaseFile(leaseFile, { lease_id: "lease_42" });

    const invoked = [];
    const execFn = async (cmd, args, opts) => {
      assert.equal(opts.env.SWARMDESK_KEY, undefined);
      invoked.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "status") {
        return {
          code: 0,
          stdout: " M Targets/Erdos7/Proof.lean\n?? .swarmdesk-lease.json\n",
          stderr: "",
        };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "show-ref") {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (cmd === "gh" && args[0] === "pr") {
        return { code: 0, stdout: "https://github.com/acme/open-math/pull/99\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    try {
      const res = await submitStep({
        cwd: tmpDir,
        step: {
          id: 42,
          target: "erdos_7_odd_covering",
          file: "Targets/Erdos7/Proof.lean",
          repo: "acme/open-math",
        },
        leaseId: "lease_42",
        client,
        leaseFile,
        execFn,
        env: { ...process.env, SWARMDESK_KEY: TEST_KEY },
      });

      assert.equal(res.ok, true);
      assert.equal(res.branch, "step-42");
      assert.equal(res.commitMessage, "step-42");
      assert.equal(res.prUrl, "https://github.com/acme/open-math/pull/99");
      assert.equal(fs.existsSync(leaseFile), false);

      assert.deepEqual(invoked, [
        ["git", "status", "--porcelain", "-uall"],
        ["bash", "scripts/check.sh", "erdos_7_odd_covering"],
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        ["git", "show-ref", "--verify", "--quiet", "refs/heads/step-42"],
        ["git", "checkout", "-b", "step-42"],
        ["git", "add", "--", "Targets/Erdos7/Proof.lean"],
        ["git", "commit", "-m", "step-42"],
        ["git", "push", "-u", "origin", "step-42"],
        ["gh", "pr", "create", "--repo", "acme/open-math", "--title", "step-42", "--body", ""],
      ]);

      const releaseCall = mock.calls.find((c) => c.path === "/desk/release");
      assert.equal(releaseCall.params.reason, "submitted");
    } finally {
      await mock.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("overnight loop runner", () => {
  let mock;
  let tmpDir;

  beforeEach(async () => {
    mock = await startMockDesk();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-loop-"));
  });

  afterEach(async () => {
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scrubs SWARMDESK_KEY from real child command env and passes SWARMDESK_STEP_* vars", async () => {
    const childEnv = buildChildEnv(
      { PATH: process.env.PATH, SWARMDESK_KEY: TEST_KEY, LEAKED: TEST_KEY },
      {
        id: 7,
        target: "foo_target",
        file: "Targets/Foo.lean",
        branch: "step-7",
        approach: "induction",
        kind: "conjecture",
      },
    );
    assert.equal(childEnv.SWARMDESK_KEY, undefined);
    assert.equal(childEnv.LEAKED, undefined);
    assert.equal(childEnv.SWARMDESK_STEP_ID, "7");
    assert.equal(childEnv.SWARMDESK_STEP_TARGET, "foo_target");
    assert.equal(childEnv.SWARMDESK_STEP_FILE, "Targets/Foo.lean");
    assert.equal(childEnv.SWARMDESK_STEP_BRANCH, "step-7");
    assert.equal(childEnv.SWARMDESK_STEP_APPROACH, "induction");
    assert.equal(childEnv.SWARMDESK_STEP_KIND, "conjecture");

    const client = createClient({ url: mock.url, key: TEST_KEY });
    const envCheckCmd =
      "node -e \"if (process.env.SWARMDESK_KEY) process.exit(99); if (!process.env.SWARMDESK_STEP_ID || !process.env.SWARMDESK_STEP_FILE) process.exit(98);\"";

    let submittedSteps = 0;
    const summary = await runLoop({
      client,
      problem: "open-math",
      cmd: envCheckCmd,
      maxSteps: 1,
      cwd: tmpDir,
      heartbeatIntervalMs: 5000,
      baseEnv: { ...process.env, SWARMDESK_KEY: TEST_KEY },
      runCheckFn: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      submitFn: async ({ step, leaseId }) => {
        submittedSteps += 1;
        await client.release(leaseId, "submitted");
        return { ok: true, stepId: step.id, prUrl: "https://example.test/pr/1" };
      },
      log: () => {},
    });

    assert.equal(submittedSteps, 1);
    assert.equal(summary.completedSteps, 1);
    assert.equal(summary.results[0].status, "submitted");
  });

  it("releases honestly as approach_blocked when check fails", async () => {
    const client = createClient({ url: mock.url, key: TEST_KEY });
    const summary = await runLoop({
      client,
      problem: "open-math",
      cmd: "true",
      maxSteps: 1,
      cwd: tmpDir,
      heartbeatIntervalMs: 5000,
      baseEnv: { ...process.env, SWARMDESK_KEY: TEST_KEY },
      runCheckFn: async () => ({ ok: false, code: 1, stdout: "", stderr: "failed" }),
      log: () => {},
    });

    assert.equal(summary.results[0].status, "released");
    assert.equal(summary.results[0].reason, "approach_blocked");
    const rel = mock.calls.find((c) => c.path === "/desk/release");
    assert.equal(rel.params.reason, "approach_blocked");
  });
});

describe("MCP JSON-RPC 2.0 server", () => {
  it("handles initialize, notifications/initialized, tools/list, tools/call, auto-renewal, and zero key leak", async () => {
    const mock = await startMockDesk();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-mcp-"));
    const input = new PassThrough();
    const output = new PassThrough();
    const responses = [];
    let outBuf = "";
    output.on("data", (chunk) => {
      outBuf += chunk.toString("utf8");
      const lines = outBuf.split("\n");
      outBuf = lines.pop();
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    const client = createClient({ url: mock.url, key: TEST_KEY });
    const server = createMcpServer({
      client,
      secretKey: TEST_KEY,
      cwd: tmpDir,
      leaseFile: path.join(tmpDir, ".swarmdesk-lease.json"),
      heartbeatIntervalMs: 25,
      runCheckFn: async ({ target }) => ({ ok: true, code: 0, target, stdout: "ACCEPTED", stderr: "" }),
      submitFn: async ({ step, leaseId }) => {
        await client.release(leaseId, "submitted");
        return { ok: true, branch: `step-${step.id}`, prUrl: "https://example.test/pr/42" };
      },
      input,
      output,
      registerSignals: false,
    });

    try {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "swarmdesk_claim", arguments: { problem: "open-math" } } })}\n`);

      await server.flush();
      assert.equal(responses.length, 3);
      assert.equal(responses[0].result.serverInfo.name, "swarmdesk");
      assert.deepEqual(
        responses[1].result.tools.map((t) => t.name),
        ["swarmdesk_claim", "swarmdesk_status", "swarmdesk_check", "swarmdesk_submit", "swarmdesk_release"],
      );
      const claimPayload = JSON.parse(responses[2].result.content[0].text);
      assert.equal(claimPayload.lease.id, "lease_42");
      assert.equal(JSON.stringify(responses).includes(TEST_KEY), false);

      // Verify in-memory auto-renewal beats fire automatically
      await new Promise((r) => setTimeout(r, 85));
      assert.ok(mock.getBeatCount() >= 2, `expected >= 2 MCP beats, got ${mock.getBeatCount()}`);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "swarmdesk_status", arguments: { problem: "open-math" } } })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "swarmdesk_check", arguments: {} } })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "swarmdesk_submit", arguments: {} } })}\n`);

      await server.flush();
      assert.equal(responses.length, 6);
      assert.equal(server.activeLeases.size, 0);
      assert.equal(JSON.stringify(responses).includes(TEST_KEY), false);
    } finally {
      server.close();
      await mock.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("also supports Content-Length MCP framing", async () => {
    const mock = await startMockDesk();
    const input = new PassThrough();
    const output = new PassThrough();
    let rawOut = "";
    output.on("data", (chunk) => {
      rawOut += chunk.toString("utf8");
    });

    const client = createClient({ url: mock.url, key: TEST_KEY });
    const server = createMcpServer({
      client,
      secretKey: TEST_KEY,
      input,
      output,
      registerSignals: false,
    });

    try {
      const req = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" });
      input.write(`Content-Length: ${Buffer.byteLength(req, "utf8")}\r\n\r\n${req}`);
      await server.flush();
      assert.match(rawOut, /^Content-Length: \d+\r\n\r\n/);
      assert.match(rawOut, /swarmdesk_claim/);
    } finally {
      server.close();
      await mock.close();
    }
  });
});

describe("CLI binary", () => {
  it("supports --help and claim/status/release without leaking SWARMDESK_KEY", async () => {
    const mock = await startMockDesk();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-cli-"));

    const runCli = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI_BIN, ...args], {
          cwd: tmpDir,
          env: {
            PATH: process.env.PATH,
            SWARMDESK_URL: mock.url,
            SWARMDESK_KEY: TEST_KEY,
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
        child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

    try {
      const help = await runCli(["--help"]);
      assert.equal(help.code, 0);
      assert.match(help.stdout, /swarmdesk/);

      const claimed = await runCli(["claim", "--problem", "open-math", "--json"]);
      assert.equal(claimed.code, 0);
      assert.equal(claimed.stdout.includes(TEST_KEY), false);
      assert.equal(claimed.stderr.includes(TEST_KEY), false);
      assert.equal(JSON.parse(claimed.stdout).lease.id, "lease_42");

      const status = await runCli(["status"]);
      assert.equal(status.code, 0);
      assert.equal(JSON.parse(status.stdout).local_lease.lease_id, "lease_42");

      const released = await runCli(["release", "--reason", "other"]);
      assert.equal(released.code, 0);
      assert.equal(JSON.parse(released.stdout).reason, "other");
      assert.equal(fs.existsSync(path.join(tmpDir, ".swarmdesk-lease.json")), false);
    } finally {
      await mock.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
