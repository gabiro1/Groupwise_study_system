-- =============================================================================
-- Lien â€” 006_outcome_triggers.sql
-- Maintain `group_membership_outcomes` activity counters.
--
-- The research question is whether groups formed by recommendation work better
-- than groups formed organically. Answering it needs a measure of what happened
-- *after* joining: sessions attended, tasks completed, messages sent.
--
-- Those counters are maintained here rather than in application code on purpose:
--
--   * They must be correct for every write path. Sessions are marked attended by
--     the RSVP flow, tasks by the task editor, messages by chat and by the AI
--     assistant. Four call sites in four modules would drift, and a counter that
--     quietly stops counting is worse than no counter: the study would still run
--     and still produce a number.
--   * The outcome row may not exist yet when the activity happens (a student can
--     attend a session and only later rejoin, or the membership row may predate the
--     outcome row). An UPDATE in a trigger is therefore a no-op in that case, and
--     the counter catches up when the membership re-opens.
--
-- AI messages are excluded from `messages_sent` on purpose. If the assistant is
-- doing the talking, counting it as the student's participation would inflate the
-- very measure the study is using to evaluate the assistant's effect.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Sessions attended
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_outcome_sessions_attended() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_session uuid;
  target_student uuid;
  -- An explicit signed delta, rather than a "current state" flag. A flag cannot
  -- express the difference between "the row is not counted" and "the row was not
  -- counted before either", which is exactly what deleting a pending RSVP means.
  delta integer := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_session := NEW.session_id;
    target_student  := NEW.student_id;
    delta := CASE WHEN COALESCE(NEW.attended, FALSE) THEN 1 ELSE 0 END;

  ELSIF TG_OP = 'DELETE' THEN
    target_session := OLD.session_id;
    target_student  := OLD.student_id;
    -- Retract only an attendance that was actually recorded. Deleting someone who
    -- had merely RSVPed is not participation, so it must leave the count alone.
    delta := CASE WHEN COALESCE(OLD.attended, FALSE) THEN -1 ELSE 0 END;

  ELSE
    target_session := NEW.session_id;
    target_student  := NEW.student_id;
    -- Signed difference between the old and new state. An RSVP change that does not
    -- touch attendance lands on 0 and the trigger becomes a no-op rather than a
    -- redundant write.
    delta := (CASE WHEN COALESCE(NEW.attended, FALSE) THEN 1 ELSE 0 END)
           - (CASE WHEN COALESCE(OLD.attended, FALSE) THEN 1 ELSE 0 END);
  END IF;

  IF delta = 0 THEN
    RETURN NULL;
  END IF;

  -- `session_participants` has no workspace column, so the workspace is resolved
  -- through the session. Scoping on the session also means an attendance edit can
  -- never be credited to a workspace the session does not belong to.
  UPDATE group_membership_outcomes o
     SET sessions_attended = GREATEST(0, o.sessions_attended + delta)
    FROM study_sessions s
   WHERE s.id = target_session
     AND o.workspace_id = s.workspace_id
     AND o.student_id = target_student;

  RETURN NULL;
END;
$$;

CREATE TRIGGER session_participants_outcome
  AFTER INSERT OR UPDATE OF attended OR DELETE ON session_participants
  FOR EACH ROW EXECUTE FUNCTION sync_outcome_sessions_attended();

-- -----------------------------------------------------------------------------
-- Tasks completed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_outcome_tasks_completed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Named `target_*` rather than `workspace_id`/`student_id`: PL/pgSQL resolves an
  -- unqualified name to the variable first, so a column-shaped local would turn
  -- `WHERE workspace_id = workspace_id` into a tautology and update every row.
  -- `retract_*` is a separate pair because the row losing the credit is not always
  -- the row gaining it: reassignment moves a completion from one person to another.
  target_workspace  uuid;
  target_student    uuid;
  retract_workspace uuid;
  retract_student   uuid;
