import { queryOne } from "../config/db.js";
import logger from "../config/logger.js";

export async function recordProviderSuccess(providerId, latencyMs) {
  if (!providerId) return;
  try {
    await queryOne(
      `INSERT INTO ai_provider_health
         (provider_id, circuit_state, consecutive_failures, total_requests, successful_requests, average_latency_ms, last_success_at)
       VALUES ($1, 'CLOSED', 0, 1, 1, $2, now())
       ON CONFLICT (provider_id) DO UPDATE SET
         circuit_state = 'CLOSED',
         consecutive_failures = 0,
         total_requests = ai_provider_health.total_requests + 1,
         successful_requests = ai_provider_health.successful_requests + 1,
         average_latency_ms = CASE
           WHEN ai_provider_health.average_latency_ms IS NULL THEN EXCLUDED.average_latency_ms
           ELSE round((ai_provider_health.average_latency_ms * 0.8) + (EXCLUDED.average_latency_ms * 0.2), 2)
         END,
         last_success_at = now(),
         updated_at = now()
       RETURNING provider_id`,
      [providerId, Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null],
      "ai:providerHealthSuccess",
    );
  } catch (error) {
    logger.warn("Failed to record AI provider success", { providerId, message: error.message });
  }
}

export async function recordProviderFailure(providerId, errorCode, latencyMs, { open = false } = {}) {
  if (!providerId) return;
  try {
    await queryOne(
      `INSERT INTO ai_provider_health
         (provider_id, circuit_state, consecutive_failures, total_requests, failed_requests, last_failure_at, last_error_code, average_latency_ms)
       VALUES ($1, CASE WHEN $5::boolean THEN 'OPEN' ELSE 'CLOSED' END, 1, 1, 1, now(), $2, $3)
       ON CONFLICT (provider_id) DO UPDATE SET
         circuit_state = CASE WHEN $5::boolean THEN 'OPEN' ELSE ai_provider_health.circuit_state END,
         consecutive_failures = ai_provider_health.consecutive_failures + 1,
         total_requests = ai_provider_health.total_requests + 1,
         failed_requests = ai_provider_health.failed_requests + 1,
         average_latency_ms = CASE
           WHEN ai_provider_health.average_latency_ms IS NULL THEN EXCLUDED.average_latency_ms
           ELSE round((ai_provider_health.average_latency_ms * 0.8) + (EXCLUDED.average_latency_ms * 0.2), 2)
         END,
         last_failure_at = now(),
         last_error_code = $2,
         updated_at = now()
       RETURNING provider_id`,
      [providerId, errorCode ?? "AI_PROVIDER_ERROR", Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null, null, Boolean(open)],
      "ai:providerHealthFailure",
    );
  } catch (error) {
    logger.warn("Failed to record AI provider failure", { providerId, message: error.message });
  }
}

export async function resetProviderHealth(providerId) {
  if (!providerId) return;
  await queryOne(
    `INSERT INTO ai_provider_health (provider_id)
     VALUES ($1)
     ON CONFLICT (provider_id) DO UPDATE SET
       circuit_state = 'CLOSED', consecutive_failures = 0, updated_at = now()
     RETURNING provider_id`,
    [providerId],
    "ai:providerHealthReset",
  );
}
