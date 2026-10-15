-- =============================================================================
-- Video meetings — Google Meet provider
--
-- The organizer supplies their own Google Meet link when scheduling; TWIGANE
-- stores it and hands members a one-click "open in new tab" button. No iframe
-- and no device permissions are needed on TWIGANE's side.
--
-- Postgres forbids *using* a newly added enum value inside the same transaction
-- that added it (see 015), so this file only extends the type and the table;
-- application code starts writing 'GOOGLE_MEET' after this commits.
-- =============================================================================

ALTER TYPE meeting_provider ADD VALUE IF NOT EXISTS 'GOOGLE_MEET';

-- User-supplied join link. NULL for embedded providers (Jitsi generates its
-- room server-side). The regex only ever matches meet.google.com URLs, and the
-- service validates it again before storing — this is defence in depth, not
-- the primary check.
ALTER TABLE group_meetings
  ADD COLUMN join_url TEXT
  CONSTRAINT group_meetings_join_url_meet CHECK (
    join_url IS NULL OR join_url ~* '^https://meet\.google\.com/[a-z0-9-]+/?$'
  );