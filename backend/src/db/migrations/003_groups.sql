-- =============================================================================
-- Lien â€” 003_groups.sql
-- Study groups, membership, invitations, join requests, workspaces.
-- =============================================================================

-- =============================================================================
-- Study groups â€” "who studies together".
--
-- A group is intentionally *not* the same row as its workspace. The group is
-- the social/pedagogical entity (members, goal, topics, schedule); the
-- workspace is the collaborative environment that belongs to it. Keeping them
-- separate means the group identity survives an archive/rebuild of a workspace
-- and lets one group later host multiple workspaces (e.g. per semester).
-- =============================================================================

CREATE TABLE study_groups (
  id              uuid PRIMARY KEY DEFAULT gen_uuid(),
  slug            citext NOT NULL UNIQUE,
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 3 AND 80),
  course_id       uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  goal_id         uuid REFERENCES learning_goals(id) ON DELETE SET NULL,
  description     TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1500),

  mode            study_mode NOT NULL DEFAULT 'EITHER',
  privacy         group_privacy NOT NULL DEFAULT 'REQUEST_REQUIRED',
  status          group_status NOT NULL DEFAULT 'ACTIVE',
  require_approval BOOLEAN NOT NULL DEFAULT TRUE,

  min_size        SMALLINT NOT NULL DEFAULT 3 CHECK (min_size BETWEEN 2 AND 12),
  max_size        SMALLINT NOT NULL DEFAULT 8 CHECK (max_size BETWEEN 2 AND 20),
  target_size     SMALLINT CHECK (target_size IS NULL OR target_size BETWEEN 2 AND 20),

  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by_role user_role NOT NULL DEFAULT 'STUDENT',

  location_hint   TEXT,
  language        TEXT NOT NULL DEFAULT 'en',

  -- Denormalised counters maintained by triggers; kept in sync inside the same
  -- transaction as membership changes so the UI never shows a stale count.
  member_count    SMALLINT NOT NULL DEFAULT 1,
  activity_score  NUMERIC(5,4) NOT NULL DEFAULT 0,

  started_at      timestamptz,
  completed_at    timestamptz,
  archived_at     timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT study_groups_size_order CHECK (max_size >= min_size),
  CONSTRAINT study_groups_lecturer_created CHECK (created_by_role <> 'LECTURER' OR owner_id IS NOT NULL)
);

CREATE TRIGGER study_groups_touch BEFORE UPDATE ON study_groups
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX study_groups_course_status_idx ON study_groups (course_id, status, member_count DESC);
CREATE INDEX study_groups_goal_idx           ON study_groups (goal_id, status);
CREATE INDEX study_groups_owner_idx          ON study_groups (owner_id, status);
CREATE INDEX study_groups_open_idx
  ON study_groups (course_id, created_at DESC)
  WHERE status = 'ACTIVE' AND privacy IN ('PUBLIC', 'REQUEST_REQUIRED');
CREATE INDEX study_groups_activity_idx ON study_groups (activity_score DESC, created_at DESC)
  WHERE status = 'ACTIVE';
CREATE INDEX study_groups_size_open_idx ON study_groups (course_id, (max_size - member_count))
  WHERE status = 'ACTIVE' AND member_count < max_size;

-- Trigram + full-text search for the "Find Study Groups" screen.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE study_groups ADD COLUMN search_document tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX study_groups_search_idx    ON study_groups USING GIN (search_document);
CREATE INDEX study_groups_name_trgm_idx ON study_groups USING GIN (name gin_trgm_ops);

-- =============================================================================
-- Group â†” Topic focus.
--
-- `focus_weight` is how much this topic drives the group (1 = passing interest,
-- 5 = the entire reason the group exists). Used for both search filtering and
-- the "what is this group weak at" analysis.
-- =============================================================================

CREATE TABLE study_group_topics (
  group_id     uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  topic_id     uuid NOT NULL REFERENCES course_topics(id) ON DELETE CASCADE,
  focus_weight SMALLINT NOT NULL DEFAULT 3 CHECK (focus_weight BETWEEN 1 AND 5),
  PRIMARY KEY (group_id, topic_id)
);

CREATE INDEX study_group_topics_topic_idx ON study_group_topics (topic_id, group_id);
CREATE INDEX study_group_topics_group_idx ON study_group_topics (group_id, focus_weight DESC);

-- =============================================================================
-- Recurring weekly group schedule. Same minute-offset design as student
-- availability so overlap is integer arithmetic.
-- =============================================================================

CREATE TABLE study_group_schedule (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  group_id     uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_minute SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   SMALLINT NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  is_primary   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_schedule_valid_range CHECK (end_minute > start_minute)
);

CREATE INDEX study_group_schedule_lookup_idx ON study_group_schedule (group_id, day_of_week, start_minute);

-- =============================================================================
-- Membership
-- =============================================================================

CREATE TABLE study_group_members (
  id             uuid PRIMARY KEY DEFAULT gen_uuid(),
  group_id       uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           group_member_role NOT NULL DEFAULT 'MEMBER',
  status         user_status NOT NULL DEFAULT 'ACTIVE',
  joined_via     TEXT NOT NULL DEFAULT 'DIRECT'
                 CHECK (joined_via IN ('DIRECT', 'INVITATION', 'JOIN_REQUEST', 'LECTURER_ASSIGNED', 'AI_ASSISTED')),
  contribution_score NUMERIC(6,4) NOT NULL DEFAULT 0,
  joined_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  CONSTRAINT study_group_members_unique UNIQUE (group_id, student_id)
);

