import { Router } from "express";
import { asyncHandler, ok, created } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { writeLimiter, searchLimiter } from "../middleware/rateLimit.js";
import { queryOne, queryRows, withTransaction } from "../config/db.js";
import { AppError, ConflictError, NotFoundError } from "../lib/errors.js";
import { recordAudit, AUDIT } from "../lib/audit.js";
import { z } from "../lib/schemas.js";
import { RECOMMENDATION_FEATURE_NAMES } from "../lib/recommendation-feature-schema.js";
import { getSection, invalidateSettingsCache } from "../services/settings.service.js";
import {
  getDataReadiness,
  getActiveModelArtifact,
  getRecommendationRuntime,
  modelServiceHealth,
  modelServiceSnapshot,
  resetModelServiceCircuit,
  selectRecommendationModel,
  invalidateModelCaches,
} from "../services/recommendation-model.service.js";

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

const modelVersionParam = z.object({ modelVersion: z.string().trim().min(3).max(120).regex(/^[A-Za-z0-9._-]+$/) });
const featureSchemaVersion = z.string().trim().min(3).max(120).default("recommendation-features-v1");

const trainingRunBody = z.object({
  modelVersion: z.string().trim().min(3).max(120).regex(/^[A-Za-z0-9._-]+$/),
  datasetKind: z.enum(["REAL", "SYNTHETIC"]).default("REAL"),
  featureSchemaVersion,
});

const registerModelBody = z.object({
  modelVersion: z.string().trim().min(3).max(120).regex(/^[A-Za-z0-9._-]+$/),
  featureSchemaVersion,
  trainingRunId: z.string().uuid().optional().nullable(),
  artifactUri: z.string().trim().min(1).max(500),
  artifactChecksum: z.string().trim().regex(/^[a-f0-9]{64}$/i),
  manifest: z.record(z.string(), z.unknown()),
});

const personalizationSettings = z.object({
  personalizationEnabled: z.boolean().optional(),
  minPersonalizationEvents: z.coerce.number().int().min(1).max(100).optional(),
  maxPersonalizationAdjustment: z.coerce.number().min(0).max(20).optional(),
  explorationRate: z.coerce.number().min(0).max(0.2).optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one recommendation setting.");

async function setRuntime(tx, updates, actorId) {
  const current = await getSection("recommendation.runtime");
  const merged = { ...current, ...updates };
  return tx.queryOne(
    `INSERT INTO system_settings (key, value, description, updated_by)
     VALUES ('recommendation.runtime', $1::jsonb, 'Recommendation model runtime configuration.', $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING key, value, updated_at`,
    [JSON.stringify(merged), actorId],
    "admin:recommendationRuntime",
  );
}

/** GET /api/admin/recommendations/status */
router.get(
  "/recommendations/status",
  searchLimiter,
  asyncHandler(async (_req, res) => {
    const [runtime, readiness, artifact, service, latestRun, fallback] = await Promise.all([
      getRecommendationRuntime(),
      getDataReadiness({ force: true }),
      getActiveModelArtifact({ force: true }),
      modelServiceHealth(),
      queryOne(
        `SELECT id, version, feature_schema_version, dataset_kind, status,
                row_count, unique_student_count, unique_request_count,
                positive_label_count, negative_label_count, label_distribution,
                training_metrics, validation_metrics, test_metrics,
                baseline_metrics, fairness_checks, failure_reason,
                created_at, started_at, completed_at
           FROM recommendation_training_runs
          ORDER BY created_at DESC LIMIT 1`,
        [],
        "admin:recommendationLatestRun",
      ),
      queryOne(
        `SELECT count(*)::int AS requests,
                count(*) FILTER (WHERE model_degraded)::int AS fallbacks,
                count(*) FILTER (WHERE personalized)::int AS personalized_requests
           FROM recommendation_requests
          WHERE created_at >= now() - interval '30 days'`,
        [],
        "admin:recommendationFallbacks",
      ),
    ]);
    const activeSelection = selectRecommendationModel({
      candidateCount: 1,
      dataReadiness: readiness,
      personalizationState: { eligible: false },
      artifact,
      runtime,
    });

    return ok(res, {
      algorithm: activeSelection.algorithm,
      activeModelVersion: activeSelection.modelVersion,
      activeArtifact: artifact,
      readiness,
      trainingDataReady: readiness.ready,
      runtime,
      latestTrainingRun: latestRun,
      modelService: { ...service, circuit: modelServiceSnapshot() },
      fallbackCount30d: fallback?.fallbacks ?? 0,
      recommendationRequests30d: fallback?.requests ?? 0,
      personalizedRequests30d: fallback?.personalized_requests ?? 0,
    });
  }),
);

/** GET /api/admin/recommendations/training-runs */
router.get(
  "/recommendations/training-runs",
  searchLimiter,
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }) }),
  asyncHandler(async (req, res) => {
    const runs = await queryRows(
      `SELECT id, version, schema_version, feature_schema_version, dataset_kind,
              status, data_start_at, data_end_at, row_count,
              unique_student_count, unique_request_count, positive_label_count,
              negative_label_count, label_distribution, training_metrics,
              validation_metrics, test_metrics, baseline_metrics, fairness_checks,
              artifact_checksum, application_version, git_commit, failure_reason,
              created_at, started_at, completed_at
         FROM recommendation_training_runs
        ORDER BY created_at DESC LIMIT $1`,
      [req.query.limit],
      "admin:recommendationTrainingRuns",
    );
    return ok(res, { runs });
  }),
);

