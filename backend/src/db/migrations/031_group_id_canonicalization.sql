-- =============================================================================
-- TWIGANE - 031_group_id_canonicalization.sql
-- Phase 2: canonical group ownership for legacy workspace-owned records.
--
-- `group_id` is the canonical scope for group content and activity. Legacy
-- workspace columns, tables, indexes, and workspace write paths remain during
-- the compatibility window, but they are nullable and are never required for a
-- new group-only write.
--
-- `workspaces.group_id` is the canonical primary group for an existing
-- workspace. A workspace may still have secondary rows in `workspace_groups`;
-- those rows are not used to guess ownership for old records because one
-- canonical group_id cannot represent more than one possible owner. The primary
-- mapping is checked explicitly before any backfill.
--
-- This migration is forward-only. Existing data is preserved: ambiguous
-- mappings, scope mismatches, and canonical uniqueness collisions fail the
-- migration rather than silently deleting or choosing a row. `workspace_id`
-- and the legacy tables remain in place for the compatibility window.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Add the canonical columns without changing the legacy columns yet.
-- -----------------------------------------------------------------------------
ALTER TABLE study_plans
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE group_topic_progress
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE study_sessions
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE resource_chunks
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE quiz_attempts
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE student_topic_mastery
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE group_feedback
  ADD COLUMN IF NOT EXISTS group_id uuid;

ALTER TABLE group_membership_outcomes
  ADD COLUMN IF NOT EXISTS group_id uuid;

-- Migration 026 normally introduced this column. Keep the guard so this
-- migration can still run against a database with a partially converged history.
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS target_group_id uuid;

-- -----------------------------------------------------------------------------
-- 2. Resolution helpers and compatibility trigger functions.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION phase2_resolve_workspace_group(
  p_workspace_id uuid,
  p_context text
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  resolved_group uuid;
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT w.group_id
    INTO resolved_group
    FROM workspaces w
    JOIN study_groups g ON g.id = w.group_id
   WHERE w.id = p_workspace_id;

  IF NOT FOUND OR resolved_group IS NULL THEN
    RAISE EXCEPTION
      'GROUP_ID_RESOLUTION_FAILED: % references workspace % without a known primary group',
      p_context, p_workspace_id
      USING ERRCODE = '23514';
  END IF;

  RETURN resolved_group;
END;
$$;

CREATE OR REPLACE FUNCTION phase2_require_known_group(
  p_group_id uuid,
  p_context text
) RETURNS uuid
LANGUAGE plpgsql AS $$
BEGIN
  IF p_group_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM study_groups WHERE id = p_group_id) THEN
    RAISE EXCEPTION
      'GROUP_ID_RESOLUTION_FAILED: % references unknown group %',
      p_context, p_group_id
      USING ERRCODE = '23514';
  END IF;

  RETURN p_group_id;
END;
$$;

-- Group-only is the canonical write shape. A legacy workspace can still supply
-- the group, but an explicit group is always validated and may not disagree.
CREATE OR REPLACE FUNCTION phase2_sync_workspace_group_id() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  workspace_group uuid;
BEGIN
  IF NEW.group_id IS NOT NULL THEN
    NEW.group_id := phase2_require_known_group(NEW.group_id, TG_TABLE_NAME);
  END IF;

  -- A group-only row is valid. The group foreign key and table-specific
  -- nullability checks reject an actually unscoped row after this trigger.
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  workspace_group := phase2_resolve_workspace_group(NEW.workspace_id, TG_TABLE_NAME);

  IF NEW.group_id IS NOT NULL AND NEW.group_id IS DISTINCT FROM workspace_group THEN
    RAISE EXCEPTION
      'GROUP_ID_SCOPE_CONFLICT: % workspace % resolves to group %, not %',
      TG_TABLE_NAME, NEW.workspace_id, workspace_group, NEW.group_id
      USING ERRCODE = '23514';
  END IF;

  NEW.group_id := workspace_group;
  RETURN NEW;
END;
$$;

-- Messages have three valid compatibility shapes:
--   * group_id only: ordinary group chat;
--   * group_id + session_id: session chat;
--   * group_id + workspace_id: legacy workspace chat.
-- A workspace and a session can never describe the same message. Legacy
-- workspace-only writes are still bridged by resolving their group; session
-- writes must carry the canonical group explicitly.
CREATE OR REPLACE FUNCTION phase2_sync_message_group_id() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  resolved_group uuid;
  session_group  uuid;
