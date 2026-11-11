import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/lien_test";
process.env.AUTH_SECRET ??= "unit-test-auth-secret-012345678901234567890123";
process.env.RECOMMENDATION_MODEL_SERVICE_URL = "http://model.test";
process.env.RECOMMENDATION_MODEL_SERVICE_TOKEN = "unit-test-model-token";

const { RECOMMENDATION_FEATURE_NAMES, buildRecommendationFeatureVector, validateRecommendationFeatureVector } =
  await import("../src/lib/recommendation-feature-schema.js");
const { MODEL_ALGORITHMS, selectRecommendationModel } = await import("../src/services/recommendation-model.service.js");
const {
  boundedPersonalizationAdjustment,
  publicPersonalizationState,
} = await import("../src/services/recommendation-personalization.service.js");

const ready = { ready: true, reason: null };
const runtime = { algorithm: "LEARNING_TO_RANK", personalizationEnabled: true };
const artifact = {
  status: "ACTIVE",
  algorithm: "LIGHTGBM_LAMBDAMART",
  model_version: "ltr-v1",
  feature_schema_version: "recommendation-features-v1",
};

describe("recommendation learning safeguards", () => {
  it("builds and validates the exact bounded feature vector", () => {
    const features = buildRecommendationFeatureVector({
      sharedCourses: 8,
      sameProgramme: true,
      preferences: { score: 0.8, components: [{ key: "mode", score: 1 }] },
      profileFieldsCompleted: 1,
    });

    assert.deepEqual(Object.keys(features), RECOMMENDATION_FEATURE_NAMES);
    assert.equal(features.shared_course_count, 4);
    assert.deepEqual(validateRecommendationFeatureVector(features), { valid: true, errors: [] });
    assert.equal(
      validateRecommendationFeatureVector({ ...features, group_age_days: 2 }).valid,
      false,
    );
  });

  it("only selects an active learned model when every gate is satisfied", () => {
    const selected = selectRecommendationModel({
      candidateCount: 3,
      dataReadiness: ready,
      personalizationState: { eligible: true },
      artifact,
      runtime,
      baselineModelVersion: "weighted-v1",
    });
    assert.equal(selected.algorithm, MODEL_ALGORITHMS.LEARNING_TO_RANK_WITH_PERSONALIZATION);
    assert.equal(selected.modelVersion, "ltr-v1");
    assert.equal(selected.degraded, false);

    const fallback = selectRecommendationModel({
      candidateCount: 3,
      dataReadiness: ready,
      personalizationState: { eligible: true },
      artifact: null,
      runtime,
      baselineModelVersion: "weighted-v1",
    });
    assert.equal(fallback.algorithm, MODEL_ALGORITHMS.PERSONALIZED_WEIGHTED_SCORING);
    assert.equal(fallback.degraded, true);
  });

  it("keeps personalization bounded and cold-start safe", () => {
    const profile = {
      eventCount: 20,
      status: "ACTIVE",
      featurePreferences: {
        course_compatibility: { positiveMean: 1, negativeMean: 0 },
      },
    };
    const adjustment = boundedPersonalizationAdjustment(profile, { course_compatibility: 1 }, { maxPoints: 2, minEvents: 5 });
    assert.ok(adjustment > 0 && adjustment <= 2);
    assert.equal(boundedPersonalizationAdjustment({ eventCount: 1 }, { course_compatibility: 1 }), 0);

    const publicState = publicPersonalizationState(profile, { enabled: true, minEvents: 5 });
    assert.equal(publicState.eligible, true);
    assert.equal(Object.hasOwn(publicState, "featurePreferences"), false);
  });
});
