import {
  redactKey,
  redactValue,
  validateHarness,
  validateKey,
  validateModel,
  validateSlug,
  validateUrl,
} from "./config.mjs";

export const RELEASE_REASONS = Object.freeze([
  "submitted",
  "statement_seems_false",
  "missing_dependency",
  "does_not_build",
  "approach_blocked",
  "out_of_time",
  "other",
]);

const RELEASE_REASON_SET = new Set(RELEASE_REASONS);
const LEASE_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;

export class DeskApiError extends Error {
  constructor(message, { status = 0, data = null, key = "" } = {}) {
    super(redactKey(message, key));
    this.name = "DeskApiError";
    this.status = status;
    this.data = data ? redactValue(data, key) : null;
  }
}

export function validateLeaseId(raw) {
  const lease = typeof raw === "string" ? raw.trim() : "";
  if (!LEASE_ID_RE.test(lease)) {
    throw new DeskApiError("Invalid lease id.");
  }
  return lease;
}

export function validateReleaseReason(raw) {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (!RELEASE_REASON_SET.has(reason)) {
    throw new DeskApiError(`reason must be one of: ${RELEASE_REASONS.join(", ")}`);
  }
  return reason;
}

async function parseJsonResponse(res, key) {
  const text = await res.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: redactKey(text.slice(0, 500), key) };
    }
  }
  if (!res.ok) {
    const msg =
      (data && typeof data.error === "string" && data.error) ||
      `HTTP ${res.status} ${res.statusText}`;
    throw new DeskApiError(msg, { status: res.status, data, key });
  }
  return redactValue(data, key);
}

/**
 * Creates a fetch-based Swarmdesk HTTP API client.
 */
export function createClient({
  url,
  key,
  harness,
  model,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }
  const baseUrl = validateUrl(url);
  const validatedKey = key !== undefined ? validateKey(key) : undefined;
  const defaultHarness = validateHarness(harness);
  const defaultModel = validateModel(model);

  async function postForm(path, fields, secretKey = "") {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== "") {
        body.set(k, String(v));
      }
    }
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new DeskApiError(err?.message || "Network request failed", { key: secretKey });
    }
    return parseJsonResponse(res, secretKey);
  }

  return {
    baseUrl,
    async claim(slug, opts = {}) {
      const problem = validateSlug(slug, "problem");
      const activeKey = opts.key !== undefined ? validateKey(opts.key) : validateKey(validatedKey);
      const effectiveHarness =
        opts.harness !== undefined ? validateHarness(opts.harness) : defaultHarness;
      const effectiveModel = opts.model !== undefined ? validateModel(opts.model) : defaultModel;
      const fields = { key: activeKey };

      if (opts.step !== undefined && opts.step !== null && opts.step !== "") {
        const stepNum = Number(opts.step);
        if (!Number.isInteger(stepNum) || stepNum <= 0) {
          throw new DeskApiError("step must be a positive integer.");
        }
        fields.step = String(stepNum);
      }
      if (opts.another) fields.another = "1";
      if (effectiveHarness) fields.harness = effectiveHarness;
      if (effectiveModel) fields.model = effectiveModel;

      return postForm(`/p/${encodeURIComponent(problem)}/desk/next`, fields, activeKey);
    },

    async beat(leaseId) {
      const lease = validateLeaseId(leaseId);
      return postForm("/desk/beat", { lease }, validatedKey || "");
    },

    async release(leaseId, reason) {
      const lease = validateLeaseId(leaseId);
      const validReason = validateReleaseReason(reason);
      return postForm("/desk/release", { lease, reason: validReason }, validatedKey || "");
    },

    async getSteps(slug) {
      const problem = validateSlug(slug, "problem");
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/p/${encodeURIComponent(problem)}/steps.json`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
      } catch (err) {
        throw new DeskApiError(err?.message || "Network request failed", {
          key: validatedKey || "",
        });
      }
      return parseJsonResponse(res, validatedKey || "");
    },
  };
}
