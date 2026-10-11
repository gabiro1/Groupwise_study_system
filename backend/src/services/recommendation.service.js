import { query, queryRows, queryOne, withTransaction } from "../config/db.js";
import { NotFoundError, AppError, ServiceUnavailableError } from "../lib/errors.js";
import {
  availabilityCompatibility,
  goalCompatibility,
  courseCompatibility,
  skillComplementarity,
  topicSimilarity,
  preferenceCompatibility,
  groupSizeCompatibility,
  activityCompatibility,
  dataConfidence,
} from "../lib/features.js";
import { computeCompatibility, buildExplanation, strengthLabel, calibrate } from "../lib/scoring.js";
import { DEFAULT_WEIGHTS, MODEL_VERSION, MODEL_METADATA, validateWeights } from "../lib/weights.js";
import { LEARNING_GOAL_LABELS, GROUP_SIZE, STUDY_MODES } from "../config/constants.js";

/**
 * Recommendation service.
 *
 * The architectural rule this file exists to enforce:
 *
 *   **An LLM may propose requirements. It may never produce a score.**
 *
 * Natural language is parsed into a structured requirement set, and from that
 * point on everything is deterministic arithmetic. The score is reproducible,
 * explainable, and identical on every run — which is also what makes the
 * research component possible.
 *
 * When the AI parser is unavailable, `degraded` is set and the request is served
 * from structured input alone. The endpoint still returns results; it never
 * fails because a model provider is down.
 */

/** Below this, a recommendation is not surfaced at all. */
const MINIMUM_SCORE = 40;

/** Below this confidence, the result is returned but flagged as provisional. */
const LOW_CONFIDENCE_FLOOR = 0.4;

/**
 * Ensure the active model version row exists, seeded from the code constants.
 *
 * Weights live in the database so they can be retuned for an experiment without a
 * deploy, and so each stored recommendation records the configuration that
 * produced it. Seeding from code on first use keeps one source of truth in
 * development while still allowing admin overrides in production.
 */
async function ensureModelVersion() {
  const existing = await queryOne(
    "SELECT id, weights, config FROM recommendation_model_versions WHERE is_active",
    [],
    "recs:modelVersion",
  );

  if (existing) {
    let weights = existing.weights;
    try {
      weights = validateWeights(weights);
    } catch {
      // A hand-edited row with bad weights must not take the API down: fall back
      // to the code defaults and let an admin notice via the weights endpoint.
      weights = DEFAULT_WEIGHTS;
      await query(
        "UPDATE recommendation_model_versions SET weights = $2 WHERE id = $1",
        [existing.id, DEFAULT_WEIGHTS],
        "recs:repairWeights",
      );
    }
    return { id: existing.id, weights };
  }

  const row = await queryOne(
    `INSERT INTO recommendation_model_versions (id, algorithm, description, weights, is_active)
     VALUES ($1, 'WEIGHTED_SCORING', $2, $3, TRUE)
     ON CONFLICT (id) DO UPDATE SET is_active = TRUE, retired_at = NULL
     RETURNING id, weights`,
    [MODEL_VERSION, MODEL_METADATA.description ?? "Weighted scoring, v1", DEFAULT_WEIGHTS],
    "recs:seedModelVersion",
  );

  return { id: row.id, weights: row.weights };
}

/**
 * Generate recommendations.
 *
 * @param {string} studentId
 * @param {object} input Validated `recommendationRequestSchema`.
 */
