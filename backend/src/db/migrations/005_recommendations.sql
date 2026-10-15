-- =============================================================================
-- Lien â€” 005_recommendations.sql
-- Recommendation events, feedback, research metrics, analytics views.
--
-- This is the research substrate. Every recommendation the engine produces is
-- persisted with a full score breakdown, and every student action on it is
-- recorded as a timestamped event. That makes acceptance rate, Precision@K and
-- calibration measurable rather than anecdotal.
-- =============================================================================

-- =============================================================================
-- Engine configuration.
--
-- Weights live in the database so they can be tuned (and re-tuned for
-- experiments) without a code change, and so each generated recommendation can
-- record which configuration produced it. Reproducibility of a scoring run is a
-- requirement for the research component.
-- =============================================================================

CREATE TABLE recommendation_model_versions (
  id             TEXT PRIMARY KEY,               -- e.g. 'weighted-v1.0.0'
  algorithm      TEXT NOT NULL,                  -- 'WEIGHTED_SCORING' (v1), later 'LTR'
  description    TEXT NOT NULL DEFAULT '',
  weights        JSONB NOT NULL,                 -- { course: 0.25, skills: 0.25, ... }
  config         JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active      BOOLEAN NOT NULL DEFAULT FALSE,
  released_at    timestamptz NOT NULL DEFAULT now(),
  retired_at     timestamptz
);

CREATE UNIQUE INDEX recommendation_model_versions_active_unique
  ON recommendation_model_versions (is_active) WHERE is_active;

-- Weight sanity: the engine refuses to run with weights that do not sum to 1.
ALTER TABLE recommendation_model_versions ADD CONSTRAINT recommendation_weights_sum_check
  CHECK (abs((weights->>'course')::numeric + (weights->>'skills')::numeric
            + (weights->>'goals')::numeric   + (weights->>'availability')::numeric
            + (weights->>'preferences')::numeric + (weights->>'topics')::numeric - 1) < 0.001);

-- =============================================================================
-- Recommendation requests â€” one row per generation call.
--
-- Storing the *request* (including any parsed natural-language intent) is what
-- lets us compare structured-input recommendations against AI-assisted ones.
-- =============================================================================

CREATE TABLE recommendation_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_uuid(),
  student_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               recommendation_kind NOT NULL,
  model_version_id   TEXT NOT NULL REFERENCES recommendation_model_versions(id),
  goal_id            uuid REFERENCES learning_goals(id) ON DELETE SET NULL,
  course_id          uuid REFERENCES courses(id) ON DELETE SET NULL,
  -- The structured requirement set. `source` distinguishes a student-filled
  -- form from an LLM-parsed natural-language request.
  requirements       JSONB NOT NULL DEFAULT '{}'::jsonb,
  source             TEXT NOT NULL DEFAULT 'FORM'
                     CHECK (source IN ('FORM', 'NATURAL_LANGUAGE', 'DASHBOARD', 'GROUP_PAGE', 'PROFILE_GAP')),
  natural_language   TEXT,
  parsed_intent      JSONB,
  parser_model       TEXT,
  parser_confidence  NUMERIC(4,3) CHECK (parser_confidence IS NULL OR parser_confidence BETWEEN 0 AND 1),
  candidate_pool_size INTEGER NOT NULL DEFAULT 0,
  result_count       INTEGER NOT NULL DEFAULT 0,
  latency_ms         INTEGER,
  degraded           BOOLEAN NOT NULL DEFAULT FALSE,  -- true when AI was unavailable
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recommendation_requests_student_idx ON recommendation_requests (student_id, created_at DESC);
CREATE INDEX recommendation_requests_created_idx ON recommendation_requests (created_at DESC);
CREATE INDEX recommendation_requests_kind_idx    ON recommendation_requests (kind, created_at DESC);