BEGIN
  IF NEW.workspace_id IS NOT NULL AND NEW.session_id IS NOT NULL THEN
    RAISE EXCEPTION
      'GROUP_ID_SCOPE_CONFLICT: messages row % has both workspace_id and session_id',
      NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.session_id IS NOT NULL THEN
    IF NEW.group_id IS NULL THEN
      RAISE EXCEPTION
        'GROUP_ID_REQUIRED: session message % must provide group_id',
        NEW.id
        USING ERRCODE = '23514';
    END IF;

    NEW.group_id := phase2_require_known_group(NEW.group_id, 'messages.session_id');

    SELECT s.group_id
      INTO session_group
      FROM study_sessions s
     WHERE s.id = NEW.session_id;

    IF NOT FOUND OR session_group IS NULL THEN
      RAISE EXCEPTION
        'GROUP_ID_RESOLUTION_FAILED: message % references session % without a known group',
        NEW.id, NEW.session_id
        USING ERRCODE = '23514';
    END IF;

    session_group := phase2_require_known_group(session_group, 'messages.session_id');

    IF NEW.group_id IS DISTINCT FROM session_group THEN
      RAISE EXCEPTION
        'GROUP_ID_SCOPE_CONFLICT: message % session % resolves to group %, not %',
        NEW.id, NEW.session_id, session_group, NEW.group_id
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.workspace_id IS NOT NULL THEN
    resolved_group := phase2_resolve_workspace_group(NEW.workspace_id, 'messages');

    IF NEW.group_id IS NOT NULL AND NEW.group_id IS DISTINCT FROM resolved_group THEN
      RAISE EXCEPTION
        'GROUP_ID_SCOPE_CONFLICT: message % workspace resolves to group %, not %',
        NEW.id, resolved_group, NEW.group_id
        USING ERRCODE = '23514';
    END IF;

    NEW.group_id := resolved_group;
    RETURN NEW;
  END IF;

  IF NEW.group_id IS NULL THEN
    RAISE EXCEPTION
      'GROUP_ID_REQUIRED: group message % must provide group_id',
      NEW.id
      USING ERRCODE = '23514';
  END IF;

  NEW.group_id := phase2_require_known_group(NEW.group_id, 'messages');
  RETURN NEW;
END;
$$;

-- A chunk inherits canonical scope from its parent resource. Duplicated legacy
-- workspace/course columns are checked when supplied, but NULL duplicates are
-- allowed during the compatibility window.
CREATE OR REPLACE FUNCTION phase2_sync_resource_chunk_group_id() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  resource_group     uuid;
  resource_workspace uuid;
  resource_course    uuid;
BEGIN
  IF NEW.group_id IS NOT NULL THEN
    NEW.group_id := phase2_require_known_group(NEW.group_id, 'resource_chunks');
  END IF;

  SELECT r.group_id, r.workspace_id, r.course_id
    INTO resource_group, resource_workspace, resource_course
    FROM resources r
   WHERE r.id = NEW.resource_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'RESOURCE_CHUNK_SCOPE_MISMATCH: chunk % references missing resource %',
      NEW.id, NEW.resource_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.workspace_id IS NOT NULL
     AND NEW.workspace_id IS DISTINCT FROM resource_workspace THEN
    RAISE EXCEPTION
      'RESOURCE_CHUNK_SCOPE_MISMATCH: chunk % workspace % disagrees with resource % workspace %',
      NEW.id, NEW.workspace_id, NEW.resource_id, resource_workspace
      USING ERRCODE = '23514';
  END IF;

  IF NEW.course_id IS NOT NULL
     AND NEW.course_id IS DISTINCT FROM resource_course THEN
    RAISE EXCEPTION
      'RESOURCE_CHUNK_SCOPE_MISMATCH: chunk % course % disagrees with resource % course %',
      NEW.id, NEW.course_id, NEW.resource_id, resource_course
      USING ERRCODE = '23514';
  END IF;

  IF resource_group IS NOT NULL THEN
    resource_group := phase2_require_known_group(resource_group, 'resource_chunks.resource_id');
  END IF;

  IF NEW.group_id IS NOT NULL AND NEW.group_id IS DISTINCT FROM resource_group THEN
    RAISE EXCEPTION
      'RESOURCE_CHUNK_SCOPE_MISMATCH: chunk % group % disagrees with resource % group %',
      NEW.id, NEW.group_id, NEW.resource_id, resource_group
      USING ERRCODE = '23514';
  END IF;

  NEW.group_id := resource_group;
  RETURN NEW;
END;
$$;

-- GROUP recommendations may now be written with target_group_id alone. The
-- legacy target_workspace_id remains an optional compatibility input and is
-- resolved when present.
CREATE OR REPLACE FUNCTION phase2_sync_recommendation_target_group_id() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  resolved_group uuid;
BEGIN
  IF NEW.kind = 'GROUP' THEN
    IF NEW.target_group_id IS NOT NULL THEN
      NEW.target_group_id := phase2_require_known_group(NEW.target_group_id, 'recommendations');
    END IF;

    IF NEW.target_workspace_id IS NOT NULL THEN
      resolved_group := phase2_resolve_workspace_group(NEW.target_workspace_id, 'recommendations');

      IF NEW.target_group_id IS NOT NULL
         AND NEW.target_group_id IS DISTINCT FROM resolved_group THEN
        RAISE EXCEPTION
          'GROUP_ID_SCOPE_CONFLICT: recommendation % workspace % resolves to group %, not %',
          NEW.id, NEW.target_workspace_id, resolved_group, NEW.target_group_id
          USING ERRCODE = '23514';
      END IF;

      NEW.target_group_id := resolved_group;
    ELSIF NEW.target_group_id IS NULL THEN
      RAISE EXCEPTION
        'GROUP_ID_REQUIRED: GROUP recommendation % must provide target_group_id or target_workspace_id',
        NEW.id
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.kind = 'STUDENT' AND NEW.target_group_id IS NOT NULL THEN
    RAISE EXCEPTION
      'GROUP_ID_SCOPE_CONFLICT: STUDENT recommendation % cannot have target_group_id %',
      NEW.id, NEW.target_group_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Outcome counters are group-scoped. The phase2 BEFORE trigger populates
