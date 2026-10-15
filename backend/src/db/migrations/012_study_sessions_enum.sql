-- =============================================================================
-- Study sessions — enum vocabulary extension
--
-- Run in its own migration because Postgres forbids *using* a newly added enum
-- value inside the same transaction that added it. The session/role/chat
-- tables in 013_study_sessions.sql reference `session_status = 'ACTIVE'` and the
-- two new notification types, so those values must already exist when it runs.
-- =============================================================================

ALTER TYPE session_status ADD VALUE IF NOT EXISTS 'ACTIVE';
ALTER TYPE session_status ADD VALUE IF NOT EXISTS 'PAUSED';

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'SESSION_STARTED';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'ROLE_ASSIGNED';