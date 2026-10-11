import env from "./env.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Keys that must never be written to logs, even if they appear on an object.
 */
const REDACTED_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "resetToken",
  "emailtoken",
  "authorization",
  "cookie",
  "apikey",
  "ai_api_key",
  "secret",
  "sessionid",
]);

const SENSITIVE_PATTERNS = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: "[email]" },
  { pattern: /\bBearer\s+[\w.\-]+/gi, replace: "Bearer [redacted]" },
  { pattern: /\beyJ[\w.\-]+\.[\w.\-]+\.[\w.\-]+\b/g, replace: "[jwt]" },
];

/**
 * Recursively redact secrets and PII before a value reaches a log sink.
 * Email masking is intentional: logs are often shipped to third parties.
 */
export function redact(value, depth = 0) {
  if (depth > 6) return "[deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let output = value;
    for (const { pattern, replace } of SENSITIVE_PATTERNS) {
      output = output.replace(pattern, replace);
    }
    return output.length > 2000 ? `${output.slice(0, 2000)}…` : output;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function emit(level, message, context) {
  if (LEVELS[level] < LEVELS[env.LOG_LEVEL]) return;

  const record = {
    level,
    time: new Date().toISOString(),
    service: env.APP_NAME,
    ...(context && typeof context === "object" ? { context: redact(context) } : {}),
    ...(typeof context === "string" ? { msg: redact(context) } : {}),
  };

  const line = env.prettyLogs
    ? `${record.level.toUpperCase().padEnd(5)} ${record.time} ${record.context ? JSON.stringify(record.context) : record.msg ?? message}`
    : JSON.stringify({ ...record, msg: record.msg ?? message });

  const sink =
    level === "error"
      ? process.stderr
      : level === "warn"
        ? process.stderr
        : process.stdout;

  sink.write(`${line}\n`);
}

export const logger = {
  debug: (message, context) => emit("debug", message, context),
  info: (message, context) => emit("info", message, context),
  warn: (message, context) => emit("warn", message, context),
  error: (message, context) => emit("error", message, context),
  child(baseContext) {
    return {
      debug: (message, context) => emit("debug", message, { ...baseContext, ...context }),
      info: (message, context) => emit("info", message, { ...baseContext, ...context }),
      warn: (message, context) => emit("warn", message, { ...baseContext, ...context }),
      error: (message, context) => emit("error", message, { ...baseContext, ...context }),
    };
  },
};

export default logger;