/** POST /api/admin/recommendations/training-runs — request an external export. */
router.post(
  "/recommendations/training-runs",
  writeLimiter,
  validate({ body: trainingRunBody }),
  asyncHandler(async (req, res) => {
    const readiness = await getDataReadiness({ force: true });
    const schema = await queryOne(
      "SELECT version FROM recommendation_feature_schemas WHERE version = $1 AND status = 'ACTIVE'",
      [req.body.featureSchemaVersion],
      "admin:recommendationFeatureSchema",
    );
    if (!schema) throw new AppError("That feature schema is not active.", { status: 422, code: "FEATURE_SCHEMA_UNAVAILABLE" });

    const ready = readiness.ready && req.body.datasetKind === "REAL";
    const run = await queryOne(
      `INSERT INTO recommendation_training_runs
         (version, feature_schema_version, dataset_kind, status, failure_reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, version, dataset_kind, status, failure_reason, created_at`,
      [
        req.body.modelVersion,
        req.body.featureSchemaVersion,
        req.body.datasetKind,
        ready ? "EXPORT_REQUESTED" : "REJECTED",
        ready ? null : req.body.datasetKind === "SYNTHETIC" ? "Synthetic data is test-only and cannot be activated." : readiness.reason,
        req.user.id,
      ],
      "admin:recommendationTrainingRequest",
    );
    await recordAudit({
      actor: req.user,
      req,
      action: AUDIT.RECOMMENDATION_TRAINING_REQUESTED,
      entityType: "recommendation_training_run",
      entityId: run.id,
      metadata: { modelVersion: run.version, datasetKind: run.dataset_kind, readiness: readiness.ready },
      required: true,
    });
    return created(res, { run, readiness, started: ready });
  }),
);

