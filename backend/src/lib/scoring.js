import { DEFAULT_WEIGHTS, resolveConfig } from "./weights.js";
import { NEUTRAL, dataConfidence } from "./features.js";

/**
 * The compatibility scorer.
 *
 * A pure function: same inputs always produce the same score. No database, no
 * clock, no randomness — which is what makes the engine testable in isolation
 * and what makes a stored score reproducible months later.
 *
 * Design decisions worth stating explicitly:
 *
 *  1. Every factor returns [0,1] and the weighted sum is multiplied by 100.
 *  2. Missing data yields `NEUTRAL` (0.5) rather than 0. A student who has not
 *     filled in their availability is *unknown*, not *incompatible* — punishing
 *     incomplete profiles would penalise exactly the students onboarding.
 *  3. A confidence term modestly discounts results built from thin data, and is
 *     surfaced to the user instead of being hidden in the score.
 *  4. The headline score is a blend of similarity and complementarity, because
 *     "we study the same thing" and "we fill each other's gaps" are different
 *     qualities and the product values the second one.
 */

const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : NEUTRAL);
const pct = (value) => Math.round(clamp01(value) * 1000) / 10;

/**
 * @typedef {object} ScoreInput
 * @property {number} course            Course/enrolment compatibility  [0,1]
 * @property {number} skills            Skill complementarity            [0,1]
 * @property {number} goals             Learning-goal compatibility      [0,1]
 * @property {number} availability      Schedule overlap                 [0,1]
 * @property {number} preferences       Mode/style/length compatibility   [0,1]
 * @property {number} topics            Topic similarity                 [0,1]
 * @property {number} [activity]        Group activity alignment         [0,1]
 * @property {number} [groupSize]       Group-size fit                   [0,1]
 * @property {number} [feedback]        Historical feedback signal       [0,1]
 * @property {number} [preferenceText]  Free-text preference agreement   [0,1]
 * @property {number} [confidence]      Input data quality               [0,1]
 * @property {object} [weights]
 * @property {object} [config]
 */

/**
 * Compute a compatibility score.
 * @param {ScoreInput} input
 * @returns {{
 *   score: number,
 *   breakdown: Record<string, {raw:number, weighted:number, weight:number}>,
 *   similarity: number,
 *   complementarity: number,
 *   confidence: number,
 *   adjustedForConfidence: boolean,
 * }}
 */
