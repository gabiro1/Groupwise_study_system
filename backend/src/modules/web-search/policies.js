import env from "../../config/env.js";
import { getSection } from "../../services/settings.service.js";

const FRESHNESS_VALUES = new Set(["pd", "pw", "pm", "py"]);
const SOURCE_MODES = new Set(["LOCAL", "WEB", "BOTH", "AUTO"]);

function asBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function parseDomains(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(values
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .map((entry) => entry.replace(/^https?:\/\//, "").split("/")[0].replace(/^\.+|\.+$/g, ""))
    .filter((entry) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/.test(entry)))];
}

export function buildWebSearchPolicy(overrides = {}) {
  const requestedMode = String(overrides.defaultMode ?? env.AI_WEB_RESEARCH_DEFAULT_MODE).trim().toUpperCase();
  const policy = {
    enabled: asBoolean(overrides.enabled, env.AI_WEB_RESEARCH_ENABLED === "true"),
    defaultMode: SOURCE_MODES.has(requestedMode) ? requestedMode : "LOCAL",
    maxQueries: clampInt(overrides.maxQueries, env.AI_WEB_RESEARCH_MAX_QUERIES, 1, 5),
    maxResults: clampInt(overrides.maxResults, env.AI_WEB_RESEARCH_MAX_RESULTS, 1, 20),
    timeoutMs: clampInt(overrides.timeoutMs, env.AI_WEB_RESEARCH_TIMEOUT_MS, 1000, 30_000),
    maxContextChars: clampInt(overrides.maxContextChars, env.AI_WEB_RESEARCH_MAX_CONTEXT_CHARS, 1000, 100_000),
    cacheTtlMin: clampInt(overrides.cacheTtlMin, env.AI_WEB_RESEARCH_CACHE_TTL_MIN, 0, 1440),
    maxRequestsPerHour: clampInt(overrides.maxRequestsPerHour, env.AI_WEB_RESEARCH_MAX_REQUESTS_PER_HOUR, 1, 10_000),
    country: String(overrides.country ?? env.AI_WEB_RESEARCH_COUNTRY).trim().toLowerCase(),
    language: String(overrides.language ?? env.AI_WEB_RESEARCH_LANGUAGE).trim().toLowerCase(),
    safeSearch: overrides.safeSearch ?? env.AI_WEB_RESEARCH_SAFESEARCH,
    freshness: overrides.freshness ?? "",
    allowlist: parseDomains(overrides.allowlist ?? env.AI_WEB_RESEARCH_ALLOWLIST_DOMAINS),
    blocklist: parseDomains(overrides.blocklist ?? env.AI_WEB_RESEARCH_BLOCKLIST_DOMAINS),
    storeRawContent: asBoolean(overrides.storeRawContent, env.AI_WEB_RESEARCH_STORE_RAW_CONTENT === "true"),
  };

  // The environment flag is a hard safety gate. An administrator can disable
  // an enabled deployment, but cannot enable outbound research accidentally
  // while the deployment-level switch is false.
  policy.enabled = policy.enabled && env.AI_WEB_RESEARCH_ENABLED === "true";
  return Object.freeze(policy);
}

export async function getWebSearchPolicy() {
  const settings = await getSection("ai.web");
  return buildWebSearchPolicy({
    enabled: settings.enabled,
    defaultMode: settings.defaultMode,
    maxQueries: settings.maxQueries,
    maxResults: settings.maxResults,
    timeoutMs: settings.timeoutMs,
    maxContextChars: settings.maxContextChars,
    cacheTtlMin: settings.cacheTtlMin,
    maxRequestsPerHour: settings.maxRequestsPerHour,
    country: settings.country,
    language: settings.language,
    safeSearch: settings.safeSearch,
    allowlist: settings.allowlistDomains,
    blocklist: settings.blocklistDomains,
  });
}

export function isDomainAllowed(domain, { allowlist = [], blocklist = [] } = {}) {
  const value = String(domain ?? "").toLowerCase().replace(/^www\./, "");
  if (!value) return false;
  if (blocklist.some((blocked) => value === blocked.replace(/^www\./, "") || value.endsWith(`.${blocked.replace(/^www\./, "")}`))) {
    return false;
  }
  if (!allowlist.length) return true;
  return allowlist.some((allowed) => value === allowed.replace(/^www\./, "") || value.endsWith(`.${allowed.replace(/^www\./, "")}`));
}

export function filterSources(sources, policy) {
  return (Array.isArray(sources) ? sources : []).filter((source) => isDomainAllowed(source.domain, policy));
}

export function privacySafeQuery(input, { privateTerms = [] } = {}) {
  let query = String(input ?? "").trim();

  // A question may name a person immediately before referring to a private
  // group or message. Remove that proper-name phrase before removing the
  // private reference itself.
  query = query.replace(
    /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2}\s+(?=[^.!?;]{0,80}\b(?:my|our|the)\s+(?:private|personal|uploaded|shared|group|workspace)\b)/g,
    "",
  );

  // Remove a private-resource reference together with the identifying phrase
  // attached to it. The provider receives the public part of the question, not
  // a resource title, person's name, or private-message description.
  query = query.replace(
    /\b(?:my|our|the)\s+(?:private|personal|uploaded|shared|group|workspace)\s+(?:resource|note|file|message|chat|document|material|workspace|group)\b(?:\s+(?:about|from|by|called|named)\s+[^,.?!;]+)/gi,
    " ",
  );

  for (const term of [...new Set(privateTerms.map((value) => String(value ?? "").trim()).filter((value) => value.length >= 3))]
    .sort((left, right) => right.length - left.length)) {
    query = query.replace(new RegExp(escapeRegExp(term), "gi"), " ");
  }

  query = query
    .replace(/https?:\/\/[^\s)]+/gi, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, " ")
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, " ")
    .replace(/\b(?:my|our|the)\s+(?:private|personal|uploaded|shared|group|workspace)\s+(?:resource|note|file|message|chat|document|material|workspace)\b/gi, " ")
    .replace(/\b(?:email|phone|student\s+id|user\s+id)\s*[:=]?\s*[^\s,;]+/gi, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Brave documents a 600-character / 75-word query bound. Trimming here is
  // deterministic and prevents a user from turning a search into an upstream
  // payload-size or cost attack.
  query = query.split(/\s+/).slice(0, 75).join(" ").slice(0, 600).trim();
  return query;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normaliseSearchOptions(options = {}, policy = buildWebSearchPolicy()) {
  const requestedAllowlist = parseDomains(options.includeDomains);
  const configuredAllowlist = policy.allowlist;
  const allowlist = configuredAllowlist.length
    ? requestedAllowlist.length
      ? configuredAllowlist.filter((domain) => requestedAllowlist.includes(domain))
      : configuredAllowlist
    : requestedAllowlist;
  const blocklist = [...new Set([...policy.blocklist, ...parseDomains(options.excludeDomains)])];

  return {
    country: String(options.country ?? policy.country).trim().toLowerCase().slice(0, 2),
    language: String(options.language ?? policy.language).trim().toLowerCase().slice(0, 12),
    freshness: normaliseFreshness(options.freshness ?? policy.freshness),
    maxResults: clampInt(options.maxResults, policy.maxResults, 1, policy.maxResults),
    includeDomains: allowlist,
    excludeDomains: blocklist,
    safeSearch: policy.safeSearch,
    maxContextChars: policy.maxContextChars,
  };
}

function normaliseFreshness(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || FRESHNESS_VALUES.has(text) || /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return "";
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return Math.min(max, Math.max(min, Number(fallback)));
  return Math.min(max, Math.max(min, number));
}

export function shouldSearchAutomatically({ message, context } = {}) {
  const lower = String(message ?? "").toLowerCase();
  const asksForWeb = /\b(latest|current|recent|today|this\s+year|news|research|sources?|cite|citation|according\s+to|updated|as\s+of|what\s+is\s+new)\b/.test(lower);
  const chunkScores = (context?.chunks ?? []).map((entry) => Number(entry.score) || 0);
  const strongestLocal = chunkScores.length ? Math.max(...chunkScores) : 0;
  const hasNonResourceLocal = (context?.recentMessages?.length ?? 0) > 0 || (context?.platformContext?.length ?? 0) > 0;
  const localIsWeak = !chunkScores.length && !hasNonResourceLocal
    ? true
    : chunkScores.length > 0 && strongestLocal < 0.34;
  return asksForWeb || localIsWeak;
}
