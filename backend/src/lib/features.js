import { PROFICIENCY_SCORE, TOPIC_STATUS_MEANING, GROUP_SIZE } from "../config/constants.js";

/**
 * Feature extraction for the recommendation engine.
 *
 * Turns raw student/group records into the normalised numeric signals the
 * scoring module consumes. Keeping this separate from scoring means the
 * semantics of each feature live in exactly one place, and scoring stays a pure
 * function of its inputs (which is what makes it testable).
 *
 * All features are in [0, 1]. `null` means "not enough information" and is
 * treated as neutral-with-penalty by the scorer, never as a zero.
 */

/** Numeric midpoint used when a feature cannot be computed. */
export const NEUTRAL = 0.5;

/** Weight of missing information in a partial profile. */
export const MISSING_DATA_PENALTY = 0.15;

const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : NEUTRAL);
const ratio = (part, whole) => (whole > 0 ? clamp01(part / whole) : NEUTRAL);
const pct = (value) => Math.round(clamp01(value) * 1000) / 10;

/**
 * Interval overlap as a proportion of the smaller interval. Two students are
 * compatible when *both* can attend, so the smaller interval is the binding
 * constraint — 90 shared minutes is a 90-minute fit, not a "50% match".
 *
 * @returns {{minutes: number, score: number}} Overlap in minutes and [0,1] score.
 */
export function intervalOverlap(startA, endA, startB, endB) {
  if (![startA, endA, startB, endB].every(Number.isFinite)) {
    return { minutes: 0, score: NEUTRAL };
  }
  const start = Math.max(startA, startB);
  const end = Math.min(endA, endB);
  const minutes = Math.max(0, end - start);
  if (minutes === 0) return { minutes: 0, score: 0 };

  const smaller = Math.min(endA - startA, endB - startB);
  return { minutes, score: clamp01(minutes / smaller) };
}

/**
 * Availability compatibility between two weekly schedules.
 *
 * Combines three signals that all matter in practice:
 *
 *  - **coverage**: what fraction of the more-constrained person's declared time
 *    is actually shared. Two students who are each only free on Saturday
 *    morning and who both pick Saturday morning have *complete* overlap — that
 *    should score full marks, not 70%.
 *  - **volume**: absolute shared minutes, capped at ~3 hours. Prevents a student
 *    with very broad availability from scoring well purely on raw hours.
 *  - **breadth**: number of distinct shared days. One rushed hour a week is a
 *    worse study relationship than four hours across three days, even at equal
 *    totals.
 *
 * @param {Array<{day_of_week:number,start_minute:number,end_minute:number}>} a
 * @param {Array<{day_of_week:number,start_minute:number,end_minute:number}>} b
 */
export function availabilityCompatibility(a = [], b = []) {
  if (a.length === 0 || b.length === 0) {
    return { score: NEUTRAL, totalMinutes: 0, sharedDays: 0, hasData: false };
  }

  let totalMinutes = 0;
  const sharedDays = new Set();

  for (const slotA of a) {
    for (const slotB of b) {
      if (slotA.day_of_week !== slotB.day_of_week) continue;
      const { minutes } = intervalOverlap(
        slotA.start_minute,
        slotA.end_minute,
        slotB.start_minute,
        slotB.end_minute,
      );
      if (minutes > 0) {
        totalMinutes += minutes;
        sharedDays.add(slotA.day_of_week);
      }
    }
  }

  if (totalMinutes === 0) return { score: 0, totalMinutes: 0, sharedDays: 0, hasData: true };

  const totalA = a.reduce((sum, slot) => sum + (slot.end_minute - slot.start_minute), 0);
  const totalB = b.reduce((sum, slot) => sum + (slot.end_minute - slot.start_minute), 0);
  const smallerTotal = Math.min(totalA, totalB);

  const coverage = smallerTotal > 0 ? clamp01(totalMinutes / smallerTotal) : NEUTRAL;
  const volume = clamp01(totalMinutes / 180);
  const depth = clamp01(coverage * 0.5 + volume * 0.5);

  // Two or more shared days is a dependable routine worth rewarding.
  const breadth = clamp01(sharedDays.size / 2);

  return {
    score: clamp01(depth * 0.7 + breadth * 0.3),
    totalMinutes,
    sharedDays: sharedDays.size,
    coverage: pct(coverage),
    hasData: true,
  };
}

/**
 * Learning-goal compatibility. Goals are not all equally compatible: two people
 * preparing for the same exam is a stronger fit than one revising generally and
 * one preparing for an exam, and "peer teaching" pairs naturally with
 * "needs help".
 */
