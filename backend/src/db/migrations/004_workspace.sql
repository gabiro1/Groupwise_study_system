-- =============================================================================
-- Lien â€” 004_workspace.sql
-- Study plans, topics, tasks, sessions, resources, chat, progress.
-- All tables here are scoped to a workspace/group and every access is guarded
-- by the membership check performed server-side in the service layer.
-- =============================================================================

-- =============================================================================
-- Study plans â€” a time-boxed goal ("Final Exam Preparation") containing tasks,
-- sessions and topics.
-- =============================================================================

CREATE TABLE study_plans (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  goal_id      uuid REFERENCES learning_goals(id) ON DELETE SET NULL,
  description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  deadline     DATE,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'ABANDONED')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER study_plans_touch BEFORE UPDATE ON study_plans
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX study_plans_workspace_idx ON study_plans (workspace_id, status, created_at DESC);
CREATE INDEX study_plans_deadline_idx  ON study_plans (deadline) WHERE status = 'ACTIVE';

-- =============================================================================
-- Plan â†” topic coverage, plus the group's declared starting proficiency so the
-- UI can show honest "what we need to get through" information.
-- =============================================================================

CREATE TABLE study_plan_topics (
  plan_id            uuid NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  topic_id           uuid NOT NULL REFERENCES course_topics(id) ON DELETE CASCADE,
  target_proficiency SMALLINT NOT NULL DEFAULT 3 CHECK (target_proficiency BETWEEN 1 AND 4),
  position           SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, topic_id)
);

CREATE INDEX study_plan_topics_topic_idx ON study_plan_topics (topic_id, plan_id);

-- =============================================================================
-- Group-level topic status.
--
-- Derived from members' self-assessments but stored so that progress reads are
-- a single query and so that a group can explicitly mark a topic as covered by
-- a session that actually happened.
-- =============================================================================

CREATE TABLE group_topic_progress (
  id            uuid PRIMARY KEY DEFAULT gen_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic_id      uuid NOT NULL REFERENCES course_topics(id) ON DELETE CASCADE,
  status        topic_status NOT NULL DEFAULT 'LEARNING',
  confidence    NUMERIC(3,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  source        TEXT NOT NULL DEFAULT 'AUTO'
                CHECK (source IN ('AUTO', 'MANUAL', 'ASSESSMENT')),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_topic_progress_unique UNIQUE (workspace_id, topic_id)
);

CREATE INDEX group_topic_progress_workspace_idx ON group_topic_progress (workspace_id, status);

-- =============================================================================
-- Tasks
--
-- Deliberately lightweight: title, owner, status, due date. No subtasks, no
-- dependencies, no custom fields. A study group task is not a sprint ticket.
-- =============================================================================

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id      uuid REFERENCES study_plans(id) ON DELETE SET NULL,
  topic_id     uuid REFERENCES course_topics(id) ON DELETE SET NULL,
  title        TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 160),
  description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  assignee_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  priority     task_priority NOT NULL DEFAULT 'MEDIUM',
  status       task_status NOT NULL DEFAULT 'TODO',
  due_at       timestamptz,
  estimate_minutes SMALLINT CHECK (estimate_minutes IS NULL OR estimate_minutes BETWEEN 5 AND 600),
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Stamps `completed_at` on the transition into COMPLETED and clears it again if
-- the task is reopened. Two BEFORE triggers fire in name order, so `tasks_completed_at`
-- runs before `tasks_touch` and both see the same NEW row.
CREATE OR REPLACE FUNCTION tasks_stamp_completed_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'COMPLETED' THEN
    -- Preserve the original completion time if it is already set, so re-saving a
    -- completed task does not reset the date and distort "completed on" analytics.
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_completed_at BEFORE UPDATE ON tasks
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION tasks_stamp_completed_at();

-- The workspace task board: one query, ordered by status then due date.
CREATE INDEX tasks_workspace_status_idx ON tasks (workspace_id, status, due_at NULLS LAST);
CREATE INDEX tasks_assignee_idx        ON tasks (assignee_id, status, due_at NULLS LAST) WHERE status <> 'COMPLETED';
CREATE INDEX tasks_plan_idx            ON tasks (plan_id, status) WHERE plan_id IS NOT NULL;
CREATE INDEX tasks_overdue_idx         ON tasks (workspace_id, due_at) WHERE status <> 'COMPLETED' AND due_at IS NOT NULL;

CREATE TABLE task_comments (
  id         uuid PRIMARY KEY DEFAULT gen_uuid(),
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER task_comments_touch BEFORE UPDATE ON task_comments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX task_comments_task_idx ON task_comments (task_id, created_at);

-- =============================================================================
-- Study sessions
-- =============================================================================

CREATE TABLE study_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id      uuid REFERENCES study_plans(id) ON DELETE SET NULL,
  topic_id     uuid REFERENCES course_topics(id) ON DELETE SET NULL,
  title        TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 140),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  mode         session_mode NOT NULL DEFAULT 'ONLINE',
  location     TEXT,
  meeting_url  TEXT,
  agenda       TEXT NOT NULL DEFAULT '' CHECK (length(agenda) <= 2000),
  status       session_status NOT NULL DEFAULT 'SCHEDULED',
  attendance_tracked BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT study_sessions_valid_window CHECK (ends_at > starts_at),
  CONSTRAINT study_sessions_duration CHECK (ends_at - starts_at <= interval '12 hours')
);

