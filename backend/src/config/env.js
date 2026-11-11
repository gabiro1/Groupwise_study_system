import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated runtime configuration.
 *
 * Nothing else in the codebase is allowed to read `process.env` directly, so
 * that a missing/invalid variable fails fast at boot instead of at request time.
 */

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  APP_NAME: z.string().default("Lien API"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(50).default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  DATABASE_SSL_REJECT_UNAUTHORIZED: z.enum(["true", "false"]).default("false"),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  /** Run pending migrations during boot. Off by default: production should migrate as a release step. */
  RUN_MIGRATIONS_ON_BOOT: z.enum(["true", "false"]).default("false"),

  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),

  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  LOG_PRETTY: z.enum(["true", "false"]).default("false"),

  UPLOAD_DIR: z.string().default("./storage/uploads"),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  SERVE_UPLOADS_LOCALLY: z.enum(["true", "false"]).default("true"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("Lien <no-reply@lien.local>"),
  RESEND_API_KEY: z.string().optional(),
  SUPPORT_EMAIL: z.string().email().default("jogabiro181@gmail.com"),

  AI_PROVIDER: z.enum(["openai", "anthropic", "none"]).default("none"),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_CHAT_MODEL: z.string().default("gpt-4o-mini"),
  AI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(900),
  AI_CACHE_TTL_MIN: z.coerce.number().int().positive().default(30),
  // Required only when database-managed AI providers are used. The value is
  // hashed into a 256-bit AES key and is never returned by an API endpoint.
  AI_CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),
  // Optional ordered failover chain, as a JSON array. Each entry is either
  //   { provider, adapter?, label?, baseUrl, apiKey, models: [...] }
  // or the single-model form { ..., model: "..." }. Targets are tried in order:
  // the primary (AI_PROVIDER) first, then each fallback model. See registry.js.
  AI_FALLBACKS: z.string().optional(),

  // Web research is an independent, opt-in capability. Missing keys never
  // prevent the application from starting; the registry reports it as disabled.
  AI_WEB_RESEARCH_ENABLED: z.enum(["true", "false"]).default("false"),
  AI_WEB_RESEARCH_DEFAULT_MODE: z.enum(["LOCAL", "WEB", "BOTH", "AUTO"]).default("LOCAL"),
  AI_WEB_RESEARCH_MAX_QUERIES: z.coerce.number().int().positive().max(5).default(2),
  AI_WEB_RESEARCH_MAX_RESULTS: z.coerce.number().int().positive().max(20).default(8),
  AI_WEB_RESEARCH_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(10_000),
  AI_WEB_RESEARCH_MAX_CONTEXT_CHARS: z.coerce.number().int().positive().max(100_000).default(24_000),
  AI_WEB_RESEARCH_CACHE_TTL_MIN: z.coerce.number().int().min(0).max(1440).default(30),
  AI_WEB_RESEARCH_MAX_REQUESTS_PER_HOUR: z.coerce.number().int().positive().max(10_000).default(20),
  AI_WEB_RESEARCH_COUNTRY: z.string().trim().regex(/^[A-Za-z]{2}$/, "AI_WEB_RESEARCH_COUNTRY must be an ISO two-letter code.").default("RW"),
  AI_WEB_RESEARCH_LANGUAGE: z.string().trim().min(2).max(12).default("en"),
  AI_WEB_RESEARCH_SAFESEARCH: z.enum(["off", "moderate", "strict"]).default("strict"),
  AI_WEB_RESEARCH_ALLOWLIST_DOMAINS: z.string().default(""),
  AI_WEB_RESEARCH_BLOCKLIST_DOMAINS: z.string().default(""),
  AI_WEB_RESEARCH_STORE_RAW_CONTENT: z.enum(["true", "false"]).default("false"),

  WEB_SEARCH_PROVIDER: z.enum(["none", "brave", "tavily"]).default("brave"),
  WEB_SEARCH_FALLBACK_PROVIDER: z.enum(["none", "brave", "tavily"]).default("tavily"),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  BRAVE_SEARCH_BASE_URL: z.string().url().default("https://api.search.brave.com/res/v1"),
  TAVILY_API_KEY: z.string().optional(),
  TAVILY_BASE_URL: z.string().url().default("https://api.tavily.com"),

  // Recommendation learning is opt-in. The deterministic weighted scorer is
  // still used when any learned-model gate is missing or unsafe.
  RECOMMENDATION_ALGORITHM: z.enum(["WEIGHTED_SCORING", "LEARNING_TO_RANK"]).default("WEIGHTED_SCORING"),
  RECOMMENDATION_PERSONALIZATION_ENABLED: z.enum(["true", "false"]).default("false"),
  RECOMMENDATION_MODEL_SERVICE_URL: z.union([z.literal(""), z.string().url()]).default(""),
  RECOMMENDATION_MODEL_SERVICE_TOKEN: z.string().optional(),
  RECOMMENDATION_MODEL_TIMEOUT_MS: z.coerce.number().int().positive().max(10_000).default(1500),
  RECOMMENDATION_MIN_TRAINING_REQUESTS: z.coerce.number().int().positive().default(500),
  RECOMMENDATION_MIN_TRAINING_STUDENTS: z.coerce.number().int().positive().default(100),
  RECOMMENDATION_MIN_LABELLED_ROWS: z.coerce.number().int().positive().default(10_000),
  RECOMMENDATION_MIN_POSITIVE_OUTCOMES: z.coerce.number().int().positive().default(100),
  RECOMMENDATION_MIN_NEGATIVE_OUTCOMES: z.coerce.number().int().positive().default(100),
  RECOMMENDATION_MIN_INTERACTIONS: z.coerce.number().int().positive().default(20),
  RECOMMENDATION_MIN_COURSES: z.coerce.number().int().positive().default(5),
  RECOMMENDATION_MIN_LABEL_DIVERSITY: z.coerce.number().int().min(2).max(7).default(3),
  RECOMMENDATION_MAX_PERSONALIZATION_ADJUSTMENT: z.coerce.number().positive().max(20).default(4),
  RECOMMENDATION_MIN_PERSONALIZATION_EVENTS: z.coerce.number().int().positive().default(5),
  RECOMMENDATION_EXPLORATION_RATE: z.coerce.number().min(0).max(0.2).default(0),
  RECOMMENDATION_MODEL_CACHE_TTL_MIN: z.coerce.number().int().min(0).max(1440).default(10),

  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  // Virtual meetings (LiveKit). All three keyed together: the application refuses
  // to hand out meeting tokens until a provider URL, key and secret are present.
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 2),

  // Video meetings (Jitsi — modular provider).
  // The frontend embeds the Jitsi Meet IFrame API from this domain. The public
  // meet.jit.si service is for testing only — production should use Jitsi-as-a-
  // Service or a self-hosted deployment (see docs/video-meetings.md).
  JITSI_DOMAIN: z.string().trim().min(1).default("meet.jit.si"),
  JITSI_APP_ID: z.string().trim().optional(),
  // Optional JWT signing secret for self-hosted Jitsi with token auth.
  // NEVER exposed to the browser; only used server-side to sign tokens.
  JITSI_JWT_SECRET: z.string().optional(),
  JITSI_JWT_APP_ID: z.string().optional(),
  JITSI_ROOM_PREFIX: z.string().trim().default("twigane"),
  VIDEO_PROVIDER_DEFAULT: z.enum(["JITSI", "LIVEKIT", "GOOGLE_MEET", "NONE"]).default("JITSI"),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AI_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(15),
  SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  WRITE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  SEED_DEMO_DATA: z.enum(["true", "false"]).default("false"),
});