-- NEW.group_id before these AFTER triggers execute, so group-only inserts are
-- counted and legacy workspace inserts continue to be counted as well.
CREATE OR REPLACE FUNCTION sync_outcome_sessions_attended() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_session uuid;
  target_student uuid;
  delta integer := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_session := NEW.session_id;
    target_student := NEW.student_id;
    delta := CASE WHEN COALESCE(NEW.attended, FALSE) THEN 1 ELSE 0 END;
  ELSIF TG_OP = 'DELETE' THEN
    target_session := OLD.session_id;
    target_student := OLD.student_id;
    delta := CASE WHEN COALESCE(OLD.attended, FALSE) THEN -1 ELSE 0 END;
  ELSE
    target_session := NEW.session_id;
    target_student := NEW.student_id;
    delta := (CASE WHEN COALESCE(NEW.attended, FALSE) THEN 1 ELSE 0 END)
           - (CASE WHEN COALESCE(OLD.attended, FALSE) THEN 1 ELSE 0 END);
  END IF;

  IF delta = 0 THEN
    RETURN NULL;
  END IF;

  UPDATE group_membership_outcomes o
     SET sessions_attended = GREATEST(0, o.sessions_attended + delta)
    FROM study_sessions s
   WHERE s.id = target_session
     AND o.group_id = s.group_id
     AND o.student_id = target_student;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION sync_outcome_tasks_completed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_group   uuid;
  target_student uuid;
  retract_group  uuid;
  retract_student uuid;
  grant_completion boolean := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_group := NEW.group_id;
    target_student := NEW.assignee_id;
    grant_completion := COALESCE(NEW.status = 'COMPLETED', FALSE);
  ELSIF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.status = 'COMPLETED', FALSE) THEN
      retract_group := OLD.group_id;
      retract_student := OLD.assignee_id;
    END IF;
  ELSE
    IF COALESCE(OLD.status = 'COMPLETED', FALSE)
       AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.assignee_id IS DISTINCT FROM NEW.assignee_id) THEN
      retract_group := OLD.group_id;
      retract_student := OLD.assignee_id;
    END IF;

    target_group := NEW.group_id;
    target_student := NEW.assignee_id;
    grant_completion := COALESCE(NEW.status = 'COMPLETED', FALSE)
                        AND (
                          NOT COALESCE(OLD.status = 'COMPLETED', FALSE)
                          OR OLD.assignee_id IS DISTINCT FROM NEW.assignee_id
                          OR OLD.group_id IS DISTINCT FROM NEW.group_id
                        );
  END IF;

  IF retract_student IS NOT NULL THEN
    UPDATE group_membership_outcomes
       SET tasks_completed = GREATEST(0, tasks_completed - 1)
     WHERE group_membership_outcomes.group_id = retract_group
       AND group_membership_outcomes.student_id = retract_student;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;

  IF NOT grant_completion THEN
    RETURN NULL;
  END IF;

  UPDATE group_membership_outcomes
     SET tasks_completed = GREATEST(0, tasks_completed + 1)
   WHERE group_membership_outcomes.group_id = target_group
     AND group_membership_outcomes.student_id = target_student;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION sync_outcome_messages_sent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.ai_model IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF NEW.author_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE group_membership_outcomes
     SET messages_sent = messages_sent + 1
   WHERE group_membership_outcomes.group_id = NEW.group_id
     AND group_membership_outcomes.student_id = NEW.author_id;

  RETURN NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Remove checks that encode workspace-only scope before validation.
-- -----------------------------------------------------------------------------

ALTER TABLE resources
  DROP CONSTRAINT IF EXISTS resources_scope_present;

-- These names were used by an earlier draft of this migration. Dropping them is
-- safe on a clean database and corrects a database where that draft was tested.
ALTER TABLE resources
  DROP CONSTRAINT IF EXISTS resources_group_requires_workspace;

ALTER TABLE quiz_attempts
  DROP CONSTRAINT IF EXISTS quiz_attempts_group_requires_workspace;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_scope_exclusive;

ALTER TABLE recommendations
  DROP CONSTRAINT IF EXISTS recommendations_target_check;

