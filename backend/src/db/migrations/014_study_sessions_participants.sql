-- =============================================================================
-- Study sessions — participation policy
--
-- Clarifies whether a session invites a specific participant list (closed) or
-- is open to every active group member (open registration). Open sessions let
-- any member RSVP and join; closed sessions only admit invited members and the
-- group moderators who manage them.
-- =============================================================================

ALTER TABLE study_sessions
  ADD COLUMN participants_closed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS study_sessions_participants_closed_idx
  ON study_sessions (participants_closed) WHERE status = 'SCHEDULED';