-- "My active groups" is the single most frequent query in the product.
CREATE INDEX study_group_members_student_idx
  ON study_group_members (student_id, joined_at DESC) WHERE left_at IS NULL;
CREATE INDEX study_group_members_group_idx
  ON study_group_members (group_id, role, joined_at);
-- Powers group-level skill coverage: who knows which topics.
CREATE INDEX study_group_members_active_idx
  ON study_group_members (group_id) WHERE left_at IS NULL;

-- Keep `study_groups.member_count` honest. A statement trigger is enough and
-- avoids the double-counting bug a naive row trigger would introduce.
CREATE OR REPLACE FUNCTION study_groups_sync_member_count() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_group uuid;
BEGIN
  affected_group := COALESCE(NEW.group_id, OLD.group_id);
  UPDATE study_groups
     SET member_count = (
           SELECT count(*)::smallint FROM study_group_members
            WHERE group_id = affected_group AND left_at IS NULL AND status = 'ACTIVE'
         )
   WHERE id = affected_group;
  RETURN NULL;
END;
$$;

CREATE TRIGGER study_group_members_count
  AFTER INSERT OR UPDATE OR DELETE ON study_group_members
  FOR EACH ROW EXECUTE FUNCTION study_groups_sync_member_count();

-- A group must always retain at least one owner; enforced in the service layer
-- with an explicit check so the error message can be meaningful.
-- =============================================================================
-- Invitations
-- =============================================================================

CREATE TABLE study_group_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_uuid(),
  group_id    uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  inviter_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      invitation_status NOT NULL DEFAULT 'PENDING',
  message     TEXT CHECK (message IS NULL OR length(message) <= 500),
  -- The compatibility snapshot at invite time is research data: it lets us ask
  -- "were low-scored invites more or less likely to be accepted?".
  compatibility_score NUMERIC(5,2),
  compatibility_note  TEXT,
  expires_at  timestamptz NOT NULL,
  responded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT study_group_invitations_no_self_invite CHECK (inviter_id <> invitee_id)
);

CREATE TRIGGER study_group_invitations_touch BEFORE UPDATE ON study_group_invitations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- At most one live invitation per (group, invitee). This partial unique index
-- is the only reliable way to prevent duplicate invites under concurrency.
CREATE UNIQUE INDEX study_group_invitations_pending_unique
  ON study_group_invitations (group_id, invitee_id) WHERE status = 'PENDING';
CREATE INDEX study_group_invitations_invitee_idx
  ON study_group_invitations (invitee_id, created_at DESC);
CREATE INDEX study_group_invitations_group_idx
  ON study_group_invitations (group_id, created_at DESC);
CREATE INDEX study_group_invitations_expiry_idx
  ON study_group_invitations (expires_at) WHERE status = 'PENDING';

-- =============================================================================
-- Join requests
-- =============================================================================

CREATE TABLE study_group_join_requests (
  id            uuid PRIMARY KEY DEFAULT gen_uuid(),
  group_id      uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        join_request_status NOT NULL DEFAULT 'PENDING',
  message       TEXT CHECK (message IS NULL OR length(message) <= 500),
  compatibility_score NUMERIC(5,2),
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  decision_note TEXT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER study_group_join_requests_touch BEFORE UPDATE ON study_group_join_requests
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE UNIQUE INDEX study_group_join_requests_pending_unique
  ON study_group_join_requests (group_id, student_id) WHERE status = 'PENDING';
CREATE INDEX study_group_join_requests_student_idx
  ON study_group_join_requests (student_id, created_at DESC);
CREATE INDEX study_group_join_requests_group_idx
  ON study_group_join_requests (group_id, created_at DESC)
  WHERE status = 'PENDING';

-- =============================================================================
-- Workspaces â€” "where the group collaborates digitally".
--
-- This migration starts with one active workspace per group. Migration 008
-- relaxes the constraint so groups can create additional shared workspaces.
-- =============================================================================

CREATE TABLE workspaces (
  id             uuid PRIMARY KEY DEFAULT gen_uuid(),
  group_id       uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  is_archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz
);

CREATE UNIQUE INDEX workspaces_active_group_unique
  ON workspaces (group_id) WHERE NOT is_archived;
CREATE INDEX workspaces_group_idx ON workspaces (group_id, is_archived);

-- Auto-create the workspace whenever a group is created, so no code path can
-- produce a group without somewhere to work.
CREATE OR REPLACE FUNCTION create_workspace_for_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspaces (group_id, name, created_by)
  VALUES (NEW.id, NEW.name || ' â€” Study Workspace', NEW.owner_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER study_groups_create_workspace
  AFTER INSERT ON study_groups
  FOR EACH ROW EXECUTE FUNCTION create_workspace_for_group();

-- =============================================================================
-- Group activity events â€” a cheap, append-only feed that powers the activity
-- score, the dashboard "recent activity" list and the admin/lecturer views.
-- =============================================================================

CREATE TABLE group_activity_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id     uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type   TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    uuid,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX group_activity_events_group_idx ON group_activity_events (group_id, created_at DESC);
CREATE INDEX group_activity_events_type_idx  ON group_activity_events (event_type, created_at DESC);