import { queryRows, queryOne } from "../config/db.js";
import { NotFoundError, ForbiddenError } from "../lib/errors.js";
import {
  availabilityCompatibility,
  goalCompatibility,
  courseCompatibility,
  skillComplementarity,
  topicSimilarity,
  preferenceCompatibility,
} from "../lib/features.js";
import { computeCompatibility, buildExplanation, strengthLabel } from "../lib/scoring.js";
import { STUDY_MODES, LEARNING_GOAL_LABELS } from "../config/constants.js";

/**
 * Discovery service — finding *other students*, as opposed to finding groups.
 *
 * This is the human-agency half of the product: the recommendation engine
 * proposes, but a student can always search for a specific person and invite
 * them regardless of score. Nothing in this file blocks an invite for a low
 * score; the score is information, not a gate.
 *
 * Two invariants govern everything here:
 *
 *  1. **Privacy is enforced in SQL, not in the UI.** A student who opted out of
 *     discovery is excluded by the `WHERE` clause, so no response shape leaks
 *     their data and no client bug can expose it.
 *  2. **A non-discoverable requester finds nobody.** If you have hidden yourself
 *     from search, you cannot use search to enumerate others — otherwise privacy
 *     is opt-out only in appearance.
 *
 * Data shapes are returned in two distinct flavours, and the difference matters:
 * `null` means "withheld by their privacy settings", `[]` means "they have
 * none". The UI must render those differently.
 */

const VISIBILITY_RANK = Object.freeze({ PUBLIC: 3, STUDENTS: 2, COURSES_ONLY: 1, PRIVATE: 0 });

/**
 * Whether `viewer` may see `target`'s profile. Mirrors the SQL predicate so the
 * service can explain *why* something is hidden without a second round trip.
 */
export function canViewProfile(viewerId, target) {
  if (!target) return false;
  if (viewerId === target.id) return true;
  const rank = VISIBILITY_RANK[target.profile_visibility] ?? VISIBILITY_RANK.STUDENTS;
  if (rank >= VISIBILITY_RANK.STUDENTS) return true;
  // COURSES_ONLY requires genuine overlap: a shared course, or the same
  // programme (which implies shared foundational courses in practice).
  return (target.shares_course ?? 0) > 0;
}

/** LIKE/ILIKE metacharacters must be neutralised or "100%" matches everything. */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Search students with optional facets.
 *
 * Facets are additive: each supplied one narrows the set, and an absent one does
 * not constrain it. Results are ordered by shared courses then recency — ranking
 * by compatibility would mean scoring every student in the university, and
 * discovery is meant to be browsable rather than ranked.
 */
