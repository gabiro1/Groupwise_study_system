-- =============================================================================
-- 021_admin_console.sql
-- Administrative console: moderation outcomes, group intervention, session
-- cancellation, announcements, AI usage telemetry and structured settings.
--
-- Everything here extends the existing schema. No table is duplicated: roles
-- remain `roles`, moderation remains `reports`, delivery remains `notifications`
-- and configuration remains `system_settings`.
--
-- The enum additions live in 020_admin_enums.sql. PostgreSQL forbids using a
-- value from ALTER TYPE ... ADD VALUE in the same transaction that added it,
-- and this file's CHECK constraints reference 'SUSPENDED'.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Group intervention columns
-- -----------------------------------------------------------------------------
ALTER TABLE study_groups
  ADD COLUMN IF NOT EXISTS suspended_at     timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT,
  ADD COLUMN IF NOT EXISTS suspended_by     uuid REFERENCES users(id) ON DELETE SET NULL;

-- A suspended group must say why. A CHECK keeps the state honest even if a
-- future code path forgets to set the reason.
ALTER TABLE study_groups
  ADD CONSTRAINT study_groups_suspension_reason
  CHECK (status <> 'SUSPENDED' OR (suspended_at IS NOT NULL AND suspended_reason IS NOT NULL));

-- -----------------------------------------------------------------------------
-- Session cancellation attribution
--
-- A cancelled session needs to record *who* cancelled it and why; group leaders
-- and administrators both cancel, and the distinction matters in a dispute.
-- -----------------------------------------------------------------------------
ALTER TABLE study_sessions
  ADD COLUMN IF NOT EXISTS cancelled_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- -----------------------------------------------------------------------------
-- Audit outcome
--
-- The specification requires recording failed administrative actions. An audit
-- row is still immutable: `outcome` is written once at insert and the table
-- already revokes UPDATE/DELETE from PUBLIC.
-- -----------------------------------------------------------------------------
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'SUCCESS';

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_outcome_valid CHECK (outcome IN ('SUCCESS', 'FAILURE', 'PARTIAL'));

CREATE INDEX IF NOT EXISTS audit_logs_outcome_idx ON audit_logs (outcome, created_at DESC);

-- -----------------------------------------------------------------------------
-- Platform announcements
--
-- This is the *draft/schedule* record an administrator edits. Delivery is still
-- performed by the existing notification pipeline: publishing resolves the
-- audience to user ids and calls notifyMany(). No second notification system.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_announcements (
  id            uuid PRIMARY KEY DEFAULT gen_uuid(),
  title         TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  body          TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 3 AND 4000),
  category      TEXT NOT NULL DEFAULT 'GENERAL'
                CHECK (category IN ('GENERAL', 'ACADEMIC', 'MAINTENANCE', 'SECURITY', 'PLATFORM_UPDATE')),
  audience      TEXT NOT NULL DEFAULT 'ALL'
                CHECK (audience IN ('ALL', 'STUDENTS', 'GROUP_LEADERS', 'ADMINS')),
  status        TEXT NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED')),
  scheduled_for timestamptz,
  published_at  timestamptz,
  archived_at   timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A scheduled announcement must have a time; a published one must have been
  -- stamped. Neither check constrains drafts or archives.
  CONSTRAINT admin_announcements_schedule_present
    CHECK (status <> 'SCHEDULED' OR scheduled_for IS NOT NULL),
  CONSTRAINT admin_announcements_publish_stamp
    CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)
);

CREATE TRIGGER admin_announcements_touch BEFORE UPDATE ON admin_announcements
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX IF NOT EXISTS admin_announcements_status_idx
  ON admin_announcements (status, scheduled_for NULLS LAST, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_announcements_due_idx
  ON admin_announcements (scheduled_for)
  WHERE status = 'SCHEDULED';

-- -----------------------------------------------------------------------------
-- AI usage telemetry
--
-- The provider registry knows *whether* AI is configured, but not how often it
-- is used or how often it fails. This append-only table makes the "AI usage"
-- panel real rather than inferred. Rows deliberately contain no prompt or
-- response text: only routing metadata, latency and outcome.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id         uuid PRIMARY KEY DEFAULT gen_uuid(),
  feature    TEXT NOT NULL
             CHECK (feature IN ('ASSISTANT', 'MATCHING', 'INTENT', 'SUMMARY', 'OTHER')),
  provider   TEXT,
  model      TEXT,
  status     TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILURE', 'SKIPPED')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code TEXT,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_events_created_idx ON ai_usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_feature_idx ON ai_usage_events (feature, created_at DESC);

-- -----------------------------------------------------------------------------
-- Structured platform settings
--
-- These rows are created with defaults and never removed by application code.
-- Secret values (AI keys, SMTP password) are deliberately *not* stored here;
-- they remain environment-only. The console masks and reports their presence.
-- -----------------------------------------------------------------------------
INSERT INTO system_settings (key, value, description) VALUES
  ('platform.general',
   '{"name":"TWIGANE","description":"A collaborative study-group platform for university students.","supportEmail":"","maintenanceBanner":""}'::jsonb,
   'Platform identity and contact information.'),
  ('registration.settings',
   '{"enabled":true,"allowedDomains":[],"requireEmailVerification":false}'::jsonb,
   'Who may create an account, and whether verification is required.'),
  ('security.settings',
   '{"passwordMinLength":8,"sessionIdleMinutes":30,"maxLoginAttempts":5,"rateLimitPerMinute":300}'::jsonb,
   'Account and session security policy. Values may only tighten, never weaken, server-enforced limits.'),
  ('maintenance.settings',
   '{"enabled":false,"message":"TWIGANE is temporarily unavailable for scheduled maintenance. Please check back shortly."}'::jsonb,
   'Maintenance mode and the message shown while it is active.'),
  ('notifications.settings',
   '{"platformNotificationsEnabled":true,"emailDeliveryEnabled":false}'::jsonb,
   'Platform notification and email delivery switches.'),
  ('ai.runtime',
   '{"assistantEnabled":true,"matchingEnabled":true,"maxRequestsPerHour":60,"timeoutMs":25000}'::jsonb,
   'Runtime toggles for AI features. Provider credentials remain environment-only.'),
  ('academic.settings',
   '{"semesters":["Semester 1","Semester 2"],"academicYear":"2025/2026"}'::jsonb,
   'Academic calendar labels used by the course register.')
ON CONFLICT (key) DO NOTHING;