export function computeCompatibility(input) {
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const config = resolveConfig(input.config);

  const factors = {
    course: clamp01(input.course),
    skills: clamp01(input.skills),
    goals: clamp01(input.goals),
    availability: clamp01(input.availability),
    preferences: clamp01(input.preferences),
    topics: clamp01(input.topics),
  };

  // Secondary factors. They have no published weight of their own; they adjust
  // the base score, which keeps the primary weighting scheme interpretable and
  // comparable across model versions.
  const secondary = {
    activity: Number.isFinite(input.activity) ? clamp01(input.activity) : null,
    groupSize: Number.isFinite(input.groupSize) ? clamp01(input.groupSize) : null,
    feedback: Number.isFinite(input.feedback) ? clamp01(input.feedback) : null,
    preferenceText: Number.isFinite(input.preferenceText) ? clamp01(input.preferenceText) : null,
  };

  // ---- Weighted base -------------------------------------------------------
  const breakdown = {};
  let weightedSum = 0;
  let weightTotal = 0;

  for (const [key, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight)) continue;
    const raw = factors[key] ?? NEUTRAL;
    weightedSum += raw * weight;
    weightTotal += weight;
    breakdown[key] = {
      raw: pct(raw),
      weighted: Math.round(raw * weight * 1000) / 10,
      weight,
    };
  }

  // Renormalise so a partially-specified weight set still yields [0,1].
  const base = weightTotal > 0 ? weightedSum / weightTotal : NEUTRAL;

  // ---- Secondary adjustments ---------------------------------------------
  let score = base;
  const adjustments = [];

  for (const [key, value] of Object.entries(secondary)) {
    if (value === null) continue;
    // Each secondary factor can move the score by at most ±4 points, so no
    // single soft signal can dominate the weighted core.
    const delta = (value - 0.5) * 0.08;
    score += delta;
    adjustments.push({ key, raw: pct(value), deltaPoints: Math.round(delta * 1000) / 10 });
  }

  // ---- Confidence shrinkage ---------------------------------------------
  const confidence = Number.isFinite(input.confidence)
    ? clamp01(input.confidence)
    : dataConfidence(input.profile ?? null);

  // Confidence shrinks the score proportionally toward a neutral midpoint, in
  // proportion to how much data is missing. Doing it proportionally rather than
  // additively matters at the ceiling: a candidate with perfect-but-unknown
  // inputs must not still be able to claim 100%.
  const confidenceInfluence = Number.isFinite(config.confidenceInfluence)
    ? config.confidenceInfluence
    : 0.12;
  const confidenceTarget = 0.55;
  const confidencePull = (confidenceTarget - score) * confidenceInfluence * (1 - confidence);
  score += confidencePull;

  const adjustedForConfidence = Math.abs(confidencePull) >= 0.005;
  score = clamp01(score);

  // ---- Similarity vs complementarity --------------------------------------
  // Reported separately so the UI can explain *why* rather than showing an
  // unexplained number. Similarity = shared context; complementarity = gaps
  // filled. The emphasis weight reflects the product's thesis that who fills
  // your gaps matters more than who resembles you.
  const emphasis = Number.isFinite(config.complementarityEmphasis)
    ? config.complementarityEmphasis
    : 0.6;

  const similarityRaw = factors.goals * 0.4 + factors.topics * 0.35 + factors.course * 0.25;
  const complementarityRaw = factors.skills * 0.65 + factors.availability * 0.2 + factors.preferences * 0.15;

  const finalScore = Math.round(score * 1000) / 10;

  return {
    score: finalScore,
    breakdown,
    adjustments,
    similarity: pct(similarityRaw),
    complementarity: pct(complementarityRaw * 0.7 + similarityRaw * 0.3),
    confidence: pct(confidence),
    adjustedForConfidence,
  };
}

/**
 * Apply a calibration curve to the raw score.
 *
 * Weighted sums cluster around the middle, which makes every candidate look
 * mediocre. An isotonic-style monotone curve spreads the useful range without
 * reordering candidates, so relative ranking is preserved exactly. This is why
 * the score can be described as "compatibility based on your current profile"
 * rather than as a probability.
 *
 * @param {number} score 0..100
 */
export function calibrate(score) {
  const x = clamp01(score / 100);
  // Monotone S-curve, steepest in the mid range.
  const calibrated = 1 / (1 + Math.exp(-6 * (x - 0.5)));
  // Rescale so the endpoints stay near 0 and 100.
  const lower = 1 / (1 + Math.exp(6 * 0.5));
  const upper = 1 / (1 + Math.exp(-6 * 0.5));
  const normalized = (calibrated - lower) / (upper - lower);
  return Math.round(clamp01(normalized) * 1000) / 10;
}

/**
 * Build the "Why am I seeing this?" payload.
 *
 * Explanations are ordered by contribution so the strongest reasons appear
 * first, and each carries the factor it came from — this is what makes the
 * ranking auditable rather than a black box.
 *
 * @returns {Array<{type:string, detail:string, weight:number, impact:string}>}
 */