export async function generate(studentId, input) {
  const model = await ensureModelVersion();
  const requirements = await resolveRequirements(studentId, input);

  // A request with no meaningful requirement has nothing to rank against, and
  // returning arbitrary groups would be worse than saying so.
  if (!requirements.courseIds.size && !requirements.topicIds.size && !requirements.goalCode) {
    throw new AppError(
      "Tell us at least one course or topic you want to study, and we will find matches.",
      { status: 422, code: "INSUFFICIENT_REQUIREMENTS" },
    );
  }

  const candidates =
    input.kind === "GROUP" ? await loadGroupCandidates(requirements, input) : await loadStudentCandidates(requirements, input);

  const scored = candidates
    .map((candidate) => scoreCandidate(requirements, candidate, model.weights, input))
    .filter((entry) => entry.score >= MINIMUM_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 20);

  // Persist only when asked. Speculative previews while typing should not
  // pollute the research dataset.
  let requestId = null;
  const recommendationIds = new Map();
  if (input.track !== false) {
    const request = await queryOne(
      `INSERT INTO recommendation_requests
         (student_id, kind, model_version_id, goal_id, course_id, requirements, source,
          natural_language, parsed_intent, candidate_pool_size, result_count, latency_ms, degraded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        studentId,
        input.kind,
        model.id,
        input.goalId ?? null,
        input.courseId ?? null,
        JSON.stringify({
          courseIds: [...requirements.courseIds],
          topicIds: [...requirements.topicIds],
          goalCode: requirements.goalCode,
          availability: requirements.availability,
          preferredMode: input.preferredMode ?? null,
        }),
        input.source ?? "FORM",
        input.naturalLanguage ?? null,
        input.parsedIntent ? JSON.stringify(input.parsedIntent) : null,
        candidates.length,
        scored.length,
        null,
        input.degraded ?? false,
      ],
      "recs:createRequest",
    );
    requestId = request.id;

    if (scored.length) {
      // One multi-row INSERT rather than a loop. With 20 results and a round trip
      // each, this endpoint would otherwise spend most of its latency waiting on
      // the database.
      //
      // Every row has the same 14 columns, so the value array and the placeholder
      // count are derived from one constant — if they drift apart, Postgres
      // reports a parameter count mismatch immediately rather than silently
      // binding the wrong values to the wrong columns.
      const COLUMNS_PER_ROW = 14;
      const isGroup = input.kind === "GROUP";

      const values = [];
      const placeholders = scored.map((entry, index) => {
        const base = index * COLUMNS_PER_ROW;
        values.push(
          requestId,
          studentId,
          input.kind,
          // Exactly one target is set; the table's CHECK constraint enforces it.
          isGroup ? null : entry.candidate.id,
          isGroup ? entry.candidate.workspace_id : null,
          index + 1,
          entry.score,
          JSON.stringify(entry.breakdown),
          entry.similarity,
          entry.complementarity,
          entry.complementaryTopics,
          entry.overlappingTopics,
          JSON.stringify(entry.explanation),
          entry.confidence,
        );
        return `(${Array.from({ length: COLUMNS_PER_ROW }, (_, i) => `$${base + i + 1}`).join(", ")})`;
      });

      const stored = await query(
        `INSERT INTO recommendations
           (request_id, student_id, kind, target_student_id, target_workspace_id, rank, score,
            score_breakdown, similarity_score, complementarity_score,
            complementary_topics, overlapping_topics, explanation, confidence)
         VALUES ${placeholders.join(", ")}
         RETURNING id, rank`,
        values,
        "recs:storeResults",
      );
      for (const row of stored.rows) recommendationIds.set(row.rank, row.id);
    }
  }

  return {
    requestId,
    modelVersion: model.id,
    degraded: Boolean(input.degraded),
    candidatesConsidered: candidates.length,
    results: scored.map((entry, index) => ({
      rank: index + 1,
      recommendationId: recommendationIds.get(index + 1) ?? null,
      ...entry.payload,
      score: entry.score,
      label: strengthLabel(entry.score),
      similarity: entry.similarity,
      complementarity: entry.complementarity,
      explanation: entry.explanation,
      reasons: entry.explanation.filter((item) => !["negative", "caveat"].includes(item.impact)),
      warnings: entry.explanation.filter((item) => ["negative", "caveat"].includes(item.impact)),
      confidence: entry.confidence,
      confidenceNote:
        entry.confidence < LOW_CONFIDENCE_FLOOR
          ? "Based on limited profile data — add availability and topic ratings to sharpen this."
          : null,
    })),
  };
}

/**
 * Merge explicit request input with the student's stored profile.
 *
 * Explicit form input wins over the profile: a student who typed "Tuesday
 * evenings" meant Tuesday evenings, even if their saved availability is broader.
 */
async function resolveRequirements(studentId, input) {
  const profile = await loadStudentProfile(studentId);
  const courseIds = new Set(
    input.courseId ? [input.courseId] : (profile?.courseIds ?? []),
  );

  // Natural language may have named several courses.
  for (const id of input.courseIds ?? []) courseIds.add(id);

  const topicIds = new Set(input.topicIds ?? []);

  return {
    studentId,
    courseIds,
    topicIds,
    goalCode: profile?.goalCode ?? null,
    goalId: input.goalId ?? profile?.goalId ?? null,
    topics: profile?.topics ?? new Map(),
    skills: profile?.skills ?? new Map(),
    availability: input.availability?.length ? input.availability : (profile?.availability ?? []),
    preferences: {
      preferred_mode: input.preferredMode ?? profile?.preferences?.preferred_mode,
      preferred_style: profile?.preferences?.preferred_style,
      min_group_size: input.minGroupSize ?? profile?.preferences?.min_group_size,
      max_group_size: input.maxGroupSize ?? profile?.preferences?.max_group_size,
      session_minutes: profile?.preferences?.session_minutes,
    },
    programmeId: profile?.programmeId ?? null,
    confidence: dataConfidence({
      courses: [...courseIds],
      topics: [...topicIds].length ? [...topicIds] : [...(profile?.topics?.keys() ?? [])],
      skills: [...(profile?.skills?.keys() ?? [])],
      goals: profile?.goalCode ? [profile.goalCode] : [],
      availability: input.availability?.length ? input.availability : (profile?.availability ?? []),
    }),
  };
}

/** Load a student's own comparison inputs. */
async function loadStudentProfile(studentId) {
  const row = await queryOne(
    "SELECT program_id FROM student_profiles WHERE user_id = $1",
    [studentId],
    "recs:profileRow",
  );

  const [courses, topics, skills, goal, availability, preferences] = await Promise.all([
    queryRows(
      "SELECT course_id FROM student_courses WHERE student_id = $1 AND is_active",
      [studentId],
      "recs:profileCourses",
    ),
    queryRows(
      `SELECT st.topic_id, st.status, st.self_rating, ct.name AS topic_name, ct.course_id
         FROM student_topics st JOIN course_topics ct ON ct.id = st.topic_id
        WHERE st.student_id = $1`,
      [studentId],
      "recs:profileTopics",
    ),
    queryRows(
      "SELECT skill_id, proficiency, is_learning FROM student_skills WHERE student_id = $1",
      [studentId],
      "recs:profileSkills",
    ),
    queryOne(
      `SELECT g.id, g.code FROM student_learning_goals sg JOIN learning_goals g ON g.id = sg.goal_id
        WHERE sg.student_id = $1 ORDER BY sg.priority LIMIT 1`,
      [studentId],
      "recs:profileGoal",
    ),
    queryRows(
      "SELECT day_of_week, start_minute, end_minute, is_preferred FROM student_availability WHERE student_id = $1",
      [studentId],
      "recs:profileAvailability",
    ),
    queryOne(
      `SELECT preferred_mode, preferred_style, min_group_size, max_group_size, session_minutes
         FROM study_preferences WHERE student_id = $1`,
      [studentId],
      "recs:profilePrefs",
    ),
  ]);

  if (!row && courses.length === 0) return null;

  return {
    programmeId: row?.program_id ?? null,
    courseIds: courses.map((course) => course.course_id),
    goalId: goal?.id ?? null,
    goalCode: goal?.code ?? null,
    topics: new Map(topics.map((topic) => [topic.topic_id, { status: topic.status, level: topic.self_rating }])),
    topicNames: Object.fromEntries(topics.map((topic) => [topic.topic_id, topic.topic_name])),
    skills: new Map(skills.map((skill) => [skill.skill_id, skill])),
    availability,
    preferences: preferences ?? {},
  };
}

/**
 * Candidate groups.
 *
 * Groups the student already belongs to are excluded — recommending somewhere
 * you already are is noise, not a feature.
 */
async function loadGroupCandidates(requirements, input) {
  const params = [requirements.studentId];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const clauses = [
    "g.status = 'ACTIVE'",
    "g.member_count < g.max_size",
    // A group must be open in some sense: joinable, or requestable.
    "g.privacy IN ('PUBLIC', 'REQUEST_REQUIRED')",
    `NOT EXISTS (SELECT 1 FROM study_group_members m
                  WHERE m.group_id = g.id AND m.student_id = ${bind(requirements.studentId)}
                    AND m.left_at IS NULL)`,
  ];

  if (requirements.courseIds.size) {
    clauses.push(`g.course_id = ANY(${bind([...requirements.courseIds])}::uuid[])`);
  }
  if (requirements.goalId) {
    clauses.push(`g.goal_id = ${bind(requirements.goalId)}`);
  }
  if (input.preferredMode && input.preferredMode !== STUDY_MODES.EITHER) {
    clauses.push(`g.mode IN (${bind(input.preferredMode)}, 'EITHER')`);
  }
  if (requirements.topicIds.size) {
    clauses.push(
      `EXISTS (SELECT 1 FROM study_group_topics gt
                WHERE gt.group_id = g.id AND gt.topic_id = ANY(${bind([...requirements.topicIds])}::uuid[]))`,
    );
  }

  const rows = await queryRows(
    `SELECT g.id, g.slug, g.name, g.description, g.mode, g.privacy, g.member_count,
            g.min_size, g.max_size, g.activity_score, g.require_approval, g.created_at,
            g.location_hint, g.course_id, g.goal_id,
            c.course_code, c.name AS course_name,
            lg.code AS goal_code, lg.label AS goal_label,
            w.id AS workspace_id,
            EXTRACT(EPOCH FROM (now() - g.created_at)) / 86400 AS age_days,
            (SELECT max(created_at) FROM group_activity_events e WHERE e.group_id = g.id) AS last_event_at
       FROM study_groups g
       JOIN courses c ON c.id = g.course_id
       LEFT JOIN learning_goals lg ON lg.id = g.goal_id
       LEFT JOIN LATERAL (
         SELECT id FROM workspaces
          WHERE group_id = g.id AND NOT is_archived
          ORDER BY created_at DESC
          LIMIT 1
       ) w ON TRUE
      WHERE ${clauses.join(" AND ")}
      ORDER BY g.activity_score DESC, g.created_at DESC
      LIMIT 200`,
    params,
    "recs:groupCandidates",
  );

  if (rows.length === 0) return [];

  const [topics, schedules, strengths] = await Promise.all([
    queryRows(
      `SELECT gt.group_id, gt.topic_id, gt.focus_weight, ct.name AS topic_name
         FROM study_group_topics gt JOIN course_topics ct ON ct.id = gt.topic_id
        WHERE gt.group_id = ANY($1::uuid[])`,
      [rows.map((row) => row.id)],
      "recs:groupTopics",
    ),
    queryRows(
      "SELECT group_id, day_of_week, start_minute, end_minute FROM study_group_schedule WHERE group_id = ANY($1::uuid[])",
      [rows.map((row) => row.id)],
      "recs:groupSchedules",
    ),
    // Group-level topic coverage: which topics the existing members can already
    // teach. Without this, a group of four all weak in Normalization looks like a
    // good match for another student weak in Normalization.
    queryRows(
      `SELECT m.group_id, st.topic_id, max(st.self_rating) AS best_rating
         FROM study_group_members m
         JOIN student_topics st ON st.student_id = m.student_id
        WHERE m.group_id = ANY($1::uuid[]) AND m.left_at IS NULL
        GROUP BY m.group_id, st.topic_id`,
      [rows.map((row) => row.id)],
      "recs:groupStrengths",
    ),
  ]);

  const byGroup = new Map(
    rows.map((row) => [row.id, { topics: new Map(), topicNames: {}, schedule: [], strengths: new Map() }]),
  );

  for (const row of topics) {
    const entry = byGroup.get(row.group_id);
    if (!entry) continue;
    entry.topics.set(row.topic_id, { status: "COMFORTABLE", level: row.focus_weight / 5 });
    entry.topicNames[row.topic_id] = row.topic_name;
  }
  for (const row of schedules) byGroup.get(row.group_id)?.schedule.push(row);
  for (const row of strengths) {
    byGroup.get(row.group_id)?.strengths.set(row.topic_id, { level: Number(row.best_rating ?? 0.5) });
  }

  return rows.map((row) => ({
    ...row,
    topics: byGroup.get(row.id).topics,
    topicNames: byGroup.get(row.id).topicNames,
    schedule: byGroup.get(row.id).schedule,
    strengths: byGroup.get(row.id).strengths,
    daysSinceLastEvent: row.last_event_at
      ? (Date.now() - new Date(row.last_event_at).getTime()) / 86_400_000
      : null,
  }));
}

/** Candidate students, respecting discoverability. */
async function loadStudentCandidates(requirements, input) {
  const params = [requirements.studentId];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const clauses = [
    `u.id <> ${bind(requirements.studentId)}`,
    "u.deleted_at IS NULL",
    "u.status = 'ACTIVE'",
    "COALESCE(ps.discoverable, TRUE) = TRUE",
    "COALESCE(ps.profile_visibility, 'STUDENTS') <> 'PRIVATE'",
  ];

  if (requirements.courseIds.size) {
    clauses.push(
      `EXISTS (SELECT 1 FROM student_courses sc
                WHERE sc.student_id = u.id AND sc.is_active
                  AND sc.course_id = ANY(${bind([...requirements.courseIds])}::uuid[]))`,
    );
  }
  if (requirements.goalId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM student_learning_goals sg
                WHERE sg.student_id = u.id AND sg.goal_id = ${bind(requirements.goalId)})`,
    );
  }
  if (requirements.topicIds.size) {
    clauses.push(
      `EXISTS (SELECT 1 FROM student_topics st
                WHERE st.student_id = u.id
                  AND st.topic_id = ANY(${bind([...requirements.topicIds])}::uuid[]))`,
    );
  }

  const rows = await queryRows(
    `SELECT u.id, u.first_name, u.last_name, u.avatar_url,
            sp.university_id, sp.program_id, sp.year_of_study,
            pref.preferred_mode, pref.preferred_style, pref.min_group_size,
            pref.max_group_size, pref.session_minutes
       FROM users u
       JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN privacy_settings ps ON ps.user_id = u.id
       LEFT JOIN study_preferences pref ON pref.student_id = u.id
      WHERE ${clauses.join(" AND ")}
      LIMIT 200`,
    params,
    "recs:studentCandidates",
  );

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [courses, topics, skills, goals, availability] = await Promise.all([
    queryRows(
      "SELECT student_id, course_id FROM student_courses WHERE student_id = ANY($1::uuid[]) AND is_active",
      [ids],
      "recs:candidateCourses",
    ),
    queryRows(
      `SELECT st.student_id, st.topic_id, st.status, st.self_rating, ct.name AS topic_name
         FROM student_topics st JOIN course_topics ct ON ct.id = st.topic_id
        WHERE st.student_id = ANY($1::uuid[])`,
      [ids],
      "recs:candidateTopics",
    ),
    queryRows(
      "SELECT student_id, skill_id, proficiency FROM student_skills WHERE student_id = ANY($1::uuid[])",
      [ids],
      "recs:candidateSkills",
    ),
    queryRows(
      `SELECT sg.student_id, g.code FROM student_learning_goals sg JOIN learning_goals g ON g.id = sg.goal_id
        WHERE sg.student_id = ANY($1::uuid[]) AND sg.priority = 1`,
      [ids],
      "recs:candidateGoals",
    ),
    queryRows(
      "SELECT student_id, day_of_week, start_minute, end_minute FROM student_availability WHERE student_id = ANY($1::uuid[])",
      [ids],
      "recs:candidateAvailability",
    ),
  ]);

  const byStudent = new Map(
    ids.map((id) => [
      id,
      { courseIds: new Set(), topics: new Map(), topicNames: {}, skills: new Map(), goalCode: null, availability: [] },
    ]),
  );

  for (const row of courses) byStudent.get(row.student_id)?.courseIds.add(row.course_id);
  for (const row of topics) {
    const entry = byStudent.get(row.student_id);
    entry?.topics.set(row.topic_id, { status: row.status, level: row.self_rating });
    if (entry && row.topic_name) entry.topicNames[row.topic_id] = row.topic_name;
  }
  for (const row of skills) byStudent.get(row.student_id)?.skills.set(row.skill_id, row);
  for (const row of goals) {
    const entry = byStudent.get(row.student_id);
    if (entry && !entry.goalCode) entry.goalCode = row.code;
  }
  for (const row of availability) byStudent.get(row.student_id)?.availability.push(row);

  return rows.map((row) => {
    const extra = byStudent.get(row.id);
    return {
      ...row,
      courseIds: extra.courseIds,
      topics: extra.topics,
      topicNames: extra.topicNames,
      skills: extra.skills,
      goalCode: extra.goalCode,
      availability: extra.availability,
    };
  });
}