-- -----------------------------------------------------------------------------
-- 4. Validate mappings and explicit canonical scopes before changing rows.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  -- The primary group is explicit on workspaces. If a workspace has join-table
  -- rows, that primary relationship must also be present.
  IF EXISTS (
    SELECT 1
      FROM workspaces w
     WHERE w.group_id IS NULL
        OR NOT EXISTS (
             SELECT 1
               FROM study_groups g
              WHERE g.id = w.group_id
           )
  ) THEN
    RAISE EXCEPTION
      'GROUP_MAPPING_AMBIGUOUS: a workspace has no known canonical primary group'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM workspaces w
     WHERE EXISTS (SELECT 1 FROM workspace_groups wg WHERE wg.workspace_id = w.id)
       AND NOT EXISTS (
             SELECT 1
               FROM workspace_groups wg
              WHERE wg.workspace_id = w.id
                AND wg.group_id = w.group_id
           )
  ) THEN
    RAISE EXCEPTION
      'GROUP_MAPPING_AMBIGUOUS: workspace_groups omits a workspace primary group'
      USING ERRCODE = '23514';
  END IF;

  -- Every existing non-null workspace scope must resolve through the known
  -- primary mapping. This remains a fail-safe for legacy rows.
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT workspace_id FROM study_plans
        UNION ALL SELECT workspace_id FROM group_topic_progress
        UNION ALL SELECT workspace_id FROM tasks
        UNION ALL SELECT workspace_id FROM study_sessions
        UNION ALL SELECT workspace_id FROM resources
        UNION ALL SELECT workspace_id FROM resource_chunks
        UNION ALL SELECT workspace_id FROM messages
        UNION ALL SELECT workspace_id FROM quiz_attempts
        UNION ALL SELECT workspace_id FROM student_topic_mastery
        UNION ALL SELECT workspace_id FROM group_feedback
        UNION ALL SELECT workspace_id FROM group_membership_outcomes
      ) owned
      LEFT JOIN workspaces w ON w.id = owned.workspace_id
      LEFT JOIN study_groups g ON g.id = w.group_id
     WHERE owned.workspace_id IS NOT NULL
       AND g.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_RESOLUTION_FAILED: an existing workspace-owned row has no known primary group'
      USING ERRCODE = '23514';
  END IF;

  -- Explicit group-only values are valid, but must already name a known group.
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT group_id FROM study_plans
        UNION ALL SELECT group_id FROM group_topic_progress
        UNION ALL SELECT group_id FROM tasks
        UNION ALL SELECT group_id FROM study_sessions
        UNION ALL SELECT group_id FROM resources
        UNION ALL SELECT group_id FROM resource_chunks
        UNION ALL SELECT group_id FROM messages
        UNION ALL SELECT group_id FROM quiz_attempts
        UNION ALL SELECT group_id FROM student_topic_mastery
        UNION ALL SELECT group_id FROM group_feedback
        UNION ALL SELECT group_id FROM group_membership_outcomes
        UNION ALL SELECT target_group_id FROM recommendations
      ) owned
      LEFT JOIN study_groups g ON g.id = owned.group_id
     WHERE owned.group_id IS NOT NULL
       AND g.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_RESOLUTION_FAILED: an existing canonical group scope is unknown'
      USING ERRCODE = '23514';
  END IF;

  -- Never overwrite an already supplied canonical group with a workspace's
  -- primary group, even when the old workspace row is otherwise resolvable.
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT group_id, workspace_id FROM study_plans
        UNION ALL SELECT group_id, workspace_id FROM group_topic_progress
        UNION ALL SELECT group_id, workspace_id FROM tasks
        UNION ALL SELECT group_id, workspace_id FROM study_sessions
        UNION ALL SELECT group_id, workspace_id FROM resources
        UNION ALL SELECT group_id, workspace_id FROM resource_chunks
        UNION ALL SELECT group_id, workspace_id FROM quiz_attempts
        UNION ALL SELECT group_id, workspace_id FROM student_topic_mastery
        UNION ALL SELECT group_id, workspace_id FROM group_feedback
        UNION ALL SELECT group_id, workspace_id FROM group_membership_outcomes
        UNION ALL SELECT group_id, workspace_id FROM messages WHERE session_id IS NULL
      ) owned
      JOIN workspaces w ON w.id = owned.workspace_id
     WHERE owned.workspace_id IS NOT NULL
       AND owned.group_id IS NOT NULL
       AND owned.group_id IS DISTINCT FROM w.group_id
  ) THEN
    RAISE EXCEPTION
      'GROUP_MAPPING_AMBIGUOUS: an existing canonical group conflicts with its workspace primary group'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM messages m
     WHERE m.workspace_id IS NOT NULL
       AND m.session_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_SCOPE_CONFLICT: an existing message has both workspace_id and session_id'
      USING ERRCODE = '23514';
  END IF;

  -- Duplicated legacy scope on a chunk must agree with its parent. The canonical
  -- group comparison is repeated after backfill, when parent groups are known.
  IF EXISTS (
    SELECT 1
      FROM resource_chunks rc
      JOIN resources r ON r.id = rc.resource_id
     WHERE (rc.workspace_id IS NOT NULL AND rc.workspace_id IS DISTINCT FROM r.workspace_id)
        OR (rc.course_id IS NOT NULL AND rc.course_id IS DISTINCT FROM r.course_id)
  ) THEN
    RAISE EXCEPTION
      'RESOURCE_CHUNK_SCOPE_MISMATCH: an existing resource chunk disagrees with its resource'
      USING ERRCODE = '23514';
  END IF;

  -- A target workspace is still accepted as a compatibility input, but it must
  -- resolve if present. A GROUP recommendation may already be group-only.
  IF EXISTS (
    SELECT 1
      FROM recommendations r
      LEFT JOIN workspaces w ON w.id = r.target_workspace_id
     WHERE r.target_workspace_id IS NOT NULL
       AND w.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_RESOLUTION_FAILED: an existing recommendation target workspace is unknown'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM recommendations r
      LEFT JOIN workspaces w ON w.id = r.target_workspace_id
     WHERE r.kind = 'GROUP'
       AND r.target_group_id IS NULL
       AND r.target_workspace_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_BACKFILL_INCOMPLETE: a GROUP recommendation has neither target group nor target workspace'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM recommendations r
      JOIN workspaces w ON w.id = r.target_workspace_id
     WHERE r.kind = 'GROUP'
       AND r.target_group_id IS NOT NULL
       AND r.target_group_id IS DISTINCT FROM w.group_id
  ) THEN
    RAISE EXCEPTION
      'GROUP_MAPPING_AMBIGUOUS: a recommendation target_group_id conflicts with its primary workspace group'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM recommendations
     WHERE kind = 'STUDENT' AND target_group_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_SCOPE_CONFLICT: a STUDENT recommendation already has target_group_id'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Backfill in dependency order, retaining any explicit group-only value.