export async function searchStudents(viewerId, filters = {}) {
  const viewer = await queryOne(
    `SELECT ps.discoverable FROM users u
       LEFT JOIN privacy_settings ps ON ps.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [viewerId],
    "discovery:viewerPrivacy",
  );

  if (!viewer) throw new NotFoundError("Your account");

  // Invariant 2. Refuse explicitly rather than returning an empty list, which
  // the user would misread as "nobody matches".
  if (viewer.discoverable === false) {
    throw new ForbiddenError(
      "Turn on discovery in your privacy settings to search for other students.",
    );
  }

  const limit = filters.limit ?? 20;
  const { params, clauses } = buildSearchFilters(viewerId, filters);

  const rows = await queryRows(
    `SELECT u.id, u.first_name, u.last_name, u.avatar_url,
            sp.bio, sp.year_of_study, sp.program_id,
            uni.code AS university_code, p.name AS program_name,
            ps.show_availability, ps.show_skills, ps.allow_invites_from,
            pref.preferred_mode, pref.preferred_style,
            (SELECT count(*)::int
               FROM student_courses sc2
               JOIN student_courses sc1
                 ON sc1.course_id = sc2.course_id AND sc1.is_active
              WHERE sc1.student_id = $1 AND sc2.student_id = u.id AND sc2.is_active) AS shared_course_count,
            EXISTS (SELECT 1 FROM study_group_members m1
                     JOIN study_group_members m2 ON m2.group_id = m1.group_id
                    WHERE m1.student_id = $1 AND m1.left_at IS NULL
                      AND m2.student_id = u.id AND m2.left_at IS NULL) AS already_shares_group
       FROM users u
       JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN universities uni ON uni.id = sp.university_id
       LEFT JOIN programs p ON p.id = sp.program_id
       LEFT JOIN privacy_settings ps ON ps.user_id = u.id
       LEFT JOIN study_preferences pref ON pref.student_id = u.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY shared_course_count DESC, sp.last_active_at DESC NULLS LAST, u.id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, filters.offset ?? 0],
    "discovery:searchStudents",
  );

  if (rows.length === 0) return { students: [], hasMore: false };

  const ids = rows.map((row) => row.id);

  // Preserve the search row's program so same-program scoring is not lost when
  // comparison inputs are loaded separately.
  const programIdsByStudent = new Map(rows.map((row) => [row.id, row.program_id ?? null]));

  const [viewerProfile, candidates] = await Promise.all([
    loadComparableProfile(viewerId),
    loadCandidateDetails(ids, programIdsByStudent),
  ]);

  const students = rows.map((row) => {
    const candidate = candidates.get(row.id);
    const scored = candidate ? scorePair(viewerProfile, candidate) : null;

    return {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      // Never returned: email, phone, student number. Discovery works by
      // browsing, not by harvesting contact details.
      avatarUrl: row.avatar_url,
      universityCode: row.university_code,
      programName: row.program_name,
      yearOfStudy: row.year_of_study,
      bio: row.bio,
      sharedCourses: Number(row.shared_course_count ?? 0),
      alreadyInGroup: Boolean(row.already_shares_group),
      shown: {
        // Enrolment is always safe to show: a student needs to know what they
        // could study together, and it is not sensitive information.
        courses: true,
        skills: row.show_skills !== false,
        topics: row.show_skills !== false,
        availability: row.show_availability !== false,
        goals: true, // goals are the entire point of matching
      },
      compatibility: scored
        ? { score: scored.score, label: strengthLabel(scored.score) }
        : null,
      reasons: scored ? scored.reasons : [],
      warnings: scored ? scored.warnings : [],
      // What the viewer may do, resolved server-side. The client renders buttons
      // from this instead of deciding for itself.
      canInvite: row.allow_invites_from !== "NOBODY",
      inviteBlockedReason:
        row.allow_invites_from === "NOBODY"
          ? "This student is not accepting invitations right now."
          : null,
    };
  });

  return { students, hasMore: rows.length === limit };
}

/**
 * Build the WHERE clause and bound parameters.
 *
 * Clause *text* is assembled only from literal fragments chosen by branches on
 * filter presence — never from user input. Every value is bound, which keeps SQL
 * injection structurally impossible while still allowing dynamic filtering.
 */
function buildSearchFilters(viewerId, filters) {
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const viewerIdParam = bind(viewerId);

  // Baseline privacy filters. Present on every search, not overridable by any facet.
  const clauses = [
    `u.id <> ${viewerIdParam}`,
    "u.deleted_at IS NULL",
    "u.status = 'ACTIVE'",
    // Undiscoverable students never appear, whatever else is requested.
    "COALESCE(ps.discoverable, TRUE) = TRUE",
    "COALESCE(ps.profile_visibility, 'STUDENTS') <> 'PRIVATE'",
    // Searching needs something to search *on*: without skills shown there is
    // nothing to match against beyond a name.
    "COALESCE(ps.show_skills, TRUE) = TRUE",
  ];

  if (filters.q) {
    const pattern = escapeLike(filters.q);
    const p = bind(`%${pattern}%`);
    // Trigram similarity backs the ILIKE so short typos still match.
    const trigram = bind(pattern);
    clauses.push(
      `(u.first_name || ' ' || u.last_name) ILIKE ${p}
       OR similarity(u.first_name || ' ' || u.last_name, ${trigram}) > 0.3`,
    );
  }
  if (filters.courseId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM student_courses sc
                WHERE sc.student_id = u.id AND sc.course_id = ${bind(filters.courseId)} AND sc.is_active)`,
    );
  }
  if (filters.skillId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM student_skills ss
                WHERE ss.student_id = u.id AND ss.skill_id = ${bind(filters.skillId)})`,
    );
  }
  if (filters.universityId) {
    clauses.push(`sp.university_id = ${bind(filters.universityId)}`);
  }
  if (filters.programId) {
    clauses.push(`sp.program_id = ${bind(filters.programId)}`);
  }
  if (filters.yearOfStudy !== undefined) {
    clauses.push(`sp.year_of_study = ${bind(filters.yearOfStudy)}`);
  }
  if (filters.goalId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM student_learning_goals g
                WHERE g.student_id = u.id AND g.goal_id = ${bind(filters.goalId)})`,
    );
  }
  if (filters.mode && filters.mode !== STUDY_MODES.EITHER) {
    // EITHER means "no preference" and must therefore not exclude anyone.
    clauses.push(`COALESCE(pref.preferred_mode, 'EITHER') IN (${bind(filters.mode)}, 'EITHER')`);
  }
  if (filters.availableDay !== undefined) {
    const day = bind(filters.availableDay);
    const from = bind(filters.availableFrom ?? 0);
    const to = bind(filters.availableTo ?? 1440);
    clauses.push(
      `EXISTS (SELECT 1 FROM student_availability av
                WHERE av.student_id = u.id AND av.day_of_week = ${day}
                  AND av.start_minute < ${to} AND av.end_minute > ${from})`,
    );
  }
  if (filters.excludeGroupId) {
    const groupId = bind(filters.excludeGroupId);
    // Already sharing a group with them: exclude unless the caller asks for
    // them anyway (an invite screen may want exactly this list).
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM study_group_members m1
                     JOIN study_group_members m2 ON m2.group_id = m1.group_id
                    WHERE m1.student_id = ${viewerIdParam} AND m1.left_at IS NULL
                      AND m2.student_id = u.id AND m2.left_at IS NULL
                      AND m1.group_id = ${groupId})`,
    );
  }

  return { params, clauses };
}