CREATE TRIGGER study_sessions_touch BEFORE UPDATE ON study_sessions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX study_sessions_upcoming_idx ON study_sessions (workspace_id, starts_at)
  WHERE status = 'SCHEDULED';
CREATE INDEX study_sessions_recent_idx   ON study_sessions (workspace_id, starts_at DESC);
-- Global "what am I doing next" across every group a student belongs to.
CREATE INDEX study_sessions_starts_at_idx ON study_sessions (starts_at) WHERE status = 'SCHEDULED';

-- Reject overlapping sessions in the same workspace at the database level. A
-- race between two members confirming the same slot would otherwise be possible.
CREATE OR REPLACE FUNCTION study_sessions_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM study_sessions s
     WHERE s.workspace_id = NEW.workspace_id
       AND s.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND s.status <> 'CANCELLED'
       AND tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'SESSION_OVERLAP'
      USING HINT = 'Another session already occupies part of that time slot.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER study_sessions_no_overlap
  BEFORE INSERT OR UPDATE ON study_sessions
  FOR EACH ROW EXECUTE FUNCTION study_sessions_no_overlap();

CREATE TABLE session_participants (
  session_id        uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rsvp              rsvp_status NOT NULL DEFAULT 'GOING',
  attended          BOOLEAN,
  attendance_minutes SMALLINT CHECK (attendance_minutes IS NULL OR attendance_minutes BETWEEN 0 AND 720),
  responded_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, student_id)
);

CREATE INDEX session_participants_student_idx ON session_participants (student_id, rsvp);

-- =============================================================================
-- Resources
--
-- `storage_key` is an opaque server-generated path. The raw filename is kept
-- separately for display and sanitised on output. Files are never served from a
-- public path: downloads go through an authorising endpoint.
-- =============================================================================

CREATE TABLE resources (
  id             uuid PRIMARY KEY DEFAULT gen_uuid(),
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  course_id      uuid REFERENCES courses(id) ON DELETE CASCADE,
  plan_id        uuid REFERENCES study_plans(id) ON DELETE SET NULL,
  topic_id       uuid REFERENCES course_topics(id) ON DELETE SET NULL,
  uploaded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Lecturer-authored course material belongs to the course, not to a group.
  uploaded_by_role user_role NOT NULL DEFAULT 'STUDENT',
  title          TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description    TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  kind           resource_kind NOT NULL,
  visibility     resource_visibility NOT NULL DEFAULT 'GROUP',
  original_filename TEXT,
  storage_key    TEXT,
  mime_type      TEXT,
  size_bytes     BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum       TEXT,
  external_url   TEXT,
  -- Extracted plain text used by the RAG pipeline. Stored once, chunked below.
  extracted_text TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (extraction_status IN ('PENDING', 'PROCESSING', 'COMPLETE', 'SKIPPED', 'FAILED')),
  is_deleted     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Exactly one source must be present, which prevents half-created resources.
  CONSTRAINT resources_source_present CHECK (
    (kind = 'LINK'  AND external_url IS NOT NULL) OR
    (kind = 'NOTE'  AND length(btrim(extracted_text)) > 0) OR
    (kind = 'FILE'  AND storage_key IS NOT NULL)
  ),
  CONSTRAINT resources_scope_present CHECK (workspace_id IS NOT NULL OR course_id IS NOT NULL)
);

CREATE TRIGGER resources_touch BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX resources_workspace_idx ON resources (workspace_id, created_at DESC) WHERE NOT is_deleted;
CREATE INDEX resources_course_idx    ON resources (course_id, created_at DESC) WHERE NOT is_deleted;
CREATE INDEX resources_plan_idx      ON resources (plan_id) WHERE plan_id IS NOT NULL AND NOT is_deleted;
CREATE INDEX resources_uploaded_idx  ON resources (uploaded_by, created_at DESC) WHERE NOT is_deleted;
CREATE INDEX resources_ai_pending_idx ON resources (id) WHERE extraction_status = 'PENDING' AND NOT is_deleted;

-- =============================================================================
-- Resource chunks for retrieval-augmented generation.
--
-- `embedding` is a plain REAL[] rather than a pgvector column so the schema
-- works on any Postgres instance. Cosine similarity over a bounded, index-
-- filtered candidate set is computed in JS; see services/ai/retrieval.js.
-- The document is tsvector-indexed for exact-phrase fallback when embeddings
-- are unavailable (AI provider down / not configured).
-- =============================================================================