-- -----------------------------------------------------------------------------

UPDATE study_plans p
   SET group_id = phase2_resolve_workspace_group(p.workspace_id, 'study_plans')
 WHERE p.group_id IS NULL
   AND p.workspace_id IS NOT NULL;

UPDATE group_topic_progress p
   SET group_id = phase2_resolve_workspace_group(p.workspace_id, 'group_topic_progress')
 WHERE p.group_id IS NULL
   AND p.workspace_id IS NOT NULL;

UPDATE tasks t
   SET group_id = phase2_resolve_workspace_group(t.workspace_id, 'tasks')
 WHERE t.group_id IS NULL
   AND t.workspace_id IS NOT NULL;

UPDATE study_sessions s
   SET group_id = phase2_resolve_workspace_group(s.workspace_id, 'study_sessions')
 WHERE s.group_id IS NULL
   AND s.workspace_id IS NOT NULL;

UPDATE resources r
   SET group_id = phase2_resolve_workspace_group(r.workspace_id, 'resources')
 WHERE r.group_id IS NULL
   AND r.workspace_id IS NOT NULL;

UPDATE quiz_attempts q
   SET group_id = phase2_resolve_workspace_group(q.workspace_id, 'quiz_attempts')
 WHERE q.group_id IS NULL
   AND q.workspace_id IS NOT NULL;

-- Resource chunks inherit canonical scope from resources, not from the
-- duplicated legacy workspace_id column.
UPDATE resource_chunks rc
   SET group_id = r.group_id
  FROM resources r
 WHERE r.id = rc.resource_id
   AND rc.group_id IS NULL;

-- Session messages inherit through study_sessions; legacy workspace chat
-- messages continue to inherit through workspaces.
UPDATE messages m
   SET group_id = s.group_id
  FROM study_sessions s
 WHERE m.group_id IS NULL
   AND m.session_id = s.id;

UPDATE messages m
   SET group_id = phase2_resolve_workspace_group(m.workspace_id, 'messages')
 WHERE m.group_id IS NULL
   AND m.session_id IS NULL
   AND m.workspace_id IS NOT NULL;

UPDATE student_topic_mastery m
   SET group_id = phase2_resolve_workspace_group(m.workspace_id, 'student_topic_mastery')
 WHERE m.group_id IS NULL
   AND m.workspace_id IS NOT NULL;

UPDATE group_feedback f
   SET group_id = phase2_resolve_workspace_group(f.workspace_id, 'group_feedback')
 WHERE f.group_id IS NULL
   AND f.workspace_id IS NOT NULL;

UPDATE group_membership_outcomes o
   SET group_id = phase2_resolve_workspace_group(o.workspace_id, 'group_membership_outcomes')
 WHERE o.group_id IS NULL
   AND o.workspace_id IS NOT NULL;

UPDATE recommendations r
   SET target_group_id = w.group_id
  FROM workspaces w
 WHERE r.kind = 'GROUP'
   AND r.target_group_id IS NULL
   AND r.target_workspace_id = w.id;

