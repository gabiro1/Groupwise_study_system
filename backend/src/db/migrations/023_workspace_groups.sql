-- A workplace is a shared container. A group may be unassigned, and a
-- workplace may contain several groups. Keep workspaces.group_id as the
-- legacy/primary group for older content while the join table becomes the
-- membership boundary for new code.

CREATE TABLE workspace_groups (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_id     uuid NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  assigned_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, group_id)
);

CREATE INDEX workspace_groups_group_idx
  ON workspace_groups (group_id, assigned_at DESC);

CREATE INDEX workspace_groups_workspace_idx
  ON workspace_groups (workspace_id, assigned_at DESC);

-- Preserve every existing relationship. The legacy group_id remains the
-- primary content group, while this row makes the relationship explicit.
INSERT INTO workspace_groups (workspace_id, group_id, assigned_by)
SELECT id, group_id, created_by
  FROM workspaces
 WHERE NOT is_archived
ON CONFLICT (workspace_id, group_id) DO NOTHING;

-- New groups no longer receive an implicit workplace. They can be assigned by
-- an owner/moderator later, which keeps groups and workplaces independent.
CREATE OR REPLACE FUNCTION create_workspace_for_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;