CREATE TABLE resource_chunks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  course_id   uuid REFERENCES courses(id) ON DELETE CASCADE,
  chunk_index SMALLINT NOT NULL,
  heading     TEXT,
  page_number SMALLINT,
  content     TEXT NOT NULL CHECK (length(content) > 0),
  token_estimate SMALLINT,
  embedding   REAL[],
  embedding_model TEXT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_chunks_unique UNIQUE (resource_id, chunk_index)
);

CREATE INDEX resource_chunks_resource_idx ON resource_chunks (resource_id, chunk_index);
CREATE INDEX resource_chunks_workspace_idx ON resource_chunks (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX resource_chunks_course_idx   ON resource_chunks (course_id)   WHERE course_id   IS NOT NULL;

ALTER TABLE resource_chunks ADD COLUMN search_document tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX resource_chunks_search_idx ON resource_chunks USING GIN (search_document);

-- =============================================================================
-- Chat
--
-- Messages are private to the workspace. There is deliberately no join to
-- `users` that would let a lecturer query private group conversations: the
-- permission model is workspace membership only.
-- =============================================================================

CREATE TABLE messages (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_id    uuid REFERENCES messages(id) ON DELETE CASCADE,
  kind         message_kind NOT NULL DEFAULT 'TEXT',
  body         TEXT NOT NULL DEFAULT '',
  resource_id  uuid REFERENCES resources(id) ON DELETE SET NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- AI provenance: lets the UI label an answer honestly and lets researchers
  -- exclude model output from human-participation metrics.
  ai_model     TEXT,
  ai_sources   JSONB,
  edited_at    timestamptz,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messages_body_or_attachment CHECK (
    kind = 'RESOURCE' OR length(btrim(body)) > 0 OR resource_id IS NOT NULL
  ),
  CONSTRAINT messages_not_self_replied CHECK (parent_id IS DISTINCT FROM id)
);

-- Cursor pagination is (created_at, id); this composite index serves it exactly.
CREATE INDEX messages_workspace_cursor_idx ON messages (workspace_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX messages_parent_idx ON messages (parent_id) WHERE parent_id IS NOT NULL;

-- =============================================================================
-- Progress
--
-- Progress is recorded from real, observable activity (a task was completed, a
-- session was attended, a quiz was scored). There is no synthetic
-- "productivity" percentage anywhere in this schema.
-- =============================================================================

CREATE TABLE quiz_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  topic_id     uuid REFERENCES course_topics(id) ON DELETE SET NULL,
  course_id    uuid REFERENCES courses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 140),
  score        NUMERIC(6,2) NOT NULL CHECK (score >= 0),
  max_score    NUMERIC(6,2) NOT NULL CHECK (max_score > 0),
  questions    SMALLINT CHECK (questions IS NULL OR questions > 0),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quiz_attempts_score_ratio CHECK (score <= max_score)
);

CREATE INDEX quiz_attempts_student_idx  ON quiz_attempts (student_id, attempted_at DESC);
CREATE INDEX quiz_attempts_topic_idx    ON quiz_attempts (topic_id, attempted_at DESC) WHERE topic_id IS NOT NULL;
CREATE INDEX quiz_attempts_workspace_idx ON quiz_attempts (workspace_id, attempted_at DESC) WHERE workspace_id IS NOT NULL;

-- Per-student, per-workspace topic mastery. Updated from quiz results or an
-- explicit self-assessment; the derivation rule lives in the service layer.
CREATE TABLE student_topic_mastery (
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic_id     uuid NOT NULL REFERENCES course_topics(id) ON DELETE CASCADE,
  mastery      NUMERIC(3,2) NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 1),
  attempts     SMALLINT NOT NULL DEFAULT 0,
  last_seen_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, workspace_id, topic_id)
);

CREATE INDEX student_topic_mastery_workspace_idx ON student_topic_mastery (workspace_id, topic_id);

-- =============================================================================
-- Feedback â€” closes the recommendation loop.
-- =============================================================================

CREATE TABLE group_feedback (
  id                  uuid PRIMARY KEY DEFAULT gen_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  student_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goals_compatible    SMALLINT NOT NULL CHECK (goals_compatible BETWEEN 1 AND 5),
  skills_complementary SMALLINT NOT NULL CHECK (skills_complementary BETWEEN 1 AND 5),
  schedule_worked     SMALLINT NOT NULL CHECK (schedule_worked BETWEEN 1 AND 5),
  productive          SMALLINT NOT NULL CHECK (productive BETWEEN 1 AND 5),
  would_repeat        BOOLEAN,
  overall_rating      SMALLINT NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  comment             TEXT CHECK (comment IS NULL OR length(comment) <= 1500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_feedback_unique UNIQUE (workspace_id, student_id)
);

CREATE INDEX group_feedback_workspace_idx ON group_feedback (workspace_id, created_at DESC);
CREATE INDEX group_feedback_student_idx   ON group_feedback (student_id, created_at DESC);