-- =============================================================================
-- Recommendation results â€” one row per (request, candidate).
--
-- `score_breakdown` keeps every individual factor, not just the total. This is
-- what powers the "Why am I seeing this?" panel and lets a research analysis
-- ask "did availability actually predict acceptance?".
-- =============================================================================

CREATE TABLE recommendations (
  id                   uuid PRIMARY KEY DEFAULT gen_uuid(),
  request_id           uuid NOT NULL REFERENCES recommendation_requests(id) ON DELETE CASCADE,
  student_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                 recommendation_kind NOT NULL,
  -- Exactly one target is set, enforced by the CHECK below.
  target_student_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  target_workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  rank                 SMALLINT NOT NULL,
  score                NUMERIC(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  score_breakdown      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Complementarity vs similarity are tracked separately because they are
  -- different phenomena, not two names for the same number.
  similarity_score     NUMERIC(5,2) CHECK (similarity_score IS NULL OR similarity_score BETWEEN 0 AND 100),
  complementarity_score NUMERIC(5,2) CHECK (complementarity_score IS NULL OR complementarity_score BETWEEN 0 AND 100),
  complementary_topics UUID[] NOT NULL DEFAULT '{}',
  overlapping_topics   UUID[] NOT NULL DEFAULT '{}',
  explanation          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ordered [{type, detail, weight}]
  confidence           NUMERIC(4,3) NOT NULL DEFAULT 1
                       CHECK (confidence BETWEEN 0 AND 1),
  shown_at             timestamptz,
  clicked_at           timestamptz,
  accepted_at          timestamptz,
  rejected_at          timestamptz,
  dismissed_reason     TEXT,

  CONSTRAINT recommendations_target_check CHECK (
    (kind = 'STUDENT' AND target_student_id IS NOT NULL AND target_workspace_id IS NULL) OR
    (kind = 'GROUP'   AND target_workspace_id IS NOT NULL AND target_student_id IS NULL)
  )
);

-- Analytics reads are always "this student's recommendations, most recently shown".
--
-- These are keyed on `shown_at`, which is the only per-recommendation timestamp that
-- exists. A recommendation has no `created_at` of its own: it is created inside a
-- `recommendation_requests` row, and "when was this asked for" is that row's
-- `created_at`. Reads that need the request time join the parent table, exactly as
-- `listRecent` and `recommendationDetail` do.
CREATE INDEX recommendations_student_shown_idx ON recommendations (student_id, shown_at DESC)
  WHERE shown_at IS NOT NULL;
CREATE INDEX recommendations_request_rank_idx    ON recommendations (request_id, rank);
CREATE INDEX recommendations_target_student_idx ON recommendations (target_student_id, shown_at DESC)
  WHERE target_student_id IS NOT NULL;
CREATE INDEX recommendations_target_group_idx   ON recommendations (target_workspace_id, shown_at DESC)
  WHERE target_workspace_id IS NOT NULL;
-- Funnel queries: how many were accepted out of how many were shown.
CREATE INDEX recommendations_outcome_idx
  ON recommendations (student_id, accepted_at, rejected_at)
  WHERE shown_at IS NOT NULL;

CREATE UNIQUE INDEX recommendations_request_student_target_unique
  ON recommendations (request_id, kind, COALESCE(target_student_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      COALESCE(target_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- =============================================================================
-- Per-recommendation feedback (thumbs up/down with an optional reason).
-- =============================================================================

CREATE TABLE recommendation_feedback (
  id               uuid PRIMARY KEY DEFAULT gen_uuid(),
  recommendation_id uuid NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  helpful          BOOLEAN,
  reason           TEXT CHECK (reason IS NULL OR reason IN
                    ('NOT_RELEVANT_COURSE', 'SCHEDULE_MISMATCH', 'GROUP_FULL',
                     'GOAL_MISMATCH', 'ALREADY_IN_GROUP', 'NOT_INTERESTED', 'OTHER')),
  comment          TEXT CHECK (comment IS NULL OR length(comment) <= 600),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recommendation_feedback_unique UNIQUE (recommendation_id)
);

CREATE INDEX recommendation_feedback_student_idx ON recommendation_feedback (student_id, created_at DESC);

-- =============================================================================
-- Group membership outcomes â€” needed to distinguish "accepted a
-- recommendation" from "actually stayed", which is a materially different
-- signal for evaluation.
-- =============================================================================

CREATE TABLE group_membership_outcomes (
  id            uuid PRIMARY KEY DEFAULT gen_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_via    TEXT NOT NULL,
  recommendation_id uuid REFERENCES recommendations(id) ON DELETE SET NULL,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  left_at       timestamptz,
  leave_reason  TEXT,
  sessions_attended SMALLINT NOT NULL DEFAULT 0,
  tasks_completed   SMALLINT NOT NULL DEFAULT 0,
  messages_sent     SMALLINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX group_membership_outcomes_unique
  ON group_membership_outcomes (workspace_id, student_id);
CREATE INDEX group_membership_outcomes_recommendation_idx
  ON group_membership_outcomes (recommendation_id)
  WHERE recommendation_id IS NOT NULL;
CREATE INDEX group_membership_outcomes_retention_idx
  ON group_membership_outcomes (joined_at, left_at);

-- =============================================================================
-- Daily aggregates. Pre-computing these keeps the research dashboards fast
-- enough to explore interactively instead of running raw aggregation queries
-- over the event tables on every page load.
-- =============================================================================

CREATE TABLE daily_metric_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_uuid(),
  snapshot_date  DATE NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'COURSE', 'UNIVERSITY', 'MODEL')),
  scope_id       TEXT NOT NULL DEFAULT '',
  model_version_id TEXT REFERENCES recommendation_model_versions(id) ON DELETE SET NULL,
  metrics        JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_metric_snapshots_unique UNIQUE (snapshot_date, scope, scope_id, model_version_id)
);

CREATE INDEX daily_metric_snapshots_lookup_idx ON daily_metric_snapshots (scope, scope_id, snapshot_date DESC);

-- =============================================================================
-- Refresh the aggregate view. Kept as a function so it can be called from the
-- app, a cron job, or manually during a study session.
-- =============================================================================

CREATE OR REPLACE FUNCTION refresh_daily_metrics() RETURNS void LANGUAGE sql AS $$
  -- The day a recommendation belongs to is the day its *request* was made, so this
  -- joins the parent table. `recommendations` deliberately has no `created_at`: it
  -- holds outcomes (shown, clicked, accepted), and the request row holds the timing.
  INSERT INTO daily_metric_snapshots (snapshot_date, scope, scope_id, metrics)
  SELECT
    (date_trunc('day', req.created_at))::date AS snapshot_date,
    'GLOBAL' AS scope,
    '' AS scope_id,
    jsonb_build_object(
      'recommendations_generated', count(*),
      'unique_students',           count(DISTINCT r.student_id),
      'accepted',                  count(*) FILTER (WHERE r.accepted_at IS NOT NULL),
      'rejected',                  count(*) FILTER (WHERE r.rejected_at IS NOT NULL),
      'clicked',                   count(*) FILTER (WHERE r.clicked_at IS NOT NULL),
      'shown',                     count(*) FILTER (WHERE r.shown_at IS NOT NULL),
      'mean_score',                round(avg(r.score), 2),
      'mean_complementarity',      round(avg(r.complementarity_score), 2),
      'ai_assisted_requests',      count(*) FILTER (WHERE req.source = 'NATURAL_LANGUAGE')
    ) AS metrics
    FROM recommendations r
    JOIN recommendation_requests req ON req.id = r.request_id
   WHERE req.created_at >= (CURRENT_DATE - INTERVAL '400 days')
   GROUP BY 1
  ON CONFLICT (snapshot_date, scope, scope_id, model_version_id)
  DO UPDATE SET metrics = EXCLUDED.metrics, computed_at = now();
$$;

-- =============================================================================
-- Analytics views.
--
-- Created here rather than in queries so that the definitions of every research
-- metric are in one auditable place. Each metric documents its formula in a
-- COMMENT so nobody has to guess how a number was produced.
-- =============================================================================

-- Recommendation funnel per model version.
CREATE VIEW v_recommendation_funnel AS
SELECT
  rr.model_version_id,
  date_trunc('day', rr.created_at)::date  AS day,
  r.kind,
  count(*)                              AS generated,
  count(*) FILTER (WHERE r.shown_at IS NOT NULL)     AS shown,
  count(*) FILTER (WHERE r.clicked_at IS NOT NULL)   AS clicked,
  count(*) FILTER (WHERE r.accepted_at IS NOT NULL)  AS accepted,
  count(*) FILTER (WHERE r.rejected_at IS NOT NULL)  AS rejected,
  -- Acceptance Rate = accepted / generated
  round(100.0 * count(*) FILTER (WHERE r.accepted_at IS NOT NULL) / NULLIF(count(*), 0), 2)
                                       AS acceptance_rate_pct,
  -- Click-through = clicked / shown
  round(100.0 * count(*) FILTER (WHERE r.clicked_at IS NOT NULL)
        / NULLIF(count(*) FILTER (WHERE r.shown_at IS NOT NULL), 0), 2) AS click_through_pct,
  round(avg(r.score)::numeric, 2)        AS mean_score,
  round(avg(r.complementarity_score)::numeric, 2) AS mean_complementarity
FROM recommendations r
JOIN recommendation_requests rr ON rr.id = r.request_id
GROUP BY 1, 2, 3;

COMMENT ON VIEW v_recommendation_funnel IS
  'Recommendation funnel by model version. acceptance_rate_pct = accepted / generated.';

-- Precision@K: of the top-K recommendations shown, how many were accepted.
CREATE VIEW v_precision_at_k AS
SELECT
  request_id,
  student_id,
  max(K) AS evaluated_at_k,
  -- Precision@K over the items the student actually saw.
  round(
    100.0 * count(*) FILTER (WHERE rank <= K AND accepted_at IS NOT NULL) / NULLIF(count(*), 0)
  , 2) AS precision_pct
FROM recommendations
CROSS JOIN generate_series(1, 10) AS K
WHERE shown_at IS NOT NULL
GROUP BY request_id, student_id;

-- Average compatibility rating, from real post-join feedback.
CREATE VIEW v_group_satisfaction AS
SELECT
  gf.workspace_id,
  w.group_id,
  count(*)                                                    AS responses,
  round(avg(gf.overall_rating)::numeric, 2)                   AS avg_overall,
  round(avg(gf.goals_compatible)::numeric, 2)                 AS avg_goals,
  round(avg(gf.skills_complementary)::numeric, 2)             AS avg_skills_complementary,
  round(avg(gf.schedule_worked)::numeric, 2)                  AS avg_schedule,
  round(avg(gf.productive)::numeric, 2)                       AS avg_productive,
  round((100.0 * count(*) FILTER (WHERE gf.would_repeat) / NULLIF(count(*), 0))::numeric, 2)
                                                               AS would_repeat_pct
FROM group_feedback gf
JOIN workspaces w ON w.id = gf.workspace_id
GROUP BY 1, 2;

-- Course-level engagement for lecturers. Strictly aggregate: no per-student
-- rows appear in this view, which is what allows it to be shown to lecturers.
CREATE VIEW v_course_engagement AS
SELECT
  c.id AS course_id,
  c.course_code,
  c.name AS course_name,
  count(DISTINCT sc.student_id)                                        AS enrolled_students,
  count(DISTINCT g.id)                                                 AS study_groups,
  count(DISTINCT g.id) FILTER (WHERE g.status = 'ACTIVE')              AS active_groups,
  -- Workspaces are joined rather than read off the membership row: a membership has
  -- no `workspace_id` column, and a group may own multiple active and archived
  -- workspaces, so counting through `workspaces` is the only way to be accurate.
  count(DISTINCT w.id)                                                 AS workspaces,
  count(DISTINCT s.student_id)                                         AS active_students
FROM courses c
LEFT JOIN student_courses sc    ON sc.course_id = c.id AND sc.is_active
LEFT JOIN study_groups g        ON g.course_id = c.id
LEFT JOIN study_group_members s ON s.group_id = g.id AND s.left_at IS NULL
LEFT JOIN workspaces w          ON w.group_id = g.id AND NOT w.is_archived
GROUP BY 1, 2, 3;

-- Session participation: attended / RSVP'd, per workspace.
CREATE VIEW v_session_participation AS
SELECT
  s.workspace_id,
  count(*)                                                        AS rsvp_total,
  count(*) FILTER (WHERE sp.attended)                             AS attended,
  count(*) FILTER (WHERE sp.rsvp = 'GOING')                       AS committed,
  -- Session Participation = attended / scheduled-and-RSVP'd
  round(100.0 * count(*) FILTER (WHERE sp.attended)
        / NULLIF(count(*) FILTER (WHERE sp.rsvp <> 'NOT_GOING'), 0), 2) AS participation_pct,
  round(avg(sp.attendance_minutes)::numeric, 1)                   AS avg_minutes
FROM study_sessions s
JOIN session_participants sp ON sp.session_id = s.id
WHERE s.status <> 'CANCELLED'
GROUP BY 1;

-- Task completion rate per workspace.
CREATE VIEW v_task_completion AS
SELECT
  workspace_id,
  count(*)                                                        AS total_tasks,
  count(*) FILTER (WHERE status = 'COMPLETED')                    AS completed,
  -- Task Completion Rate = completed / total created
  round(100.0 * count(*) FILTER (WHERE status = 'COMPLETED') / NULLIF(count(*), 0), 2)
                                                                       AS completion_rate_pct,
  count(*) FILTER (WHERE status = 'COMPLETED' AND completed_at <= due_at) AS completed_on_time
FROM tasks
GROUP BY 1;

-- Topic difficulty, derived from real quiz scores only.
CREATE VIEW v_topic_difficulty AS
SELECT
  t.id AS topic_id,
  t.course_id,
  t.name AS topic_name,
  count(q.id)                                                          AS attempts,
  -- Difficulty = 1 - mean score ratio. NULL when there is not enough data,
  -- because a difficulty derived from three attempts is not a measurement.
  CASE WHEN count(q.id) >= 5
       THEN round((1 - avg(q.score / q.max_score))::numeric, 3)
  END                                                                  AS difficulty_index,
  round(avg(q.score / q.max_score)::numeric, 3)                       AS mean_score_ratio
FROM course_topics t
LEFT JOIN quiz_attempts q ON q.topic_id = t.id
GROUP BY 1, 2, 3;

-- Group retention: what share of members are still active after 30 days.
CREATE VIEW v_group_retention AS
SELECT
  w.group_id,
  count(*)                                                          AS joined_total,
  count(*) FILTER (WHERE mo.left_at IS NULL)                        AS still_joined,
  count(*) FILTER (WHERE mo.left_at IS NOT NULL)                    AS left_group,
  -- Group Retention = still_joined / joined_total
  round(100.0 * count(*) FILTER (WHERE mo.left_at IS NULL) / NULLIF(count(*), 0), 2)
                                                                      AS retention_pct,
  round(avg(EXTRACT(EPOCH FROM (COALESCE(mo.left_at, now()) - mo.joined_at)) / 86400)::numeric, 1)
                                                                      AS avg_days_active
FROM group_membership_outcomes mo
JOIN workspaces w ON w.id = mo.workspace_id
GROUP BY 1;