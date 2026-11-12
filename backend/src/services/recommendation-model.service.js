import env from "../config/env.js";
import logger from "../config/logger.js";
import { queryOne } from "../config/db.js";
import { getSection } from "./settings.service.js";
import { MODEL_VERSION } from "../lib/weights.js";

export const MODEL_ALGORITHMS = Object.freeze({
  WEIGHTED_SCORING: "WEIGHTED_SCORING",
  PERSONALIZED_WEIGHTED_SCORING: "PERSONALIZED_WEIGHTED_SCORING",
  LEARNING_TO_RANK: "LEARNING_TO_RANK",
  LEARNING_TO_RANK_WITH_PERSONALIZATION: "LEARNING_TO_RANK_WITH_PERSONALIZATION",
});

const readinessCache = { expiresAt: 0, value: null };
const artifactCache = { expiresAt: 0, value: null };
const circuit = {
  failures: 0,
  openedAt: null,
  openUntil: 0,
  lastError: null,
  lastSuccessAt: null,
  fallbackCount: 0,
};

function cacheTtlMs() {
  return Math.max(0, Number(env.RECOMMENDATION_MODEL_CACHE_TTL_MIN ?? 10)) * 60_000;
}

function thresholds() {
  return {
    students: Number(env.RECOMMENDATION_MIN_TRAINING_STUDENTS ?? 100),
    requests: Number(env.RECOMMENDATION_MIN_TRAINING_REQUESTS ?? 500),
    rows: Number(env.RECOMMENDATION_MIN_LABELLED_ROWS ?? 10_000),
    positives: Number(env.RECOMMENDATION_MIN_POSITIVE_OUTCOMES ?? 100),
    negatives: Number(env.RECOMMENDATION_MIN_NEGATIVE_OUTCOMES ?? 100),
    interactions: Number(env.RECOMMENDATION_MIN_INTERACTIONS ?? 20),
    courses: Number(env.RECOMMENDATION_MIN_COURSES ?? 5),
    labels: Number(env.RECOMMENDATION_MIN_LABEL_DIVERSITY ?? 3),
  };
}

function check(name, observed, required) {
  return { name, observed: Number(observed ?? 0), required, ready: Number(observed ?? 0) >= required };
}

function readinessResult(counts) {
  const required = thresholds();
  const checks = [
    check("unique_students", counts.unique_students, required.students),
    check("recommendation_requests", counts.recommendation_requests, required.requests),
    check("labelled_candidate_rows", counts.labelled_candidate_rows, required.rows),
    check("positive_outcomes", counts.positive_outcomes, required.positives),
    check("negative_outcomes", counts.negative_outcomes, required.negatives),
    check("group_interactions", counts.interactions, required.interactions),
    check("courses_represented", counts.courses, required.courses),
    check("label_diversity", counts.label_diversity, required.labels),
  ];
  const failed = checks.filter((entry) => !entry.ready);
  return {
    ready: failed.length === 0,
    reason: failed.length ? `Not enough real data for training: ${failed.map((entry) => `${entry.name} ${entry.observed}/${entry.required}`).join(", ")}` : null,
    checks,
    counts: {
      uniqueStudents: counts.unique_students,
      recommendationRequests: counts.recommendation_requests,
      labelledRows: counts.labelled_candidate_rows,
      positiveOutcomes: counts.positive_outcomes,
      negativeOutcomes: counts.negative_outcomes,
      interactions: counts.interactions,
      courses: counts.courses,
      labelDiversity: counts.label_diversity,
    },
    thresholds: required,
    evaluatedAt: new Date().toISOString(),
  };
}