const GOAL_AFFINITY = {
  EXAM_PREPARATION: { EXAM_PREPARATION: 1.0, PRACTICE: 0.8, GENERAL_REVISION: 0.75, ASSIGNMENT: 0.55, IMPROVE_UNDERSTANDING: 0.7, PEER_TEACHING: 0.6, RESEARCH_PROJECT: 0.5 },
  ASSIGNMENT: { ASSIGNMENT: 1.0, EXAM_PREPARATION: 0.55, PRACTICE: 0.7, GENERAL_REVISION: 0.5, IMPROVE_UNDERSTANDING: 0.6, PEER_TEACHING: 0.55, RESEARCH_PROJECT: 0.6 },
  IMPROVE_UNDERSTANDING: { IMPROVE_UNDERSTANDING: 1.0, PRACTICE: 0.75, EXAM_PREPARATION: 0.7, GENERAL_REVISION: 0.7, PEER_TEACHING: 0.85, ASSIGNMENT: 0.6, RESEARCH_PROJECT: 0.7 },
  PRACTICE: { PRACTICE: 1.0, EXAM_PREPARATION: 0.8, ASSIGNMENT: 0.7, IMPROVE_UNDERSTANDING: 0.75, PEER_TEACHING: 0.5, GENERAL_REVISION: 0.6, RESEARCH_PROJECT: 0.45 },
  PEER_TEACHING: { PEER_TEACHING: 1.0, IMPROVE_UNDERSTANDING: 0.85, PRACTICE: 0.5, EXAM_PREPARATION: 0.6, GENERAL_REVISION: 0.6, ASSIGNMENT: 0.55, RESEARCH_PROJECT: 0.65 },
  GENERAL_REVISION: { GENERAL_REVISION: 1.0, EXAM_PREPARATION: 0.75, IMPROVE_UNDERSTANDING: 0.7, PRACTICE: 0.6, ASSIGNMENT: 0.5, PEER_TEACHING: 0.6, RESEARCH_PROJECT: 0.45 },
  RESEARCH_PROJECT: { RESEARCH_PROJECT: 1.0, IMPROVE_UNDERSTANDING: 0.7, ASSIGNMENT: 0.6, PEER_TEACHING: 0.65, PRACTICE: 0.45, EXAM_PREPARATION: 0.5, GENERAL_REVISION: 0.45 },
};

export function goalCompatibility(goalA, goalB) {
  if (!goalA || !goalB) return NEUTRAL;
  return GOAL_AFFINITY[goalA]?.[goalB] ?? NEUTRAL;
}

/**
 * Course compatibility. Enrolment is the strongest legitimate signal available:
 * two students in the same course share a syllabus, an assessment calendar and
 * a set of topics, so there is something concrete to study together.
 *
 * Partial credit for the same programme, because a shared programme implies
 * shared foundational courses even when enrolment records differ.
 */
export function courseCompatibility(sharedCourseCount, sameProgramme = false) {
  if (sharedCourseCount > 0) return clamp01(0.85 + 0.15 * Math.min(sharedCourseCount, 3) / 3);
  return sameProgramme ? 0.45 : 0.2;
}

/**
 * Skill complementarity — the research contribution.
 *
 * The key insight: a partner is best when their knowledge profile *fills your
 * gaps*, not when it mirrors yours. Two signals are combined.
 *
 * **Per-topic quality** — for each shared topic, how much knowledge actually
 * transfers between the two people:
 *   - both strong          → redundancy; reinforcement but no gap filled
 *   - one strong, one weak → the strongest possible signal (mutual teaching)
 *   - both weak            → mutual reinforcement, the weakest case
 *
 * **Gap coverage** — the fraction of the seeker's declared weaknesses that the
 * candidate can actually address. Without this term a partner strong in one
 * topic scores as highly as one strong in every gap, which is wrong: a group
 * of four students all weak in Normalization is not a study group.
 *
 * @param {Map<string, {level:number, status:string}>} mine   topicId → my state
 * @param {Map<string, {level:number, status:string}>} theirs topicId → their state
 * @returns {{score:number, complementary:string[], overlapping:string[], detail:Array}}
 */
