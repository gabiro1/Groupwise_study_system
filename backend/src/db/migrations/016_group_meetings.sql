-- =============================================================================
-- Video meetings — group meetings + attendance
--
-- A `group_meeting` is the schedulable video call that belongs to exactly one
-- study group. It is deliberately separate from `study_sessions` (the
-- structured collaboration layer): meetings carry video-provider state
-- (provider, room identifier, live/ended timestamps) and an attendance ledger,
-- while study sessions carry agenda/timer/roles.
--
-- Conventions follow the existing schema:
--   * UUIDv7 ids via gen_uuid(), timestamptz everywhere.
--   * Native enums (meeting_status, meeting_provider) so invalid states are
--     unrepresentable; transitions are enforced in the service layer with
--     compare-and-set UPDATEs.
--   * touch_updated_at() keeps updated_at honest.
--   * Overlap guard mirrors study_sessions_no_overlap().
-- =============================================================================

CREATE TABLE group_meetings (
  id                        uuid PRIMARY KEY DEFAULT gen_uuid(),
  group_id                  uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  title                     TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 160),
  description               TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  scheduled_start           timestamptz NOT NULL,
  expected_duration_minutes SMALLINT NOT NULL CHECK (expected_duration_minutes BETWEEN 5 AND 480),
  status                    meeting_status NOT NULL DEFAULT 'SCHEDULED',
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  provider                  meeting_provider NOT NULL DEFAULT 'JITSI',
  provider_room_identifier  TEXT NOT NULL,
  started_at                timestamptz,
  ended_at                  timestamptz,
  cancelled_at              timestamptz,
  live_started_at           timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_meetings_cancelled_consistent CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL)
  ),
  CONSTRAINT group_meetings_live_consistent CHECK (
    (status = 'LIVE' AND live_started_at IS NOT NULL)
    OR (status <> 'LIVE')
  ),
  CONSTRAINT group_meetings_completed_consistent CHECK (
    (status = 'COMPLETED' AND ended_at IS NOT NULL)
    OR (status <> 'COMPLETED')
  ),
  CONSTRAINT group_meetings_start_required CHECK (scheduled_start IS NOT NULL)
);

CREATE TRIGGER group_meetings_touch BEFORE UPDATE ON group_meetings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE UNIQUE INDEX group_meetings_room_unique ON group_meetings (provider_room_identifier);
CREATE INDEX group_meetings_group_status_start_idx ON group_meetings (group_id, status, scheduled_start);
CREATE INDEX group_meetings_status_start_idx ON group_meetings (status, scheduled_start);
CREATE INDEX group_meetings_group_start_idx ON group_meetings (group_id, scheduled_start DESC);
CREATE INDEX group_meetings_created_by_idx ON group_meetings (created_by, scheduled_start DESC);

-- Reject overlapping non-cancelled meetings in the same group.
CREATE OR REPLACE FUNCTION group_meetings_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM group_meetings m
     WHERE m.group_id = NEW.group_id
       AND m.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND m.status <> 'CANCELLED'
       AND tstzrange(m.scheduled_start, m.scheduled_start + (m.expected_duration_minutes || ' minutes')::interval, '[)')
           && tstzrange(NEW.scheduled_start, NEW.scheduled_start + (NEW.expected_duration_minutes || ' minutes')::interval, '[)')
  ) THEN
    RAISE EXCEPTION 'MEETING_OVERLAP'
      USING HINT = 'Another meeting already occupies part of that time slot.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER group_meetings_no_overlap
  BEFORE INSERT OR UPDATE ON group_meetings
  FOR EACH ROW EXECUTE FUNCTION group_meetings_no_overlap();

-- =============================================================================
-- Attendance ledger — verifiable join/leave events only.
--
-- One OPEN row per (meeting, user) while they are in the call (left_at NULL).
-- A rejoin after leaving inserts a fresh row; duplicates can never corrupt the
-- ledger because the partial unique index allows at most one open row.
-- `status` records the last reliable event (JOINED / LEFT / IN_CALL).
-- Nothing here is fabricated: durations are derived from joined_at/left_at.
-- =============================================================================

CREATE TABLE meeting_attendance (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  meeting_id   uuid NOT NULL REFERENCES group_meetings(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  status       meeting_attendance_status NOT NULL DEFAULT 'JOINED',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_attendance_window CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE TRIGGER meeting_attendance_touch BEFORE UPDATE ON meeting_attendance
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- At most one open (not yet left) attendance row per participant per meeting.
CREATE UNIQUE INDEX meeting_attendance_open_unique
  ON meeting_attendance (meeting_id, user_id)
  WHERE left_at IS NULL;

CREATE INDEX meeting_attendance_meeting_idx ON meeting_attendance (meeting_id, joined_at);
CREATE INDEX meeting_attendance_user_idx ON meeting_attendance (user_id, joined_at DESC);
