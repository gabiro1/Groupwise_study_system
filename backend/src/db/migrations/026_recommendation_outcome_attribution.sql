-- Preserve the recommendation that led to a group join or partner request.
-- These links are optional for organic actions and are always validated by the
-- service against the caller and target before they are stored.

ALTER TABLE study_group_join_requests
  ADD COLUMN IF NOT EXISTS recommendation_id uuid REFERENCES recommendations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS study_group_join_requests_recommendation_idx
  ON study_group_join_requests (recommendation_id)
  WHERE recommendation_id IS NOT NULL;

ALTER TABLE partner_connections
  ADD COLUMN IF NOT EXISTS recommendation_id uuid REFERENCES recommendations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS partner_connections_recommendation_idx
  ON partner_connections (recommendation_id)
  WHERE recommendation_id IS NOT NULL;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS target_group_id uuid REFERENCES study_groups(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS recommendations_target_group_entity_idx
  ON recommendations (target_group_id, shown_at DESC)
  WHERE target_group_id IS NOT NULL;

UPDATE recommendations r
   SET target_group_id = w.group_id
  FROM workspaces w
 WHERE r.kind = 'GROUP'
   AND r.target_group_id IS NULL
   AND r.target_workspace_id = w.id
   AND w.group_id IS NOT NULL;
