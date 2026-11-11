import { query, queryOne, queryRows } from "../config/db.js";
import logger from "../config/logger.js";
import env from "../config/env.js";

/**
 * Structured platform settings.
 *
 * `system_settings` is the existing key/value store; this service gives it a
 * typed, validated shape so the admin console can present real forms instead of
 * a raw JSON editor. Two rules matter:
 *
 *   1. Defaults are always returned, even when a row is missing, so a feature
 *      never breaks because an operator deleted a setting.
 *   2. Nothing secret is stored here. Provider keys and SMTP credentials stay in
 *      environment variables and are reported only as present/absent.
 *
 * Reads are cached briefly (10s) because maintenance and registration checks sit
 * on hot request paths; every write invalidates the cache immediately.
 */

const CACHE_TTL_MS = 10_000;

const DEFAULTS = Object.freeze({
  "platform.general": {
    name: "TWIGANE",
    description: "A collaborative study-group platform for university students.",
    supportEmail: "",
    maintenanceBanner: "",
  },
  "registration.settings": {
    enabled: true,
    allowedDomains: [],
    requireEmailVerification: false,
  },
  "security.settings": {
    passwordMinLength: 8,
    sessionIdleMinutes: 30,
    maxLoginAttempts: 5,
    rateLimitPerMinute: 300,
  },
  "maintenance.settings": {
    enabled: false,
    message: "TWIGANE is temporarily unavailable for scheduled maintenance. Please check back shortly.",
  },
  "notifications.settings": {
    platformNotificationsEnabled: true,
    emailDeliveryEnabled: false,
  },
  "ai.runtime": {
    assistantEnabled: true,
    matchingEnabled: true,
    maxRequestsPerHour: 60,
    timeoutMs: 25_000,
    maxFailoverAttempts: 3,
    fallbackEnabled: true,
    failureThreshold: 3,
    recoveryCooldownMs: 30_000,
  },
  "ai.web": {
    // The environment flag remains the hard deployment-level gate. These
    // defaults let an enabled deployment be configured from the admin console.
    enabled: true,
    defaultMode: env.AI_WEB_RESEARCH_DEFAULT_MODE,
    maxQueries: env.AI_WEB_RESEARCH_MAX_QUERIES,
    maxResults: env.AI_WEB_RESEARCH_MAX_RESULTS,
    timeoutMs: env.AI_WEB_RESEARCH_TIMEOUT_MS,
    maxContextChars: env.AI_WEB_RESEARCH_MAX_CONTEXT_CHARS,
    cacheTtlMin: env.AI_WEB_RESEARCH_CACHE_TTL_MIN,
    maxRequestsPerHour: env.AI_WEB_RESEARCH_MAX_REQUESTS_PER_HOUR,
    country: env.AI_WEB_RESEARCH_COUNTRY,
    language: env.AI_WEB_RESEARCH_LANGUAGE,
    safeSearch: env.AI_WEB_RESEARCH_SAFESEARCH,
    allowlistDomains: String(env.AI_WEB_RESEARCH_ALLOWLIST_DOMAINS ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    blocklistDomains: String(env.AI_WEB_RESEARCH_BLOCKLIST_DOMAINS ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean),
  },
  "recommendation.runtime": {
    algorithm: env.RECOMMENDATION_ALGORITHM,
    personalizationEnabled: env.RECOMMENDATION_PERSONALIZATION_ENABLED === "true",
    minPersonalizationEvents: env.RECOMMENDATION_MIN_PERSONALIZATION_EVENTS,
    maxPersonalizationAdjustment: env.RECOMMENDATION_MAX_PERSONALIZATION_ADJUSTMENT,
    explorationRate: env.RECOMMENDATION_EXPLORATION_RATE,
  },
  "academic.settings": {
    semesters: ["Semester 1", "Semester 2"],
    academicYear: "2025/2026",
  },
});

export const SETTING_KEYS = Object.freeze(Object.keys(DEFAULTS));

let cache = { loadedAt: 0, values: null, pending: null };

function defaultsCopy() {
  const out = {};
  for (const [key, value] of Object.entries(DEFAULTS)) out[key] = structuredClone(value);
  return out;
}

/** Merge stored values over defaults without letting a stored row drop keys. */
function merge(key, stored) {
  const base = DEFAULTS[key] ?? {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return structuredClone(base);
  return { ...structuredClone(base), ...stored };
}

async function loadAll() {
  const rows = await queryRows("SELECT key, value FROM system_settings", [], "settings:loadAll");
  const values = defaultsCopy();
  for (const row of rows) {
    if (values[row.key] === undefined) continue;
    values[row.key] = merge(row.key, row.value);
  }
  return values;
}

async function cachedValues() {
  const now = Date.now();
  if (cache.values && now - cache.loadedAt < CACHE_TTL_MS) return cache.values;
  if (cache.pending) return cache.pending;

  cache.pending = loadAll()
    .then((values) => {
      cache = { loadedAt: Date.now(), values, pending: null };
      return values;
    })
    .catch((error) => {
      // A settings read failure must not take registration or the API down.
      // Falling back to defaults is safe: every default is the conservative,
      // feature-preserving choice.
      logger.warn("Settings load failed; using defaults", { message: error.message });
      cache = { loadedAt: Date.now(), values: defaultsCopy(), pending: null };
      return cache.values;
    });

  return cache.pending;
}

export function invalidateSettingsCache() {
  cache = { loadedAt: 0, values: null, pending: null };
}

/** All structured settings, merged over defaults. */
export async function getSettings() {
  return cachedValues();
}

export async function getSection(key) {
  const values = await cachedValues();
  return values[key] ?? structuredClone(DEFAULTS[key] ?? {});
}

export async function getRawSettings() {
  const rows = await queryRows(
    `SELECT s.key, s.value, s.description, s.updated_at,
            u.first_name AS updated_by_first_name, u.last_name AS updated_by_last_name
       FROM system_settings s
       LEFT JOIN users u ON u.id = s.updated_by
      ORDER BY s.key`,
    [],
    "settings:raw",
  );
  return rows;
}

/**
 * Write a whole structured section. The caller validates the shape first; this
 * only persists and invalidates the cache.
 */
export async function setSection(key, value, { updatedBy = null, description = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    const error = new Error("That setting section is not recognised.");
    error.status = 422;
    error.code = "UNKNOWN_SETTING";
    throw error;
  }

  const current = await getSection(key);
  const merged = { ...current, ...value };

  const row = await queryOne(
    `INSERT INTO system_settings (key, value, description, updated_by)
     VALUES ($1, $2::jsonb, COALESCE($3, 'Updated from the administrative console.'), $4)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           description = COALESCE($3, system_settings.description),
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
     RETURNING key, value, description, updated_at`,
    [key, JSON.stringify(merged), description, updatedBy],
    "settings:setSection",
  );

  invalidateSettingsCache();
  return row;
}

/** Register the default rows on a database that predates migration 021. */
export async function ensureSettings() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await query(
      `INSERT INTO system_settings (key, value, description)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value), `Default configuration for ${key}.`],
      "settings:ensure",
    );
  }
  invalidateSettingsCache();
}

/** Maintenance gate used by request middleware. */
export async function maintenanceState() {
  const section = await getSection("maintenance.settings");
  return {
    enabled: Boolean(section.enabled),
    message: section.message || DEFAULTS["maintenance.settings"].message,
  };
}

/** Registration policy used by the auth service. */
export async function registrationPolicy() {
  const section = await getSection("registration.settings");
  return {
    enabled: section.enabled !== false,
    allowedDomains: Array.isArray(section.allowedDomains)
      ? section.allowedDomains.map((domain) => String(domain).trim().toLowerCase()).filter(Boolean)
      : [],
    requireEmailVerification: Boolean(section.requireEmailVerification),
  };
}

export async function aiRuntime() {
  const section = await getSection("ai.runtime");
  return {
    assistantEnabled: section.assistantEnabled !== false,
    matchingEnabled: section.matchingEnabled !== false,
    maxRequestsPerHour: Math.min(1000, Math.max(1, Number(section.maxRequestsPerHour) || 60)),
    timeoutMs: Math.min(120_000, Math.max(1000, Number(section.timeoutMs) || 25_000)),
    maxFailoverAttempts: Math.min(20, Math.max(1, Number(section.maxFailoverAttempts) || 3)),
    fallbackEnabled: section.fallbackEnabled !== false,
    failureThreshold: Math.min(20, Math.max(1, Number(section.failureThreshold) || 3)),
    recoveryCooldownMs: Math.min(3_600_000, Math.max(1000, Number(section.recoveryCooldownMs) || 30_000)),
  };
}

export async function aiWebSearch() {
  const section = await getSection("ai.web");
  return {
    enabled: section.enabled !== false,
    defaultMode: section.defaultMode ?? env.AI_WEB_RESEARCH_DEFAULT_MODE,
    maxQueries: Math.min(5, Math.max(1, Number(section.maxQueries) || env.AI_WEB_RESEARCH_MAX_QUERIES)),
    maxResults: Math.min(20, Math.max(1, Number(section.maxResults) || env.AI_WEB_RESEARCH_MAX_RESULTS)),
    timeoutMs: Math.min(30_000, Math.max(1000, Number(section.timeoutMs) || env.AI_WEB_RESEARCH_TIMEOUT_MS)),
    maxContextChars: Math.min(100_000, Math.max(1000, Number(section.maxContextChars) || env.AI_WEB_RESEARCH_MAX_CONTEXT_CHARS)),
    cacheTtlMin: Math.min(1440, Math.max(0, Number(section.cacheTtlMin) || 0)),
    maxRequestsPerHour: Math.min(10_000, Math.max(1, Number(section.maxRequestsPerHour) || env.AI_WEB_RESEARCH_MAX_REQUESTS_PER_HOUR)),
    country: String(section.country ?? env.AI_WEB_RESEARCH_COUNTRY).toUpperCase(),
    language: String(section.language ?? env.AI_WEB_RESEARCH_LANGUAGE).toLowerCase(),
    safeSearch: section.safeSearch ?? env.AI_WEB_RESEARCH_SAFESEARCH,
    allowlistDomains: Array.isArray(section.allowlistDomains) ? section.allowlistDomains : [],
    blocklistDomains: Array.isArray(section.blocklistDomains) ? section.blocklistDomains : [],
  };
}

export default {
  SETTING_KEYS,
  getSettings,
  getSection,
  getRawSettings,
  setSection,
  ensureSettings,
  invalidateSettingsCache,
  maintenanceState,
  registrationPolicy,
  aiRuntime,
  aiWebSearch,
};
