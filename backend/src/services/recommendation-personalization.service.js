import { queryOne, queryRows } from "../config/db.js";
import logger from "../config/logger.js";
import { RECOMMENDATION_FEATURE_NAMES } from "../lib/recommendation-feature-schema.js";

const PROFILE_VERSION = "personalization-v1";
const CACHE_TTL_MS = 10 * 60 * 1000;
const RETENTION_WINDOW_MS = 30 * 86_400_000;
const cache = new Map();

function emptyProfile() {
  return {
    version: PROFILE_VERSION,
    eventCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    feedbackCount: 0,
    retainedCount: 0,
    helpfulFeedbackRate: 0.5,
    retentionRate: 0.5,
    featurePreferences: {},
    reasonCounts: {},
    successfulTypes: {},
    lastEventAt: null,
    status: "COLD_START",
  };
}

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function mean(values, prior = 0.5) {
  if (!values.length) return prior;
  // Bayesian smoothing prevents one interaction from becoming a hard preference.
  return (values.reduce((sum, value) => sum + value, 0) + prior * 2) / (values.length + 2);
}

function hasEvent(row) {
  return Boolean(row.accepted_at || row.rejected_at || row.clicked_at || (row.helpful !== null && row.helpful !== undefined));
}

function retentionObserved(row) {
  if (row.kind !== "GROUP" || !row.joined_at) return false;
  const joinedAt = new Date(row.joined_at).getTime();
  if (!Number.isFinite(joinedAt) || Date.now() - joinedAt < RETENTION_WINDOW_MS) return false;
  if (!row.left_at) return true;
  const leftAt = new Date(row.left_at).getTime();
  return Number.isFinite(leftAt) && leftAt - joinedAt >= RETENTION_WINDOW_MS;
}

function summarize(rows) {
  const profile = emptyProfile();
  const positiveFeatures = Object.fromEntries(RECOMMENDATION_FEATURE_NAMES.map((name) => [name, []]));
  const negativeFeatures = Object.fromEntries(RECOMMENDATION_FEATURE_NAMES.map((name) => [name, []]));
  let helpful = 0;
  let unhelpful = 0;
  let acceptedGroupCount = 0;

  for (const row of rows) {
    if (!hasEvent(row)) continue;
    profile.eventCount += 1;
    if (row.accepted_at) {
      profile.acceptedCount += 1;
      if (row.kind === "GROUP") acceptedGroupCount += 1;
    }
    if (row.rejected_at) profile.rejectedCount += 1;
    if (row.helpful !== null && row.helpful !== undefined) {
      profile.feedbackCount += 1;
      if (row.helpful) helpful += 1;
      else unhelpful += 1;
      if (row.reason) profile.reasonCounts[row.reason] = (profile.reasonCounts[row.reason] ?? 0) + 1;
    }

    const retained = retentionObserved(row);
    if (retained) profile.retainedCount += 1;

    const negative = Boolean(row.rejected_at || row.helpful === false || finite(row.overall_rating) <= 2);
    const positive = !negative && Boolean(row.accepted_at || row.helpful === true || retained || finite(row.overall_rating) >= 4);
    const features = row.feature_values && typeof row.feature_values === "object" ? row.feature_values : {};
    const target = positive ? positiveFeatures : negative ? negativeFeatures : null;
    if (target) {
      for (const name of RECOMMENDATION_FEATURE_NAMES) {
        if (Number.isFinite(Number(features[name]))) target[name].push(Number(features[name]));
      }
    }

    if (positive) profile.successfulTypes[row.kind] = (profile.successfulTypes[row.kind] ?? 0) + 1;
    const eventDate = row.accepted_at || row.rejected_at || row.clicked_at || row.feedback_created_at;
    if (eventDate && (!profile.lastEventAt || new Date(eventDate) > new Date(profile.lastEventAt))) {
      profile.lastEventAt = eventDate;
    }
  }

  const feedbackTotal = helpful + unhelpful;
  const retentionDenominator = acceptedGroupCount > 0 ? acceptedGroupCount : profile.retainedCount;
  profile.helpfulFeedbackRate = feedbackTotal ? (helpful + 1) / (feedbackTotal + 2) : 0.5;
  profile.retentionRate = retentionDenominator ? (profile.retainedCount + 1) / (retentionDenominator + 2) : 0.5;
  profile.featurePreferences = Object.fromEntries(RECOMMENDATION_FEATURE_NAMES.map((name) => [name, {
    positiveMean: mean(positiveFeatures[name]),
    negativeMean: mean(negativeFeatures[name]),
    positiveSamples: positiveFeatures[name].length,
    negativeSamples: negativeFeatures[name].length,
  }]));
  profile.status = profile.eventCount ? "ACTIVE" : "COLD_START";
  return profile;
}