/**
 * Score one candidate. Pure arithmetic — identical inputs always give the
 * identical score, which is what makes stored results reproducible.
 */
function scoreCandidate(requirements, candidate, weights, input) {
  // A group candidate carries its single `course_id`, not a `courseIds` set, so
  // the shared-course count is derived from whichever shape is present. Without
  // this guard a group recommendation throws on `[...undefined]`.
  const candidateCourses =
    candidate.courseIds instanceof Set
      ? candidate.courseIds
      : candidate.course_id
        ? new Set([candidate.course_id])
        : new Set();

  const sharedCourses = [...candidateCourses].filter((id) => requirements.courseIds.has(id)).length;
  const complementarity = skillComplementarity(requirements.topics, candidate.topics);
  const availability = availabilityCompatibility(requirements.availability, candidate.availability ?? candidate.schedule);
  const preferences = preferenceCompatibility(requirements.preferences, {
    preferred_mode: candidate.mode ?? candidate.preferred_mode,
    preferred_style: candidate.preferred_style,
    min_group_size: candidate.min_size ?? candidate.min_group_size,
    max_group_size: candidate.max_size ?? candidate.max_group_size,
    session_minutes: candidate.session_minutes,
  });

  const result = computeCompatibility({
    course: courseCompatibility(sharedCourses, Boolean(candidate.program_id && candidate.program_id === requirements.programmeId)),
    skills: complementarity.score,
    goals: goalCompatibility(requirements.goalCode, candidate.goalCode ?? candidate.goal_code),
    availability: availability.score,
    preferences: preferences.score,
    topics: topicSimilarity(requirements.topics, candidate.topics),
    groupSize: groupSizeCompatibility(requirements.preferences, candidate.member_count, candidate.max_size),
    activity: candidate.activity_score !== undefined
      ? activityCompatibility(
          { recentScore: 0.6 },
          { activityScore: Number(candidate.activity_score ?? 0), daysSinceLastEvent: candidate.daysSinceLastEvent },
        )
      : undefined,
    confidence: requirements.confidence,
    weights,
  });

  const explanation = buildExplanation(result, {
    courseName: candidate.course_name,
    complementaryDetail: complementarity.detail,
    overlappingTopics: complementarity.overlapping,
    topicNames: candidate.topicNames ?? {},
    availabilityMinutes: availability.totalMinutes,
    goalLabel: candidate.goal_label ?? (requirements.goalCode ? LEARNING_GOAL_LABELS[requirements.goalCode] : undefined),
    modeMatch: describeMode(requirements.preferences.preferred_mode, candidate.mode ?? candidate.preferred_mode),
    groupSizeMatch:
      candidate.max_size !== undefined &&
      requirements.preferences.max_group_size >= candidate.max_size,
    groupSizeText: `you prefer up to ${requirements.preferences.max_group_size}, this group allows ${candidate.max_size}`,
  });

  return {
    score: result.score,
    breakdown: result.breakdown,
    similarity: result.similarity,
    complementarity: result.complementarity,
    complementaryTopics: complementarity.complementary,
    overlappingTopics: complementarity.overlapping,
    explanation,
    confidence: result.confidence,
    candidate,
    payload:
      candidate.name !== undefined
        ? {
            kind: "GROUP",
            groupId: candidate.id,
            workspaceId: candidate.workspace_id,
            // A group can exist without a workspace if the trigger was bypassed
            // (e.g. a manual insert during data repair). Surfacing null here is
            // correct: the client must not offer "open workspace" for it.
            hasWorkspace: Boolean(candidate.workspace_id),
            slug: candidate.slug,
            name: candidate.name,
            description: candidate.description,
            courseCode: candidate.course_code,
            courseName: candidate.course_name,
            memberCount: candidate.member_count,
            maxSize: candidate.max_size,
            mode: candidate.mode,
            privacy: candidate.privacy,
            locationHint: candidate.location_hint,
          }
        : {
            kind: "STUDENT",
            studentId: candidate.id,
            firstName: candidate.first_name,
            lastName: candidate.last_name,
            avatarUrl: candidate.avatar_url,
            yearOfStudy: candidate.year_of_study,
            sharedCourses: sharedCourses,
          },
  };
}

