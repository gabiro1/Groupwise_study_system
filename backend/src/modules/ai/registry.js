import env from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * AI provider registry.
 *
 * Providers are enabled on *config* (a provider name + an API key), never on
 * credentials alone, so a half-configured deployment cannot authenticate an
 * upstream request. The registry advertises only targets that are fully
 * configured; anything else is treated as unconfigured by the orchestration
 * layer below.
 */
const PROVIDER_CONFIGS = {
  openai: {
    key: "openai",
    label: "OpenAI compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    prepare: (config) => {
      const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
      return { ...config, baseUrl };
    },
    health: {
      path: "/health",
      timeoutMs: 2000,
    },
  },
  anthropic: {
    key: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    prepare: (config) => {
      const baseUrl = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
      return { ...config, baseUrl };
    },
    health: {
      path: "/v1/models",
      timeoutMs: 3000,
    },
  },
};

/** Map env.AI_PROVIDER -> registry key so the config layer can reject unknown values. */
const PROVIDER_KEYS = new Set(Object.keys(PROVIDER_CONFIGS));

/** Returns the resolved config for a provider, or null when unconfigured. */
export function getProviderConfig(provider = env.AI_PROVIDER) {
  if (!provider || !PROVIDER_KEYS.has(provider)) return null;
  const raw = {
    provider,
    apiKey: env.AI_API_KEY,
    baseUrl: env.AI_BASE_URL,
    chatModel: env.AI_CHAT_MODEL,
    embeddingModel: env.AI_EMBEDDING_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
  };
  return { ...PROVIDER_CONFIGS[provider], config: PROVIDER_CONFIGS[provider].prepare(raw) };
}

/** Parse the optional AI_FALLBACKS JSON array, tolerating malformed input. */
function parseFallbacks() {
  if (!env.AI_FALLBACKS) return [];
  let parsed;
  try {
    parsed = JSON.parse(env.AI_FALLBACKS);
  } catch (error) {
    logger.warn("AI_FALLBACKS is not valid JSON; ignoring the failover chain", {
      message: error.message,
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn("AI_FALLBACKS must be a JSON array; ignoring the failover chain");
    return [];
  }
  return parsed.filter((entry) => entry && typeof entry === "object");
}

/** Resolve which transport adapter a fallback entry uses. */
function resolveAdapter(entry) {
  if (entry.adapter && PROVIDER_CONFIGS[entry.adapter]) return entry.adapter;
  if (entry.provider && PROVIDER_CONFIGS[entry.provider]) return entry.provider;
  return "openai";
}

/**
 * The ordered list of AI targets to try, primary first then each fallback.
 *
 * Each target carries everything an adapter needs to make one call, plus a
 * stable `id` (used to key the per-target circuit breaker and logs) and a
 * human `label`. The list is computed once because env is frozen at boot.
 */
let cachedTargets = null;

export function getTargets() {
  if (cachedTargets) return cachedTargets;

  const targets = [];

  const primary = getProviderConfig(env.AI_PROVIDER);
  if (primary) {
    const config = primary.config;
    targets.push({
      id: `${config.provider}:${config.chatModel}`,
      provider: config.provider,
      label: primary.label,
      adapter: primary.key,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      chatModel: config.chatModel,
      timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
    });
  }

  for (const entry of parseFallbacks()) {
    const adapter = resolveAdapter(entry);
    const provider = entry.provider ?? adapter;
    const baseUrl = String(
      entry.baseUrl ?? PROVIDER_CONFIGS[adapter]?.defaultBaseUrl ?? "",
    ).replace(/\/$/, "");
    const models = Array.isArray(entry.models)
      ? entry.models
      : entry.model
        ? [entry.model]
        : [];

    for (const model of models) {
      if (!model) continue;
      targets.push({
        id: `${provider}:${model}`,
        provider,
        label: entry.label ?? PROVIDER_CONFIGS[adapter]?.label ?? provider,
        adapter,
        apiKey: entry.apiKey ?? env.AI_API_KEY,
        baseUrl,
        chatModel: model,
        timeoutMs: entry.timeoutMs ?? env.AI_TIMEOUT_MS,
        maxOutputTokens: entry.maxOutputTokens ?? env.AI_MAX_OUTPUT_TOKENS,
      });
    }
  }

  cachedTargets = targets.filter((target) => target.apiKey && target.baseUrl);
  return cachedTargets;
}

/** Whether any target is fully configured (provider + API key). */
export function isConfigured() {
  return getTargets().length > 0;
}

/** All distinct provider keys that are fully configured at runtime. */
export function configuredKeys() {
  return [...new Set(getTargets().map((target) => target.provider))];
}

/** Human-readable provider id for the admin/health payload (primary target). */
export function configuredId() {
  return getTargets()[0]?.provider ?? null;
}

/** Provider label, or null when no provider is configured. */
export function configuredLabel() {
  return getTargets()[0]?.label ?? null;
}

/** Chat model in use, or null when no provider is configured. */
export function configuredModel() {
  return getTargets()[0]?.chatModel ?? null;
}

/** Embedding model in use, or null when no provider is configured. */
export function configuredEmbeddingModel() {
  const config = getProviderConfig();
  return config ? config.config.embeddingModel : null;
}