/**
 * Load a student in the shape the scorer expects.
 * Returns null when there is no profile yet (mid-onboarding).
 *
 * Note the raw snake_case availability rows: `availabilityCompatibility` and
 * `preferenceCompatibility` read `day_of_week`/`start_minute` and
 * `preferred_mode`/`preferred_style` directly, so these objects are passed
 * through untransformed rather than being renamed.
 */
async function loadComparableProfile(studentId) {
  const row = await queryOne(
    "SELECT program_id FROM student_profiles WHERE user_id = $1",
    [studentId],
    "discovery:viewerProfile",
  );
  if (!row) return null;

  const [courses, topics, goals, availability, preferences] = await Promise.all([
    queryRows(
      "SELECT course_id FROM student_courses WHERE student_id = $1 AND is_active",
      [studentId],
      "discovery:viewerCourses",
    ),
    queryRows(
      "SELECT topic_id, status, self_rating FROM student_topics WHERE student_id = $1",
      [studentId],
      "discovery:viewerTopics",
    ),
    queryRows(
      `SELECT g.code FROM student_learning_goals sg
         JOIN learning_goals g ON g.id = sg.goal_id
        WHERE sg.student_id = $1 ORDER BY sg.priority LIMIT 1`,
      [studentId],
      "discovery:viewerGoals",
    ),
    queryRows(
      "SELECT day_of_week, start_minute, end_minute, is_preferred FROM student_availability WHERE student_id = $1",
      [studentId],
      "discovery:viewerAvailability",
    ),
    queryOne(
      `SELECT preferred_mode, preferred_style, min_group_size, max_group_size, session_minutes
         FROM study_preferences WHERE student_id = $1`,
      [studentId],
      "discovery:viewerPrefs",
    ),
  ]);

  return {
    id: studentId,
    programId: row.program_id,
    courseIds: new Set(courses.map((course) => course.course_id)),
    goalCode: goals[0]?.code ?? null,
    topics: topicMap(topics),
    availability,
    preferences: preferences ?? {},
  };
}

