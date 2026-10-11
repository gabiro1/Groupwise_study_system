import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
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
} from "../src/lib/features.js";

/**
 * Deterministic fixtures. No randomness anywhere: these tests assert exact
 * ranking relationships, so a flaky test here would invalidate the research
 * claims the project rests on.
 */
const topicId = (n) => `00000000-0000-0000-0000-00000000000${n}`;

const STRONG = { status: "STRONG" };
const COMFORTABLE = { status: "COMFORTABLE" };
const LEARNING = { status: "LEARNING" };
const NEEDS_HELP = { status: "NEEDS_HELP" };

describe("intervalOverlap", () => {
  it("computes overlap in minutes against the smaller interval", () => {
    const result = intervalOverlap(600, 720, 660, 780);
    assert.equal(result.minutes, 60);
    // 60 shared minutes against the smaller 120-minute interval = 0.5
    assert.equal(result.score, 0.5);
  });

  it("returns zero when intervals do not overlap", () => {
    const result = intervalOverlap(600, 660, 700, 780);
    assert.equal(result.minutes, 0);
    assert.equal(result.score, 0);
  });

  it("handles touching intervals as no overlap", () => {
    const result = intervalOverlap(600, 660, 660, 720);
    assert.equal(result.minutes, 0);
    assert.equal(result.score, 0);
  });

  it("returns neutral for non-finite input", () => {
    const result = intervalOverlap(undefined, 720, 600, 780);
    assert.equal(result.minutes, 0);
    assert.equal(result.score, 0.5);
  });
});

describe("availabilityCompatibility", () => {
  const slot = (day, start, end) => ({ day_of_week: day, start_minute: start, end_minute: end });

  it("scores a complete weekly match very highly", () => {
    // Two students each declaring the same three weekly slots overlap completely.
    const a = [slot(1, 600, 720), slot(3, 600, 720), slot(6, 600, 720)];
    const b = [slot(1, 600, 720), slot(3, 600, 720), slot(6, 600, 720)];
    const result = availabilityCompatibility(a, b);

    assert.equal(result.totalMinutes, 360);
    assert.equal(result.sharedDays, 3);
    assert.ok(result.score > 0.9, `expected > 0.9, got ${result.score}`);
  });

  it("gives full credit when two narrow availabilities fully coincide", () => {
    // Each declares only Saturday 10-12, and both pick it: coverage is 100%.
    const result = availabilityCompatibility([slot(6, 600, 720)], [slot(6, 600, 720)]);
    assert.equal(result.coverage, 100);
    assert.ok(result.score > 0.6, `expected a solid score, got ${result.score}`);
  });

  it("rewards breadth at equal total minutes", () => {
    // 180 minutes in one long block...
    const concentrated = availabilityCompatibility([slot(6, 540, 780)], [slot(6, 600, 780)]);
    // ...versus the same 180 minutes spread across three days.
    const spread = availabilityCompatibility(
      [slot(1, 600, 660), slot(3, 600, 660), slot(5, 600, 660)],
      [slot(1, 600, 660), slot(3, 600, 660), slot(5, 600, 660)],
    );

    assert.equal(concentrated.totalMinutes, spread.totalMinutes, "fixtures must share the same volume");
    assert.ok(
      spread.score > concentrated.score,
      `spreading the same minutes across more days should score higher (${spread.score} vs ${concentrated.score})`,
    );
  });

  it("scores a single narrow overlap above neutral but below a full match", () => {
    const narrow = availabilityCompatibility([slot(6, 600, 660)], [slot(6, 600, 660)]);
    const full = availabilityCompatibility([slot(1, 600, 720), slot(3, 600, 720)], [slot(1, 600, 720), slot(3, 600, 720)]);

    assert.ok(narrow.score > 0.5, `expected > 0.5, got ${narrow.score}`);
    assert.ok(full.score > narrow.score);
  });

  it("returns zero when days do not align even if times do", () => {
    const result = availabilityCompatibility([slot(6, 600, 720)], [slot(0, 600, 720)]);
    assert.equal(result.totalMinutes, 0);
    assert.equal(result.score, 0);
    assert.equal(result.hasData, true);
  });

  it("signals missing data rather than treating it as incompatibility", () => {
    const result = availabilityCompatibility([], [slot(6, 600, 720)]);
    assert.equal(result.hasData, false);
    assert.equal(result.score, 0.5, "missing data must be neutral, not zero");
  });
});

