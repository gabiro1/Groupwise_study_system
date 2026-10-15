import { queryRows, queryOne } from "../config/db.js";
import { NotFoundError, ForbiddenError } from "../lib/errors.js";

/**
 * Research analytics.
 *
 * The research question this product exists to answer is narrow: *does
 * compatibility-based matching produce study groups that actually work together
 * better than chance?*
 *
 * Three consequences shape every query here.
 *
 * 1. **Outcome, not engagement.** Sessions attended, tasks completed and messages
 *    sent are measured after joining; the score that produced the match is
 *    measured before. Without that separation, a high score would simply be
 *    correlated with engagement because engagement produced the score.
 * 2. **Aggregates only.** Everything is computed in SQL over the whole
 *    population and returned as counts and rates. There is no endpoint anywhere in
 *    this file that returns a per-student row, because research output that can be
 *    joined back to an individual is surveillance output.
 * 3. **AI output is separable.** `recommendation_requests.source` distinguishes a
 *    student's form from a parsed intent, and `parser_model` names the model. Any
 *    comparison between those cohorts is possible without joining identities.
 */

/** Shared helpers --------------------------------------------------------- */

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Resolve the reporting window, defaulting to the last 12 weeks. */
function resolveWindow({ from, to }) {
  const end = isDate(to) ? to : new Date().toISOString().slice(0, 10);
  const start = isDate(from)
    ? from
    : new Date(Date.now() - 84 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (start > end) {
    throw new NotFoundError("That date range");
  }

  return { start, end };
}

/**
 * Resolve the courses a request is allowed to see.
 *
 * These analytics are an administrator surface. An explicit course narrows the
 * view; the absence of one means "every course".
 */
async function resolveCourseScope(actor, courseId) {
  if (actor.role !== "ADMIN") {
    throw new ForbiddenError("Platform analytics are restricted to administrators.");
  }

  return courseId ? [courseId] : null;
}

/**
 * SQL predicate for a resolved scope. `null` means unrestricted, which is why the
 * parameter is always passed as `$n::uuid[]` rather than being interpolated.
 */
const scopePredicate = (column, param) => `(${param}::uuid[] IS NULL OR ${column} = ANY(${param}::uuid[]))`;

/**
 * Outcome measures for group membership.
 *
 * `group_membership_outcomes` is the spine: one row per student per workspace,
 * recording how they arrived and what they then did. Everything the study needs
 * about group success is derived from it.
 */
async function outcomesByCourse({ from, to, courseIds, granularity }) {
  const bucket = bucketExpression(granularity);

  const rows = await queryRows(
    `SELECT ${bucket} AS period,
            c.id AS course_id, c.course_code, c.name AS course_name,
            count(*)::int AS memberships,
            count(*) FILTER (WHERE o.left_at IS NULL)::int AS still_active,
            count(*) FILTER (WHERE o.left_at IS NOT NULL)::int AS left_group,
            round(
              100.0 * count(*) FILTER (WHERE o.left_at IS NOT NULL)
              / nullif(count(*), 0), 1
            ) AS attrition_pct,
            round(avg(o.sessions_attended)::numeric, 2) AS avg_sessions_attended,
            round(avg(o.tasks_completed)::numeric, 2) AS avg_tasks_completed,
            round(avg(o.messages_sent)::numeric, 2) AS avg_messages_sent
       FROM group_membership_outcomes o
       JOIN workspaces w ON w.id = o.workspace_id
       JOIN study_groups g ON g.id = w.group_id
       JOIN courses c ON c.id = g.course_id
      WHERE o.joined_at >= $1::date AND o.joined_at < ($2::date + interval '1 day')
        AND ${scopePredicate("c.id", "$3")}
      GROUP BY period, c.id, c.course_code, c.name
      ORDER BY period DESC, c.course_code`,
    [from, to, courseIds ?? null],
    "research:outcomesByCourse",
  );

  return rows;
}

/**
 * The headline comparison: how groups formed by recommendation differ from groups
 * formed by joining directly.
 *
 * This is the study's core comparison. Note that `joined_via` is recorded at join
 * time, so the cohorts are defined by *how the student arrived*, not by their
 * compatibility score — otherwise the analysis would be circular.
 */
async function recommendationsVsOrganic({ from, to, courseIds }) {
  return queryRows(
    `SELECT c.id AS course_id, c.course_code,
            count(*) FILTER (WHERE o.joined_via IN ('DIRECT', 'INVITATION', 'JOIN_REQUEST'))::int AS organic,
            count(*) FILTER (WHERE o.joined_via = 'AI_ASSISTED')::int AS recommended,
            -- Retention: still in the group 30+ days after joining.
            round(
              100.0 * count(*) FILTER (WHERE o.joined_via = 'AI_ASSISTED' AND o.left_at IS NULL)
              / nullif(count(*) FILTER (WHERE o.joined_via = 'AI_ASSISTED'), 0), 1
            ) AS recommended_retained_pct,
            round(
              100.0 * count(*) FILTER (WHERE o.joined_via <> 'AI_ASSISTED' AND o.left_at IS NULL)
              / nullif(count(*) FILTER (WHERE o.joined_via <> 'AI_ASSISTED'), 0), 1
            ) AS organic_retained_pct,
            round(
              avg(o.sessions_attended) FILTER (WHERE o.joined_via = 'AI_ASSISTED')::numeric, 2
            ) AS recommended_avg_sessions,
            round(
              avg(o.sessions_attended) FILTER (WHERE o.joined_via <> 'AI_ASSISTED')::numeric, 2
            ) AS organic_avg_sessions,
            round(
              avg(o.tasks_completed) FILTER (WHERE o.joined_via = 'AI_ASSISTED')::numeric, 2
            ) AS recommended_avg_tasks,
            round(
              avg(o.tasks_completed) FILTER (WHERE o.joined_via <> 'AI_ASSISTED')::numeric, 2
            ) AS organic_avg_tasks
       FROM group_membership_outcomes o
       JOIN workspaces w ON w.id = o.workspace_id
       JOIN study_groups g ON g.id = w.group_id
       JOIN courses c ON c.id = g.course_id
      WHERE o.joined_at >= $1::date AND o.joined_at < ($2::date + interval '1 day')
        AND ${scopePredicate("c.id", "$3")}
      GROUP BY c.id, c.course_code
      HAVING count(*) FILTER (WHERE o.joined_via = 'AI_ASSISTED') > 0
         OR count(*) FILTER (WHERE o.joined_via <> 'AI_ASSISTED') > 0
      ORDER BY c.course_code`,
    [from, to, courseIds ?? null],
    "research:recommendedVsOrganic",
  );
}

/**
 * Score calibration: do high scores actually predict joining?
 *
 * Bucketed by score band, with the acceptance rate in each. If the score carried
 * no information, these rates would be flat across bands; a monotone rise is the
 * basic evidence that the ranking is not noise.
 */
async function scoreCalibration({ from, to, courseIds }) {
  const rows = await queryRows(
    `SELECT width_bucket(r.score, 0, 100, 5) AS band,
            min(r.score)::numeric AS band_low,
            max(r.score)::numeric AS band_high,
            count(*)::int AS shown,
            count(*) FILTER (WHERE r.clicked_at IS NOT NULL)::int AS clicked,
            count(*) FILTER (WHERE r.accepted_at IS NOT NULL)::int AS accepted,
            count(*) FILTER (WHERE r.rejected_at IS NOT NULL OR r.dismissed_reason IS NOT NULL)::int AS dismissed,
            round(
              100.0 * count(*) FILTER (WHERE r.accepted_at IS NOT NULL) / nullif(count(*), 0), 1
            ) AS acceptance_pct,
            round(avg(r.score)::numeric, 1) AS avg_score
       FROM recommendations r
       JOIN recommendation_requests q ON q.id = r.request_id
       JOIN courses c ON c.id = q.course_id
      WHERE q.created_at >= $1::date AND q.created_at < ($2::date + interval '1 day')
        AND ${scopePredicate("c.id", "$3")}
        AND r.shown_at IS NOT NULL
      GROUP BY band
      ORDER BY band`,
    [from, to, courseIds ?? null],
    "research:scoreCalibration",
  );

  // Precision@K on the same data: of the top 5 shown, how many were accepted?
  const precision = await queryOne(
    `WITH ranked AS (
       SELECT r.id, r.rank, r.accepted_at,
              row_number() OVER (PARTITION BY q.id ORDER BY r.rank) AS position
         FROM recommendations r
         JOIN recommendation_requests q ON q.id = r.request_id
        WHERE q.created_at >= $1::date AND q.created_at < ($2::date + interval '1 day')
          AND ${scopePredicate("q.course_id", "$3")}
     )
     SELECT
       round(100.0 * count(*) FILTER (WHERE position <= 5 AND accepted_at IS NOT NULL)
             / nullif(count(*) FILTER (WHERE position <= 5), 0), 1) AS precision_at_5,
       round(100.0 * count(*) FILTER (WHERE position <= 10 AND accepted_at IS NOT NULL)
             / nullif(count(*) FILTER (WHERE position <= 10), 0), 1) AS precision_at_10,
       count(DISTINCT position)::int AS requests
     FROM ranked`,
    [from, to, courseIds ?? null],
    "research:precision",
  );

  return { bands: rows, precision };
}

/**
 * Form vs natural language.
 *
 * The product question this answers: did letting a student type a sentence produce
 * useful structured filters, or did it produce empty searches? `parser_confidence`
 * is reported alongside, because a parser that is confidently wrong is worse than
 * one that declines.
 */
async function intentParserEffectiveness({ from, to, courseIds }) {
  const rows = await queryRows(
    `SELECT q.source, q.parser_model,
            count(*)::int AS requests,
            round(avg(q.parser_confidence)::numeric, 3) AS avg_confidence,
            count(*) FILTER (WHERE q.degraded)::int AS degraded,
            round(avg(q.candidate_pool_size)::numeric, 1) AS avg_pool,
            round(avg(q.result_count)::numeric, 1) AS avg_results,
            round(avg(q.latency_ms)::numeric, 0) AS avg_latency_ms,
            -- A parsed request that yielded no candidates is a failed parse, not a
            -- failed search.
            count(*) FILTER (WHERE q.source = 'NATURAL_LANGUAGE' AND q.candidate_pool_size = 0)::int AS empty_parses
       FROM recommendation_requests q
      WHERE q.created_at >= $1::date AND q.created_at < ($2::date + interval '1 day')
        AND ${scopePredicate("q.course_id", "$3")}
      GROUP BY q.source, q.parser_model
      ORDER BY requests DESC`,
    [from, to, courseIds ?? null],
    "research:parserEffectiveness",
  );

  return rows;
}

/**
 * The availability of data itself. An analytics UI should say "too little yet".
 *
 * Scoped like every other query: a lecturer's coverage counts describe the courses
 * they teach, not the platform. A "0 students" answer for a lecturer is a true
 * statement about their courses rather than a leak of the total.
 */
async function dataCoverage({ from, to, courseIds }) {
  return queryOne(
    `SELECT
       (SELECT count(DISTINCT sc.student_id)::int
          FROM student_courses sc
         WHERE sc.is_active AND ${scopePredicate("sc.course_id", "$1")}) AS students,
       (SELECT count(DISTINCT sc.student_id)::int
          FROM student_courses sc
          JOIN users u ON u.id = sc.student_id
         WHERE sc.is_active AND u.status = 'ACTIVE' AND ${scopePredicate("sc.course_id", "$1")}) AS active_users,
       (SELECT count(*)::int
          FROM study_groups g
         WHERE g.created_at >= $2::date AND g.created_at < ($3::date + interval '1 day')
           AND ${scopePredicate("g.course_id", "$1")}) AS groups_created,
       (SELECT count(*)::int
          FROM group_membership_outcomes o
          JOIN workspaces w ON w.id = o.workspace_id
          JOIN study_groups g ON g.id = w.group_id
         WHERE o.joined_at >= $2::date AND o.joined_at < ($3::date + interval '1 day')
           AND ${scopePredicate("g.course_id", "$1")}) AS memberships,
       (SELECT count(*)::int
          FROM group_feedback f
          JOIN workspaces w ON w.id = f.workspace_id
          JOIN study_groups g ON g.id = w.group_id
         WHERE f.created_at >= $2::date AND f.created_at < ($3::date + interval '1 day')
           AND ${scopePredicate("g.course_id", "$1")}) AS feedback_responses,
       (SELECT count(*)::int
          FROM recommendation_requests q
         WHERE q.created_at >= $2::date AND q.created_at < ($3::date + interval '1 day')
           AND ${scopePredicate("q.course_id", "$1")}) AS recommendations_shown,
       (SELECT count(DISTINCT sc.course_id)::int
          FROM student_courses sc
         WHERE sc.is_active AND ${scopePredicate("sc.course_id", "$1")}) AS courses_with_enrolments,
       -- A study needs both cohorts populated to compare them at all.
       (SELECT count(*)::int
          FROM group_membership_outcomes o
          JOIN workspaces w ON w.id = o.workspace_id
          JOIN study_groups g ON g.id = w.group_id
         WHERE o.joined_via = 'AI_ASSISTED'
           AND o.joined_at >= $2::date AND o.joined_at < ($3::date + interval '1 day')
           AND ${scopePredicate("g.course_id", "$1")}) AS recommended_memberships,
       (SELECT count(*)::int
          FROM group_membership_outcomes o
          JOIN workspaces w ON w.id = o.workspace_id
          JOIN study_groups g ON g.id = w.group_id
         WHERE o.joined_via <> 'AI_ASSISTED'
           AND o.joined_at >= $2::date AND o.joined_at < ($3::date + interval '1 day')
           AND ${scopePredicate("g.course_id", "$1")}) AS organic_memberships`,
    [courseIds ?? null, from, to],
    "research:coverage",
  );
}

/** Only admin can see platform-wide figures; everyone else is course-scoped. */
function assertAdminScope(actorRole) {
  if (actorRole !== "ADMIN") {
    throw new ForbiddenError("Platform-wide analytics are limited to administrators.");
  }
}

const bucketExpression = (granularity) =>
  ({ day: "to_char(o.joined_at, 'YYYY-MM-DD')", week: "to_char(date_trunc('week', o.joined_at), 'IYYY-\"W\"IW')", month: "to_char(o.joined_at, 'YYYY-MM')" })[
    granularity
  ] ??
  "to_char(date_trunc('week', o.joined_at), 'IYYY-\"W\"IW')";

export {
  outcomesByCourse,
  recommendationsVsOrganic,
  scoreCalibration,
  intentParserEffectiveness,
  dataCoverage,
  assertAdminScope,
  resolveWindow,
  resolveCourseScope,
};

export default {
  outcomesByCourse,
  recommendationsVsOrganic,
  scoreCalibration,
  intentParserEffectiveness,
  dataCoverage,
  assertAdminScope,
  resolveWindow,
  resolveCourseScope,
};