/** Batch-load comparison inputs for many candidates in five queries, not N×5. */
async function loadCandidateDetails(studentIds, programIdsByStudent = new Map()) {
  const [courses, topics, goals, availability, preferences] = await Promise.all([
    queryRows(
      "SELECT student_id, course_id FROM student_courses WHERE student_id = ANY($1::uuid[]) AND is_active",
      [studentIds],
      "discovery:candidateCourses",
    ),
    queryRows(
      `SELECT st.student_id, st.topic_id, st.status, st.self_rating, ct.name AS topic_name
         FROM student_topics st
         JOIN course_topics ct ON ct.id = st.topic_id
        WHERE st.student_id = ANY($1::uuid[])`,
      [studentIds],
      "discovery:candidateTopics",
    ),
    queryRows(
      `SELECT sg.student_id, g.code FROM student_learning_goals sg
         JOIN learning_goals g ON g.id = sg.goal_id
        WHERE sg.student_id = ANY($1::uuid[]) AND sg.priority = 1`,
      [studentIds],
      "discovery:candidateGoals",
    ),
    queryRows(
      "SELECT student_id, day_of_week, start_minute, end_minute, is_preferred FROM student_availability WHERE student_id = ANY($1::uuid[])",
      [studentIds],
      "discovery:candidateAvailability",
    ),
    queryRows(
      `SELECT student_id, preferred_mode, preferred_style, min_group_size, max_group_size, session_minutes
         FROM study_preferences WHERE student_id = ANY($1::uuid[])`,
      [studentIds],
      "discovery:candidatePrefs",
    ),
  ]);

  // `program_id` is carried through from the search row, which already selected
  // it. It matters because same-program study is a real compatibility signal:
  // two students in one programme share prerequisites, exam boards and revision
  // timing, which is worth a course-score boost.
  const byStudent = new Map(
    studentIds.map((id) => [
      id,
      {
        id,
        programId: programIdsByStudent.get(id) ?? null,
        courseIds: new Set(),
        topics: new Map(),
        topicNames: {},
        goalCode: null,
        availability: [],
        preferences: {},
      },
    ]),
  );

  for (const row of courses) byStudent.get(row.student_id)?.courseIds.add(row.course_id);
  for (const row of topics) {
    const entry = byStudent.get(row.student_id);
    entry?.topics.set(row.topic_id, { status: row.status, level: row.self_rating });
    if (entry && row.topic_name) entry.topicNames[row.topic_id] = row.topic_name;
  }
  for (const row of goals) {
    const entry = byStudent.get(row.student_id);
    if (entry && !entry.goalCode) entry.goalCode = row.code;
  }
  for (const row of availability) byStudent.get(row.student_id)?.availability.push(row);
  for (const row of preferences) {
    const entry = byStudent.get(row.student_id);
    if (entry) entry.preferences = row;
  }

  return byStudent;
}

function topicMap(rows) {
  return new Map(rows.map((row) => [row.topic_id, { status: row.status, level: row.self_rating }]));
}

/**
 * Score a candidate against the viewer.
 *
 * Returns null when the *viewer* has no profile, because a score computed from an
 * empty profile would be meaningless — better to show no number than a
 * confident-looking wrong one.
 */
function scorePair(viewerProfile, candidate) {
  if (!viewerProfile) return null;

  const sharedCourses = [...candidate.courseIds].filter((id) => viewerProfile.courseIds.has(id)).length;
  const complementarity = skillComplementarity(viewerProfile.topics, candidate.topics);
  const availability = availabilityCompatibility(viewerProfile.availability, candidate.availability);

  const result = computeCompatibility({
    course: courseCompatibility(sharedCourses, Boolean(candidate.programId && candidate.programId === viewerProfile.programId)),
    skills: complementarity.score,
    goals: goalCompatibility(viewerProfile.goalCode, candidate.goalCode),
    availability: availability.score,
    preferences: preferenceCompatibility(viewerProfile.preferences, candidate.preferences).score,
    topics: topicSimilarity(viewerProfile.topics, candidate.topics),
  });

  // `buildExplanation` returns a flat array of items, each tagged with an impact
  // of high/medium/low/negative/caveat. Separate them so the caller does not have
  // to know that taxonomy: users should see why it matches and why it might not.
  const items = buildExplanation(result, {
    complementaryDetail: complementarity.detail,
    overlappingTopics: complementarity.overlapping,
    // Without topic names `buildExplanation` degrades every topic reference to
    // "this topic", so the names are loaded alongside the topic rows.
    topicNames: candidate.topicNames,
    availabilityMinutes: availability.totalMinutes,
    goalLabel: viewerProfile.goalCode ? LEARNING_GOAL_LABELS[viewerProfile.goalCode] : undefined,
    modeMatch: describeModeMatch(viewerProfile.preferences.preferred_mode, candidate.preferences.preferred_mode),
  });

  return {
    score: result.score,
    reasons: items.filter((item) => !["negative", "caveat"].includes(item.impact)).slice(0, 4),
    warnings: items.filter((item) => ["negative", "caveat"].includes(item.impact)).slice(0, 2),
  };
}

function describeModeMatch(mine, theirs) {
  if (!mine || !theirs) return undefined;
  if (mine === theirs || mine === "EITHER" || theirs === "EITHER") return "You are both happy to study in person or online.";
  const mode = mine === "ONLINE" ? "online" : "in person";
  return `You prefer to study ${mode}.`;
}

