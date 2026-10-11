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

  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

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
  aiEnabled: raw.AI_PROVIDER !== "none" && Boolean(raw.AI_API_KEY),
});

export default env;