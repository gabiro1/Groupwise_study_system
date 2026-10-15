-- =============================================================================
-- Study sessions — structured collaboration
--
-- Extends the existing `study_sessions`/`session_participants` model with a
-- guided/flexible format, a server-authoritative timer, agenda activities,
-- temporary study roles (Teacher / Questioner / Timer), shared notes, a
-- question queue, preparation checklists and learning reflections.
--
-- The timer never lives only in the browser: an activity is started and paused
-- server-side, and any client can reconstruct the remaining time from the
-- persisted start/pause timestamps plus accumulated elapsed seconds.
--
-- Session chat reuses the existing `messages` storage but scoped to a session
-- (messages.session_id) instead of a workspace, so nothing in the existing
-- workspace chat changes. A cross-scope CHECK keeps each message in exactly one
-- conversation.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- New vocabulary
-- ---------------------------------------------------------------------------

CREATE TYPE session_format       AS ENUM ('GUIDED', 'FLEXIBLE');
CREATE TYPE study_role           AS ENUM ('TEACHER', 'QUESTIONER', 'TIMER');
CREATE TYPE question_status      AS ENUM ('OPEN', 'ANSWERED', 'NEEDS_VERIFICATION', 'RESOLVED');
CREATE TYPE prep_status          AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'READY');
CREATE TYPE session_activity_kind AS ENUM (
  'INTRO', 'TEACH', 'QUESTIONS', 'EXERCISE', 'DISCUSSION', 'BREAK', 'REVIEW', 'WRAP_UP'
);

-- ---------------------------------------------------------------------------
-- Agenda activities — the ordered items a timer runs through.
-- ---------------------------------------------------------------------------