/**
 * Another student's public profile.
 *
 * Returns 404 rather than 403 for a hidden profile: a 403 confirms the account
 * exists, which is itself a leak.
 */
export async function getStudentProfile(viewerId, studentId) {
  if (viewerId === studentId) {
    const own = await queryOne(
      `SELECT u.first_name, u.last_name, u.avatar_url, sp.bio, sp.year_of_study
         FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`,
      [studentId],
      "discovery:ownProfile",
    );
    if (!own) throw new NotFoundError("That student profile");
    return {
      id: studentId,
      firstName: own.first_name,
      lastName: own.last_name,
      avatarUrl: own.avatar_url,
      bio: own.bio,
      yearOfStudy: own.year_of_study,
      isSelf: true,
      canInvite: false,
    };
  }

  const row = await queryOne(
    `SELECT u.id, u.first_name, u.last_name, u.avatar_url,
            sp.bio, sp.year_of_study, sp.program_id, sp.university_id,
            uni.code AS university_code, p.name AS program_name,
            ps.profile_visibility, ps.discoverable, ps.show_availability,
            ps.show_skills, ps.show_full_schedule, ps.allow_invites_from,
            pref.preferred_mode, pref.preferred_style,
            (SELECT count(*)::int FROM student_courses sc2
               JOIN student_courses sc1 ON sc1.course_id = sc2.course_id AND sc1.is_active
              WHERE sc1.student_id = $1 AND sc2.student_id = u.id AND sc2.is_active) AS shared_course_count,
            (SELECT count(*)::int FROM student_courses sc2
               JOIN student_courses sc1 ON sc1.course_id = sc2.course_id AND sc1.is_active
              WHERE sc1.student_id = $1 AND sc2.student_id = u.id AND sc2.is_active) AS shares_course,
            EXISTS (SELECT 1 FROM study_group_members m1
                     JOIN study_group_members m2 ON m2.group_id = m1.group_id
                    WHERE m1.student_id = $1 AND m1.left_at IS NULL
                      AND m2.student_id = u.id AND m2.left_at IS NULL) AS already_shares_group
       FROM users u
       JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN universities uni ON uni.id = sp.university_id
       LEFT JOIN programs p ON p.id = sp.program_id
       LEFT JOIN privacy_settings ps ON ps.user_id = u.id
       LEFT JOIN study_preferences pref ON pref.student_id = u.id
      WHERE u.id = $2 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'`,
    [viewerId, studentId],
    "discovery:studentProfile",
  );

  if (!row) throw new NotFoundError("That student profile");

  const visible = canViewProfile(viewerId, {
    id: row.id,
    profile_visibility: row.profile_visibility ?? "STUDENTS",
    shares_course: row.shares_course,
  });

  if (!visible || row.discoverable === false) {
    // Uniform 404. Revealing that a profile exists but is hidden is itself a leak.
    throw new NotFoundError("That student profile");
  }

  const showSkills = row.show_skills !== false;
  const showSchedule = row.show_full_schedule === true;

  const [courses, skills, topics, goals, availability] = await Promise.all([
    // Always shown: enrolment is what makes a study relationship possible.
    queryRows(
      `SELECT c.id, c.course_code, c.name FROM student_courses sc
         JOIN courses c ON c.id = sc.course_id
        WHERE sc.student_id = $1 AND sc.is_active ORDER BY c.name`,
      [studentId],
      "discovery:profileCourses",
    ),
    showSkills
      ? queryRows(
          `SELECT s.name, ss.proficiency, ss.is_learning FROM student_skills ss
             JOIN skills s ON s.id = ss.skill_id
            WHERE ss.student_id = $1 AND ss.course_id IS NULL ORDER BY s.name`,
          [studentId],
          "discovery:profileSkills",
        )
      : Promise.resolve(null),
    showSkills
      ? queryRows(
          `SELECT ct.id AS topic_id, ct.name AS topic_name, c.course_code, st.status
             FROM student_topics st
             JOIN course_topics ct ON ct.id = st.topic_id
             JOIN courses c ON c.id = ct.course_id
            WHERE st.student_id = $1
            ORDER BY st.status DESC, ct.position LIMIT 20`,
          [studentId],
          "discovery:profileTopics",
        )
      : Promise.resolve(null),
    queryRows(
      `SELECT g.code, g.label, sg.priority FROM student_learning_goals sg
         JOIN learning_goals g ON g.id = sg.goal_id
        WHERE sg.student_id = $1 ORDER BY sg.priority`,
      [studentId],
      "discovery:profileGoals",
    ),
    showSchedule
      ? queryRows(
          `SELECT day_of_week, start_minute, end_minute FROM student_availability
            WHERE student_id = $1 AND is_preferred ORDER BY day_of_week, start_minute`,
          [studentId],
          "discovery:profileSchedule",
        )
      : Promise.resolve(null),
  ]);

  const [viewerProfile, candidates] = await Promise.all([
    loadComparableProfile(viewerId),
    loadCandidateDetails([studentId], new Map([[studentId, row.program_id ?? null]])),
  ]);

  const candidate = candidates.get(studentId);
  const scored = candidate ? scorePair(viewerProfile, candidate) : null;

  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    yearOfStudy: row.year_of_study,
    universityCode: row.university_code,
    programName: row.program_name,
    sharedCourses: Number(row.shared_course_count ?? 0),
    alreadyInGroup: Boolean(row.already_shares_group),
    courses,
    // null = withheld by their settings; [] = they declared none.
    skills,
    topics,
    goals,
    availability,
    preferences: { mode: row.preferred_mode, style: row.preferred_style },
    compatibility: scored ? { score: scored.score, label: strengthLabel(scored.score) } : null,
    reasons: scored?.reasons ?? [],
    warnings: scored?.warnings ?? [],
    canInvite: row.allow_invites_from !== "NOBODY",
    isSelf: false,
  };
}