/** Count real historical data without exporting any student content. */
export async function getDataReadiness({ force = false } = {}) {
  if (!force && readinessCache.value && readinessCache.expiresAt > Date.now()) return readinessCache.value;

  try {
    const counts = await queryOne(
      `SELECT count(DISTINCT rr.student_id)::int AS unique_students,
              count(DISTINCT rr.id)::int AS recommendation_requests,
               count(DISTINCT r.id) FILTER (WHERE r.shown_at IS NOT NULL OR r.clicked_at IS NOT NULL
                                               OR r.accepted_at IS NOT NULL OR r.rejected_at IS NOT NULL
                                               OR rf.helpful IS NOT NULL)::int AS labelled_candidate_rows,
               count(DISTINCT r.id) FILTER (WHERE r.accepted_at IS NOT NULL OR rf.helpful = TRUE
                                               OR mo.recommendation_id IS NOT NULL)::int AS positive_outcomes,
               count(DISTINCT r.id) FILTER (WHERE r.rejected_at IS NOT NULL OR rf.helpful = FALSE)::int AS negative_outcomes,
               count(DISTINCT r.target_group_id::text)::int AS interactions,
              count(DISTINCT COALESCE(rr.course_id::text, course_ids.course_id))::int AS courses,
              count(DISTINCT CASE
                WHEN r.rejected_at IS NOT NULL OR rf.helpful = FALSE THEN 0
                WHEN r.accepted_at IS NOT NULL THEN 3
                WHEN rf.helpful = TRUE THEN 4
                WHEN r.clicked_at IS NOT NULL THEN 2
                WHEN r.shown_at IS NOT NULL THEN 1
              END)::int AS label_diversity
         FROM recommendation_requests rr
         JOIN recommendations r ON r.request_id = rr.id
         LEFT JOIN recommendation_feedback rf ON rf.recommendation_id = r.id
         LEFT JOIN group_membership_outcomes mo ON mo.recommendation_id = r.id
         LEFT JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(rr.requirements->'courseIds') = 'array'
                THEN rr.requirements->'courseIds' ELSE '[]'::jsonb END
         ) AS course_ids(course_id) ON TRUE`,
      [],
      "recs:dataReadiness",
    );
    const result = readinessResult(counts ?? {});
    readinessCache.value = result;
    readinessCache.expiresAt = Date.now() + cacheTtlMs();
    return result;
  } catch (error) {
    logger.warn("Recommendation readiness check failed", { message: error.message });
    const result = {
      ready: false,
      reason: "Readiness could not be evaluated; weighted scoring remains active.",
      code: "READINESS_UNAVAILABLE",
      checks: [],
      counts: {},
      thresholds: thresholds(),
      evaluatedAt: new Date().toISOString(),
    };
    readinessCache.value = result;
    readinessCache.expiresAt = Date.now() + 30_000;
    return result;
  }
}

