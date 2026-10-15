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
  // Optional ordered failover chain, as a JSON array. Each entry is either
  //   { provider, adapter?, label?, baseUrl, apiKey, models: [...] }
  // or the single-model form { ..., model: "..." }. Targets are tried in order:
  // the primary (AI_PROVIDER) first, then each fallback model. See registry.js.
  AI_FALLBACKS: z.string().optional(),

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
  corsOrigins: raw.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  databaseSsl: raw.DATABASE_SSL === "true",
  databaseSslRejectUnauthorized: raw.DATABASE_SSL_REJECT_UNAUTHORIZED === "true",
  trustProxy: raw.TRUST_PROXY === "true",
  serveUploadsLocally: raw.SERVE_UPLOADS_LOCALLY === "true",
  cookieSecure: raw.COOKIE_SECURE === "true",
  prettyLogs: raw.LOG_PRETTY === "true",
  aiEnabled: primaryAiConfigured || countAiFallbackModels(raw.AI_FALLBACKS) > 0,
  livekitConfigured: Boolean(raw.LIVEKIT_URL && raw.LIVEKIT_API_KEY && raw.LIVEKIT_API_SECRET),
  jitsiDomain: raw.JITSI_DOMAIN,
  jitsiRoomPrefix: raw.JITSI_ROOM_PREFIX,
  videoProviderDefault: raw.VIDEO_PROVIDER_DEFAULT,
});

export default env;