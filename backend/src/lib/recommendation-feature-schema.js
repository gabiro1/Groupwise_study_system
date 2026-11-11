/**
 * Versioned, safe feature contract shared by the Node scorer and the offline
 * learning-to-rank pipeline. These values are deliberately structured and do
 * not contain names, emails, messages, secrets, or sensitive attributes.
 */

export const RECOMMENDATION_FEATURE_SCHEMA_VERSION = "recommendation-features-v1";

export const RECOMMENDATION_FEATURE_NAMES = Object.freeze([
  "shared_course_count",
  "same_programme",
  "course_compatibility",
  "skill_complementarity",
  "topic_similarity",
  "goal_compatibility",
  "availability_overlap",
  "mode_compatibility",
  "style_compatibility",
  "session_length_compatibility",
  "preference_compatibility",
  "group_size_compatibility",
  "activity_compatibility",
  "candidate_activity_score",
  "group_dormancy",
  "capacity_available_ratio",
  "group_age_days",
  "profile_confidence",
  "profile_fields_completed",
  "candidate_type_group",
  "requester_prior_accepted_count",
  "requester_helpful_feedback_rate",
  "requester_group_retention_rate",
]);

const clamp = (value, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : (min + max) / 2);
const clamp01 = (value) => clamp(value, 0, 1);

/**
 * Convert the calculated compatibility signals into the exact model schema.
 * The model receives a complete vector so a missing optional signal is neutral
 * rather than silently changing the feature ordering.
 */
export function buildRecommendationFeatureVector({
  sharedCourses = 0,
  sameProgramme = false,
  courseCompatibility = 0.5,
  skillComplementarity = 0.5,
  topicSimilarity = 0.5,
  goalCompatibility = 0.5,
  availabilityOverlap = 0.5,
  preferences = {},
  groupSizeCompatibility = 0.5,
  activityCompatibility = 0.5,
  candidateActivityScore = 0.5,
  daysSinceLastEvent = null,
  memberCount = null,
  maxSize = null,
  ageDays = null,
  profileConfidence = 0.5,
  profileFieldsCompleted = 0.5,
  isGroup = false,
  personalization = {},
} = {}) {
  const components = new Map((preferences.components ?? []).map((item) => [item.key, item.score]));
  const dormancy = Number.isFinite(daysSinceLastEvent)
    ? daysSinceLastEvent <= 7 ? 1 : daysSinceLastEvent <= 14 ? 0.8 : daysSinceLastEvent <= 30 ? 0.55 : 0.3
    : 0.5;
  const capacity = Number.isFinite(memberCount) && Number.isFinite(maxSize) && maxSize > 0
    ? clamp01((maxSize - memberCount) / maxSize)
    : 0.5;

  const values = {
    shared_course_count: clamp(sharedCourses, 0, 4),
    same_programme: sameProgramme ? 1 : 0,
    course_compatibility: clamp01(courseCompatibility),
    skill_complementarity: clamp01(skillComplementarity),
    topic_similarity: clamp01(topicSimilarity),
    goal_compatibility: clamp01(goalCompatibility),
    availability_overlap: clamp01(availabilityOverlap),
    mode_compatibility: clamp01(components.get("mode")),
    style_compatibility: clamp01(components.get("style")),
    session_length_compatibility: clamp01(components.get("session_length")),
    preference_compatibility: clamp01(preferences.score),
    group_size_compatibility: clamp01(groupSizeCompatibility),
    activity_compatibility: clamp01(activityCompatibility),
    candidate_activity_score: clamp01(candidateActivityScore),
    group_dormancy: clamp01(dormancy),
    capacity_available_ratio: capacity,
    group_age_days: Number.isFinite(ageDays) ? clamp(ageDays / 365, 0, 1) : 0.5,
    profile_confidence: clamp01(profileConfidence),
    profile_fields_completed: clamp01(profileFieldsCompleted),
    candidate_type_group: isGroup ? 1 : 0,
    requester_prior_accepted_count: clamp((personalization.acceptedCount ?? 0) / 10, 0, 1),
    requester_helpful_feedback_rate: clamp01(personalization.helpfulFeedbackRate),
    requester_group_retention_rate: clamp01(personalization.retentionRate),
  };

  return Object.fromEntries(RECOMMENDATION_FEATURE_NAMES.map((name) => [name, values[name]]));
}

export function validateRecommendationFeatureVector(features) {
  const errors = [];
  if (!features || typeof features !== "object" || Array.isArray(features)) {
    return { valid: false, errors: ["features must be an object"] };
  }

  for (const name of RECOMMENDATION_FEATURE_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(features, name)) {
      errors.push(`features.${name} is required`);
      continue;
    }
    const value = Number(features[name]);
    if (!Number.isFinite(value)) {
      errors.push(`features.${name} must be numeric`);
      continue;
    }
    const maximum = name === "shared_course_count" ? 4 : 1;
    if (value < 0 || value > maximum) errors.push(`features.${name} must be between 0 and ${maximum}`);
  }

  for (const name of Object.keys(features)) {
    if (!RECOMMENDATION_FEATURE_NAMES.includes(name)) errors.push(`features.${name} is not recognised`);
  }

  return { valid: errors.length === 0, errors };
}

export default {
  RECOMMENDATION_FEATURE_SCHEMA_VERSION,
  RECOMMENDATION_FEATURE_NAMES,
  buildRecommendationFeatureVector,
  validateRecommendationFeatureVector,
};
