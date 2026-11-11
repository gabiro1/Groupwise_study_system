import { query, queryOne, queryRows } from "../config/db.js";
import { AppError, NotFoundError, ServiceUnavailableError } from "../lib/errors.js";
import { decryptCredential, encryptCredential } from "./aiCredential.service.js";

const PROVIDER_DEFAULTS = Object.freeze({
  OPENAI: { baseUrl: "https://api.openai.com/v1", adapter: "openai", label: "OpenAI" },
  GEMINI: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", adapter: "gemini", label: "Google Gemini" },
  OPENROUTER: { baseUrl: "https://openrouter.ai/api/v1", adapter: "openai", label: "OpenRouter" },
  CUSTOM_OPENAI: { baseUrl: "", adapter: "openai", label: "Custom OpenAI-compatible" },
  ANTHROPIC: { baseUrl: "https://api.anthropic.com", adapter: "anthropic", label: "Anthropic" },
});

function publicProvider(row) {
  const credential = row.credential_ciphertext ? "stored" : null;
  return {
    id: row.id,
    displayName: row.display_name,
    providerType: row.provider_type,
    providerLabel: PROVIDER_DEFAULTS[row.provider_type]?.label ?? row.provider_type,
    baseUrl: row.base_url,
    modelId: row.model_id,
    modelDisplayName: row.model_display_name,
    priority: row.priority,
    timeoutMs: row.timeout_ms,
    enabled: row.enabled,
    fallbackEnabled: row.fallback_enabled,
    operationalStatus: row.operational_status,
    credentialMasked: credential ? "••••••••" : null,
    hasCredential: Boolean(credential),
    lastTestedAt: row.last_tested_at,
    credentialRotatedAt: row.credential_rotated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    health: {
      circuit: row.circuit_state ?? "CLOSED",
      consecutiveFailures: row.consecutive_failures ?? 0,
      totalRequests: row.total_requests ?? 0,
      successfulRequests: row.successful_requests ?? 0,
      failedRequests: row.failed_requests ?? 0,
      successRate: row.total_requests ? Math.round((row.successful_requests / row.total_requests) * 1000) / 10 : null,
      averageLatencyMs: row.average_latency_ms ?? null,
      lastSuccessAt: row.last_success_at ?? null,
      lastFailureAt: row.last_failure_at ?? null,
      lastErrorCode: row.last_error_code ?? null,
    },
  };
}

const PROVIDER_SELECT = `
  SELECT p.*, h.circuit_state, h.consecutive_failures, h.total_requests,
         h.successful_requests, h.failed_requests, h.average_latency_ms,
         h.last_success_at, h.last_failure_at, h.last_error_code
    FROM ai_provider_configs p
    LEFT JOIN ai_provider_health h ON h.provider_id = p.id`;

export async function listProviders({ includeDisabled = true } = {}) {
  const rows = await queryRows(
    `${PROVIDER_SELECT} ${includeDisabled ? "" : "WHERE p.enabled"} ORDER BY p.priority ASC, p.created_at ASC`,
    [],
    "ai:providerList",
  );
  return rows.map(publicProvider);
}

export async function getProviderRow(id) {
  const row = await queryOne(`${PROVIDER_SELECT} WHERE p.id = $1`, [id], "ai:providerGet");
  if (!row) throw new NotFoundError("That AI provider");
  return row;
}

export async function getProvider(id) {
  return publicProvider(await getProviderRow(id));
}

function validateType(type) {
  if (!PROVIDER_DEFAULTS[type]) {
    throw new AppError("Choose a supported AI provider type.", { status: 422, code: "INVALID_PROVIDER_TYPE" });
  }
}

function targetFromRow(row) {
  const apiKey = decryptCredential(row);
  if (!apiKey) return null;
  const config = PROVIDER_DEFAULTS[row.provider_type];
  return {
    id: `db:${row.id}`,
    providerId: row.id,
    provider: row.provider_type.toLowerCase(),
    providerType: row.provider_type,
    label: row.display_name,
    adapter: config.adapter,
    apiKey,
    baseUrl: row.base_url.replace(/\/$/, ""),
    chatModel: row.model_id,
    modelDisplayName: row.model_display_name,
    timeoutMs: row.timeout_ms,
    maxOutputTokens: 900,
    priority: row.priority,
    failureThreshold: 3,
    recoveryCooldownMs: 30_000,
    enabled: row.enabled,
    fallbackEnabled: row.fallback_enabled,
  };
}

export async function getRuntimeTargets() {
  const rows = await queryRows(
    `${PROVIDER_SELECT} WHERE p.enabled AND p.credential_ciphertext IS NOT NULL
     ORDER BY p.priority ASC, p.created_at ASC`,
    [],
    "ai:providerTargets",
  );
  return rows.map(targetFromRow).filter(Boolean);
}

export async function createProvider(input, actorId = null) {
  validateType(input.providerType);
  const encrypted = encryptCredential(input.apiCredential);
  const row = await queryOne(
    `INSERT INTO ai_provider_configs
      (display_name, provider_type, base_url, model_id, model_display_name, credential_ciphertext, credential_iv, credential_tag,
       priority, timeout_ms, enabled, fallback_enabled, created_by, updated_by, credential_rotated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, now())
     RETURNING id`,
    [input.displayName, input.providerType, input.baseUrl.replace(/\/$/, ""), input.modelId, input.modelDisplayName || null,
      encrypted.ciphertext, encrypted.iv, encrypted.tag, input.priority, input.timeoutMs, input.enabled, input.fallbackEnabled, actorId],
    "ai:providerCreate",
  );
  return getProvider(row.id);
}

