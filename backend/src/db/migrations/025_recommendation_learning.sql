-- =============================================================================
-- 025_recommendation_learning.sql
-- Versioned learning-to-rank metadata, readiness history and bounded student
-- personalization. Runtime artifacts and exported rows remain outside source
-- control; these tables store metadata and aggregate summaries only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Versioned feature schemas
-- ----------------------------------------------------------------------------
CREATE TABLE recommendation_feature_schemas (
  version        TEXT PRIMARY KEY,
  schema         JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  failure_reason TEXT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER recommendation_feature_schemas_touch
  BEFORE UPDATE ON recommendation_feature_schemas
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

INSERT INTO recommendation_feature_schemas (version, schema, status)
VALUES (
  'recommendation-features-v1',
  '{
    "algorithm": "LIGHTGBM_LAMBDAMART",
    "features": [
      "shared_course_count", "same_programme", "course_compatibility",
      "skill_complementarity", "topic_similarity", "goal_compatibility",
      "availability_overlap", "mode_compatibility", "style_compatibility",
      "session_length_compatibility", "preference_compatibility",
      "group_size_compatibility", "activity_compatibility",
      "candidate_activity_score", "group_dormancy", "capacity_available_ratio",
      "group_age_days", "profile_confidence", "profile_fields_completed",
      "candidate_type_group", "requester_prior_accepted_count",
      "requester_helpful_feedback_rate", "requester_group_retention_rate"
    ],
    "excluded": [
      "gender", "religion", "race", "ethnicity", "disability", "password",
      "token", "private_message", "raw_name", "raw_email"
    ]
  }'::jsonb,
  'ACTIVE'
)
ON CONFLICT (version) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Training and evaluation runs
-- -----------------------------------------------------------------------------
CREATE TABLE recommendation_training_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_uuid(),
  version               TEXT NOT NULL,
  schema_version        TEXT NOT NULL DEFAULT 'recommendation-training-v1',
  feature_schema_version TEXT NOT NULL REFERENCES recommendation_feature_schemas(version),
  dataset_kind          TEXT NOT NULL DEFAULT 'REAL'
                        CHECK (dataset_kind IN ('REAL', 'SYNTHETIC')),
  status                TEXT NOT NULL DEFAULT 'EXPORT_REQUESTED'
                        CHECK (status IN ('EXPORT_REQUESTED', 'EXPORTING', 'TRAINING',
                                           'EVALUATED', 'READY', 'FAILED', 'REJECTED')),
  data_start_at         timestamptz,
  data_end_at           timestamptz,
  row_count             INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  unique_student_count  INTEGER NOT NULL DEFAULT 0 CHECK (unique_student_count >= 0),
  unique_request_count  INTEGER NOT NULL DEFAULT 0 CHECK (unique_request_count >= 0),
  positive_label_count  INTEGER NOT NULL DEFAULT 0 CHECK (positive_label_count >= 0),
  negative_label_count  INTEGER NOT NULL DEFAULT 0 CHECK (negative_label_count >= 0),
  label_distribution    JSONB NOT NULL DEFAULT '{}'::jsonb,
  training_metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_metrics    JSONB NOT NULL DEFAULT '{}'::jsonb,
  test_metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,
  baseline_metrics     JSONB NOT NULL DEFAULT '{}'::jsonb,
  fairness_checks      JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_checksum     TEXT,
  application_version   TEXT,
  git_commit            TEXT,
  failure_reason        TEXT,
  audit_metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recommendation_training_runs_status_idx
  ON recommendation_training_runs (status, created_at DESC);

CREATE TRIGGER recommendation_training_runs_touch
  BEFORE UPDATE ON recommendation_training_runs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- Validated model metadata. The artifact URI is a deployment-local path or