describe("goalCompatibility", () => {
  it("scores identical goals highest", () => {
    assert.equal(goalCompatibility("EXAM_PREPARATION", "EXAM_PREPARATION"), 1.0);
  });

  it("scores peer teaching as a strong match for understanding goals", () => {
    const score = goalCompatibility("PEER_TEACHING", "IMPROVE_UNDERSTANDING");
    assert.ok(score >= 0.8, `expected >= 0.8, got ${score}`);
  });

  it("scores mismatched goals below neutral", () => {
    const score = goalCompatibility("RESEARCH_PROJECT", "PRACTICE");
    assert.ok(score < 0.5, `expected < 0.5, got ${score}`);
  });

  it("is symmetric", () => {
    const pairs = [
      ["EXAM_PREPARATION", "PRACTICE"],
      ["ASSIGNMENT", "PEER_TEACHING"],
      ["GENERAL_REVISION", "RESEARCH_PROJECT"],
    ];
    for (const [a, b] of pairs) {
      assert.equal(goalCompatibility(a, b), goalCompatibility(b, a), `${a}/${b} must be symmetric`);
    }
  });

  it("returns neutral when a goal is missing", () => {
    assert.equal(goalCompatibility(null, "PRACTICE"), 0.5);
  });
});

describe("courseCompatibility", () => {
  it("scores a shared course very high", () => {
    assert.ok(courseCompatibility(1) > 0.85);
  });

  it("gives more credit for multiple shared courses", () => {
    assert.ok(courseCompatibility(3) > courseCompatibility(1));
  });

  it("scores same-programme higher than unrelated", () => {
    assert.ok(courseCompatibility(0, true) > courseCompatibility(0, false));
  });

  it("stays bounded at 1 for many shared courses", () => {
    assert.equal(courseCompatibility(50), 1);
  });
});

describe("skillComplementarity — the research contribution", () => {
  const sql = topicId(1);
  const normalization = topicId(2);

  it("ranks a complementary partner above a similar partner", () => {
    // Me: weak at both topics.
    const mine = new Map([[sql, NEEDS_HELP], [normalization, LEARNING]]);

    // Eric: strong at both — he fills my gaps.
    const complementary = new Map([[sql, STRONG], [normalization, STRONG]]);

    // Patrick: also weak — we mirror each other but neither can help.
    const similar = new Map([[sql, NEEDS_HELP], [normalization, LEARNING]]);

    const complementaryScore = skillComplementarity(mine, complementary);
    const similarScore = skillComplementarity(mine, similar);

    assert.ok(
      complementaryScore.score > similarScore.score,
      `complementary (${complementaryScore.score}) must beat similar (${similarScore.score})`,
    );
  });

  it("flags which topics are complementary", () => {
    const mine = new Map([[sql, NEEDS_HELP]]);
    const theirs = new Map([[sql, STRONG]]);
    const result = skillComplementarity(mine, theirs);

    assert.deepEqual(result.complementary, [sql]);
    assert.ok(result.detail[0].direction === "they_help_me");
  });

  it("recognises reciprocal teaching", () => {
    const mine = new Map([[sql, STRONG]]);
    const theirs = new Map([[sql, NEEDS_HELP]]);
    const result = skillComplementarity(mine, theirs);

    assert.deepEqual(result.complementary, [sql]);
    assert.ok(result.detail[0].direction === "i_help_them");
  });

  it("separates mutual reinforcement from gap filling", () => {
    const mine = new Map([[sql, STRONG], [normalization, NEEDS_HELP]]);
    const theirs = new Map([[sql, STRONG], [normalization, STRONG]]);
    const result = skillComplementarity(mine, theirs);

    assert.ok(result.complementary.includes(normalization), "their strength fills my gap");
    assert.ok(result.overlapping.includes(sql), "our shared strength is overlap, not complement");
  });

  it("returns neutral when either side has no data", () => {
    const result = skillComplementarity(new Map(), new Map([[sql, STRONG]]));
    assert.equal(result.score, 0.5);
    assert.equal(result.hasData, false);
  });

  it("scores low when there are no shared topics", () => {
    const result = skillComplementarity(new Map([[sql, STRONG]]), new Map([[normalization, STRONG]]));
    assert.ok(result.score < 0.5, "no shared topics means little to study together");
  });

  it("is symmetric for bidirectional complementarity", () => {
    const mine = new Map([[sql, NEEDS_HELP], [normalization, STRONG]]);
    const theirs = new Map([[sql, STRONG], [normalization, NEEDS_HELP]]);

    const forward = skillComplementarity(mine, theirs);
    const backward = skillComplementarity(theirs, mine);

    assert.equal(forward.score, backward.score);
    assert.deepEqual(forward.complementary.slice().sort(), backward.complementary.slice().sort());
  });

  it("prefers a partner who covers more of my gaps", () => {
    const mine = new Map([[sql, NEEDS_HELP], [normalization, NEEDS_HELP]]);

    const coversOne = new Map([[sql, STRONG]]);
    const coversBoth = new Map([[sql, STRONG], [normalization, STRONG]]);

    const partial = skillComplementarity(mine, coversOne);
    const complete = skillComplementarity(mine, coversBoth);

    assert.ok(complete.score > partial.score, "covering both gaps must beat covering one");
  });
});