export async function getActiveModelArtifact({ force = false } = {}) {
  if (!force && artifactCache.value !== null && artifactCache.expiresAt > Date.now()) return artifactCache.value;
  try {
    const artifact = await queryOne(
      `SELECT model_version, algorithm, feature_schema_version, artifact_uri,
              artifact_checksum, manifest, status, created_at, activated_at,
              activated_by, failure_reason
         FROM recommendation_model_artifacts
        WHERE status = 'ACTIVE'
        ORDER BY activated_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
      [],
      "recs:activeModelArtifact",
    );
    artifactCache.value = artifact;
    artifactCache.expiresAt = Date.now() + cacheTtlMs();
    return artifact;
  } catch (error) {
    logger.warn("Active recommendation artifact unavailable", { message: error.message });
    artifactCache.value = null;
    artifactCache.expiresAt = Date.now() + 30_000;
    return null;
  }
}

export async function getRecommendationRuntime() {
  const configured = await getSection("recommendation.runtime");
  const algorithm = configured.algorithm === "LEARNING_TO_RANK"
    ? "LEARNING_TO_RANK"
    : env.RECOMMENDATION_ALGORITHM === "LEARNING_TO_RANK" ? "LEARNING_TO_RANK" : "WEIGHTED_SCORING";
  return {
    algorithm,
    personalizationEnabled: configured.personalizationEnabled !== undefined
      ? configured.personalizationEnabled !== false
      : env.RECOMMENDATION_PERSONALIZATION_ENABLED === "true",
    minPersonalizationEvents: Number(configured.minPersonalizationEvents ?? env.RECOMMENDATION_MIN_PERSONALIZATION_EVENTS ?? 5),
    maxPersonalizationAdjustment: Number(configured.maxPersonalizationAdjustment ?? env.RECOMMENDATION_MAX_PERSONALIZATION_ADJUSTMENT ?? 4),
    explorationRate: Number(configured.explorationRate ?? env.RECOMMENDATION_EXPLORATION_RATE ?? 0),
  };
}

/** Pure model-selection policy. It never performs eligibility or authorization. */
export function selectRecommendationModel({
  student,
  request,
  candidateCount,
  dataReadiness,
  personalizationState,
  artifact,
  runtime,
  baselineModelVersion = MODEL_VERSION,
} = {}) {
  void student;
  void request;
  const personalizationEnabled = Boolean(runtime?.personalizationEnabled);
  const personalized = personalizationEnabled && Boolean(personalizationState?.eligible);
  const requestedLearningToRank = runtime?.algorithm === "LEARNING_TO_RANK";
  const serviceConfigured = Boolean(env.RECOMMENDATION_MODEL_SERVICE_URL && env.RECOMMENDATION_MODEL_SERVICE_TOKEN);
  const artifactReady = artifact?.status === "ACTIVE" && artifact?.algorithm === "LIGHTGBM_LAMBDAMART";
  const trainedReady = requestedLearningToRank && candidateCount > 0 && dataReadiness?.ready && artifactReady && serviceConfigured;

  if (trainedReady) {
    return {
      algorithm: personalized ? MODEL_ALGORITHMS.LEARNING_TO_RANK_WITH_PERSONALIZATION : MODEL_ALGORITHMS.LEARNING_TO_RANK,
      modelVersion: artifact.model_version,
      featureSchemaVersion: artifact.feature_schema_version,
      baselineModelVersion,
      personalized,
      degraded: false,
      fallbackReason: null,
      trainingDataReady: true,
    };
  }

  const fallbackReason = requestedLearningToRank
    ? !dataReadiness?.ready
      ? dataReadiness?.reason ?? "Training data is not ready."
      : !artifactReady
        ? "No validated learning-to-rank model is active."
        : !serviceConfigured
          ? "The model service is not configured."
          : "The learning-to-rank model was not selected."
    : null;

  return {
    algorithm: personalized ? MODEL_ALGORITHMS.PERSONALIZED_WEIGHTED_SCORING : MODEL_ALGORITHMS.WEIGHTED_SCORING,
    modelVersion: baselineModelVersion,
    featureSchemaVersion: null,
    baselineModelVersion,
    personalized,
    degraded: Boolean(fallbackReason),
    fallbackReason,
    trainingDataReady: Boolean(dataReadiness?.ready),
  };
}

function serviceError(message, code = "MODEL_SERVICE_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function circuitOpen() {
  return circuit.openUntil > Date.now();
}

function recordFailure(error) {
  circuit.failures += 1;
  circuit.lastError = error.code ?? "MODEL_SERVICE_ERROR";
  circuit.fallbackCount += 1;
  if (circuit.failures >= 3) {
    circuit.openedAt = new Date().toISOString();
    circuit.openUntil = Date.now() + 30_000;
  }
}

function recordSuccess() {
  circuit.failures = 0;
  circuit.openUntil = 0;
  circuit.lastError = null;
  circuit.lastSuccessAt = new Date().toISOString();
}

function normalizeUrl(url, path) {
  const value = String(url).replace(/\/$/, "");
  return value.endsWith(path) ? value : `${value}${path}`;
}

/** Request scores only. Candidate eligibility and all explanations stay in Node. */
export async function predictRecommendationScores({ selection, candidates }) {
  if (!selection || !selection.algorithm.startsWith("LEARNING_TO_RANK")) return null;
  if (circuitOpen()) throw serviceError("Recommendation model circuit is open.", "MODEL_CIRCUIT_OPEN");
  if (!env.RECOMMENDATION_MODEL_SERVICE_URL || !env.RECOMMENDATION_MODEL_SERVICE_TOKEN) {
    throw serviceError("Recommendation model service is not configured.", "MODEL_SERVICE_NOT_CONFIGURED");
  }
  if (!Array.isArray(candidates) || candidates.length > 200) {
    throw serviceError("Recommendation model request is too large.", "MODEL_REQUEST_TOO_LARGE");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.RECOMMENDATION_MODEL_TIMEOUT_MS ?? 1500));
  try {
    const response = await fetch(normalizeUrl(env.RECOMMENDATION_MODEL_SERVICE_URL, "/predict"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-model-service-token": env.RECOMMENDATION_MODEL_SERVICE_TOKEN,
      },
      body: JSON.stringify({
        modelVersion: selection.modelVersion,
        featureSchemaVersion: selection.featureSchemaVersion,
        candidates: candidates.map((candidate) => ({
          candidateId: String(candidate.candidate.id),
          features: candidate.featureValues,
        })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw serviceError(`Model service returned ${response.status}.`, "MODEL_SERVICE_HTTP_ERROR");
    const body = await response.json();
    if (body.modelVersion !== selection.modelVersion || body.featureSchemaVersion !== selection.featureSchemaVersion) {
      throw serviceError("Model service returned a mismatched model schema.", "MODEL_SCHEMA_MISMATCH");
    }
    if (!Array.isArray(body.scores) || body.scores.length !== candidates.length) {
      throw serviceError("Model service returned an invalid score count.", "MODEL_INVALID_OUTPUT");
    }

    const expectedIds = new Set(candidates.map((candidate) => String(candidate.candidate.id)));
    const scores = new Map();
    for (const entry of body.scores) {
      if (!entry || !expectedIds.has(String(entry.candidateId)) || scores.has(String(entry.candidateId))) {
        throw serviceError("Model service returned an invalid candidate id.", "MODEL_INVALID_OUTPUT");
      }
      if (!Number.isFinite(Number(entry.score))) throw serviceError("Model service returned a non-numeric score.", "MODEL_INVALID_OUTPUT");
      scores.set(String(entry.candidateId), Number(entry.score));
    }
    recordSuccess();
    return scores;
  } catch (error) {
    const normalized = error.name === "AbortError" ? serviceError("Recommendation model service timed out.", "MODEL_SERVICE_TIMEOUT") : error;
    recordFailure(normalized);
    logger.warn("Recommendation model inference failed; using weighted fallback", { code: normalized.code, message: normalized.message });
    throw normalized;
  } finally {
    clearTimeout(timeout);
  }
}

export function modelServiceSnapshot() {
  return {
    configured: Boolean(env.RECOMMENDATION_MODEL_SERVICE_URL && env.RECOMMENDATION_MODEL_SERVICE_TOKEN),
    circuit: circuitOpen() ? "OPEN" : "CLOSED",
    failures: circuit.failures,
    fallbackCount: circuit.fallbackCount,
    openedAt: circuit.openedAt,
    openUntil: circuit.openUntil ? new Date(circuit.openUntil).toISOString() : null,
    lastError: circuit.lastError,
    lastSuccessAt: circuit.lastSuccessAt,
  };
}

export function resetModelServiceCircuit() {
  circuit.failures = 0;
  circuit.openedAt = null;
  circuit.openUntil = 0;
  circuit.lastError = null;
}

export async function modelServiceHealth({ modelVersion } = {}) {
  const base = modelServiceSnapshot();
  if (!base.configured) return { ...base, status: "NOT_CONFIGURED" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Number(env.RECOMMENDATION_MODEL_TIMEOUT_MS ?? 1500), 1500));
  try {
    const healthUrl = new URL(normalizeUrl(env.RECOMMENDATION_MODEL_SERVICE_URL, "/health"));
    if (modelVersion) healthUrl.searchParams.set("modelVersion", modelVersion);
    const response = await fetch(healthUrl, {
      headers: { "x-model-service-token": env.RECOMMENDATION_MODEL_SERVICE_TOKEN },
      signal: controller.signal,
    });
    let details = {};
    if (response.ok) {
      details = await response.json().catch(() => ({}));
    }
    return {
      ...base,
      status: response.ok ? "HEALTHY" : "UNHEALTHY",
      httpStatus: response.status,
      modelVersion: details.modelVersion ?? null,
      featureSchemaVersion: details.featureSchemaVersion ?? null,
      artifactChecksum: details.artifactChecksum ?? null,
    };
  } catch (error) {
    return { ...base, status: "UNHEALTHY", error: error.name === "AbortError" ? "TIMEOUT" : "UNREACHABLE" };
  } finally {
    clearTimeout(timeout);
  }
}

export function invalidateModelCaches() {
  readinessCache.expiresAt = 0;
  artifactCache.expiresAt = 0;
}

export default {
  MODEL_ALGORITHMS,
  getDataReadiness,
  getActiveModelArtifact,
  getRecommendationRuntime,
  selectRecommendationModel,
  predictRecommendationScores,
  modelServiceSnapshot,
  modelServiceHealth,
  resetModelServiceCircuit,
  invalidateModelCaches,
};
