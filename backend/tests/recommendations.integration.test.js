import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import "./test-database.js";

/**
 * Recommendation HTTP integration coverage.
 *
 * This suite uses the real Express application and the dedicated test database
 * so it verifies authentication, request validation, candidate filtering,
 * persistence, and the outcome state machine together.
 */

const RUN = randomUUID().slice(0, 8);
process.env.RATE_LIMIT_MAX = "100000";
process.env.SEARCH_RATE_LIMIT_MAX = "100000";
process.env.WRITE_RATE_LIMIT_MAX = "100000";
process.env.LOG_LEVEL = "silent";

const { createApp } = await import("../src/config/app.js");
const { pool, query, queryOne, closePool } = await import("../src/config/db.js");
const { signAccessToken } = await import("../src/lib/tokens.js");
const { ROLES } = await import("../src/config/constants.js");

let server;
let baseUrl;
const createdUserIds = [];
const createdGroupIds = [];

before(async () => {
  await pool.query("SELECT 1");
  server = http.createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const id of createdGroupIds) {
    await query("DELETE FROM study_groups WHERE id = $1", [id], "test:cleanupRecommendationGroup").catch(() => {});
  }
  for (const id of createdUserIds) {
    await query("DELETE FROM users WHERE id = $1", [id], "test:cleanupRecommendationUser").catch(() => {});
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await closePool();
});

let sequence = 0;
async function createStudent(label) {
  const role = await queryOne("SELECT id FROM roles WHERE key = $1", [ROLES.STUDENT], "test:recommendationRole");
  const id = randomUUID();
  const email = `recs-${RUN}-${label}-${++sequence}@example.test`;
  await query(
    `INSERT INTO users (id, email, password_hash, role_id, status, first_name, last_name, email_verified_at)
     VALUES ($1, $2, 'x', $3, 'ACTIVE', $4, 'Test', now())`,
    [id, email, role.id, label],
    "test:createRecommendationUser",
  );
  const sessionId = randomUUID();
  await query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 day')`,
    [sessionId, id, `recommendation-session-${sessionId}`],
    "test:createRecommendationSession",
  );
  await query(
    "INSERT INTO privacy_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [id],
    "test:createRecommendationPrivacy",
  );
  return {
    id,
    token: signAccessToken({ userId: id, role: ROLES.STUDENT, roleId: role.id, sessionId, email, name: label }),
  };
}