export function skillComplementarity(mine = new Map(), theirs = new Map()) {
  const complementary = [];
  const overlapping = [];
  const detail = [];

  if (mine.size === 0 || theirs.size === 0) {
    return { score: NEUTRAL, complementary, overlapping, detail, hasData: false };
  }

  // Only topics both people have declared are informative — a gap they have not
  // mentioned is not evidence of anything.
  const sharedTopicIds = [...mine.keys()].filter((id) => theirs.has(id));

  if (sharedTopicIds.length === 0) {
    return { score: 0.35, complementary, overlapping, detail, hasData: true };
  }

  let weightedSum = 0;

  for (const topicId of sharedTopicIds) {
    const my = mine.get(topicId);
    const their = theirs.get(topicId);

    const myLevel = resolveLevel(my);
    const theirLevel = resolveLevel(their);

    const gapFilled = theirLevel - myLevel;      // >0: they know what I lack
    const gapFilledByMe = myLevel - theirLevel;  // >0: I know what they lack

    // Best outcome is bidirectional complementarity; a one-way gap is still good.
    const mutual = Math.max(gapFilled, gapFilledByMe);
    const similarity = 1 - Math.abs(gapFilled);

    // Blend: complementarity dominates (0.75), similarity supports (0.25).
    weightedSum += clamp01(0.75 * mutual + 0.25 * similarity);

    if (mutual >= 0.4) {
      complementary.push(topicId);
      detail.push({
        topicId,
        mutual,
        similarity,
        direction: gapFilled > 0 ? "they_help_me" : gapFilledByMe > 0 ? "i_help_them" : "balanced",
      });
    } else if (similarity >= 0.7) {
      overlapping.push(topicId);
    }
  }

  const perTopicQuality = weightedSum / sharedTopicIds.length;

  // Gap coverage is counted against *every* weakness the seeker declared, not
  // only the ones that happen to overlap. Otherwise a candidate strong in one
  // topic scores full marks simply because it is the only topic in common.
  let gapTotal = 0;
  let gapAddressed = 0;
  for (const [topicId, my] of mine) {
    if (!isGap(my)) continue;
    gapTotal += 1;
    const theirLevel = theirs.has(topicId) ? resolveLevel(theirs.get(topicId)) : 0;
    if (theirLevel > resolveLevel(my) + 0.2) gapAddressed += 1;
  }

  const gapCoverage = gapTotal === 0 ? null : gapAddressed / gapTotal;

  const score =
    gapCoverage === null
      ? perTopicQuality
      : clamp01(0.6 * perTopicQuality + 0.4 * gapCoverage);

  return {
    score,
    perTopicQuality,
    gapCoverage,
    gapsFound: gapTotal,
    gapsAddressed: gapAddressed,
    complementary,
    overlapping,
    detail,
    hasData: true,
  };
}

/** True when a topic entry represents a declared weakness. */
function isGap(entry) {
  if (!entry) return false;
  if (entry.polarity) return entry.polarity === "gap";
  if (entry.status) return entry.status === "NEEDS_HELP" || entry.status === "LEARNING";
  return Number.isFinite(entry.level) && entry.level < 0.5;
}

/** Resolve a declared topic/skill entry to a numeric ability in [0,1]. */
export function resolveLevel(entry) {
  if (!entry) return PROFICIENCY_SCORE.UNKNOWN;
  if (Number.isFinite(entry.level)) return clamp01(entry.level);
  if (entry.status && TOPIC_STATUS_MEANING[entry.status]) {
    const { min, max } = TOPIC_STATUS_MEANING[entry.status];
    return clamp01((min + max) / 2);
  }
  if (entry.proficiency && PROFICIENCY_SCORE[entry.proficiency] !== undefined) {
    return PROFICIENCY_SCORE[entry.proficiency];
  }
  return PROFICIENCY_SCORE.UNKNOWN;
}

/**
 * Topic similarity (distinct from complementarity). Measures whether the two
 * students are focused on the same syllabus areas, which determines whether
 * they can discuss the same material at all.
 */
export function topicSimilarity(mine = new Map(), theirs = new Map()) {
  if (mine.size === 0 || theirs.size === 0) return NEUTRAL;

  const shared = [...mine.keys()].filter((id) => theirs.has(id)).length;
  // Jaccard: intersection over union, so adding unrelated topics correctly
  // lowers similarity rather than being ignored.
  const union = new Set([...mine.keys(), ...theirs.keys()]).size;
  return union === 0 ? NEUTRAL : clamp01(shared / union);
}

/**
 * Study-preference compatibility across the dimensions students actually choose
 * between: mode, session length and study style.
 *
 * Mode and style use "either/mixed" as a genuine wildcard, because a student
 * who is flexible really is compatible with both options. Session length uses a
 * soft tolerance so a 60-vs-120-minute mismatch is a mild penalty, not a
 * rejection.
 */