-- object-store key, never a copy of student rows.
-- ---------------------------------------------------------------------------- -
CREATE TABLE recommendation_model_artifacts (
  id                    uuid PRIMARY KEY DEFAULT gen_uuid(),
  model_version         TEXT NOT NULL UNIQUE,
  version               TEXT NOT NULL DEFAULT 'recommendation-artifact-v1',
  algorithm             TEXT NOT NULL CHECK (algorithm IN ('LIGHTGBM_LAMBDAMART')),
  feature_schema_version TEXT NOT NULL REFERENCES recommendation_feature_schemas(version),
  training_run_id       uuid REFERENCES recommendation_training_runs(id) ON DELETE SET NULL,
  artifact_uri          TEXT NOT NULL,
  artifact_checksum     TEXT NOT NULL,
  manifest              JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'VALIDATED', 'ACTIVE', 'DEACTIVATED', 'REJECTED')),
  failure_reason        TEXT,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  activated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  deactivated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz,
  deactivated_at        timestamptz
);

CREATE UNIQUE INDEX recommendation_model_artifacts_active_idx
  ON recommendation_model_artifacts (status) WHERE status = 'ACTIVE';

CREATE INDEX recommendation_model_artifacts_history_idx
  ON recommendation_model_artifacts (created_at DESC);

CREATE TRIGGER recommendation_model_artifacts_touch
  BEFORE UPDATE ON recommendation_model_artifacts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------- -
-- Aggregate student preference summaries. No comments or raw message text are
-- retained here; feature means and counts are sufficient for bounded adjustment.
-- ---------------------------------------------------------------------------- -
CREATE TABLE student_recommendation_profiles (
  student_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version                 TEXT NOT NULL DEFAULT 'personalization-v1',
  event_count             INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  accepted_count          INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count          INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  feedback_count          INTEGER NOT NULL DEFAULT 0 CHECK (feedback_count >= 0),
  retained_count          INTEGER NOT NULL DEFAULT 0 CHECK (retained_count >= 0),
  helpful_feedback_rate   NUMERIC(5,4) NOT NULL DEFAULT 0.5 CHECK (helpful_feedback_rate BETWEEN 0 AND 1),
  retention_rate          NUMERIC(5,4) NOT NULL DEFAULT 0.5 CHECK (retention_rate BETWEEN 0 AND 1),
  feature_preferences     JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason_counts           JSONB NOT NULL DEFAULT '{}'::jsonb,
  successful_types        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_event_at           timestamptz,
  status                  TEXT NOT NULL DEFAULT 'COLD_START'
                          CHECK (status IN ('COLD_START', 'ACTIVE', 'STALE', 'FAILED')),
  failure_reason          TEXT,
  created_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX student_recommendation_profiles_status_idx
  ON student_recommendation_profiles (status, updated_at DESC);

CREATE TRIGGER student_recommendation_profiles_touch
  BEFORE UPDATE ON student_recommendation_profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------- -
-- Capture which model actually served a request. The old model_version_id still
-- points at the weighted configuration used for the auditable baseline.
-- ---------------------------------------------------------------------------- -
ALTER TABLE recommendation_requests
  ADD COLUMN IF NOT EXISTS serving_model_version TEXT,
  ADD COLUMN IF NOT EXISTS algorithm TEXT NOT NULL DEFAULT 'WEIGHTED_SCORING'
    CHECK (algorithm IN ('WEIGHTED_SCORING', 'PERSONALIZED_WEIGHTED_SCORING',
                         'LEARNING_TO_RANK', 'LEARNING_TO_RANK_WITH_PERSONALIZATION')),
  ADD COLUMN IF NOT EXISTS feature_schema_version TEXT,
  ADD COLUMN IF NOT EXISTS personalized BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS training_data_ready BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS model_degraded BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fallback_reason TEXT;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS baseline_score NUMERIC(5,2)
    CHECK (baseline_score IS NULL OR baseline_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS personalization_adjustment NUMERIC(6,2) NOT NULL DEFAULT 0
    CHECK (personalization_adjustment BETWEEN -100 AND 100),
  ADD COLUMN IF NOT EXISTS feature_values JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX recommendations_algorithm_idx
  ON recommendation_requests (algorithm, created_at DESC);
