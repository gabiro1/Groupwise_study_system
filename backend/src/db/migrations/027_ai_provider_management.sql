-- AI provider management and failover telemetry.
-- Credentials are encrypted by the application before they reach this table.

CREATE TABLE IF NOT EXISTS ai_provider_configs (
  id                         uuid PRIMARY KEY DEFAULT gen_uuid(),
  display_name               TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 120),
  provider_type              TEXT NOT NULL CHECK (provider_type IN ('OPENAI', 'GEMINI', 'OPENROUTER', 'CUSTOM_OPENAI', 'ANTHROPIC')),
  base_url                   TEXT NOT NULL CHECK (length(btrim(base_url)) BETWEEN 8 AND 500),
  model_id                   TEXT NOT NULL CHECK (length(btrim(model_id)) BETWEEN 1 AND 200),
  model_display_name         TEXT,
  credential_ciphertext      TEXT,
  credential_iv              TEXT,
  credential_tag             TEXT,
  priority                   INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 10000),
  timeout_ms                 INTEGER NOT NULL DEFAULT 25000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  enabled                    BOOLEAN NOT NULL DEFAULT TRUE,
  fallback_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  operational_status         TEXT NOT NULL DEFAULT 'UNTESTED' CHECK (operational_status IN ('UNTESTED', 'OPERATIONAL', 'DEGRADED', 'INVALID')),
  last_tested_at             timestamptz,
  credential_rotated_at      timestamptz,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_provider_configs_priority_idx
  ON ai_provider_configs (enabled, fallback_enabled, priority, created_at);

CREATE TABLE IF NOT EXISTS ai_provider_health (
  provider_id                uuid PRIMARY KEY REFERENCES ai_provider_configs(id) ON DELETE CASCADE,
  circuit_state               TEXT NOT NULL DEFAULT 'CLOSED' CHECK (circuit_state IN ('CLOSED', 'OPEN', 'HALF-OPEN')),
  consecutive_failures        INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  total_requests               INTEGER NOT NULL DEFAULT 0 CHECK (total_requests >= 0),
  successful_requests          INTEGER NOT NULL DEFAULT 0 CHECK (successful_requests >= 0),
  failed_requests              INTEGER NOT NULL DEFAULT 0 CHECK (failed_requests >= 0),
  average_latency_ms           NUMERIC,
  last_success_at              timestamptz,
  last_failure_at              timestamptz,
  last_error_code              TEXT,
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER ai_provider_configs_touch BEFORE UPDATE ON ai_provider_configs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS failover_count INTEGER NOT NULL DEFAULT 0 CHECK (failover_count >= 0),
  ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  ADD COLUMN IF NOT EXISTS completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  ADD COLUMN IF NOT EXISTS total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC CHECK (estimated_cost IS NULL OR estimated_cost >= 0);

UPDATE system_settings
   SET value = value || '{"maxFailoverAttempts":3,"fallbackEnabled":true,"failureThreshold":3,"recoveryCooldownMs":30000}'::jsonb
 WHERE key = 'ai.runtime';
