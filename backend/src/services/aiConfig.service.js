import { queryRows, queryOne } from "../config/db.js";
import logger from "../config/logger.js";
import { aiRuntime } from "./settings.service.js";
import { getTargetsAsync } from "../modules/ai/registry.js";
import { callProvider, getCircuitSnapshot } from "../modules/ai/orchestration.js";
import { listProviders, markProviderTest, targetForProvider } from "./aiProvider.service.js";
import { getWebSearchPolicy } from "../modules/web-search/policies.js";
import { getSearchProviderStatus } from "../modules/web-search/registry.js";

/**
 * AI configuration and telemetry for the admin console.
 *
 * Boundary that is never crossed: credentials. The provider registry reads keys
 * from the environment, and this module reports only *metadata* — provider name,
 * model, failover order, circuit state and whether a key exists. There is no
 * endpoint that returns a key, masked or otherwise, because a masked key is still
 * a leak of its length and prefix.
 *
 * Runtime knobs (assistant on/off, matching on/off, request budget, timeout) are
 * persisted in `system_settings` under `ai.runtime` and applied on the next
 * request, so a misbehaving provider can be disabled without a redeploy.
 */

export async function aiConfiguration() {
  const runtime = await aiRuntime();
  const webPolicy = await getWebSearchPolicy();
  const webStatus = getSearchProviderStatus();
  const targets = await getTargetsAsync();
  const circuits = getCircuitSnapshot();
  const managedProviders = await listProviders().catch(() => []);
  const managedHealth = new Map(managedProviders.map((provider) => [provider.id, provider.health]));
  const status = {
    configured: targets.length > 0,
    provider: targets[0]?.provider ?? null,
    model: targets[0]?.chatModel ?? null,
    fallbacks: Math.max(0, targets.length - 1),
  };

  return {
    configured: status.configured,
    required: false,
    primary: status.provider ? { provider: status.provider, model: status.model } : null,
    providers: managedProviders,
    fallbacks: status.fallbacks,
    runtime,
    // Feature switches are reported separately from provider readiness: a
    // provider can be configured while the assistant is deliberately off.
    features: {
      assistant: { enabled: runtime.assistantEnabled, providerReady: status.configured },
      matching: { enabled: runtime.matchingEnabled, providerReady: status.configured },
    },
    webSearch: {
      ...webStatus,
      enabled: webPolicy.enabled,
      defaultMode: webPolicy.defaultMode,
      maxQueries: webPolicy.maxQueries,
      maxResults: webPolicy.maxResults,
      maxContextChars: webPolicy.maxContextChars,
      timeoutMs: webPolicy.timeoutMs,
      cacheTtlMin: webPolicy.cacheTtlMin,
      maxRequestsPerHour: webPolicy.maxRequestsPerHour,
      country: webPolicy.country,
      language: webPolicy.language,
      safeSearch: webPolicy.safeSearch,
      allowlistConfigured: webPolicy.allowlist.length > 0,
      allowlistDomains: webPolicy.allowlist,
      blocklistDomains: webPolicy.blocklist,
    },
    chain: targets.map((target) => ({
      id: target.id,
      provider: target.provider,
      label: target.label,
      model: target.chatModel,
      circuit: circuits[target.id]?.state ?? "CLOSED",
      failures: circuits[target.id]?.failures ?? 0,
      lastFailureAt: circuits[target.id]?.lastFailureAt ?? null,
      priority: target.priority ?? null,
      enabled: target.enabled !== false,
      providerId: target.providerId ?? null,
      averageLatencyMs: target.providerId ? managedHealth.get(target.providerId)?.averageLatencyMs ?? null : null,
      successRate: target.providerId ? managedHealth.get(target.providerId)?.successRate ?? null : null,
      consecutiveFailures: target.providerId ? managedHealth.get(target.providerId)?.consecutiveFailures ?? 0 : circuits[target.id]?.failures ?? 0,
      lastSuccessAt: target.providerId ? managedHealth.get(target.providerId)?.lastSuccessAt ?? null : null,
      lastFailureAt: target.providerId ? managedHealth.get(target.providerId)?.lastFailureAt ?? circuits[target.id]?.lastFailureAt ?? null : circuits[target.id]?.lastFailureAt ?? null,
    })),
    secretsExposed: false,
    note: "Database-managed credentials are encrypted at rest and only exposed as masked status. Environment providers remain supported as a compatibility fallback.",
  };
}

/**
 * Record one AI request. Deliberately best-effort: telemetry must never turn a
 * successful answer into a failed request.
 */