export async function updateProvider(id, input, actorId = null) {
  const existing = await getProviderRow(id);
  if (input.providerType) validateType(input.providerType);
  let encrypted = null;
  if (input.apiCredential) encrypted = encryptCredential(input.apiCredential);

  const values = [
    input.displayName ?? existing.display_name,
    input.providerType ?? existing.provider_type,
    input.baseUrl ? input.baseUrl.replace(/\/$/, "") : existing.base_url,
    input.modelId ?? existing.model_id,
    input.modelDisplayName === undefined ? existing.model_display_name : (input.modelDisplayName || null),
    input.priority ?? existing.priority,
    input.timeoutMs ?? existing.timeout_ms,
    input.enabled ?? existing.enabled,
    input.fallbackEnabled ?? existing.fallback_enabled,
    actorId,
  ];

  const clearCredential = Boolean(input.removeCredential);
  const configurationChanged = ["providerType", "baseUrl", "modelId", "timeoutMs"].some((key) => input[key] !== undefined);
  const setCredential = encrypted
    ? `credential_ciphertext = $11, credential_iv = $12, credential_tag = $13, credential_rotated_at = now(), operational_status = 'UNTESTED'`
    : clearCredential
      ? `credential_ciphertext = NULL, credential_iv = NULL, credential_tag = NULL, credential_rotated_at = now(), operational_status = 'UNTESTED'`
      : `credential_ciphertext = credential_ciphertext${configurationChanged ? ", operational_status = 'UNTESTED'" : ""}`;
  const extra = encrypted ? [encrypted.ciphertext, encrypted.iv, encrypted.tag] : [null, null, null];

  await queryOne(
    `UPDATE ai_provider_configs SET
       display_name = $1, provider_type = $2, base_url = $3, model_id = $4, model_display_name = $5,
       priority = $6, timeout_ms = $7, enabled = $8, fallback_enabled = $9, updated_by = $10,
       ${setCredential}, updated_at = now()
     WHERE id = $14
     RETURNING id`,
    [...values, ...extra, id],
    "ai:providerUpdate",
  );
  return getProvider(id);
}

export async function removeProvider(id) {
  const result = await query("DELETE FROM ai_provider_configs WHERE id = $1", [id], "ai:providerRemove");
  if (!result.rowCount) throw new NotFoundError("That AI provider");
}

export async function targetForProvider(id) {
  const row = await getProviderRow(id);
  if (!row.credential_ciphertext) throw new ServiceUnavailableError("Add an API credential before testing this provider.");
  return targetFromRow(row);
}

export async function markProviderTest(id, ok) {
  await queryOne(
    `UPDATE ai_provider_configs
        SET operational_status = $2, last_tested_at = now(), updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, ok ? "OPERATIONAL" : "INVALID"],
    "ai:providerTestStatus",
  );
}

export async function discoverModels(id) {
  const row = await getProviderRow(id);
  const credential = decryptCredential(row);
  if (!credential) throw new ServiceUnavailableError("Add an API credential before fetching models.");
  const type = row.provider_type;
  const base = row.base_url.replace(/\/$/, "");
  const timeoutMs = Math.min(row.timeout_ms, 30_000);
  let url;
  const headers = { accept: "application/json" };
  if (type === "GEMINI") {
    url = `${base}/models?key=${encodeURIComponent(credential)}`;
  } else if (type === "ANTHROPIC") {
    url = `${base}/v1/models`;
    headers.authorization = `Bearer ${credential}`;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    url = `${base}/models`;
    headers.authorization = `Bearer ${credential}`;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text().catch(() => "");
  let payload = null;
  try { payload = body ? JSON.parse(body) : null; } catch { payload = null; }
  if (!response.ok) {
    if ([404, 405].includes(response.status)) {
      throw new AppError("This provider does not support automatic model discovery. Enter the model identifier manually.", { status: 422, code: "MODEL_DISCOVERY_UNSUPPORTED" });
    }
    throw new AppError("The provider rejected model discovery.", { status: response.status === 401 || response.status === 403 ? 422 : 502, code: response.status === 401 || response.status === 403 ? "AI_INVALID_CREDENTIAL" : "AI_MODEL_DISCOVERY_FAILED" });
  }
  const models = type === "GEMINI"
    ? (Array.isArray(payload?.models) ? payload.models.map((model) => ({ id: String(model.name ?? "").replace(/^models\//, ""), displayName: model.displayName ?? model.name, supportedMethods: model.supportedGenerationMethods ?? [] })) : [])
    : (Array.isArray(payload?.data) ? payload.data.map((model) => ({ id: model.id, displayName: model.name ?? model.id })) : []);
  return { providerId: id, models: models.filter((model) => model.id) };
}

export function auditSafeProvider(input) {
  return {
    id: input.id,
    displayName: input.displayName,
    providerType: input.providerType,
    modelId: input.modelId,
    priority: input.priority,
    enabled: input.enabled,
  };
}

export { PROVIDER_DEFAULTS };
