import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/lien_test";
process.env.AUTH_SECRET ??= "unit-test-auth-secret-012345678901234567890123";

const { scoreRecommendationCandidate } = await import("../src/services/recommendation.service.js");
const { DEFAULT_WEIGHTS } = await import("../src/lib/weights.js");

const topicId = "00000000-0000-0000-0000-000000000001";
const courseId = "00000000-0000-0000-0000-000000000002";

function requirements() {
  return {
    studentId: "00000000-0000-0000-0000-000000000003",
    courseIds: new Set([courseId]),
    topicIds: new Set([topicId]),
    goalCode: null,
    programmeId: null,
    topics: new Map([[topicId, { status: "NEEDS_HELP", level: 0.2 }]]),
    availability: [],
    preferences: { min_group_size: 2, max_group_size: 6 },
    confidence: 1,
  };
}

function groupCandidate(skillTopics) {
  return {
    id: "00000000-0000-0000-0000-000000000004",
    name: "Database study group",
    course_id: courseId,
    topicNames: { [topicId]: "Normalization" },
    topics: new Map([[topicId, { level: 0.4 }]]),
    skillTopics,
    schedule: [],
    mode: "EITHER",
    member_count: 2,
    max_size: 6,
    activity_score: 0.8,
    daysSinceLastEvent: 2,
  };
}

describe("recommendation candidate scoring", () => {
  it("uses existing group-member strengths for group complementarity", () => {
    const complementary = scoreRecommendationCandidate(
      requirements(),
      groupCandidate(new Map([[topicId, { level: 0.95 }]])),
      DEFAULT_WEIGHTS,
    );
    const redundant = scoreRecommendationCandidate(
      requirements(),
      groupCandidate(new Map([[topicId, { level: 0.2 }]])),
      DEFAULT_WEIGHTS,
    );

    assert.ok(complementary.complementaryTopics.includes(topicId));
    assert.ok(complementary.complementarity > redundant.complementarity);
    assert.ok(complementary.score > redundant.score);
  });
});
