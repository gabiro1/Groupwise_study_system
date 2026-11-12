-- =============================================================================
-- Remove standalone Partners infrastructure.
--
-- Groups are now the only collaboration environment. This migration removes
-- tables that existed exclusively for one-to-one partner requests and direct
-- messages, while retaining users, groups, memberships, group invitations,
-- group requests, and historical recommendation rows.
-- =============================================================================

DROP TABLE IF EXISTS direct_messages CASCADE;
DROP TABLE IF EXISTS direct_conversation_members CASCADE;
DROP TABLE IF EXISTS direct_conversations CASCADE;
DROP TABLE IF EXISTS partner_connections CASCADE;
DROP TYPE IF EXISTS partner_connection_status;

-- The old privacy field only governed direct messaging. Group discussions are
-- governed by group membership, so the field is no longer meaningful.
ALTER TABLE privacy_settings DROP COLUMN IF EXISTS allow_messages_from;

-- Preserve existing free-text learning preferences while removing the old
-- partner-specific name. This is a rename, not a data deletion.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'study_preferences'
       AND column_name = 'partner_preferences'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'study_preferences'
       AND column_name = 'collaboration_preferences'
  ) THEN
    ALTER TABLE study_preferences RENAME COLUMN partner_preferences TO collaboration_preferences;
  END IF;
END $$;

-- Remove persisted notifications that point to the deleted experience. The
-- enum is recreated below because PostgreSQL cannot drop enum values in place.
DELETE FROM notifications
 WHERE type::text IN ('PARTNER_INVITATION', 'PARTNER_ACCEPTED', 'DIRECT_MESSAGE');

ALTER TABLE notifications
  ALTER COLUMN type TYPE text USING type::text;

DROP TYPE notification_type;

CREATE TYPE notification_type AS ENUM (
  'GROUP_INVITATION', 'JOIN_REQUEST', 'INVITATION_ACCEPTED', 'JOIN_REQUEST_APPROVED',
  'SESSION_REMINDER', 'SESSION_UPDATED', 'TASK_ASSIGNED', 'TASK_DUE',
  'GROUP_ANNOUNCEMENT', 'AI_RECOMMENDATION', 'SYSTEM', 'MODERATION',
  'SESSION_STARTED', 'ROLE_ASSIGNED',
  'MEETING_SCHEDULED', 'MEETING_UPDATED', 'MEETING_CANCELLED', 'MEETING_STARTED'
);

ALTER TABLE notifications
  ALTER COLUMN type TYPE notification_type USING type::notification_type;