/** POST /api/admin/recommendations/models — register an externally trained artifact. */
router.post(
  "/recommendations/models",
  writeLimiter,
  validate({ body: registerModelBody }),
  asyncHandler(async (req, res) => {
    const manifest = req.body.manifest;
    if (manifest.model_version !== req.body.modelVersion || manifest.algorithm !== "LIGHTGBM_LAMBDAMART") {
      throw new AppError("The model manifest does not match the artifact.", { status: 422, code: "MODEL_MANIFEST_MISMATCH" });
    }
    if (manifest.feature_schema_version !== req.body.featureSchemaVersion || manifest.artifact_checksum !== req.body.artifactChecksum) {
      throw new AppError("The model checksum or feature schema does not match the manifest.", { status: 422, code: "MODEL_CHECKSUM_MISMATCH" });
    }
    const qualityChecks = manifest.quality_checks ?? {};
    const fairnessChecks = manifest.fairness_checks ?? {};
    const featureNamesMatch = JSON.stringify(manifest.feature_names) === JSON.stringify([...RECOMMENDATION_FEATURE_NAMES]);
    if (
      manifest.activation_eligible !== true
      || manifest.training_data_kind !== "REAL"
      || !featureNamesMatch
      || qualityChecks.model_matches_or_beats_baseline !== true
      || qualityChecks.coverage_preserved !== true
      || qualityChecks.fairness_gate !== true
      || fairnessChecks.status !== "PASS"
    ) {
      throw new AppError("This model has not passed the activation quality gates.", { status: 422, code: "MODEL_NOT_ACTIVATION_ELIGIBLE" });
    }
    const schema = await queryOne(
      "SELECT version FROM recommendation_feature_schemas WHERE version = $1 AND status = 'ACTIVE'",
      [req.body.featureSchemaVersion],
      "admin:recommendationActiveFeatureSchema",
    );
    if (!schema) throw new AppError("That feature schema is not active.", { status: 422, code: "FEATURE_SCHEMA_UNAVAILABLE" });

    const artifact = await withTransaction(async (tx) => {
      if (req.body.trainingRunId) {
        const run = await tx.queryOne(
          "SELECT id, status FROM recommendation_training_runs WHERE id = $1 FOR UPDATE",
          [req.body.trainingRunId],
          "admin:recommendationTrainingForModel",
        );
        if (!run) throw new NotFoundError("That training run");
        if (run.status !== "READY") throw new ConflictError("That training run is not ready for activation.");
      }
      return tx.queryOne(
        `INSERT INTO recommendation_model_artifacts
           (model_version, algorithm, feature_schema_version, training_run_id,
            artifact_uri, artifact_checksum, manifest, status, created_by)
         VALUES ($1, 'LIGHTGBM_LAMBDAMART', $2, $3, $4, $5, $6, 'VALIDATED', $7)
         RETURNING id, model_version, algorithm, feature_schema_version,
                   artifact_uri, artifact_checksum, status, created_at`,
        [
          req.body.modelVersion,
          req.body.featureSchemaVersion,
          req.body.trainingRunId ?? null,
          req.body.artifactUri,
          req.body.artifactChecksum,
          JSON.stringify(manifest),
          req.user.id,
        ],
        "admin:recommendationRegisterModel",
      );
    }, "admin:recommendationRegisterModel");
    invalidateModelCaches();
    await recordAudit({
      actor: req.user,
      req,
      action: AUDIT.RECOMMENDATION_MODEL_REGISTERED,
      entityType: "recommendation_model_artifact",
      entityId: artifact.id,
      metadata: { modelVersion: artifact.model_version, checksum: artifact.artifact_checksum },
      required: true,
    });
    return created(res, { artifact });
  }),
);