async function readHistory(studentId) {
  return queryRows(
    `SELECT r.kind, r.feature_values, r.accepted_at, r.rejected_at, r.clicked_at,
            rf.helpful, rf.reason, rf.created_at AS feedback_created_at,
            mo.joined_at, mo.left_at, gf.overall_rating
       FROM recommendations r
       JOIN recommendation_requests rr ON rr.id = r.request_id
       LEFT JOIN recommendation_feedback rf ON rf.recommendation_id = r.id
       LEFT JOIN group_membership_outcomes mo ON mo.recommendation_id = r.id
       LEFT JOIN group_feedback gf ON gf.workspace_id = mo.workspace_id AND gf.student_id = r.student_id
      WHERE r.student_id = $1 AND rr.created_at < now()
      ORDER BY rr.created_at DESC
      LIMIT 500`,
    [studentId],
    "recs:personalizationHistory",
  );
}

async function persistProfile(studentId, profile) {
  await queryOne(
    `INSERT INTO student_recommendation_profiles
       (student_id, version, event_count, accepted_count, rejected_count, feedback_count,
        retained_count, helpful_feedback_rate, retention_rate, feature_preferences,
        reason_counts, successful_types, last_event_at, status, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL)
     ON CONFLICT (student_id) DO UPDATE SET
       version = EXCLUDED.version,
       event_count = EXCLUDED.event_count,
       accepted_count = EXCLUDED.accepted_count,
       rejected_count = EXCLUDED.rejected_count,
       feedback_count = EXCLUDED.feedback_count,
       retained_count = EXCLUDED.retained_count,
       helpful_feedback_rate = EXCLUDED.helpful_feedback_rate,
       retention_rate = EXCLUDED.retention_rate,
       feature_preferences = EXCLUDED.feature_preferences,
       reason_counts = EXCLUDED.reason_counts,
       successful_types = EXCLUDED.successful_types,
       last_event_at = EXCLUDED.last_event_at,
       status = EXCLUDED.status,
       failure_reason = NULL,
       updated_at = now()
     RETURNING student_id`,
    [
      studentId,
      profile.version,
      profile.eventCount,
      profile.acceptedCount,
      profile.rejectedCount,
      profile.feedbackCount,
      profile.retainedCount,
      profile.helpfulFeedbackRate,
      profile.retentionRate,
      JSON.stringify(profile.featurePreferences),
      JSON.stringify(profile.reasonCounts),
      JSON.stringify(profile.successfulTypes),
      profile.lastEventAt,
      profile.status,
    ],
    "recs:personalizationProfile",
  );
}

/**
 * Load a smoothed, student-specific preference summary. It contains aggregate
 * feature statistics only; raw feedback comments are never read here.
 */
export async function loadPersonalizationState(studentId, { refresh = false } = {}) {
  const cached = cache.get(studentId);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const profile = summarize(await readHistory(studentId));
    await persistProfile(studentId, profile);
    cache.set(studentId, { value: profile, expiresAt: Date.now() + CACHE_TTL_MS });
    return profile;
  } catch (error) {
    // Personalization must never make the recommendation endpoint unavailable.
    logger.warn("Personalization profile unavailable; using cold start", { message: error.message });
    const profile = emptyProfile();
    cache.set(studentId, { value: profile, expiresAt: Date.now() + 30_000 });
    return profile;
  }
}

export function invalidatePersonalization(studentId) {
  cache.delete(studentId);
}

/**
 * Apply a conservative score adjustment. The result is in percentage points and
 * is always bounded by the configured maximum.
 */
export function boundedPersonalizationAdjustment(profile, features, { maxPoints = 4, minEvents = 5 } = {}) {
  if (!profile || profile.eventCount < minEvents) return 0;

  let delta = 0;
  for (const name of RECOMMENDATION_FEATURE_NAMES) {
    const preference = profile.featurePreferences?.[name];
    const value = Number(features?.[name]);
    if (!preference || !Number.isFinite(value)) continue;
    const direction = Number(preference.positiveMean) - Number(preference.negativeMean);
    if (!Number.isFinite(direction)) continue;
    delta += (value - 0.5) * direction * 4;
  }

  const reliability = Math.min(1, profile.eventCount / Math.max(minEvents * 2, 10));
  return Math.min(maxPoints, Math.max(-maxPoints, delta * reliability));
}

export function publicPersonalizationState(profile, { enabled = false, minEvents = 5 } = {}) {
  return {
    enabled,
    eventCount: profile?.eventCount ?? 0,
    minimumEvents: minEvents,
    eligible: Boolean(enabled && (profile?.eventCount ?? 0) >= minEvents),
    status: profile?.status ?? "COLD_START",
    lastEventAt: profile?.lastEventAt ?? null,
  };
}

export default {
  loadPersonalizationState,
  invalidatePersonalization,
  boundedPersonalizationAdjustment,
  publicPersonalizationState,
};