CREATE TABLE session_activities (
  id             uuid PRIMARY KEY DEFAULT gen_uuid(),
  session_id     uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  title          TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  kind           session_activity_kind NOT NULL DEFAULT 'INTRO',
  position       SMALLINT NOT NULL DEFAULT 0,
  planned_minutes SMALLINT CHECK (planned_minutes IS NULL OR planned_minutes BETWEEN 1 AND 240),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER session_activities_touch BEFORE UPDATE ON session_activities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX session_activities_session_idx ON session_activities (session_id, position);

-- ---------------------------------------------------------------------------
-- Extend study_sessions with the collaboration/format columns.
-- ---------------------------------------------------------------------------

ALTER TABLE study_sessions
  ADD COLUMN format               session_format NOT NULL DEFAULT 'FLEXIBLE',
  ADD COLUMN main_topic           TEXT CHECK (main_topic IS NULL OR length(btrim(main_topic)) BETWEEN 1 AND 200),
  ADD COLUMN objectives           TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN preparation          JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN focus_interval_minutes SMALLINT NOT NULL DEFAULT 50
                     CHECK (focus_interval_minutes BETWEEN 10 AND 180),
  ADD COLUMN break_minutes        SMALLINT NOT NULL DEFAULT 5
                     CHECK (break_minutes BETWEEN 0 AND 60),
  ADD COLUMN started_at           timestamptz,
  ADD COLUMN paused_at            timestamptz,
  ADD COLUMN completed_at         timestamptz,
  ADD COLUMN active_activity_id   uuid,
  ADD COLUMN activity_started_at  timestamptz,
  ADD COLUMN activity_paused_at   timestamptz,
  ADD COLUMN activity_elapsed_seconds INTEGER NOT NULL DEFAULT 0 CHECK (activity_elapsed_seconds >= 0),
  ADD COLUMN meeting_room         TEXT;

-- The active activity must belong to the same session.
ALTER TABLE study_sessions ADD CONSTRAINT study_sessions_activity_scope
  FOREIGN KEY (active_activity_id) REFERENCES session_activities(id)
  ON DELETE SET NULL;

CREATE INDEX study_sessions_my_idx ON study_sessions (status, starts_at) WHERE status IN ('SCHEDULED', 'ACTIVE');

-- ---------------------------------------------------------------------------
-- Temporary study roles. Exactly one holder per role per round.
-- ---------------------------------------------------------------------------

CREATE TABLE session_roles (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  session_id   uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  round_number SMALLINT NOT NULL DEFAULT 1 CHECK (round_number BETWEEN 1 AND 99),
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         study_role NOT NULL,
  source       TEXT NOT NULL DEFAULT 'ROTATION' CHECK (source IN ('ROTATION', 'MANUAL')),
  assigned_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX session_roles_round_unique ON session_roles (session_id, round_number, role);
CREATE INDEX session_roles_member_idx ON session_roles (student_id, session_id);

-- ---------------------------------------------------------------------------
-- Question queue with a shared answer/response history.
-- ---------------------------------------------------------------------------

CREATE TABLE session_questions (
  id          uuid PRIMARY KEY DEFAULT gen_uuid(),
  session_id  uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  topic       TEXT CHECK (topic IS NULL OR length(btrim(topic)) BETWEEN 1 AND 160),
  body        TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  status      question_status NOT NULL DEFAULT 'OPEN',
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER session_questions_touch BEFORE UPDATE ON session_questions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Stamp resolved_at on the transition into RESOLVED and clear it on reopen.
CREATE OR REPLACE FUNCTION session_questions_stamp_resolved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'RESOLVED' THEN
    NEW.resolved_at := COALESCE(NEW.resolved_at, now());
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_questions_resolved BEFORE UPDATE ON session_questions
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION session_questions_stamp_resolved();

CREATE INDEX session_questions_session_idx ON session_questions (session_id, created_at);

CREATE TABLE session_question_responses (
  id          uuid PRIMARY KEY DEFAULT gen_uuid(),
  question_id uuid NOT NULL REFERENCES session_questions(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_question_responses_question_idx ON session_question_responses (question_id, created_at);

-- ---------------------------------------------------------------------------
-- Shared notes with optimistic concurrency (updated via `version`).
-- ---------------------------------------------------------------------------

CREATE TABLE session_notes (
  id         uuid PRIMARY KEY DEFAULT gen_uuid(),
  session_id uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  title      TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body       TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 20_000),
  version    INTEGER NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER session_notes_touch BEFORE UPDATE ON session_notes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX session_notes_session_idx ON session_notes (session_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Preparation checklists and learning reflections (self-reported).
-- ---------------------------------------------------------------------------

CREATE TABLE session_prep (
  session_id uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     prep_status NOT NULL DEFAULT 'NOT_STARTED',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, student_id)
);

CREATE TABLE session_reflections (
  id            uuid PRIMARY KEY DEFAULT gen_uuid(),
  session_id    uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  learned       TEXT CHECK (learned IS NULL OR length(learned) <= 2000),
  unclear       TEXT CHECK (unclear IS NULL OR length(unclear) <= 2000),
  review        TEXT CHECK (review IS NULL OR length(review) <= 2000),
  understanding SMALLINT CHECK (understanding IS NULL OR understanding BETWEEN 1 AND 5),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_reflections_unique UNIQUE (session_id, student_id)
);

CREATE INDEX session_reflections_session_idx ON session_reflections (session_id, created_at);

-- ---------------------------------------------------------------------------
-- Session chat — reuses `messages`, scoped by session_id.
-- ---------------------------------------------------------------------------

ALTER TABLE messages
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE messages
  ADD COLUMN session_id uuid REFERENCES study_sessions(id) ON DELETE CASCADE,
  ADD COLUMN client_id  TEXT;

-- A message lives in exactly one scope: the workspace chat or a study session.
ALTER TABLE messages ADD CONSTRAINT messages_scope_exclusive CHECK (
  (workspace_id IS NOT NULL) <> (session_id IS NOT NULL)
);

CREATE INDEX messages_session_cursor_idx ON messages (session_id, created_at DESC, id DESC)
  WHERE session_id IS NOT NULL AND deleted_at IS NULL;

-- Duplicate-send protection, mirroring the direct-message pattern.
CREATE UNIQUE INDEX messages_session_idempotency ON messages (session_id, client_id)
  WHERE session_id IS NOT NULL AND client_id IS NOT NULL;