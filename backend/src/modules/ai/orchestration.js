import crypto from "node:crypto";
import { AppError, ServiceUnavailableError } from "../../lib/errors.js";
import { logger } from "../../config/logger.js";
import { getTargets } from "./registry.js";
import { getAdapterFor } from "./adapters.js";

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

function circuitBreaker(key, opts = { failThreshold: 3, resetTimeoutMs: 30_000, timeoutMs: 8000 }) {
  let state = "CLOSED";
  let failures = 0;
  let lastFailureAt = null;

  return {
    key,
    allow() {
      if (state === "OPEN") {
        if (lastFailureAt && Date.now() - lastFailureAt >= opts.resetTimeoutMs) {
          state = "HALF_OPEN";
          failures = 0;
        } else {
          return { allowed: false, state };
        }
      }
      return { allowed: true, state };
    },
    recordSuccess() {
      failures = 0;
      if (state === "HALF_OPEN") state = "CLOSED";
    },
    recordFailure() {
      failures += 1;
      lastFailureAt = Date.now();
      if (failures >= opts.failThreshold) state = "OPEN";
    },
    reset() {
      state = "CLOSED";
      failures = 0;
      lastFailureAt = null;
    },
  };
}

function circuitFor(id) {
  let breaker = CIRCUIT_STATE.get(id);
  if (!breaker) {
    breaker = circuitBreaker(id);
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
  const targets = options.targets?.length ? options.targets : getTargets();
  if (!targets.length) throw new ServiceUnavailableError("No AI provider is configured");

  const errors = [];

  for (const target of targets) {
    const breaker = circuitFor(target.id);
    const permit = breaker.allow();
    if (!permit.allowed) {
      logger.warn("AI target circuit open, skipping", { target: target.id, state: permit.state });
      errors.push(new ServiceUnavailableError(`AI target ${target.id} is temporarily unavailable`));
      continue;
    }

    try {
      const adapter = getAdapterFor(target);
      const text = await doCall(adapter, messages, {
        model: target,
        jsonMode: options.jsonMode ?? true,
        timeoutMs: options.timeoutMs ?? target.timeoutMs,
      });
      breaker.recordSuccess();
      return { text, model: target.chatModel, provider: target.provider, targetId: target.id };
    } catch (error) {
      breaker.recordFailure();
      const normalized =
        error instanceof AppError
          ? error
          : new AppError("AI target failed", {
              status: 502,
              code: "AI_PROVIDER_ERROR",
              details: error?.message ?? String(error),
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

async function doCall(adapter, messages, options) {
  const model = options.model;
  return adapter.chatCompletions(messages, {
    model,
    timeoutMs: options.timeoutMs ?? model?.timeoutMs ?? 25000,
    jsonMode: options.jsonMode ?? true,
  });
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
