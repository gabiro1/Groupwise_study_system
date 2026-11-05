-- =============================================================================
-- 022_admin_enum_types.sql
-- Promote the administrative vocabularies to native enum types.
--
-- 021 introduced these columns as TEXT + CHECK constraints, which was enough to
-- keep bad values out. The project's convention is stronger: every enum-like
-- vocabulary also exists as a Postgres enum, and `scripts/check-schema.js`
-- enforces that `config/constants.js` and the migrations agree. Converting now
-- keeps that guard meaningful for the new admin surface.
--
-- This runs as its own migration because the columns and their CHECK constraints
-- already exist; a type change has to drop those constraints first.
-- =============================================================================

CREATE TYPE announcement_category AS ENUM (
  'GENERAL',
  'ACADEMIC',
  'MAINTENANCE',
  'SECURITY',
  'PLATFORM_UPDATE'
);

CREATE TYPE announcement_audience AS ENUM (
  'ALL',
  'STUDENTS',
  'GROUP_LEADERS',
  'ADMINS'
);

CREATE TYPE announcement_status AS ENUM (
  'DRAFT',
  'SCHEDULED',
  'PUBLISHED',
  'ARCHIVED'
);

CREATE TYPE ai_usage_feature AS ENUM (
  'ASSISTANT',
  'MATCHING',
  'INTENT',
  'SUMMARY',
  'OTHER'
);

CREATE TYPE ai_usage_status AS ENUM (
  'SUCCESS',
  'FAILURE',
  'SKIPPED'
);

CREATE TYPE audit_outcome AS ENUM (
  'SUCCESS',
  'FAILURE',
  'PARTIAL'
);

-- -----------------------------------------------------------------------------
-- Announcements: drop every expression that compares these columns to a text
-- literal (CHECKs and the partial index) before changing the types, then put
-- them back. A constraint written against a TEXT column stores the literal as
-- text, which is no longer a valid comparison once the column is an enum.
-- -----------------------------------------------------------------------------
ALTER TABLE admin_announcements
  DROP CONSTRAINT IF EXISTS admin_announcements_category_check,
  DROP CONSTRAINT IF EXISTS admin_announcements_audience_check,
  DROP CONSTRAINT IF EXISTS admin_announcements_status_check,
  DROP CONSTRAINT IF EXISTS admin_announcements_schedule_present,
  DROP CONSTRAINT IF EXISTS admin_announcements_publish_stamp;

DROP INDEX IF EXISTS admin_announcements_due_idx;

ALTER TABLE admin_announcements
  ALTER COLUMN category DROP DEFAULT,
  ALTER COLUMN audience DROP DEFAULT,
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE admin_announcements
  ALTER COLUMN category TYPE announcement_category USING category::announcement_category,
  ALTER COLUMN audience TYPE announcement_audience USING audience::announcement_audience,
  ALTER COLUMN status TYPE announcement_status USING status::announcement_status;

ALTER TABLE admin_announcements
  ALTER COLUMN category SET DEFAULT 'GENERAL',
  ALTER COLUMN audience SET DEFAULT 'ALL',
  ALTER COLUMN status SET DEFAULT 'DRAFT';

ALTER TABLE admin_announcements
  ADD CONSTRAINT admin_announcements_schedule_present
    CHECK (status <> 'SCHEDULED' OR scheduled_for IS NOT NULL),
  ADD CONSTRAINT admin_announcements_publish_stamp
    CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS admin_announcements_due_idx
  ON admin_announcements (scheduled_for)
  WHERE status = 'SCHEDULED';

-- -----------------------------------------------------------------------------
-- AI usage telemetry.
-- -----------------------------------------------------------------------------
ALTER TABLE ai_usage_events
  DROP CONSTRAINT IF EXISTS ai_usage_events_feature_check,
  DROP CONSTRAINT IF EXISTS ai_usage_events_status_check;

ALTER TABLE ai_usage_events
  ALTER COLUMN feature TYPE ai_usage_feature USING feature::ai_usage_feature,
  ALTER COLUMN status TYPE ai_usage_status USING status::ai_usage_status;

-- -----------------------------------------------------------------------------
-- Audit outcome.
-- -----------------------------------------------------------------------------
ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_outcome_valid;

ALTER TABLE audit_logs
  ALTER COLUMN outcome DROP DEFAULT,
  ALTER COLUMN outcome TYPE audit_outcome USING outcome::audit_outcome,
  ALTER COLUMN outcome SET DEFAULT 'SUCCESS';
