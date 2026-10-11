/**
 * Recommendation weights and scoring configuration.
 *
 * Weights are configuration, not constants buried in the scorer. They are
 * seeded into `recommendation_model_versions` and read from the database at
 * request time, which is what makes the weighting scheme tunable and what
 * allows A/B-style experiments between model versions without a code change.
 */

export const MODEL_VERSION = "weighted-v1.0.0";

/**
 * The published weighting scheme from the project specification.
 *
 * Note the deliberate split: "skills" (25%) is complementarity — knowledge
 * gaps filled — while "topics" (5%) is syllabus overlap. Collapsing these two
 * would lose the central thesis of the system.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  course: 0.25,
  skills: 0.25,
  goals: 0.2,
  availability: 0.15,
  preferences: 0.1,
  topics: 0.05,
});

export const MODEL_METADATA = Object.freeze({
  id: MODEL_VERSION,
  algorithm: "WEIGHTED_SCORING",
  description:
    "Version 1: deterministic weighted multi-factor scoring with explicit " +
    "skill-complementarity and data-confidence terms. No learned parameters — " +
    "weights are expert-set and versioned so results are reproducible.",
  weights: DEFAULT_WEIGHTS,
  config: {
    /** How much a candidate's data quality modulates their score. */
    confidenceInfluence: 0.12,
    /** Below this, a candidate is not shown at all. */
    minimumScore: 25,
    /** Above this, the candidate is labelled "exceptional match". */
    strongMatch: 80,
    /** How many results to return by default. */
    defaultLimit: 20,
    /** Weight given to similarity vs complementarity in the headline number. */
    complementarityEmphasis: 0.6,
  },
});

/**
 * Validate a weight set: all finite, non-negative, and summing to 1.
 * The database enforces this too, but failing early here means a bad
 * configuration surfaces as a clear error rather than silently skewed scores.
 *
 * @returns {{valid:boolean, errors:string[], normalized:object}}
 */
export function validateWeights(weights) {
  const errors = [];
  const keys = Object.keys(DEFAULT_WEIGHTS);
  const normalized = {};

  for (const key of keys) {
    const value = Number(weights?.[key]);
    if (!Number.isFinite(value)) {
      errors.push(`weights.${key} must be a number`);
      normalized[key] = DEFAULT_WEIGHTS[key];
      continue;
    }
    if (value < 0) errors.push(`weights.${key} must not be negative`);
    normalized[key] = value;
  }

  const total = keys.reduce((sum, key) => sum + (Number.isFinite(normalized[key]) ? normalized[key] : 0), 0);
  // 0.001 tolerance absorbs floating-point representation error.
  if (Math.abs(total - 1) > 0.001) {
    errors.push(`weights must sum to 1 (got ${total.toFixed(4)})`);
  }

  return { valid: errors.length === 0, errors, normalized };
}

/** Merge persisted config over the defaults without losing new keys. */
export function resolveConfig(overrides = {}) {
  return { ...MODEL_METADATA.config, ...overrides };
}

export default { MODEL_VERSION, DEFAULT_WEIGHTS, MODEL_METADATA, validateWeights, resolveConfig };