-- -----------------------------------------------------------------------------
-- 6. Verify the canonical backfill before adding constraints.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM study_plans WHERE group_id IS NULL)
     OR EXISTS (SELECT 1 FROM group_topic_progress WHERE group_id IS NULL)
     OR EXISTS (SELECT 1 FROM tasks WHERE group_id IS NULL)
     OR EXISTS (SELECT 1 FROM study_sessions WHERE group_id IS NULL)
     OR EXISTS (SELECT 1 FROM messages WHERE group_id IS NULL)
     OR EXISTS (SELECT 1 FROM student_topic_mastery WHERE group_id IS NULL)
     OR EXISTS (SELECT 1 FROM group_feedback WHERE group_id IS NULL)
     OR EXISTS (SELECT 1 FROM group_membership_outcomes WHERE group_id IS NULL) THEN
    RAISE EXCEPTION
      'GROUP_ID_BACKFILL_INCOMPLETE: an always-group-scoped row has no canonical group'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM resources
     WHERE group_id IS NULL AND course_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'RESOURCE_SCOPE_MISMATCH: a resource has neither group_id nor course_id'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM resource_chunks rc
      JOIN resources r ON r.id = rc.resource_id
     WHERE rc.group_id IS DISTINCT FROM r.group_id
        OR (rc.workspace_id IS NOT NULL AND rc.workspace_id IS DISTINCT FROM r.workspace_id)
        OR (rc.course_id IS NOT NULL AND rc.course_id IS DISTINCT FROM r.course_id)
  ) THEN
    RAISE EXCEPTION
      'RESOURCE_CHUNK_SCOPE_MISMATCH: a resource chunk disagrees with its resource'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM messages
     WHERE workspace_id IS NOT NULL AND session_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_SCOPE_CONFLICT: a message has both workspace_id and session_id'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM messages m
      LEFT JOIN study_sessions s ON s.id = m.session_id
     WHERE m.session_id IS NOT NULL
       AND (s.id IS NULL OR s.group_id IS NULL OR m.group_id IS DISTINCT FROM s.group_id)
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_RESOLUTION_FAILED: a session message has no matching session group'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM messages m
      JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.workspace_id IS NOT NULL
       AND m.session_id IS NULL
       AND m.group_id IS DISTINCT FROM w.group_id
  ) THEN
    RAISE EXCEPTION
      'GROUP_MAPPING_AMBIGUOUS: a workspace message group conflicts with its workspace group'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM recommendations r
      LEFT JOIN workspaces w ON w.id = r.target_workspace_id
     WHERE r.kind = 'GROUP'
       AND (r.target_group_id IS NULL
            OR (r.target_workspace_id IS NOT NULL AND w.group_id IS DISTINCT FROM r.target_group_id))
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_BACKFILL_INCOMPLETE: a GROUP recommendation has no canonical target group'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM recommendations
     WHERE kind = 'STUDENT' AND target_group_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_SCOPE_CONFLICT: a STUDENT recommendation has target_group_id'
      USING ERRCODE = '23514';
  END IF;

  -- A group can have multiple legacy workspaces, but each canonical group key
  -- must still have one row. Fail closed instead of merging data implicitly.
  IF EXISTS (
    SELECT 1 FROM group_topic_progress
     GROUP BY group_id, topic_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_UNIQUENESS_CONFLICT: group_topic_progress has duplicate group/topic rows'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM group_feedback
     GROUP BY group_id, student_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_UNIQUENESS_CONFLICT: group_feedback has duplicate group/student rows'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM group_membership_outcomes
     GROUP BY group_id, student_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_UNIQUENESS_CONFLICT: group_membership_outcomes has duplicate group/student rows'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM student_topic_mastery
     GROUP BY student_id, group_id, topic_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_UNIQUENESS_CONFLICT: student_topic_mastery has duplicate student/group/topic rows'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM recommendations
     GROUP BY request_id, kind,
              COALESCE(target_student_id, '00000000-0000-0000-0000-000000000000'::uuid),
              COALESCE(target_group_id, '00000000-0000-0000-0000-000000000000'::uuid)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'GROUP_ID_UNIQUENESS_CONFLICT: recommendations has duplicate request/target rows after group canonicalization'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Foreign keys, group-key constraints, nullability, and scope checks.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'study_plans_group_id_fkey') THEN
    ALTER TABLE study_plans
      ADD CONSTRAINT study_plans_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_topic_progress_group_id_fkey') THEN
    ALTER TABLE group_topic_progress
      ADD CONSTRAINT group_topic_progress_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_group_id_fkey') THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'study_sessions_group_id_fkey') THEN
    ALTER TABLE study_sessions
      ADD CONSTRAINT study_sessions_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resources_group_id_fkey') THEN
    ALTER TABLE resources
      ADD CONSTRAINT resources_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_chunks_group_id_fkey') THEN
    ALTER TABLE resource_chunks
      ADD CONSTRAINT resource_chunks_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_group_id_fkey') THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quiz_attempts_group_id_fkey') THEN
    ALTER TABLE quiz_attempts
      ADD CONSTRAINT quiz_attempts_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_topic_mastery_group_id_fkey') THEN
    ALTER TABLE student_topic_mastery
      ADD CONSTRAINT student_topic_mastery_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_feedback_group_id_fkey') THEN
    ALTER TABLE group_feedback
      ADD CONSTRAINT group_feedback_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_membership_outcomes_group_id_fkey') THEN
    ALTER TABLE group_membership_outcomes
      ADD CONSTRAINT group_membership_outcomes_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recommendations_target_group_id_fkey') THEN
    ALTER TABLE recommendations
      ADD CONSTRAINT recommendations_target_group_id_fkey
      FOREIGN KEY (target_group_id) REFERENCES study_groups(id) ON DELETE CASCADE;
  END IF;