export async function recordAiUsage({
  feature,
  status,
  provider = null,
  model = null,
  latencyMs = null,
  errorCode = null,
  actorId = null,
  failoverCount = 0,
  usage = null,
}) {
  try {
    await queryOne(
      `INSERT INTO ai_usage_events
         (feature, provider, model, status, latency_ms, error_code, actor_id, failover_count,
          prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [feature, provider, model, status, latencyMs, errorCode, actorId, Number.isInteger(failoverCount) ? failoverCount : 0,
        usage?.prompt_tokens ?? usage?.promptTokens ?? null, usage?.completion_tokens ?? usage?.completionTokens ?? null,
        usage?.total_tokens ?? usage?.totalTokens ?? null],
      "ai:usage",
    );
  } catch (error) {
    logger.warn("Failed to record AI usage", { feature, status, message: error.message });
  }
}

/** Record only non-sensitive web-search routing metadata. */
export async function recordWebSearchAudit({
  actorId = null,
  sourceMode,
  provider = null,
  queryHash,
  searchCount = 1,
  sourceDomains = [],
  latencyMs = null,
  status,
  errorCode = null,
}) {
  try {
    await queryOne(
      `INSERT INTO ai_web_search_events
         (actor_id, source_mode, provider, query_hash, search_count, source_domains, latency_ms, status, error_code)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9)
       RETURNING id`,
      [actorId, sourceMode, provider, queryHash, searchCount, sourceDomains.slice(0, 20), latencyMs, status, errorCode],
      "ai:webSearchAudit",
    );
  } catch (error) {
    logger.warn("Failed to record web-search audit", { message: error.message, status, provider });
  }
}

/** Aggregate AI usage for the console and analytics pages. */
export async function aiUsageReport(range = 30) {
  const days = [7, 30, 90].includes(Number(range)) ? Number(range) : 30;
  const since = new Date(Date.now() - days * 86_400_000);

  const [totals, byFeature, byProvider, byModel, series, recent, conversations] = await Promise.all([
    queryOne(
      `SELECT count(*)::int AS requests,
              count(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
              count(*) FILTER (WHERE status = 'FAILURE')::int AS failed,
              count(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped,
              round(avg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::int AS avg_latency_ms,
              coalesce(sum(failover_count), 0)::int AS failovers,
              sum(total_tokens)::int AS total_tokens
         FROM ai_usage_events
        WHERE created_at >= $1`,
      [since],
      "ai:usageTotals",
    ),
    queryRows(
      `SELECT feature,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
              count(*) FILTER (WHERE status = 'FAILURE')::int AS failed,
              round(avg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::int AS avg_latency_ms
         FROM ai_usage_events
        WHERE created_at >= $1
        GROUP BY feature
        ORDER BY feature`,
      [since],
      "ai:usageByFeature",
    ),
    queryRows(
      `SELECT coalesce(provider, 'unknown') AS provider,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
              count(*) FILTER (WHERE status = 'FAILURE')::int AS failed,
              round(avg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::int AS avg_latency_ms,
              coalesce(sum(failover_count), 0)::int AS failovers
         FROM ai_usage_events
        WHERE created_at >= $1
        GROUP BY 1 ORDER BY requests DESC, provider`,
      [since],
      "ai:usageByProvider",
    ),
    queryRows(
      `SELECT coalesce(provider, 'unknown') AS provider, coalesce(model, 'unknown') AS model,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
              round(avg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::int AS avg_latency_ms,
              sum(total_tokens)::int AS total_tokens
         FROM ai_usage_events
        WHERE created_at >= $1
        GROUP BY 1, 2 ORDER BY requests DESC, provider, model`,
      [since],
      "ai:usageByModel",
    ),
    queryRows(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              count(*)::int AS requests,
              count(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
              count(*) FILTER (WHERE status = 'FAILURE')::int AS failed
         FROM ai_usage_events
        WHERE created_at >= $1
        GROUP BY 1 ORDER BY 1`,
      [since],
      "ai:usageSeries",
    ),
    queryRows(
      `SELECT id, feature, provider, model, status, latency_ms, error_code, failover_count,
              prompt_tokens, completion_tokens, total_tokens, estimated_cost, created_at
         FROM ai_usage_events
        ORDER BY created_at DESC
        LIMIT 25`,
      [],
      "ai:usageRecent",
    ),
    queryOne(
      `SELECT
         (SELECT count(*)::int FROM ai_conversations WHERE status <> 'DELETED') AS conversations,
         (SELECT count(*)::int FROM ai_messages WHERE deleted_at IS NULL) AS messages,
         (SELECT count(*)::int FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
           WHERE m.deleted_at IS NULL AND c.status <> 'DELETED' AND m.role = 'ASSISTANT') AS assistant_messages`,
      [],
      "ai:usageConversations",
    ),
  ]);

  let webSearch = { requests: 0, successful: 0, failed: 0, avgLatencyMs: null };
  try {
    const webTotals = await queryOne(
      `SELECT count(*)::int AS requests,
              count(*) FILTER (WHERE status = 'SUCCESS')::int AS successful,
              count(*) FILTER (WHERE status = 'FAILURE')::int AS failed,
              round(avg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::int AS avg_latency_ms
         FROM ai_web_search_events
        WHERE created_at >= $1`,
      [since],
      "ai:webSearchTotals",
    );
    webSearch = {
      requests: webTotals?.requests ?? 0,
      successful: webTotals?.successful ?? 0,
      failed: webTotals?.failed ?? 0,
      avgLatencyMs: webTotals?.avg_latency_ms ?? null,
    };
  } catch (error) {
    logger.warn("Failed to load web-search usage", { message: error.message });
  }

  // Dense day series: a chart must show quiet days as zero, not skip them.
  const labels = [];
  const now = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - offset);
    labels.push(day.toISOString().slice(0, 10));
  }
  const byDay = new Map(series.map((row) => [row.day, row]));

  return {
    range: days,
    generatedAt: new Date().toISOString(),
    totals: {
      requests: totals.requests,
      successful: totals.successful,
      failed: totals.failed,
      skipped: totals.skipped,
      failovers: totals.failovers,
      totalTokens: totals.total_tokens,
      successRate:
        totals.requests > 0 ? Math.round((totals.successful / totals.requests) * 1000) / 10 : null,
      avgLatencyMs: totals.avg_latency_ms,
    },
    byFeature,
    byProvider,
    byModel,
    conversations,
    webSearch,
    recent,
    series: {
      labels,
      requests: labels.map((day) => byDay.get(day)?.requests ?? 0),
      successful: labels.map((day) => byDay.get(day)?.successful ?? 0),
      failed: labels.map((day) => byDay.get(day)?.failed ?? 0),
    },
  };
}

/**
 * Live provider probe. This makes one small, real request through the same
 * failover stack the product uses, so "Test provider" cannot report a false
 * positive from cached configuration alone.
 */
export async function testProvider() {
  const targets = await getTargetsAsync();
  if (!targets.length) {
    return {
      ok: false,
      configured: false,
      code: "AI_NOT_CONFIGURED",
      message: "No AI provider is configured. Set AI_PROVIDER and AI_API_KEY in the backend environment.",
    };
  }

  const startedAt = Date.now();
  try {
    const result = await callProvider(
      [
        { role: "system", content: "You are a health probe. Reply with the single word OK." },
        { role: "user", content: "Reply with OK." },
      ],
      { jsonMode: false, timeoutMs: 10_000, maxFailoverAttempts: targets.length },
    );

    const latencyMs = Date.now() - startedAt;
    await recordAiUsage({
      feature: "OTHER",
      status: "SUCCESS",
      provider: result.provider,
      model: result.model,
      latencyMs,
      failoverCount: result.failoverCount ?? 0,
      usage: result.usage,
    });
    if (result.targetId?.startsWith("db:")) await markProviderTest(result.targetId.slice(3), true);

    return {
      ok: true,
      configured: true,
      provider: result.provider,
      model: result.model,
      latencyMs,
      sample: String(result.text ?? "").slice(0, 80),
      failoverCount: result.failoverCount ?? 0,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    await recordAiUsage({
      feature: "OTHER",
      status: "FAILURE",
      latencyMs,
      errorCode: error.code ?? "AI_PROVIDER_ERROR",
    });
    return {
      ok: false,
      configured: true,
      latencyMs,
      code: error.code ?? "AI_PROVIDER_ERROR",
      message: error.message || "The configured provider did not answer.",
    };
  }
}

export async function testSpecificProvider(providerId) {
  const target = await targetForProvider(providerId);
  const startedAt = Date.now();
  try {
    const result = await callProvider(
      [
        { role: "system", content: "You are a health probe. Reply with the single word OK." },
        { role: "user", content: "Reply with OK." },
      ],
      { targets: [target], jsonMode: false, timeoutMs: Math.min(target.timeoutMs, 10_000), maxFailoverAttempts: 1 },
    );
    const latencyMs = Date.now() - startedAt;
    await recordAiUsage({ feature: "OTHER", status: "SUCCESS", provider: result.provider, model: result.model, latencyMs, usage: result.usage });
    await markProviderTest(providerId, true);
    return { ok: true, configured: true, provider: result.provider, model: result.model, latencyMs, sample: String(result.text ?? "").slice(0, 80) };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    await recordAiUsage({ feature: "OTHER", status: "FAILURE", provider: target.provider, model: target.chatModel, latencyMs, errorCode: error.code ?? "AI_PROVIDER_ERROR" });
    await markProviderTest(providerId, false);
    return { ok: false, configured: true, provider: target.provider, model: target.chatModel, latencyMs, code: error.code ?? "AI_PROVIDER_ERROR", message: error.message || "The provider did not answer." };
  }
}

export default { aiConfiguration, recordAiUsage, recordWebSearchAudit, aiUsageReport, testProvider, testSpecificProvider };