describe("topicSimilarity", () => {
  it("is one for identical topic sets", () => {
    const set = new Map([[topicId(1), STRONG], [topicId(2), LEARNING]]);
    assert.equal(topicSimilarity(set, set), 1);
  });

  it("is zero for disjoint topic sets", () => {
    const a = new Map([[topicId(1), STRONG]]);
    const b = new Map([[topicId(2), STRONG]]);
    assert.equal(topicSimilarity(a, b), 0);
  });

  it("uses Jaccard similarity so unrelated topics reduce the score", () => {
    const mine = new Map([[topicId(1), STRONG], [topicId(2), STRONG]]);
    const partial = new Map([[topicId(1), STRONG]]);
    const exact = new Map([[topicId(1), STRONG], [topicId(2), STRONG]]);

    assert.ok(topicSimilarity(mine, exact) > topicSimilarity(mine, partial));
    assert.equal(topicSimilarity(mine, partial), 0.5);
  });

  it("separates similarity from complementarity for mirrored weak profiles", () => {
    const mine = new Map([[topicId(1), NEEDS_HELP]]);
    const mirror = new Map([[topicId(1), NEEDS_HELP]]);
    const stronger = new Map([[topicId(1), STRONG]]);

    // Similarity cannot tell these two apart — both study the same topic, so the
    // Jaccard overlap is identical. This is precisely why similarity alone is an
    // inadequate basis for matching.
    assert.equal(topicSimilarity(mine, mirror), topicSimilarity(mine, stronger));

    // Complementarity can: one fills my gap, the other mirrors it.
    assert.ok(
      skillComplementarity(mine, stronger).score > skillComplementarity(mine, mirror).score,
      "complementarity must distinguish a gap-filler from a mirror",
    );
  });
});