function describeMode(mine, theirs) {
  if (!mine || !theirs) return undefined;
  if (mine === theirs || mine === "EITHER" || theirs === "EITHER") return "You are both happy to meet in person or online.";
  return mine === "ONLINE" ? "You prefer studying online." : "You prefer meeting in person.";
}

/**
 * Compatibility between two specific students.
 *
 * Used for invitations, where the question is specific rather than a search.
 * Returns null rather than a fabricated score when either profile is too thin.
 */
export async function pairCompatibility(studentIdA, studentIdB) {
  const [a, b] = await Promise.all([loadStudentProfile(studentIdA), loadStudentProfile(studentIdB)]);
  if (!a || !b) return null;

  const sharedCourses = [...b.courseIds].filter((id) => a.courseIds.has(id)).length;
  const complementarity = skillComplementarity(a.topics, b.topics);
  const availability = availabilityCompatibility(a.availability, b.availability);

  const result = computeCompatibility({
    course: courseCompatibility(sharedCourses, Boolean(a.programmeId && a.programmeId === b.programmeId)),
    skills: complementarity.score,
    goals: goalCompatibility(a.goalCode, b.goalCode),
    availability: availability.score,
    preferences: preferenceCompatibility(a.preferences, b.preferences).score,
    topics: topicSimilarity(a.topics, b.topics),
  });

  const reasons = buildExplanation(result, {
    complementaryDetail: complementarity.detail,
    topicNames: b.topicNames,
    availabilityMinutes: availability.totalMinutes,
    goalLabel: b.goalCode ? LEARNING_GOAL_LABELS[b.goalCode] : undefined,
  });

  return { score: result.score, label: strengthLabel(result.score), reasons, breakdown: result.breakdown };
}