BEGIN
  -- `task_status` spells this value COMPLETED, not DONE.
  IF TG_OP = 'INSERT' THEN
    target_workspace := NEW.workspace_id;
    target_student := NEW.assignee_id;

  ELSIF TG_OP = 'DELETE' THEN
    -- Only retract a completion that was actually recorded. Deleting a task that was
    -- still `IN_PROGRESS` never contributed to the count, so it must not decrement.
    IF COALESCE(OLD.status = 'COMPLETED', FALSE) THEN
      retract_workspace := OLD.workspace_id;
      retract_student := OLD.assignee_id;
    END IF;

  ELSE
    -- Retract the previous state whenever it was a completion, whether it is being
    -- un-completed, reassigned, or both. `IS DISTINCT FROM` treats a NULL assignee
    -- as a real value, so unassigning a completed task still retracts its credit.
    IF COALESCE(OLD.status = 'COMPLETED', FALSE)
       AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.assignee_id IS DISTINCT FROM NEW.assignee_id) THEN
      retract_workspace := OLD.workspace_id;
      retract_student := OLD.assignee_id;
    END IF;

    target_workspace := NEW.workspace_id;
    target_student := NEW.assignee_id;
  END IF;

  -- Retract first. Doing it before the grant keeps the two updates independent, so
  -- the same outcome row is never touched by both.
  IF retract_student IS NOT NULL THEN
    UPDATE group_membership_outcomes
       SET tasks_completed = GREATEST(0, tasks_completed - 1)
     WHERE group_membership_outcomes.workspace_id = retract_workspace
       AND group_membership_outcomes.student_id = retract_student;
  END IF;

  -- Grant only if this write *is* the completion. On INSERT and on the transition
  -- into COMPLETED, `is_completion_event` holds; on DELETE and on a plain edit it
  -- does not, which is what stops a title edit from counting as work.
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT (NOT COALESCE(OLD.status = 'COMPLETED', FALSE)
                              AND COALESCE(NEW.status = 'COMPLETED', FALSE)) THEN
    RETURN NULL;
  END IF;

  IF NOT COALESCE(NEW.status = 'COMPLETED', FALSE) THEN
    RETURN NULL;
  END IF;

  -- Only the assignee's participation is measured. A task created by someone else
  -- and marked done by the workspace owner would otherwise credit them with work
  -- they did not do. An unassigned task (target_student NULL) matches no row.
  UPDATE group_membership_outcomes
     SET tasks_completed = GREATEST(0, tasks_completed + 1)
   WHERE group_membership_outcomes.workspace_id = target_workspace
     AND group_membership_outcomes.student_id = target_student;

  RETURN NULL;
END;
$$;

-- `assignee_id` is included because a reassignment of an already-completed task
-- transfers its credit; watching `status` alone would leave the count stranded.
CREATE TRIGGER tasks_outcome
  AFTER INSERT OR UPDATE OF status, assignee_id OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION sync_outcome_tasks_completed();

-- -----------------------------------------------------------------------------
-- Messages sent
-- -----------------------------------------------------------------------------
-- Fires on INSERT only, and that is the point: a message is counted once, when it
-- is first written. An edit rewrites the body rather than adding another message, so
-- counting updates would turn message volume into a measure of how often people fix
-- typos. A cascade delete needs no handling either: the membership and its outcome
-- row are removed with the group.
CREATE OR REPLACE FUNCTION sync_outcome_messages_sent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Excluded: soft-deleted messages, and anything the assistant wrote. If the model
  -- is doing the talking, counting it as the student's participation would inflate
  -- the very measure the study uses to evaluate the assistant's effect.
  IF NEW.deleted_at IS NOT NULL OR NEW.ai_model IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF NEW.author_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE group_membership_outcomes
     SET messages_sent = messages_sent + 1
   WHERE workspace_id = NEW.workspace_id
     AND student_id = NEW.author_id;

  RETURN NULL;
END;
$$;

CREATE TRIGGER messages_outcome
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION sync_outcome_messages_sent();