/** POST /api/admin/recommendations/models/:modelVersion/activate */
router.post(
  "/recommendations/models/:modelVersion/activate",
  writeLimiter,
  validate({ params: modelVersionParam }),
  asyncHandler(async (req, res) => {
    const readiness = await getDataReadiness({ force: true });
    if (!readiness.ready) throw new ConflictError(readiness.reason, { code: "TRAINING_DATA_NOT_READY" });

    const artifact = await queryOne(
      "SELECT * FROM recommendation_model_artifacts WHERE model_version = $1",
      [req.params.modelVersion],
      "admin:loadRecommendationArtifact",
    );
    if (!artifact) throw new NotFoundError("That recommendation model");
    if (artifact.status !== "VALIDATED") throw new ConflictError("Only a validated model can be activated.");
    const artifactQuality = artifact.manifest?.quality_checks ?? {};
    const artifactFairness = artifact.manifest?.fairness_checks ?? {};
    if (
      artifact.manifest?.activation_eligible !== true
      || artifact.manifest?.training_data_kind !== "REAL"
      || artifactQuality.model_matches_or_beats_baseline !== true
      || artifactQuality.coverage_preserved !== true
      || artifactQuality.fairness_gate !== true
      || artifactFairness.status !== "PASS"
    ) {
      throw new ConflictError("The model evaluation report did not pass its activation gates.", { code: "MODEL_NOT_READY" });
    }
    const service = await modelServiceHealth({ modelVersion: artifact.model_version });
    if (service.status !== "HEALTHY") {
      throw new ConflictError("The model service must be healthy before a learned model can be activated.", { code: "MODEL_SERVICE_UNAVAILABLE" });
    }
    if (service.modelVersion && service.modelVersion !== artifact.model_version) {
      throw new ConflictError("The model service is serving a different model version.", { code: "MODEL_SERVICE_VERSION_MISMATCH" });
    }
    if (service.featureSchemaVersion && service.featureSchemaVersion !== artifact.feature_schema_version) {
      throw new ConflictError("The model service is serving a different feature schema.", { code: "MODEL_SERVICE_SCHEMA_MISMATCH" });
    }
    if (service.artifactChecksum && service.artifactChecksum !== artifact.artifact_checksum) {
      throw new ConflictError("The model service artifact checksum does not match the registered artifact.", { code: "MODEL_SERVICE_CHECKSUM_MISMATCH" });
    }

    const activated = await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE recommendation_model_artifacts
            SET status = 'DEACTIVATED', deactivated_at = now(), deactivated_by = $1
          WHERE status = 'ACTIVE' AND model_version <> $2`,
        [req.user.id, req.params.modelVersion],
        "admin:deactivateOtherRecommendationModels",
      );
      const next = await tx.queryOne(
        `UPDATE recommendation_model_artifacts
            SET status = 'ACTIVE', activated_at = now(), activated_by = $2,
                deactivated_at = NULL, deactivated_by = NULL, failure_reason = NULL
          WHERE model_version = $1 AND status = 'VALIDATED'
          RETURNING id, model_version, status, activated_at`,
        [req.params.modelVersion, req.user.id],
        "admin:activateRecommendationModel",
      );
      if (!next) throw new ConflictError("That model changed state. Try again.");
      await setRuntime(tx, { algorithm: "LEARNING_TO_RANK" }, req.user.id);
      await recordAudit({
        actor: req.user,
        req,
        action: AUDIT.RECOMMENDATION_MODEL_ACTIVATED,
        entityType: "recommendation_model_artifact",
        entityId: next.id,
        metadata: { modelVersion: next.model_version },
      }, { tx });
      return next;
    }, "admin:activateRecommendationModel");
    invalidateSettingsCache();
    invalidateModelCaches();
    return ok(res, { artifact: activated, readiness });
  }),
);

/** POST /api/admin/recommendations/models/:modelVersion/deactivate */
router.post(
  "/recommendations/models/:modelVersion/deactivate",
  writeLimiter,
  validate({ params: modelVersionParam }),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (tx) => {
      const artifact = await tx.queryOne(
        `UPDATE recommendation_model_artifacts
            SET status = 'DEACTIVATED', deactivated_at = now(), deactivated_by = $2
          WHERE model_version = $1 AND status = 'ACTIVE'
          RETURNING id, model_version, status, deactivated_at`,
        [req.params.modelVersion, req.user.id],
        "admin:deactivateRecommendationModel",
      );
      if (!artifact) throw new ConflictError("That model is not active.");
      await setRuntime(tx, { algorithm: "WEIGHTED_SCORING" }, req.user.id);
      await recordAudit({
        actor: req.user,
        req,
        action: AUDIT.RECOMMENDATION_MODEL_DEACTIVATED,
        entityType: "recommendation_model_artifact",
        entityId: artifact.id,
        metadata: { modelVersion: artifact.model_version },
      }, { tx });
      return artifact;
    }, "admin:deactivateRecommendationModel");
    invalidateSettingsCache();
    invalidateModelCaches();
    return ok(res, { artifact: result, algorithm: "WEIGHTED_SCORING" });
  }),
);

/** PATCH /api/admin/recommendations/settings */
router.patch(
  "/recommendations/settings",
  writeLimiter,
  validate({ body: personalizationSettings }),
  asyncHandler(async (req, res) => {
    const current = await getSection("recommendation.runtime");
    const merged = { ...current, ...req.body };
    const row = await queryOne(
      `INSERT INTO system_settings (key, value, description, updated_by)
       VALUES ('recommendation.runtime', $1::jsonb, 'Recommendation model runtime configuration.', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING key, value, updated_at`,
      [JSON.stringify(merged), req.user.id],
      "admin:updateRecommendationSettings",
    );
    await recordAudit({
      actor: req.user,
      req,
      action: AUDIT.RECOMMENDATION_PERSONALIZATION_UPDATED,
      entityType: "system_setting",
      entityId: "recommendation.runtime",
      metadata: { changes: Object.keys(req.body), personalizationEnabled: merged.personalizationEnabled },
      required: true,
    });
    invalidateSettingsCache();
    return ok(res, { settings: row.value, updatedAt: row.updated_at });
  }),
);

/** POST /api/admin/recommendations/model-service/reset */
router.post(
  "/recommendations/model-service/reset",
  writeLimiter,
  asyncHandler(async (req, res) => {
    resetModelServiceCircuit();
    await recordAudit({
      actor: req.user,
      req,
      action: AUDIT.RECOMMENDATION_CIRCUIT_RESET,
      entityType: "recommendation_model_service",
      metadata: { circuit: "CLOSED" },
      required: true,
    });
    return ok(res, { modelService: modelServiceSnapshot() });
  }),
);

export default router;