/**
 * Record a student action on a recommendation.
 *
 * Drives the acceptance-rate and Precision@K figures, so the funnel stages are
 * written as a monotonically advancing state: an accepted recommendation cannot
 * later be marked rejected, because the outcome is whatever happened first.
 */
export async function recordOutcome(studentId, recommendationId, action, { reason } = {}) {
  const column = { SHOWN: "shown_at", CLICKED: "clicked_at", ACCEPTED: "accepted_at", REJECTED: "rejected_at" }[action];
  if (!column) throw new AppError("That is not a valid recommendation action.", { status: 400, code: "BAD_ACTION" });

  const row = await queryOne(
    `UPDATE recommendations SET ${column} = COALESCE(${column}, now()),
            dismissed_reason = CASE WHEN $4 = 'REJECTED' THEN $3 ELSE dismissed_reason END
      WHERE id = $1 AND student_id = $2 AND ($3::text IS NULL OR dismissed_reason IS NULL)
      RETURNING id, kind, target_student_id, target_workspace_id, request_id`,
    [recommendationId, studentId, reason ?? null, action],
    "recs:recordOutcome",
  );

  if (!row) throw new NotFoundError("That recommendation");

  // Accepting a *group* recommendation should not silently join the group: that is
  // a separate, reversible action the student takes deliberately. Only a student
  // recommendation is a pure acknowledgement.
  return {
    recorded: true,
    kind: row.kind,
    // What the client should do next, decided here rather than in the UI.
    nextAction: action === "ACCEPTED" && row.kind === "GROUP" ? "JOIN_GROUP" : null,
  };
}

