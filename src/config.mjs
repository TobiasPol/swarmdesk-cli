export const KEY_RE = /^sd_[0-9a-f]{32}$/;
export const KEY_GLOBAL_RE = /\bsd_[0-9a-f]{32}\b/gi;
export const DEFAULT_URL = "https://joinswarmdesk.com";

export const ALLOWED_HARNESSES = Object.freeze([
  "claude-code",
  "codex",
  "gemini-cli",
  "opencode",
  "aider",
  "cursor",
  "goose",
  "swarmdesk-loop",
  "custom",
]);

const HARNESS_SET = new Set(ALLOWED_HARNESSES);
export const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,63}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class ConfigError extends Error {
  constructor(message) {
    super(redactKey(message));
    this.name = "ConfigError";
  }
}

/**
 * Redacts any Swarmdesk desk key (`sd_<32 hex chars>`) and an optional explicit key
 * from arbitrary text so credentials can never leak to stdout, stderr, files, or LLM context.
 */
export function redactKey(input, extraKey = "") {
  if (input === null || input === undefined) return "";
  let text = typeof input === "string" ? input : String(input);
  text = text.replace(KEY_GLOBAL_RE, "sd_[REDACTED]");
  if (typeof extraKey === "string" && extraKey.length > 0) {
    text = text.split(extraKey).join("sd_[REDACTED]");
    const encoded = encodeURIComponent(extraKey);
    if (encoded !== extraKey) {
      text = text.split(encoded).join("sd_[REDACTED]");
    }
  }
  return text;
}

/**
 * Recursively strips/redacts `sd_` credentials from JSON-serializable values.
 */
export function redactValue(value, extraKey = "") {
  if (typeof value === "string") return redactKey(value, extraKey);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, extraKey));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "key" && typeof v === "string" && (KEY_RE.test(v.trim()) || v === extraKey)) {
        out[k] = "sd_[REDACTED]";
      } else {
        out[k] = redactValue(v, extraKey);
      }
    }
    return out;
  }
  return value;
}

export function safeErrorMessage(err, extraKey = "") {
  const msg = err instanceof Error ? err.message : String(err ?? "unknown error");
  return redactKey(msg, extraKey);
}

export function validateKey(raw) {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) {
    throw new ConfigError("SWARMDESK_KEY is required (format: sd_<32 lowercase hex chars>).");
  }
  if (!KEY_RE.test(key)) {
    throw new ConfigError("Invalid SWARMDESK_KEY format (expected ^sd_[0-9a-f]{32}$).");
  }
  return key;
}

export function validateUrl(raw) {
  const candidate = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ConfigError(`Invalid SWARMDESK_URL: ${redactKey(candidate)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("SWARMDESK_URL must use http: or https:.");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

export function validateHarness(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (!HARNESS_SET.has(normalized)) {
    throw new ConfigError(
      `Invalid SWARMDESK_HARNESS "${redactKey(normalized)}". Allowed: ${ALLOWED_HARNESSES.join(", ")}`,
    );
  }
  return normalized;
}

export function validateModel(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const trimmed = String(raw).trim();
  if (!MODEL_RE.test(trimmed)) {
    throw new ConfigError(
      "Invalid SWARMDESK_MODEL (expected 1-64 identifier chars: letters, digits, ., _, :, /, -).",
    );
  }
  return trimmed;
}

export function validateSlug(raw, label = "problem") {
  const slug = typeof raw === "string" ? raw.trim() : "";
  if (!SLUG_RE.test(slug)) {
    throw new ConfigError(`Invalid ${label} slug "${redactKey(slug)}".`);
  }
  return slug;
}

export function loadConfig(env = process.env, { requireKey = true } = {}) {
  const rawKey = env?.SWARMDESK_KEY;
  const key =
    requireKey || (typeof rawKey === "string" && rawKey.trim() !== "")
      ? validateKey(rawKey)
      : undefined;
  const url = validateUrl(env?.SWARMDESK_URL);
  const harness = validateHarness(env?.SWARMDESK_HARNESS);
  const model = validateModel(env?.SWARMDESK_MODEL);
  return { key, url, harness, model };
}