END;
$$;

ALTER TABLE study_plans
  ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE group_topic_progress
  ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE tasks
  ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE study_sessions
  ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE messages
  ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE student_topic_mastery
  ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE group_feedback
  ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE group_membership_outcomes
  ALTER COLUMN group_id SET NOT NULL;

-- The old primary key encoded workspace scope. The new primary key makes group
-- scope authoritative while retaining workspace_id as a nullable compatibility
-- column for old readers and writers.
ALTER TABLE student_topic_mastery
  DROP CONSTRAINT IF EXISTS student_topic_mastery_pkey;

ALTER TABLE student_topic_mastery
  ADD CONSTRAINT student_topic_mastery_pkey PRIMARY KEY (student_id, group_id, topic_id);

-- These legacy columns are intentionally retained but no longer required for a
-- canonical group-only write. Resources, chunks, and attempts were already
-- nullable in the base schema; repeating DROP NOT NULL verifies that contract.
ALTER TABLE study_plans
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE group_topic_progress
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE tasks
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE study_sessions
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE resources
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE resource_chunks
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE quiz_attempts
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE student_topic_mastery
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE group_feedback
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE group_membership_outcomes
  ALTER COLUMN workspace_id DROP NOT NULL;

-- Keep the old workspace uniqueness keys for legacy ON CONFLICT writers, but
-- make the group keys authoritative for canonical writes.
ALTER TABLE group_topic_progress
  DROP CONSTRAINT IF EXISTS group_topic_progress_group_topic_unique;

ALTER TABLE group_topic_progress
  ADD CONSTRAINT group_topic_progress_group_topic_unique UNIQUE (group_id, topic_id);

ALTER TABLE group_feedback
  DROP CONSTRAINT IF EXISTS group_feedback_group_student_unique;

ALTER TABLE group_feedback
  ADD CONSTRAINT group_feedback_group_student_unique UNIQUE (group_id, student_id);

DROP INDEX IF EXISTS group_membership_outcomes_group_student_unique;
CREATE UNIQUE INDEX group_membership_outcomes_group_student_unique
  ON group_membership_outcomes (group_id, student_id);

-- A resource is scoped by a group or a course. A workspace is only a legacy
-- compatibility scope and must not be required by the resource check.
ALTER TABLE resources
  ADD CONSTRAINT resources_scope_present CHECK (group_id IS NOT NULL OR course_id IS NOT NULL);

-- Group chat has no session or workspace. Session chat has group + session.
-- Legacy workspace chat has group + workspace. Workspace/session overlap is
-- always invalid, and every message must have canonical group scope.
ALTER TABLE messages
  ADD CONSTRAINT messages_scope_exclusive CHECK (
    group_id IS NOT NULL
    AND NOT (workspace_id IS NOT NULL AND session_id IS NOT NULL)
  );

-- target_workspace_id remains optional for GROUP recommendations during the
-- compatibility window; target_group_id is the canonical target.
ALTER TABLE recommendations
  ADD CONSTRAINT recommendations_target_check CHECK (
    (kind = 'STUDENT'
      AND target_student_id IS NOT NULL
      AND target_workspace_id IS NULL
      AND target_group_id IS NULL)
    OR
    (kind = 'GROUP'
      AND target_student_id IS NULL
      AND target_group_id IS NOT NULL)
  );