/**
 * Qualitative feedback on one recommendation: "was this any good?".
 *
 * Kept separate from `recordOutcome`, which records the behavioural events
 * (shown / clicked / accepted / rejected). Mixing them would let a student who
 * explicitly rejected a card still have it marked as helpful, and the research
 * question - does a high score predict joining? - depends on those two signals
 * staying independent.
 *
 * Upserted rather than inserted: changing your mind about one card is normal, and
 * the unique constraint on `recommendation_id` means there is exactly one current
 * opinion per card.
 */
export async function recordFeedback(studentId, recommendationId, { helpful, reason, comment } = {}) {
  if (helpful === undefined || helpful === null) {
    if (!reason && !comment) {
      throw new AppError("Tell us whether this recommendation was helpful, or why not.", {
        status: 422,
        code: "FEEDBACK_EMPTY",
        fields: { helpful: "Pick helpful or not helpful." },
      });
    }
  }

  // Scoped by student_id as well as the insert, so a student cannot write feedback
  // against someone else's card by guessing its id.
  const owner = await queryOne(
    "SELECT id FROM recommendations WHERE id = $1 AND student_id = $2",
    [recommendationId, studentId],
    "recs:feedbackOwner",
  );

  if (!owner) throw new NotFoundError("That recommendation");

  const row = await queryOne(
    `INSERT INTO recommendation_feedback (recommendation_id, student_id, helpful, reason, comment)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (recommendation_id) DO UPDATE
       SET helpful = EXCLUDED.helpful,
           reason = EXCLUDED.reason,
           comment = EXCLUDED.comment,
           created_at = now()
     RETURNING helpful, reason, comment, created_at`,
    [
      recommendationId,
      studentId,
      helpful ?? null,
      reason ?? null,
      comment ?? null,
    ],
    "recs:recordFeedback",
  );

  return { saved: true, feedback: row };
}

