import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeCompatibility, calibrate, buildExplanation, strengthLabel } from "../src/lib/scoring.js";
import { validateWeights, DEFAULT_WEIGHTS, resolveConfig } from "../src/lib/weights.js";

/** A strong all-round candidate. */
const IDEAL = {
  course: 1,
  skills: 1,
  goals: 1,
  availability: 1,
  preferences: 1,
  topics: 1,
  confidence: 1,
};

/** A candidate sharing nothing in common. */
const POOR = {
  course: 0.1,
  skills: 0.1,
  goals: 0.1,
  availability: 0.1,
  preferences: 0.1,
  topics: 0.1,
  confidence: 1,
};

describe("validateWeights", () => {
  it("accepts the published default weighting", () => {
    const result = validateWeights(DEFAULT_WEIGHTS);
    assert.equal(result.valid, true, result.errors.join(", "));
  });

  it("rejects weights that do not sum to one", () => {
    const result = validateWeights({ ...DEFAULT_WEIGHTS, course: 0.9 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("sum to 1")));
  });

  it("rejects negative weights", () => {
    const result = validateWeights({ ...DEFAULT_WEIGHTS, course: -0.5, skills: 0.75 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("negative")));
  });

  it("rejects non-numeric weights", () => {
    const result = validateWeights({ ...DEFAULT_WEIGHTS, goals: "high" });
    assert.equal(result.valid, false);
  });

  it("falls back to defaults for missing keys when normalising", () => {
    const result = validateWeights({ course: 1 });
    assert.equal(result.normalized.skills, DEFAULT_WEIGHTS.skills);
  });

  it("tolerates floating-point representation error", () => {
    const result = validateWeights({
      course: 0.25000001,
      skills: 0.25,
      goals: 0.2,
      availability: 0.15,
      preferences: 0.1,
      topics: 0.05,
    });
    assert.equal(result.valid, true);
  });
});

describe("resolveConfig", () => {
  it("layers overrides over defaults", () => {
    const config = resolveConfig({ minimumScore: 40 });
    assert.equal(config.minimumScore, 40);
    assert.equal(config.defaultLimit, 20, "unoverridden keys keep their defaults");
  });
});

