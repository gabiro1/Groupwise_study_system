-- =============================================================================
-- Video meetings — enum vocabulary
--
-- Separate migration because Postgres forbids *using* a newly added enum value
-- inside the same transaction that added it. The tables in 016 reference these
-- values, so they must already exist when it runs (same pattern as 012).
-- =============================================================================

CREATE TYPE meeting_status AS ENUM ('SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE meeting_provider AS ENUM ('JITSI', 'LIVEKIT', 'NONE');
CREATE TYPE meeting_attendance_status AS ENUM ('JOINED', 'LEFT', 'IN_CALL');

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'MEETING_SCHEDULED';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'MEETING_UPDATED';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'MEETING_CANCELLED';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'MEETING_STARTED';
