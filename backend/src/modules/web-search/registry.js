import env from "../../config/env.js";

const PROVIDERS = Object.freeze({
  brave: { provider: "brave", baseUrl: env.BRAVE_SEARCH_BASE_URL, apiKey: env.BRAVE_SEARCH_API_KEY },
  tavily: { provider: "tavily", baseUrl: env.TAVILY_BASE_URL, apiKey: env.TAVILY_API_KEY },
});

let cachedTargets = null;

function targetFor(provider, fallback = {}) {
  const config = PROVIDERS[provider];
  if (!config || !config.apiKey || !config.baseUrl) return null;
  return {
    provider,
    baseUrl: fallback.baseUrl ?? config.baseUrl,
    apiKey: fallback.apiKey ?? config.apiKey,
  };
}

export function getSearchTargets() {
  if (cachedTargets) return cachedTargets;
  const targets = [];
  if (env.WEB_SEARCH_PROVIDER !== "none") {
    const primary = targetFor(env.WEB_SEARCH_PROVIDER);
    if (primary) targets.push(primary);
  }
  if (env.WEB_SEARCH_FALLBACK_PROVIDER !== "none" && env.WEB_SEARCH_FALLBACK_PROVIDER !== env.WEB_SEARCH_PROVIDER) {
    const fallback = targetFor(env.WEB_SEARCH_FALLBACK_PROVIDER);
    if (fallback) targets.push(fallback);
  }
  cachedTargets = targets;
  return cachedTargets;
}

export function getSearchProviderStatus() {
  const targets = getSearchTargets();
  return {
    provider: targets[0]?.provider ?? null,
    configured: targets.length > 0,
    fallbacks: targets.slice(1).map((target) => target.provider),
  };
}

export function resetSearchRegistry() {
  cachedTargets = null;
}