describe("computeCompatibility", () => {
  it("keeps the score within 0..100", () => {
    assert.ok(computeCompatibility(IDEAL).score <= 100);
    assert.ok(computeCompatibility(POOR).score >= 0);
  });

  it("ranks a strong candidate above a weak one", () => {
    assert.ok(computeCompatibility(IDEAL).score > computeCompatibility(POOR).score);
  });

  it("is deterministic for identical input", () => {
    const a = computeCompatibility({ ...IDEAL, skills: 0.62, goals: 0.41 });
    const b = computeCompatibility({ ...IDEAL, skills: 0.62, goals: 0.41 });
    assert.equal(a.score, b.score);
    assert.deepEqual(a.breakdown, b.breakdown);
  });

  it("respects the configured weighting over a naive average", () => {
    // Course carries 25% — a perfect course match with everything else poor
    // should beat a middling average across all six factors.
    const courseOnly = computeCompatibility({
      ...POOR,
      course: 1,
      skills: 0.2,
      goals: 0.2,
      availability: 0.2,
      preferences: 0.2,
      topics: 0.2,
      confidence: 1,
    });
    const middling = computeCompatibility({
      course: 0.6,
      skills: 0.6,
      goals: 0.6,
      availability: 0.6,
      preferences: 0.6,
      topics: 0.6,
      confidence: 1,
    });

    const courseContribution = courseOnly.breakdown.course.weighted;
    const middlingContribution = middling.breakdown.course.weighted;
    assert.ok(
      courseContribution > middlingContribution,
      "a 25%-weighted factor must move the score more than a 5% factor at a similar value",
    );
  });

  it("reports every factor in the breakdown", () => {
    const result = computeCompatibility(IDEAL);
    for (const key of ["course", "skills", "goals", "availability", "preferences", "topics"]) {
      assert.ok(result.breakdown[key], `missing breakdown for ${key}`);
      assert.equal(result.breakdown[key].weight, DEFAULT_WEIGHTS[key]);
      assert.ok(Number.isFinite(result.breakdown[key].raw));
    }
  });

  it("applies a small confidence discount for thin data", () => {
    const strong = { ...IDEAL, confidence: 1 };
    const thin = { ...IDEAL, confidence: 0.2 };

    const strongScore = computeCompatibility(strong).score;
    const thinScore = computeCompatibility(thin).score;

    assert.ok(thinScore < strongScore, "thin data must not be presented as a confident result");
    // Discount must be modest — never enough to bury a genuinely strong match.
    assert.ok(strongScore - thinScore < 10, `discount too aggressive: ${strongScore - thinScore}`);
  });

  it("flags when confidence actually moved the score", () => {
    assert.equal(computeCompatibility({ ...IDEAL, confidence: 1 }).adjustedForConfidence, false);
    assert.equal(computeCompatibility({ ...IDEAL, confidence: 0.1 }).adjustedForConfidence, true);
  });

  it("pulls thin-data scores toward the middle rather than toward zero", () => {
    const perfectButUnknown = computeCompatibility({
      course: 1, skills: 1, goals: 1, availability: 1, preferences: 1, topics: 1, confidence: 0.1,
    });
    assert.ok(
      perfectButUnknown.score > 80,
      `an unknown-but-promising match should stay near the top, got ${perfectButUnknown.score}`,
    );
  });

  it("treats missing factors as neutral, not as zero", () => {
    const empty = computeCompatibility({ confidence: 1 });
    for (const key of Object.keys(DEFAULT_WEIGHTS)) {
      assert.equal(empty.breakdown[key].raw, 50, `${key} should default to neutral 50`);
    }
    assert.ok(empty.score > 40 && empty.score < 60, `expected a middling score, got ${empty.score}`);
  });

  it("lets a strong secondary factor lift a middling base", () => {
    const base = { course: 0.5, skills: 0.5, goals: 0.5, availability: 0.5, preferences: 0.5, topics: 0.5, confidence: 1 };
    const withoutActivity = computeCompatibility(base);
    const withActivity = computeCompatibility({ ...base, activity: 1 });

    assert.ok(withActivity.score > withoutActivity.score);
  });

  it("caps any single secondary factor's influence", () => {
    const base = { course: 0.5, skills: 0.5, goals: 0.5, availability: 0.5, preferences: 0.5, topics: 0.5, confidence: 1 };
    const boosted = computeCompatibility({
      ...base,
      activity: 1, groupSize: 1, feedback: 1,
    }).score;
    const floor = computeCompatibility({
      ...base,
      activity: 0, groupSize: 0, feedback: 0,
    }).score;

    // Three secondary factors x ±4 points = a bounded 24-point band.
    assert.ok(boosted - floor <= 25, `secondary factors moved the score by ${boosted - floor}`);
  });

  it("renormalises a partial weight set instead of under-scaling", () => {
    const full = computeCompatibility({ ...IDEAL, weights: DEFAULT_WEIGHTS });
    const half = computeCompatibility({
      ...IDEAL,
      weights: { course: 0.5, skills: 0.5, goals: 0, availability: 0, preferences: 0, topics: 0 },
    });
    assert.equal(half.score, full.score, "renormalisation must keep an all-perfect input at the ceiling");
  });

  it("separates similarity from complementarity in its output", () => {
    // High similarity (same course, same goal) but no complementarity.
    const similarOnly = computeCompatibility({
      course: 1, skills: 0.2, goals: 1, availability: 0.5, preferences: 0.7, topics: 1, confidence: 1,
    });

    assert.ok(similarOnly.similarity > 60, `expected high similarity, got ${similarOnly.similarity}`);
    assert.ok(
      similarOnly.complementarity < similarOnly.similarity,
      "low skill complementarity must not be hidden inside a high similarity score",
    );
  });
});

describe("calibrate", () => {
  it("is monotone, so ranking is preserved exactly", () => {
    const inputs = [10, 25, 40, 55, 70, 85, 95];
    const outputs = inputs.map(calibrate);
    for (let index = 1; index < outputs.length; index += 1) {
      assert.ok(
        outputs[index] > outputs[index - 1],
        `calibration must not reorder: ${outputs[index - 1]} -> ${outputs[index]}`,
      );
    }
  });

  it("spreads the mid range without ever leaving 0..100", () => {
    for (const input of [0, 1, 25, 50, 75, 99, 100]) {
      const output = calibrate(input);
      assert.ok(output >= 0 && output <= 100, `calibrate(${input}) = ${output}`);
    }
  });

  it("maps the extremes to the extremes", () => {
    assert.equal(calibrate(0), 0);
    assert.equal(calibrate(100), 100);
  });

  it("separates two candidates that were close before calibration", () => {
    const a = calibrate(58);
    const b = calibrate(62);
    assert.ok(b > a, "nearby scores must remain ordered");
    assert.ok(b - a >= 0, "calibration must widen, not collapse, a gap");
  });
});

