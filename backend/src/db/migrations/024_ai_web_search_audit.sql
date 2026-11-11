-- =============================================================================
-- 024_ai_web_search_audit.sql
-- Lightweight web-research audit metadata. Raw pages and private context are
-- deliberately absent. Search policy remains in environment/settings.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_web_search_events (
  id              uuid PRIMARY KEY DEFAULT gen_uuid(),
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  source_mode     TEXT NOT NULL CHECK (source_mode IN ('LOCAL', 'WEB', 'BOTH', 'AUTO')),
  provider        TEXT,
  query_hash      TEXT NOT NULL CHECK (length(query_hash) BETWEEN 8 AND 128),
  search_count    INTEGER NOT NULL DEFAULT 1 CHECK (search_count >= 0),
  source_domains  TEXT[] NOT NULL DEFAULT '{}'::text[],
  latency_ms      INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  status          TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILURE', 'SKIPPED')),
  error_code      TEXT,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_web_search_events_created_idx
  ON ai_web_search_events (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_web_search_events_actor_idx
  ON ai_web_search_events (actor_id, created_at DESC);