export function buildExplanation(result, context = {}) {
  const items = [];
  const { breakdown = {}, overlappingTopics = [], availabilityMinutes = 0 } = result;

  // Reporting thresholds. `breakdown.*.raw` is a 0..100 percentage, so these
  // must be percentages too — mixing units here is how a factor with a raw score
  // of 0 silently reports itself as a perfect match.
  const HIGH = 80;
  const MEDIUM = 70;
  const LOW = 30;

  // `optional: true` items are caveats and warnings, not positive reasons — they
  // carry no weight but must still be shown, because omitting a schedule
  // mismatch or a low-confidence caveat would make the explanation misleading.
  const push = (type, detail, weight, impact, optional = false) => {
    if (!optional && weight <= 0) return;
    items.push({ type, detail, weight, impact });
  };

  if ((breakdown.course?.raw ?? 0) >= HIGH) {
    push(
      "COURSE_MATCH",
      context.courseName
        ? `Both of you are taking ${context.courseName}.`
        : "You are taking the same course.",
      breakdown.course.weight,
      "high",
    );
  }

  if (context.complementaryDetail?.length) {
    const topics = context.complementaryDetail.slice(0, 3).map((entry) => context.topicNames?.[entry.topicId] ?? "this topic");
    const subject = context.complementaryDetail[0].direction;
    if (topics.length) {
      push(
        "SKILL_COMPLEMENTARITY",
        subject === "they_help_me"
          ? `They have stronger knowledge in ${formatList(topics)} — an area you flagged as a weakness.`
          : subject === "i_help_them"
            ? `You can support them on ${formatList(topics)}.`
            : `Your strengths and weaknesses balance out across ${formatList(topics)}.`,
        breakdown.skills.weight,
        "high",
      );
    }
  }

  if ((breakdown.goals?.raw ?? 0) >= MEDIUM && context.goalLabel) {
    push("GOAL_MATCH", `You are both working towards the same goal: ${context.goalLabel}.`, breakdown.goals.weight, "high");
  }

  if (availabilityMinutes > 0) {
    const label = formatMinutes(availabilityMinutes);
    push(
      "SCHEDULE_OVERLAP",
      `Your available study time overlaps by ${label}.`,
      breakdown.availability.weight,
      availabilityMinutes >= 120 ? "high" : "medium",
    );
  } else if ((breakdown.availability?.raw ?? 100) < LOW) {
    push("SCHEDULE_MISMATCH", "Your schedules currently have little or no overlap.", 0, "negative", true);
  }

  if (context.groupSizeMatch && context.groupSizeText) {
    push("GROUP_SIZE", `Preferred group size matches: ${context.groupSizeText}.`, breakdown.preferences.weight, "medium");
  }

  if ((breakdown.preferences?.raw ?? 0) >= HIGH && context.modeMatch) {
    push("STUDY_MODE", context.modeMatch, breakdown.preferences.weight, "medium");
  }

  if (overlappingTopics.length && context.topicNames) {
    const names = overlappingTopics.slice(0, 3).map((id) => context.topicNames[id]).filter(Boolean);
    if (names.length) {
      push("TOPIC_OVERLAP", `You are both focusing on ${formatList(names)}.`, breakdown.topics.weight, "low");
    }
  }

  if (context.activityNote) {
    push("ACTIVITY", context.activityNote, 0, "low", true);
  }

  // `confidence` is reported as a 0..100 percentage, so the caveat threshold is
  // 50, not 0.5.
  if (result.confidence !== undefined && result.confidence < 50) {
    push(
      "LOW_CONFIDENCE",
      "This match is based on limited profile data — add availability and topics to improve it.",
      0,
      "caveat",
      true,
    );
  }

  // Optional/caveat items first so they cannot be pushed out of view by positive
  // reasons, then positive reasons by descending weight.
  const severity = { negative: 0, caveat: 1, high: 2, medium: 3, low: 4 };
  return items.sort(
    (a, b) =>
      (severity[a.impact] ?? 5) - (severity[b.impact] ?? 5) || b.weight - a.weight,
  );
}

function formatList(items) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? "" : "s"}`;
}

/**
 * Human-readable strength label. Bands are deliberately coarse — a 93% and a
 * 94% compatibility are not meaningfully different, and implying otherwise would
 * overstate the precision of the model.
 */
export function strengthLabel(score) {
  if (score >= 85) return "Strong match";
  if (score >= 70) return "Good match";
  if (score >= 55) return "Fair match";
  if (score >= 40) return "Weak match";
  return "Low match";
}

export default { computeCompatibility, calibrate, buildExplanation, strengthLabel };