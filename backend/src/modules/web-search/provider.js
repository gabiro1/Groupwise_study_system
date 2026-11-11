import crypto from "node:crypto";
import logger from "../../config/logger.js";
import { cloneSources } from "./normalise.js";
import { getSearchTargets } from "./registry.js";
import { braveAdapter } from "./brave.adapter.js";
import { tavilyAdapter } from "./tavily.adapter.js";
import { filterSources, normaliseSearchOptions, privacySafeQuery } from "./policies.js";
import { WebSearchError } from "./errors.js";

const ADAPTERS = Object.freeze({ brave: braveAdapter, tavily: tavilyAdapter });
const CACHE = new Map();
const REQUESTS_BY_ACTOR = new Map();

function queryHash(query) {
  return crypto.createHash("sha256").update(query).digest("hex").slice(0, 24);
}

export function hashSearchQuery(query, { privateTerms = [] } = {}) {
  return queryHash(privacySafeQuery(query, { privateTerms }));
}

function cacheKey(query, options) {
  return crypto.createHash("sha256").update(JSON.stringify({ query, options })).digest("hex");
}

function consumeActorBudget(actorId, maxRequestsPerHour) {
  if (!actorId) return;
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const recent = (REQUESTS_BY_ACTOR.get(actorId) ?? []).filter((timestamp) => timestamp > windowStart);
  if (recent.length >= maxRequestsPerHour) {
    throw new WebSearchError("You have reached the web research limit for this hour.", {
      code: "WEB_SEARCH_RATE_LIMITED",
      status: 429,
      context: { actorId, count: recent.length },
    });
  }
  recent.push(now);
  REQUESTS_BY_ACTOR.set(actorId, recent);
}

function clearExpiredCache(now = Date.now()) {
  for (const [key, entry] of CACHE.entries()) {
    if (entry.expiresAt <= now) CACHE.delete(key);
  }
}

/**
 * Provider-neutral web search. The caller supplies the already-resolved policy
 * so policy evaluation does not perform a database lookup in the provider layer.
 */
export async function searchWeb({
  query,
  country,
  language,
  freshness,
   maxResults,
   includeDomains,
   excludeDomains,
   safeSearch,
   privateTerms,
   actorId,
   policy,
 } = {}) {
  if (!policy?.enabled) {
    throw new WebSearchError("Web research is disabled.", { code: "WEB_SEARCH_DISABLED" });
  }

  const safeQuery = privacySafeQuery(query, { privateTerms });
  if (!safeQuery) {
    throw new WebSearchError("There is not enough public information to search for.", { code: "WEB_SEARCH_QUERY_EMPTY", status: 422 });
  }
  if (safeQuery.length > 600 || safeQuery.split(/\s+/).length > 75) {
    throw new WebSearchError("That research question is too long.", { code: "WEB_SEARCH_QUERY_TOO_LONG", status: 422 });
  }

  const options = normaliseSearchOptions({
    country,
    language,
    freshness,
    maxResults,
    includeDomains,
    excludeDomains,
    safeSearch,
  }, policy);
  const targets = getSearchTargets();
  if (!targets.length) {
    throw new WebSearchError("Web research is not configured.", { code: "WEB_SEARCH_UNAVAILABLE" });
  }

  clearExpiredCache();
  const key = cacheKey(safeQuery, options);
  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      sources: cloneSources(cached.sources),
      search: { ...cached.search, cached: true, latencyMs: 0 },
    };
  }

  consumeActorBudget(actorId, policy.maxRequestsPerHour);
  const startedAt = Date.now();
  const failures = [];
  let emptyResult = null;

  for (const [targetIndex, target] of targets.entries()) {
    const adapter = ADAPTERS[target.provider];
    if (!adapter) continue;
    try {
      const rawSources = await adapter.search(safeQuery, {
        ...options,
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        timeoutMs: policy.timeoutMs,
      });
      const sources = filterSources(rawSources, {
        allowlist: options.includeDomains,
        blocklist: options.excludeDomains,
      }).slice(0, options.maxResults);
      const search = {
        provider: target.provider,
        queryHash: queryHash(safeQuery),
        sourceCount: sources.length,
        latencyMs: Date.now() - startedAt,
        status: "SUCCESS",
        cached: false,
      };
      if (!sources.length && targetIndex < targets.length - 1) {
        emptyResult = { sources, search };
        continue;
      }
      if (policy.cacheTtlMin > 0) {
        CACHE.set(key, {
          sources: cloneSources(sources),
          search,
          expiresAt: Date.now() + policy.cacheTtlMin * 60 * 1000,
        });
      }
      return { sources, search };
    } catch (error) {
      failures.push(error);
      logger.warn("Web search target failed, falling through", {
        provider: target.provider,
        code: error.code ?? "WEB_SEARCH_ERROR",
      });
    }
  }

  if (emptyResult) return emptyResult;
  const last = failures[failures.length - 1];
  if (last instanceof WebSearchError) throw last;
  throw new WebSearchError("All web research providers are unavailable.", {
    code: "WEB_SEARCH_UNAVAILABLE",
    context: { providerCount: targets.length },
  });
}

export function getSearchCacheStats() {
  clearExpiredCache();
  return { entries: CACHE.size };
}

export function resetSearchState() {
  CACHE.clear();
  REQUESTS_BY_ACTOR.clear();
}