/**
 * Another student's availability, subject to `show_availability`.
 *
 * `show_full_schedule` is a stricter permission than "show that I am free
 * sometimes". Without it, each day is collapsed to its earliest start and latest
 * end: enough to know whether you could meet, not enough to reconstruct their
 * week. With it, individual slots are returned.
 */
export async function getStudentAvailability(viewerId, studentId) {
  if (viewerId === studentId) {
    return queryRows(
      `SELECT day_of_week, start_minute, end_minute, is_preferred FROM student_availability
        WHERE student_id = $1 ORDER BY day_of_week, start_minute`,
      [studentId],
      "discovery:ownAvailability",
    );
  }

  const allowed = await queryOne(
    `SELECT COALESCE(ps.show_availability, FALSE) AS show_availability,
            COALESCE(ps.show_full_schedule, FALSE) AS show_full_schedule
       FROM users u LEFT JOIN privacy_settings ps ON ps.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'`,
    [studentId],
    "discovery:availabilityPermission",
  );

  if (!allowed?.show_availability) {
    throw new ForbiddenError("This student does not share their availability.");
  }

  if (!allowed.show_full_schedule) {
    return queryRows(
      `SELECT day_of_week,
              min(start_minute)::int AS start_minute,
              max(end_minute)::int AS end_minute,
              bool_or(is_preferred) AS is_preferred,
              TRUE AS summarised
         FROM student_availability WHERE student_id = $1
        GROUP BY day_of_week ORDER BY day_of_week`,
      [studentId],
      "discovery:availabilitySummary",
    );
  }

  return queryRows(
    `SELECT day_of_week, start_minute, end_minute, is_preferred, FALSE AS summarised
       FROM student_availability WHERE student_id = $1 ORDER BY day_of_week, start_minute`,
    [studentId],
    "discovery:availabilityFull",
  );
}

/** Groups both students belong to — the basis of "you already study together". */
export async function getSharedGroups(viewerId, studentId) {
  return queryRows(
    `SELECT g.id, g.name, g.slug, g.mode, g.member_count,
            theirs.role AS their_role, mine.role AS my_role,
            c.course_code, c.name AS course_name
       FROM study_group_members theirs
       JOIN study_group_members mine
         ON mine.group_id = theirs.group_id
        AND mine.student_id = $1 AND mine.left_at IS NULL
       JOIN study_groups g ON g.id = theirs.group_id
       JOIN courses c ON c.id = g.course_id
      WHERE theirs.student_id = $2 AND theirs.left_at IS NULL AND g.status = 'ACTIVE'
      ORDER BY theirs.joined_at DESC`,
    [viewerId, studentId],
    "discovery:sharedGroups",
  );
}

export default {
  searchStudents,
  getStudentProfile,
  getStudentAvailability,
  getSharedGroups,
  canViewProfile,
};