describe("preferenceCompatibility", () => {
  it("scores identical preferences highest", () => {
    const prefs = { preferred_mode: "ONLINE", preferred_style: "DISCUSS", session_minutes: 120 };
    const result = preferenceCompatibility(prefs, prefs);
    assert.equal(result.score, 1);
  });

  it("treats EITHER mode as compatible with any concrete mode", () => {
    const flexible = { preferred_mode: "EITHER", preferred_style: "MIXED", session_minutes: 120 };
    const online = { preferred_mode: "ONLINE", preferred_style: "DISCUSS", session_minutes: 120 };

    const modeComponent = preferenceCompatibility(flexible, online).components.find((c) => c.key === "mode");
    assert.equal(modeComponent.score, 1);
  });

  it("penalises a concrete mode conflict without zeroing the score", () => {
    const online = { preferred_mode: "ONLINE", preferred_style: "MIXED", session_minutes: 120 };
    const physical = { preferred_mode: "PHYSICAL", preferred_style: "MIXED", session_minutes: 120 };

    const result = preferenceCompatibility(online, physical);
    const modeComponent = result.components.find((c) => c.key === "mode");
    assert.equal(modeComponent.score, 0.3);
    assert.ok(result.score > 0, "a mode conflict alone must not zero the whole factor");
  });

  it("softens session-length differences rather than cliff-edging", () => {
    const short = { preferred_mode: "EITHER", preferred_style: "MIXED", session_minutes: 60 };
    const long = { preferred_mode: "EITHER", preferred_style: "MIXED", session_minutes: 240 };

    const result = preferenceCompatibility(short, long);
    const length = result.components.find((c) => c.key === "session_length");
    assert.ok(length.score > 0.4 && length.score < 1, `got ${length.score}`);
  });
});

describe("groupSizeCompatibility", () => {
  it("scores overlapping ranges as a perfect fit", () => {
    const result = groupSizeCompatibility({ min_group_size: 3, max_group_size: 6 }, 4, 5);
    assert.equal(result, 1);
  });

  it("penalises adjacent but disjoint ranges", () => {
    const result = groupSizeCompatibility({ min_group_size: 2, max_group_size: 3 }, 5, 6);
    assert.ok(result > 0 && result < 1, `got ${result}`);
  });

  it("penalises distant ranges more", () => {
    const near = groupSizeCompatibility({ min_group_size: 2, max_group_size: 3 }, 5, 6);
    const far = groupSizeCompatibility({ min_group_size: 2, max_group_size: 3 }, 11, 12);
    assert.ok(far < near);
  });
});

describe("activityCompatibility", () => {
  it("scores aligned activity highly", () => {
    const result = activityCompatibility({ recentScore: 0.8 }, { activityScore: 0.8, daysSinceLastEvent: 0 });
    assert.ok(result > 0.9);
  });

  it("applies a dormancy penalty to stale groups", () => {
    const active = activityCompatibility({ recentScore: 0.8 }, { activityScore: 0.8, daysSinceLastEvent: 1 });
    const dormant = activityCompatibility({ recentScore: 0.8 }, { activityScore: 0.8, daysSinceLastEvent: 45 });
    assert.ok(dormant < active, "a dormant group must score lower");
  });

  it("does not penalise unknown activity history", () => {
    const unknown = activityCompatibility({ recentScore: 0.8 }, { activityScore: 0.8, daysSinceLastEvent: null });
    assert.equal(unknown, 1);
  });
});

describe("dataConfidence", () => {
  it("returns low confidence for an empty profile", () => {
    assert.ok(dataConfidence({}) < 0.2);
  });

  it("returns high confidence for a complete profile", () => {
    const complete = {
      courses: ["c1"],
      topics: ["t1", "t2"],
      skills: ["s1", "s2"],
      goals: ["g1"],
      availability: [{ day_of_week: 1 }],
      preferences: { preferred_mode: "ONLINE" },
      programId: "p1",
    };
    assert.equal(dataConfidence(complete), 1);
  });

  it("scales with the number of populated signals", () => {
    const partial = { courses: ["c1"], goals: ["g1"] };
    assert.ok(dataConfidence(partial) > 0 && dataConfidence(partial) < 0.5);
  });
});

describe("resolveLevel", () => {
  it("prefers an explicit numeric level", () => {
    assert.equal(resolveLevel({ level: 0.8 }), 0.8);
  });

  it("maps topic status to a numeric level", () => {
    assert.ok(resolveLevel(STRONG) > resolveLevel(COMFORTABLE));
    assert.ok(resolveLevel(COMFORTABLE) > resolveLevel(LEARNING));
    assert.ok(resolveLevel(LEARNING) > resolveLevel(NEEDS_HELP));
  });

  it("falls back to unknown for missing input", () => {
    assert.equal(resolveLevel(undefined), 0.5);
  });
});