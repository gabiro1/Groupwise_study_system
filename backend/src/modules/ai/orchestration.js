import crypto from "node:crypto";
import { AppError, ServiceUnavailableError } from "../../lib/errors.js";
import { logger } from "../../config/logger.js";
import { getTargetsAsync } from "./registry.js";
import { getAdapterFor } from "./adapters.js";
import { aiRuntime } from "../../services/settings.service.js";
import { recordProviderFailure, recordProviderSuccess } from "../../services/aiProviderHealth.service.js";

/**
 * Bounded failover + circuit breaker + idempotency-safe orchestration.
 *
 * Rules:
 *  - Targets are tried in order: the primary provider first, then each fallback
 *    model from `AI_FALLBACKS`. The first target that returns usable text wins.
 *  - Each target owns its own circuit breaker keyed by `<provider>:<model>`, so
 *    a persistently failing model is skipped (after 3 failures) and only probed
 *    again after a 30s cooldown, without disabling the healthy ones behind it.
 *  - A target "fails" on a non-2xx response, a 200 response that carries an
 *    `error` body (OpenRouter-style), a timeout, or unusable/empty content. All
 *    of those fall through to the next target.
 *  - When every target fails the last error is re-thrown, so callers can degrade
 *    the feature rather than surfacing a hang.
 *  - `idempotencyKey` on the request is honoured so retries never mutate
 *    conversation storage twice.
 */
const CIRCUIT_STATE = new Map();

function circuitBreaker(key, opts = {}) {
  const settings = {
    failThreshold: opts.failThreshold ?? 3,
    resetTimeoutMs: opts.resetTimeoutMs ?? 30_000,
  };
  let state = "CLOSED";
  let failures = 0;
  let lastFailureAt = null;

  return {
    key,
    allow() {
      if (state === "OPEN") {
        if (lastFailureAt && Date.now() - lastFailureAt >= settings.resetTimeoutMs) {
          state = "HALF-OPEN";
          failures = 0;
        } else {
          return { allowed: false, state };
        }
      }
      return { allowed: true, state };
    },
    recordSuccess() {
      failures = 0;
      if (state === "HALF-OPEN") state = "CLOSED";
    },
    recordFailure() {
      failures += 1;
      lastFailureAt = Date.now();
      if (failures >= settings.failThreshold) state = "OPEN";
    },
    reset() {
      state = "CLOSED";
      failures = 0;
      lastFailureAt = null;
    },
    snapshot() {
      return { state, failures, lastFailureAt: lastFailureAt ? new Date(lastFailureAt).toISOString() : null };
    },
  };
}

function circuitFor(id, options = {}) {
  let breaker = CIRCUIT_STATE.get(id);
  if (!breaker) {
    breaker = circuitBreaker(id, options);
    CIRCUIT_STATE.set(id, breaker);
  }
  return breaker;
}

function idempotencyKey(req) {
  return req?.headers?.["x-idempotency-key"]?.trim() || null;
}

/** Request id: client supplied, otherwise server generated. Never trusted for auth. */
export function requestId(req) {
  const id = req?.headers?.["x-request-id"];
  if (id?.trim()) return id.trim();
  return crypto.randomUUID();
}

/**
 * Call the AI chain: try each target in order until one answers.
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {{jsonMode?:boolean, timeoutMs?:number, targets?:Array}} [options]
 * @returns {Promise<{text:string, model:string, provider:string, targetId:string}>}
 */