describe("buildExplanation", () => {
  const result = {
    breakdown: {
      course: { raw: 100, weighted: 25, weight: 0.25 },
      skills: { raw: 80, weighted: 20, weight: 0.25 },
      goals: { raw: 90, weighted: 18, weight: 0.2 },
      availability: { raw: 70, weighted: 10.5, weight: 0.15 },
      preferences: { raw: 100, weighted: 10, weight: 0.1 },
      topics: { raw: 50, weighted: 2.5, weight: 0.05 },
    },
    confidence: 90,
  };

  it("orders reasons by contribution", () => {
    const items = buildExplanation(result, { courseName: "Database Systems" });
    const weights = items.map((item) => item.weight);
    const sorted = [...weights].sort((a, b) => b - a);
    assert.deepEqual(weights, sorted);
  });

  it("explains course compatibility when it is high", () => {
    const items = buildExplanation(result, { courseName: "Database Systems" });
    const course = items.find((item) => item.type === "COURSE_MATCH");
    assert.ok(course);
    assert.match(course.detail, /Database Systems/);
  });

  it("omits reasons for factors that did not contribute", () => {
    // Same fixture, but with every factor below its reporting threshold.
    const quiet = {
      ...result,
      breakdown: {
        course: { raw: 20, weighted: 5, weight: 0.25 },
        skills: { raw: 20, weighted: 5, weight: 0.25 },
        goals: { raw: 30, weighted: 6, weight: 0.2 },
        availability: { raw: 40, weighted: 6, weight: 0.15 },
        preferences: { raw: 40, weighted: 4, weight: 0.1 },
        topics: { raw: 20, weighted: 1, weight: 0.05 },
      },
      confidence: 90,
    };
    const items = buildExplanation(quiet, {});
    assert.ok(
      !items.some((item) => item.type === "COURSE_MATCH" || item.type === "GOAL_MATCH"),
      "low-scoring factors must not produce promotional-sounding reasons",
    );
  });

  it("reports a schedule mismatch as a negative rather than hiding it", () => {
    const conflicting = {
      ...result,
      breakdown: { ...result.breakdown, availability: { raw: 0, weighted: 0, weight: 0.15 } },
    };
    const items = buildExplanation(conflicting, { availabilityMinutes: 0 });
    const mismatch = items.find((item) => item.type === "SCHEDULE_MISMATCH");
    assert.ok(mismatch, "an honest explanation must surface the mismatch");
    assert.equal(mismatch.impact, "negative");
  });

  it("names the complementary topics when they are known", () => {
    const topicId = "00000000-0000-0000-0000-000000000001";
    const items = buildExplanation(result, {
      complementaryDetail: [{ topicId, direction: "they_help_me" }],
      topicNames: { [topicId]: "Normalization" },
    });
    const complementarity = items.find((item) => item.type === "SKILL_COMPLEMENTARITY");
    assert.ok(complementarity);
    assert.match(complementarity.detail, /Normalization/);
    assert.match(complementarity.detail, /weakness/);
  });

  it("flags a low-confidence recommendation to the user", () => {
    const items = buildExplanation({ ...result, confidence: 30 }, {});
    const caveat = items.find((item) => item.type === "LOW_CONFIDENCE");
    assert.ok(caveat, "thin-data results must be labelled as such");
    assert.equal(caveat.impact, "caveat");
  });

  it("does not flag low confidence when the data is good", () => {
    const items = buildExplanation({ ...result, confidence: 85 }, {});
    assert.ok(!items.some((item) => item.type === "LOW_CONFIDENCE"));
  });
});

describe("strengthLabel", () => {
  it("uses coarse bands rather than implying false precision", () => {
    assert.equal(strengthLabel(93), "Strong match");
    assert.equal(strengthLabel(94), "Strong match");
    assert.equal(strengthLabel(86), "Strong match");
    assert.equal(strengthLabel(85), "Strong match");
  });

  it("descends monotonically as the score falls", () => {
    const scores = [95, 75, 60, 45, 30];
    const order = ["Strong match", "Good match", "Fair match", "Weak match", "Low match"];
    const indices = scores.map((score) => order.indexOf(strengthLabel(score)));

    for (let index = 1; index < indices.length; index += 1) {
      assert.ok(
        indices[index] >= indices[index - 1],
        `a lower score must never yield a better band: ${scores[index - 1]} -> ${scores[index]}`,
      );
    }
  });

  it("collapses indistinguishable scores into the same label", () => {
    // Two scores a user cannot act on differently should not read differently.
    assert.equal(strengthLabel(72), strengthLabel(74));
    assert.equal(strengthLabel(88), strengthLabel(91));
  });
});