async function call(method, path, { token, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createRecommendationFixture() {
  const seeker = await createStudent("seeker");
  const candidate = await createStudent("candidate");
  createdUserIds.push(seeker.id, candidate.id);

  const university = await queryOne("SELECT id FROM universities WHERE is_active ORDER BY name LIMIT 1", [], "test:recommendationUniversity");
  const course = await queryOne("SELECT id FROM courses WHERE is_active ORDER BY course_code LIMIT 1", [], "test:recommendationCourse");
  const topic = await queryOne(
    "SELECT id FROM course_topics WHERE course_id = $1 ORDER BY position, name LIMIT 1",
    [course.id],
    "test:recommendationTopic",
  );
  assert.ok(university && course && topic, "reference university, course, and topic must be seeded");

  for (const student of [seeker, candidate]) {
    await query(
      "INSERT INTO student_profiles (user_id, university_id, year_of_study, onboarding_done) VALUES ($1, $2, 1, TRUE)",
      [student.id, university.id],
      "test:recommendationProfile",
    );
    await query(
      "INSERT INTO student_courses (student_id, course_id) VALUES ($1, $2)",
      [student.id, course.id],
      "test:recommendationCourseEnrollment",
    );
    await query(
      `INSERT INTO study_preferences (student_id, preferred_mode, preferred_style, min_group_size, max_group_size)
       VALUES ($1, 'EITHER', 'MIXED', 2, 6)`,
      [student.id],
      "test:recommendationPreferences",
    );
  }

  await query(
    `INSERT INTO student_topics (student_id, topic_id, status, self_rating)
     VALUES ($1, $3, 'NEEDS_HELP', 0.2), ($2, $3, 'STRONG', 0.95)`,
    [seeker.id, candidate.id, topic.id],
    "test:recommendationTopics",
  );

  return { seeker, candidate, course, topic };
}

async function createGroupFixture(fixture) {
  const groupId = randomUUID();
  await query(
    `INSERT INTO study_groups
       (id, slug, name, course_id, description, mode, privacy, require_approval,
        min_size, max_size, owner_id, created_by_role)
     VALUES ($1, $2, $3, $4, '', 'EITHER', 'PUBLIC', FALSE, 2, 6, $5, 'STUDENT')`,
    [groupId, `recs-${RUN}-${groupId.slice(0, 6)}`, `Recommendation Group ${RUN}`, fixture.course.id, fixture.candidate.id],
    "test:createRecommendationGroup",
  );
  createdGroupIds.push(groupId);

  await query(
    `INSERT INTO workspaces (id, group_id, name, description, created_by)
      VALUES ($1, $2, $3, '', $4)`,
    [randomUUID(), groupId, `Workspace for ${RUN}`, fixture.candidate.id],
    "test:createRecommendationWorkspace",
  );
  const workspace = await queryOne(
    "SELECT id FROM workspaces WHERE group_id = $1 ORDER BY created_at DESC LIMIT 1",
    [groupId],
    "test:recommendationWorkspace",
  );
  await query(
    "INSERT INTO workspace_groups (workspace_id, group_id, assigned_by) VALUES ($1, $2, $3)",
    [workspace.id, groupId, fixture.candidate.id],
    "test:recommendationWorkspaceGroup",
  );

  await query(
    `INSERT INTO study_group_members (id, group_id, student_id, role, status, joined_at)
     VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', now())`,
    [randomUUID(), groupId, fixture.candidate.id],
    "test:addRecommendationGroupOwner",
  );
  await query(
    "INSERT INTO study_group_topics (group_id, topic_id, focus_weight) VALUES ($1, $2, 5)",
    [groupId, fixture.topic.id],
    "test:addRecommendationGroupTopic",
  );
  return groupId;
}

describe("recommendation API integration", () => {
  it("generates and persists an authorized student recommendation", async () => {
    const fixture = await createRecommendationFixture();
    const response = await call("POST", "/api/recommendations", {
      token: fixture.seeker.token,
      body: {
        kind: "STUDENT",
        courseId: fixture.course.id,
        topicIds: [fixture.topic.id],
        track: true,
        limit: 10,
      },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body?.data?.results?.find((entry) => entry.studentId === fixture.candidate.id);
    assert.ok(result, "the eligible candidate is returned");
    assert.ok(result.recommendationId, "the tracked result has a persisted recommendation id");
    assert.ok(result.score >= 40 && result.score <= 100, "the score stays within the public range");
    assert.ok(Array.isArray(result.explanation) && result.explanation.length > 0, "an explanation is returned");

    const stored = await queryOne(
      "SELECT target_student_id, rank, shown_at FROM recommendations WHERE id = $1 AND student_id = $2",
      [result.recommendationId, fixture.seeker.id],
      "test:recommendationStored",
    );
    assert.equal(stored.target_student_id, fixture.candidate.id);
    assert.equal(stored.rank, result.rank);
    assert.equal(stored.shown_at, null, "generation does not imply exposure");

    const shown = await call("PATCH", `/api/recommendations/${result.recommendationId}/outcome`, {
      token: fixture.seeker.token,
      body: { action: "SHOWN" },
    });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    const exposed = await queryOne(
      "SELECT shown_at FROM recommendations WHERE id = $1",
      [result.recommendationId],
      "test:recommendationShown",
    );
    assert.ok(exposed.shown_at, "the explicit shown event records exposure");
  });

  it("does not allow a terminal recommendation outcome to be reversed", async () => {
    const fixture = await createRecommendationFixture();
    const response = await call("POST", "/api/recommendations", {
      token: fixture.seeker.token,
      body: { kind: "STUDENT", courseId: fixture.course.id, topicIds: [fixture.topic.id], track: true },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const recommendationId = response.body?.data?.results?.[0]?.recommendationId;
    assert.ok(recommendationId, "a recommendation id is available for outcome tracking");

    const accepted = await call("PATCH", `/api/recommendations/${recommendationId}/outcome`, {
      token: fixture.seeker.token,
      body: { action: "ACCEPTED" },
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    const reversed = await call("PATCH", `/api/recommendations/${recommendationId}/outcome`, {
      token: fixture.seeker.token,
      body: { action: "REJECTED", reason: "NOT_INTERESTED" },
    });
    assert.equal(reversed.status, 409, JSON.stringify(reversed.body));
    assert.equal(reversed.body?.error?.code, "OUTCOME_FINAL");
  });

  it("generates a group recommendation using active member strengths", async () => {
    const fixture = await createRecommendationFixture();
    const groupId = await createGroupFixture(fixture);
    const response = await call("POST", "/api/recommendations", {
      token: fixture.seeker.token,
      body: {
        kind: "GROUP",
        courseId: fixture.course.id,
        topicIds: [fixture.topic.id],
        track: true,
        limit: 10,
      },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body?.data?.results?.find((entry) => entry.groupId === groupId);
    assert.ok(result, "the eligible group is returned");
    assert.equal(result.kind, "GROUP");
    assert.ok(result.workspaceId, "the group recommendation has a workspace target");
    assert.ok(result.complementarity > 0, "group complementarity is calculated");
    assert.ok(result.explanation.some((item) => item.type === "SKILL_COMPLEMENTARITY"));

    const stored = await queryOne(
      "SELECT target_group_id FROM recommendations WHERE id = $1",
      [result.recommendationId],
      "test:groupRecommendationAttribution",
    );
    assert.equal(stored.target_group_id, groupId);

    const joined = await call("POST", `/api/study-groups/${groupId}/join`, {
      token: fixture.seeker.token,
      body: { recommendationId: result.recommendationId },
    });
    assert.equal(joined.status, 202, JSON.stringify(joined.body));
    const outcome = await queryOne(
      `SELECT mo.joined_via, mo.recommendation_id
         FROM group_membership_outcomes mo
         JOIN workspace_groups wg ON wg.workspace_id = mo.workspace_id
        WHERE wg.group_id = $1 AND mo.student_id = $2`,
      [groupId, fixture.seeker.id],
      "test:groupRecommendationOutcome",
    );
    assert.equal(outcome.joined_via, "AI_ASSISTED");
    assert.equal(outcome.recommendation_id, result.recommendationId);
  });
});