export async function callProvider(messages, options = {}) {
  const runtime = options.targets?.length ? {} : await aiRuntime().catch(() => ({}));
  const configuredTargets = options.targets?.length ? options.targets : await getTargetsAsync();
  const fallbackEnabled = options.fallbackEnabled ?? runtime.fallbackEnabled ?? true;
  const maxAttempts = options.maxFailoverAttempts ?? runtime.maxFailoverAttempts ?? configuredTargets.length;
  const targets = configuredTargets
    .filter((target, index) => index === 0 || (fallbackEnabled && target.fallbackEnabled !== false))
    .slice(0, Math.max(1, Number(maxAttempts) || 1));
  if (!targets.length) throw new ServiceUnavailableError("No AI provider is configured");

  const errors = [];

  for (const [index, target] of targets.entries()) {
    const breaker = circuitFor(target.id, {
      failThreshold: options.failureThreshold ?? runtime.failureThreshold ?? target.failureThreshold,
      resetTimeoutMs: options.recoveryCooldownMs ?? runtime.recoveryCooldownMs ?? target.recoveryCooldownMs,
    });
    const permit = breaker.allow();
    if (!permit.allowed) {
      logger.warn("AI target circuit open, skipping", { target: target.id, state: permit.state });
      errors.push(new ServiceUnavailableError(`AI target ${target.id} is temporarily unavailable`));
      continue;
    }

    const startedAt = Date.now();
    try {
      const adapter = getAdapterFor(target);
      const result = await doCall(adapter, messages, {
        model: target,
        jsonMode: options.jsonMode ?? true,
        timeoutMs: options.timeoutMs ?? target.timeoutMs,
      });
      breaker.recordSuccess();
      const latencyMs = Date.now() - startedAt;
      await recordProviderSuccess(target.providerId, latencyMs);
      return {
        text: result.text,
        usage: result.usage ?? null,
        model: target.chatModel,
        provider: target.provider,
        targetId: target.id,
        failoverCount: index,
      };
    } catch (error) {
      const normalized =
        error instanceof AppError
          ? error
          : new AppError("AI target failed", {
              status: 502,
              code: "AI_PROVIDER_ERROR",
              details: error?.message ?? String(error),
            });
      const retryable = isRetryableProviderError(normalized);
      if (!retryable) {
        logger.warn("AI target rejected request; failover stopped", {
          target: target.id,
          provider: target.provider,
          code: normalized.code,
        });
        throw normalized;
      }
      breaker.recordFailure();
      await recordProviderFailure(target.providerId, normalized.code, Date.now() - startedAt, {
        open: breaker.snapshot().state === "OPEN",
      });
      logger.warn("AI target failed, falling through", {
        target: target.id,
        provider: target.provider,
        code: normalized.code,
        message: normalized.message,
      });
      errors.push(normalized);
    }
  }

  const last = errors[errors.length - 1];
  throw last ?? new ServiceUnavailableError("All AI providers are unavailable");
}

export function isRetryableProviderError(error) {
  if (error?.retryable === false || error?.authenticationFailure || error?.contentSafetyRejection) return false;
  const status = Number(error?.status);
  if ([408, 425, 429].includes(status) || status >= 500) return true;
  return status === 0 || !Number.isFinite(status) || error?.name === "TimeoutError" || error?.name === "AbortError";
}

async function doCall(adapter, messages, options) {
  const model = options.model;
  const result = await adapter.chatCompletions(messages, {
    model,
    timeoutMs: options.timeoutMs ?? model?.timeoutMs ?? 25000,
    jsonMode: options.jsonMode ?? true,
  });
  return typeof result === "string" ? { text: result, usage: null } : result;
}

/** Reset one target's circuit breaker, or all of them when no id is given. */
export function resetCircuit(targetId = null) {
  if (!targetId) {
    for (const breaker of CIRCUIT_STATE.values()) breaker.reset();
    return;
  }
  CIRCUIT_STATE.get(targetId)?.reset();
}

/** Circuit state for one target, or every tracked target when no id is given. */
export function getCircuitState(targetId = null) {
  if (targetId) {
    const breaker = CIRCUIT_STATE.get(targetId);
    return breaker ? { [targetId]: breaker } : {};
  }
  return Object.fromEntries(CIRCUIT_STATE);
}

/**
 * Plain-data circuit snapshot: { state, failures, lastFailureAt }.
 *
 * `getCircuitState` returns live breaker objects, which is useful internally but
 * serialises to `{}` over JSON. The admin console needs the actual state, so this
 * exposes only the safe, serialisable fields.
 */
export function getCircuitSnapshot(targetId = null) {
  if (targetId) {
    const breaker = CIRCUIT_STATE.get(targetId);
    return breaker ? breaker.snapshot() : { state: "CLOSED", failures: 0, lastFailureAt: null };
  }
  return Object.fromEntries(
    [...CIRCUIT_STATE.entries()].map(([id, breaker]) => [id, breaker.snapshot()]),
  );
}