/**
 * Normalise the CORS allowlist.
 *
 * Browsers compare origins exactly, so `https://app.example.com/` and
 * `https://app.example.com` must resolve to the same entry. Paths are rejected
 * because an Origin header never contains one. A wildcard is always refused:
 * combined with credentials it is unsafe, and the allowlist is small enough to
 * spell out.
 */
function normalizeOrigins(value, { production }) {
  const origins = [];

  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    if (trimmed === "*") {
      throw new Error("wildcard origins are not allowed; list each frontend origin explicitly.");
    }

    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`"${trimmed}" is not a valid URL.`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`"${trimmed}" must use http or https.`);
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`"${trimmed}" must be an origin only (for example https://app.example.com).`);
    }

    origins.push(url.origin);
  }

  if (!origins.length && production) {
    throw new Error("at least one frontend origin is required in production.");
  }

  return [...new Set(origins)];
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

const raw = parsed.data;

let corsOrigins;
try {
  corsOrigins = normalizeOrigins(raw.CORS_ORIGINS, { production: raw.NODE_ENV === "production" });
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n  - CORS_ORIGINS: ${error.message}\n`);
  process.exit(1);
}

/** Count models in the optional AI_FALLBACKS JSON, tolerating malformed input. */
function countAiFallbackModels(value) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return 0;
    return parsed.reduce((count, entry) => {
      if (!entry || typeof entry !== "object") return count;
      if (Array.isArray(entry.models)) return count + entry.models.filter(Boolean).length;
      return entry.model ? count + 1 : count;
    }, 0);
  } catch {
    return 0;
  }
}

const primaryAiConfigured = raw.AI_PROVIDER !== "none" && Boolean(raw.AI_API_KEY);

export const env = Object.freeze({
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isTest: raw.NODE_ENV === "test",
  corsOrigins,
  databaseSsl: raw.DATABASE_SSL === "true",
  databaseSslRejectUnauthorized: raw.DATABASE_SSL_REJECT_UNAUTHORIZED === "true",
  trustProxy: raw.TRUST_PROXY === "true",
  serveUploadsLocally: raw.SERVE_UPLOADS_LOCALLY === "true",
  cookieSecure: raw.COOKIE_SECURE === "true",
  prettyLogs: raw.LOG_PRETTY === "true",
  aiEnabled: primaryAiConfigured || countAiFallbackModels(raw.AI_FALLBACKS) > 0,
  webSearchEnabled: raw.AI_WEB_RESEARCH_ENABLED === "true",
  livekitConfigured: Boolean(raw.LIVEKIT_URL && raw.LIVEKIT_API_KEY && raw.LIVEKIT_API_SECRET),
  jitsiDomain: raw.JITSI_DOMAIN,
  jitsiRoomPrefix: raw.JITSI_ROOM_PREFIX,
  videoProviderDefault: raw.VIDEO_PROVIDER_DEFAULT,
});

export default env;