-- -----------------------------------------------------------------------------
-- 8. Group-oriented indexes and recommendation uniqueness.
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS study_plans_group_idx
  ON study_plans (group_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS group_topic_progress_group_idx
  ON group_topic_progress (group_id, status);

CREATE INDEX IF NOT EXISTS tasks_group_status_idx
  ON tasks (group_id, status, due_at NULLS LAST);

CREATE INDEX IF NOT EXISTS tasks_group_overdue_idx
  ON tasks (group_id, due_at)
  WHERE status <> 'COMPLETED' AND due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS study_sessions_group_upcoming_idx
  ON study_sessions (group_id, starts_at)
  WHERE status = 'SCHEDULED';

CREATE INDEX IF NOT EXISTS study_sessions_group_recent_idx
  ON study_sessions (group_id, starts_at DESC);

CREATE INDEX IF NOT EXISTS resources_group_idx
  ON resources (group_id, created_at DESC)
  WHERE group_id IS NOT NULL AND NOT is_deleted;

CREATE INDEX IF NOT EXISTS resource_chunks_group_idx
  ON resource_chunks (group_id, resource_id, chunk_index)
  WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_group_cursor_idx
  ON messages (group_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS quiz_attempts_group_idx
  ON quiz_attempts (group_id, attempted_at DESC)
  WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS student_topic_mastery_group_idx
  ON student_topic_mastery (group_id, topic_id);

CREATE INDEX IF NOT EXISTS group_feedback_group_idx
  ON group_feedback (group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS group_membership_outcomes_group_idx
  ON group_membership_outcomes (group_id, student_id, joined_at DESC);

CREATE INDEX IF NOT EXISTS recommendations_target_group_entity_idx
  ON recommendations (target_group_id, shown_at DESC)
  WHERE target_group_id IS NOT NULL;

-- The old index used target_workspace_id, so two workspaces for the same group
-- could produce duplicate canonical recommendations. Use target_group_id for
-- GROUP rows while preserving the same expression shape for STUDENT rows.
DROP INDEX IF EXISTS recommendations_request_student_target_unique;

CREATE UNIQUE INDEX recommendations_request_student_target_unique
  ON recommendations (
    request_id,
    kind,
    COALESCE(target_student_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(target_group_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- -----------------------------------------------------------------------------
-- 9. Compatibility triggers for the migration window.
-- -----------------------------------------------------------------------------

-- The BEFORE group bridge fires before this overlap trigger by trigger name, so
-- both legacy workspace writes and canonical group-only writes are checked
-- against the same group scope. Defining it here avoids applying the new scope
-- rule to rows while their canonical group is being backfilled.
CREATE OR REPLACE FUNCTION study_sessions_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  IF NEW.group_id IS NULL THEN
    RAISE EXCEPTION
      'GROUP_ID_REQUIRED: study session must provide group_id'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM study_sessions s
     WHERE s.group_id = NEW.group_id
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

DROP TRIGGER IF EXISTS phase2_sync_group_id ON study_plans;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON study_plans
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_workspace_group_id();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON group_topic_progress;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON group_topic_progress
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_workspace_group_id();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON tasks;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_workspace_group_id();

-- Include scope changes so a completed legacy task moved to another canonical
-- group retracts and re-grants its counter instead of leaving it stranded.
DROP TRIGGER IF EXISTS tasks_outcome ON tasks;
CREATE TRIGGER tasks_outcome
  AFTER INSERT OR UPDATE OF status, assignee_id, group_id, workspace_id OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION sync_outcome_tasks_completed();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON study_sessions;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON study_sessions
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_workspace_group_id();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON resources;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_workspace_group_id();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON quiz_attempts;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON quiz_attempts
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_workspace_group_id();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON student_topic_mastery;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON student_topic_mastery
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_workspace_group_id();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON group_feedback;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON group_feedback
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_workspace_group_id();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON group_membership_outcomes;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON group_membership_outcomes
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_workspace_group_id();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON resource_chunks;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON resource_chunks
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_resource_chunk_group_id();

DROP TRIGGER IF EXISTS phase2_sync_group_id ON messages;
CREATE TRIGGER phase2_sync_group_id
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_message_group_id();

DROP TRIGGER IF EXISTS phase2_sync_target_group_id ON recommendations;
CREATE TRIGGER phase2_sync_target_group_id
  BEFORE INSERT OR UPDATE ON recommendations
  FOR EACH ROW EXECUTE FUNCTION phase2_sync_recommendation_target_group_id();

-- Group-only writes are canonical. Legacy workspace writes remain valid only as
-- compatibility inputs and are resolved/checked by the triggers above.

COMMENT ON COLUMN workspaces.group_id IS
  'Canonical primary group for legacy workspace-owned content. Phase 2 keeps workspace_id and workspace_groups during the compatibility window.';

COMMENT ON COLUMN study_plans.group_id IS
  'Canonical group scope. Group-only writes are supported; legacy workspace_id remains nullable during the compatibility window.';

COMMENT ON COLUMN group_topic_progress.group_id IS
  'Canonical group scope and uniqueness key; legacy workspace_id remains nullable for compatibility writes.';

COMMENT ON COLUMN tasks.group_id IS
  'Canonical group scope. Legacy workspace_id remains nullable for compatibility writes.';

COMMENT ON COLUMN study_sessions.group_id IS
  'Canonical group scope used by overlap validation. Legacy workspace_id remains nullable for compatibility writes.';

COMMENT ON COLUMN resources.group_id IS
  'Canonical group scope for group resources, NULL for course-only resources; workspace_id remains a nullable compatibility column.';

COMMENT ON COLUMN resource_chunks.group_id IS
  'Canonical group scope inherited from resources.group_id, NULL for course-only resources; legacy scope columns remain nullable during compatibility.';

COMMENT ON COLUMN messages.group_id IS
  'Required canonical group scope for group chat and session chat; workspace_id remains a nullable legacy compatibility column.';

COMMENT ON COLUMN quiz_attempts.group_id IS
  'Canonical group scope for group attempts, NULL for course-only attempts; workspace_id remains a nullable compatibility column.';

COMMENT ON COLUMN student_topic_mastery.group_id IS
  'Canonical group scope and primary-key component; workspace_id remains nullable during the compatibility window.';

COMMENT ON COLUMN group_feedback.group_id IS
  'Canonical group scope and uniqueness key; workspace_id remains nullable for compatibility writes.';

COMMENT ON COLUMN group_membership_outcomes.group_id IS
  'Canonical group scope and uniqueness key used by outcome counters; workspace_id remains nullable for compatibility writes.';

COMMENT ON COLUMN recommendations.target_group_id IS
  'Canonical GROUP recommendation target. target_workspace_id remains optional during the compatibility window.';
