import fs from "node:fs";
import path from "node:path";
import { redactKey, redactValue, safeErrorMessage } from "./config.mjs";

export const DEFAULT_LEASE_FILE = ".swarmdesk-lease.json";
export const DEFAULT_HEARTBEAT_MS = 25 * 60 * 1000;

/**
 * Strips any key field or `sd_` token from lease metadata before persisting to disk.
 */
export function sanitizeLeaseRecord(record) {
  if (!record || typeof record !== "object") return {};
  const clone = redactValue(record);
  delete clone.key;
  delete clone.desk_key;
  delete clone.SWARMDESK_KEY;
  return clone;
}

export function buildLeaseRecord({ claimResult, problem, url }) {
  const step = claimResult?.step || null;
  const lease = claimResult?.lease || null;
  return sanitizeLeaseRecord({
    problem: problem || step?.problem || null,
    repo: step?.repo || null,
    url: url || null,
    handle: claimResult?.handle || null,
    lease_id: lease?.id || null,
    lease,
    step,
    updated_at: new Date().toISOString(),
  });
}

export function writeLeaseFile(filePath = DEFAULT_LEASE_FILE, record) {
  const safe = sanitizeLeaseRecord(record);
  const absPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const payload = `${redactKey(JSON.stringify(safe, null, 2))}\n`;
  fs.writeFileSync(absPath, payload, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(absPath, 0o600);
  return absPath;
}

export function readLeaseFile(filePath = DEFAULT_LEASE_FILE) {
  const absPath = path.resolve(filePath);
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw);
  return sanitizeLeaseRecord(parsed);
}

export function removeLeaseFile(filePath = DEFAULT_LEASE_FILE) {
  const absPath = path.resolve(filePath);
  fs.rmSync(absPath, { force: true });
}

/**
 * Starts a background interval that renews `leaseId` every `intervalMs` (default 25 min).
 * Stops cleanly on `stop()`, release, SIGINT, or SIGTERM without leaking timers or listeners.
 */
export function startHeartbeat({
  client,
  leaseId,
  intervalMs = DEFAULT_HEARTBEAT_MS,
  leaseFile = null,
  onBeat = null,
  onError = null,
  registerSignals = true,
} = {}) {
  if (!client || typeof client.beat !== "function") {
    throw new Error("startHeartbeat requires a client with a beat() method.");
  }
  if (!leaseId || typeof leaseId !== "string") {
    throw new Error("startHeartbeat requires a valid leaseId.");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("intervalMs must be a positive finite number.");
  }

  let running = true;
  let inFlight = false;
  let timer = null;

  const beatNow = async () => {
    if (!running || inFlight) return null;
    inFlight = true;
    try {
      const res = await client.beat(leaseId);
      if (leaseFile && res?.lease) {
        const existing = readLeaseFile(leaseFile);
        if (existing && (!existing.lease_id || existing.lease_id === leaseId)) {
          writeLeaseFile(leaseFile, {
            ...existing,
            lease: res.lease,
            updated_at: new Date().toISOString(),
          });
        }
      }
      if (typeof onBeat === "function") onBeat(res);
      return res;
    } catch (err) {
      if (typeof onError === "function") {
        onError(new Error(safeErrorMessage(err)), err);
      }
      if (err && err.status === 404) {
        stop();
      }
      return null;
    } finally {
      inFlight = false;
    }
  };

  const onSignal = () => {
    stop();
  };

  const stop = () => {
    if (!running) return;
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (registerSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  };

  timer = setInterval(() => {
    void beatNow();
  }, intervalMs);

  if (registerSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return {
    leaseId,
    beatNow,
    stop,
    isRunning: () => running,
  };
}
