-- A study group may have multiple active workspaces (for example, separate
-- spaces for different projects or study plans). Each workspace still belongs
-- to exactly one group, and workspace membership is inherited from that group.
DROP INDEX IF EXISTS workspaces_active_group_unique;

CREATE INDEX workspaces_active_group_created_idx
  ON workspaces (group_id, created_at DESC)
  WHERE NOT is_archived;