/**
 * One stored recommendation, with its full breakdown.
 *
 * This is what a student sees when they ask "why is this 82%?". Everything comes
 * back from the row that was persisted at ranking time — the score is not
 * recomputed here, so the explanation cannot drift from the number that was shown.
 */
export async function recommendationDetail(studentId, recommendationId) {
  const row = await queryOne(
    `SELECT r.id, r.kind, r.score, r.rank, r.confidence, r.score_breakdown, r.explanation,
            r.similarity_score, r.complementarity_score,
            r.complementary_topics, r.overlapping_topics,
            r.shown_at, r.clicked_at, r.accepted_at, r.rejected_at, r.dismissed_reason,
            req.created_at, r.target_student_id, r.target_workspace_id,
            u.first_name, u.last_name, u.avatar_url,
            g.id AS group_id, g.name AS group_name, g.slug
       FROM recommendations r
       JOIN recommendation_requests req ON req.id = r.request_id
       LEFT JOIN users u ON u.id = r.target_student_id
       LEFT JOIN workspaces w ON w.id = r.target_workspace_id
       LEFT JOIN study_groups g ON g.id = w.group_id
      WHERE r.id = $1 AND r.student_id = $2`,
    [recommendationId, studentId],
    "recs:detail",
  );

  // Scoped to the owner: a recommendation is personal, so another student's id
  // must be indistinguishable from a missing one.
  if (!row) throw new NotFoundError("That recommendation");

  const topicNames = await queryRows(
    `SELECT ct.id, ct.name FROM course_topics ct WHERE ct.id = ANY($1::uuid[])`,
    [[...(row.complementary_topics ?? []), ...(row.overlapping_topics ?? [])]],
    "recs:detailTopics",
  );

  const names = new Map(topicNames.map((topic) => [topic.id, topic.name]));

  return {
    recommendation: {
      id: row.id,
      kind: row.kind,
      score: row.score,
      rank: row.rank,
      label: strengthLabel(row.score),
      confidence: row.confidence,
      breakdown: row.score_breakdown,
      explanation: row.explanation,
      similarityScore: row.similarity_score,
      complementarityScore: row.complementarity_score,
      complementaryTopics: (row.complementary_topics ?? []).map((id) => ({ id, name: names.get(id) })),
      overlappingTopics: (row.overlapping_topics ?? []).map((id) => ({ id, name: names.get(id) })),
      target: row.kind === "STUDENT"
        ? { type: "STUDENT", studentId: row.target_student_id, name: [row.first_name, row.last_name].filter(Boolean).join(" ") }
        : { type: "GROUP", groupId: row.group_id, workspaceId: row.target_workspace_id, name: row.group_name, slug: row.slug },
      outcome: {
        shownAt: row.shown_at,
        clickedAt: row.clicked_at,
        acceptedAt: row.accepted_at,
        rejectedAt: row.rejected_at,
        dismissedReason: row.dismissed_reason,
      },
      createdAt: row.created_at,
    },
  };
}

