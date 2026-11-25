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

async function postForm(ctx, path, fields, secretKey = "") {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") {
      body.set(k, String(v));
    }
  }
  let res;
  try {
    res = await ctx.fetchImpl(`${ctx.baseUrl}${path}`, {
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

/** The form fields of a desk claim: the key, and the optional step, harness and model. */
function claimFields(ctx, opts) {
  const activeKey = opts.key !== undefined ? validateKey(opts.key) : validateKey(ctx.key);
  const harness = opts.harness !== undefined ? validateHarness(opts.harness) : ctx.harness;
  const model = opts.model !== undefined ? validateModel(opts.model) : ctx.model;
  const fields = { key: activeKey };
  if (opts.step !== undefined && opts.step !== null && opts.step !== "") {
    const stepNum = Number(opts.step);
    if (!Number.isInteger(stepNum) || stepNum <= 0) {
      throw new DeskApiError("step must be a positive integer.");
    }
    fields.step = String(stepNum);
  }
  if (opts.another) fields.another = "1";
  if (harness) fields.harness = harness;
  if (model) fields.model = model;
  return fields;
}

async function getSteps(ctx, slug) {
  const problem = validateSlug(slug, "problem");
  let res;
  try {
    res = await ctx.fetchImpl(`${ctx.baseUrl}/p/${encodeURIComponent(problem)}/steps.json`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    throw new DeskApiError(err?.message || "Network request failed", { key: ctx.key || "" });
  }
  return parseJsonResponse(res, ctx.key || "");
}

/**
 * Creates a fetch-based Swarmdesk HTTP API client.
 */
export function createClient({ url, key, harness, model, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }
  const ctx = {
    fetchImpl,
    baseUrl: validateUrl(url),
    key: key !== undefined ? validateKey(key) : undefined,
    harness: validateHarness(harness),
    model: validateModel(model),
  };
  return {
    baseUrl: ctx.baseUrl,
    async claim(slug, opts = {}) {
      const problem = validateSlug(slug, "problem");
      const fields = claimFields(ctx, opts);
      return postForm(ctx, `/p/${encodeURIComponent(problem)}/desk/next`, fields, fields.key);
    },
    async beat(leaseId) {
      return postForm(ctx, "/desk/beat", { lease: validateLeaseId(leaseId) }, ctx.key || "");
    },
    async release(leaseId, reason) {
      const fields = { lease: validateLeaseId(leaseId), reason: validateReleaseReason(reason) };
      return postForm(ctx, "/desk/release", fields, ctx.key || "");
    },
    getSteps: (slug) => getSteps(ctx, slug),
  };
}