export function preferenceCompatibility(mine = {}, theirs = {}) {
  const components = [];

  // Mode ------------------------------------------------------------------
  const myModes = expandMode(mine.preferred_mode);
  const theirModes = expandMode(theirs.preferred_mode);
  const modeScore = intersects(myModes, theirModes) ? 1 : 0.3;
  components.push({ key: "mode", score: modeScore, weight: 0.4 });

  // Study style -----------------------------------------------------------
  const myStyles = expandStyle(mine.preferred_style);
  const theirStyles = expandStyle(theirs.preferred_style);
  const styleScore = intersects(myStyles, theirStyles) ? 1 : 0.5;
  components.push({ key: "style", score: styleScore, weight: 0.3 });

  // Session length --------------------------------------------------------
  const lenScore = sessionLengthCompatibility(mine.session_minutes, theirs.session_minutes);
  components.push({ key: "session_length", score: lenScore, weight: 0.3 });

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = components.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;

  return { score: clamp01(score), components };
}

function expandMode(mode) {
  if (!mode) return [];
  if (mode === "EITHER") return ["ONLINE", "PHYSICAL"];
  return [mode];
}

function expandStyle(style) {
  if (!style) return [];
  if (style === "MIXED") return ["DISCUSS", "PROBLEM_SOLVING", "TEACH_BACK", "QUIET_FOCUS"];
  return [style];
}

const intersects = (a, b) => a.some((value) => b.includes(value));

/**
 * Tolerance falls off smoothly to a floor rather than cliff-edging, so a single
 * preference difference never zeroes an otherwise strong match. 4 hours is the
 * widest gap treated as "mismatched" before the floor is reached.
 */
function sessionLengthCompatibility(mine, theirs) {
  if (!Number.isFinite(mine) || !Number.isFinite(theirs)) return NEUTRAL;
  const difference = Math.abs(mine - theirs);
  const maxDifference = 240;
  return clamp01(1 - 0.6 * (difference / maxDifference));
}

/**
 * Group-size compatibility. Both partners' ranges are honoured: the combined
 * group must satisfy at least one's minimum and neither one's maximum.
 */
export function groupSizeCompatibility(studentPref = {}, groupSize = null, groupMax = null) {
  const theirMin = groupSize ?? groupMax ?? GROUP_SIZE.DEFAULT_MIN;
  const theirMax = groupMax ?? theirMin;

  const myMin = studentPref.min_group_size ?? GROUP_SIZE.DEFAULT_MIN;
  const myMax = studentPref.max_group_size ?? GROUP_SIZE.DEFAULT_MAX;

  const rangeOverlap = Math.min(myMax, theirMax) >= Math.max(myMin, theirMin);
  if (rangeOverlap) return 1;

  // Partial credit when the ranges are merely adjacent rather than disjoint.
  const gap = Math.max(myMin, theirMin) - Math.min(myMax, theirMax);
  return clamp01(0.7 - 0.1 * gap);
}

/**
 * Activity compatibility for group recommendations.
 *
 * A student who wants to study weekly should not be matched into a group that
 * has been dormant for two months. This compares a student's recent activity
 * with a group's, using an exponential recency-weighted frequency.
 *
 * @param {{recentScore:number}} student  0..1
 * @param {{activityScore:number, daysSinceLastEvent:number|null}} group
 */
export function activityCompatibility(student, group) {
  const groupActivity = Number.isFinite(group?.activityScore) ? group.activityScore : NEUTRAL;
  const studentActivity = Number.isFinite(student?.recentScore) ? student.recentScore : NEUTRAL;

  // 1 when they agree, decaying with distance.
  const agreement = clamp01(1 - Math.abs(groupActivity - studentActivity));

  // Dormancy penalty: a group with no event for 30+ days is hard to revive.
  const days = group?.daysSinceLastEvent;
  let dormancy = 1;
  if (Number.isFinite(days)) {
    if (days > 30) dormancy = 0.3;
    else if (days > 14) dormancy = 0.6;
    else if (days > 7) dormancy = 0.85;
  }

  return clamp01(agreement * dormancy);
}

/**
 * Assess how much we can trust a recommendation given the input data quality.
 * A low-confidence score is shown to the user as such, and recommendations
 * below a floor are not surfaced at all.
 */
export function dataConfidence(profile) {
  if (!profile) return 0;
  const signals = [
    profile.courses?.length >= 1,
    profile.topics?.length >= 2,
    profile.skills?.length >= 2,
    profile.goals?.length >= 1,
    profile.availability?.length >= 1,
    profile.preferences != null,
    profile.programId != null,
  ];
  return clamp01(signals.filter(Boolean).length / signals.length);
}

export const featureHelpers = {
  clamp01,
  ratio,
  resolveLevel,
};

export default {
  NEUTRAL,
  MISSING_DATA_PENALTY,
  intervalOverlap,
  availabilityCompatibility,
  goalCompatibility,
  courseCompatibility,
  skillComplementarity,
  topicSimilarity,
  preferenceCompatibility,
  groupSizeCompatibility,
  activityCompatibility,
  dataConfidence,
  resolveLevel,
};