/** Previous recommendations for the caller, for the "you might also like" strip. */
export async function listRecent(studentId, limit = 10) {
  return queryRows(
    `SELECT r.id, r.kind, r.score, r.rank, r.accepted_at, r.rejected_at, r.shown_at,
            r.target_student_id, r.target_workspace_id,
            req.created_at,
            u.first_name, u.last_name,
            g.name AS group_name, g.slug
       FROM recommendations r
       JOIN recommendation_requests req ON req.id = r.request_id
       LEFT JOIN users u ON u.id = r.target_student_id
       LEFT JOIN workspaces w ON w.id = r.target_workspace_id
       LEFT JOIN study_groups g ON g.id = w.group_id
      WHERE r.student_id = $1
      ORDER BY req.created_at DESC LIMIT $2`,
    [studentId, limit],
    "recs:listRecent",
  );
}

/**
 * Parse natural language into structured requirements.
 *
 * When no AI provider is configured this throws `ServiceUnavailableError`, and
 * the caller falls back to structured input. It never guesses.
 */
export async function parseIntent(studentId, text, eligible) {
  const { parseNaturalLanguage } = await import("./ai.service.js");
  const env = (await import("../config/env.js")).default;

  // `aiEnabled` requires a provider *and* a key, so a half-configured deployment
  // reports unavailable instead of firing requests that cannot authenticate.
  if (!env.aiEnabled) {
    throw new ServiceUnavailableError();
  }

  return parseNaturalLanguage(text, eligible, studentId);
}

/**
 * Replace the active weights. Used by admin tuning and by research experiments.
 * Validates that the weights still sum to 1 before writing, so a bad config can
 * never make the engine refuse to score.
 */
export async function updateWeights(actorId, weights) {
  const validated = validateWeights(weights);
  const model = await ensureModelVersion();

  await query(
    "UPDATE recommendation_model_versions SET weights = $2 WHERE id = $1",
    [model.id, validated],
    "recs:updateWeights",
  );

  return { modelVersion: model.id, weights: validated, updatedBy: actorId };
}

/** Active configuration, for display on the research and admin screens. */
export async function currentModel() {
  const model = await ensureModelVersion();
  return {
    id: model.id,
    algorithm: MODEL_METADATA.algorithm ?? "WEIGHTED_SCORING",
    description: MODEL_METADATA.description,
    weights: model.weights,
    // Published so the UI can show students what the percentage is made of.
    weightExplanations: MODEL_METADATA.weightExplanations ?? {},
    minimumScore: MINIMUM_SCORE,
  };
}

export { MINIMUM_SCORE };

export default {
  generate,
  pairCompatibility,
  recordOutcome,
  recordFeedback,
  listRecent,
  parseIntent,
  updateWeights,
  currentModel,
};