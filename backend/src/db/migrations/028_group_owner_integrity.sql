-- Keep group ownership aligned with active membership.
--
-- The service layer owns the user-facing transition, but the database must still
-- reject a direct write that would leave an active group without its owner.

-- If legacy data contains more than one active OWNER, preserve the group owner
-- when possible and demote the remaining rows before adding the unique index.
WITH ranked AS (
  SELECT m.id,
         row_number() OVER (
           PARTITION BY m.group_id
           ORDER BY (m.student_id = g.owner_id) DESC, m.joined_at, m.id
         ) AS position
    FROM study_group_members m
    JOIN study_groups g ON g.id = m.group_id
   WHERE m.role = 'OWNER'
     AND m.left_at IS NULL
     AND m.status = 'ACTIVE'
)
UPDATE study_group_members m
   SET role = 'MEMBER'
  FROM ranked r
 WHERE m.id = r.id AND r.position > 1;

-- A group's owner_id is the canonical owner identity. Align it with the one
-- active OWNER membership where old data pointed at a stale membership row.
WITH selected AS (
  SELECT DISTINCT ON (g.id) g.id AS group_id, m.student_id
    FROM study_groups g
    JOIN study_group_members m ON m.group_id = g.id
   WHERE g.status IN ('ACTIVE', 'SUSPENDED')
     AND m.role = 'OWNER'
     AND m.left_at IS NULL
     AND m.status = 'ACTIVE'
   ORDER BY g.id, (m.student_id = g.owner_id) DESC, m.joined_at, m.id
)
UPDATE study_groups g
   SET owner_id = selected.student_id
  FROM selected
 WHERE g.id = selected.group_id;

-- Do not silently carry an ownerless active group into the constrained schema.
-- There is no safe automatic owner choice when legacy data has no valid owner
-- membership, so require an operator to repair that data before deployment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM study_groups g
     WHERE g.status IN ('ACTIVE', 'SUSPENDED')
       AND NOT EXISTS (
         SELECT 1
           FROM study_group_members m
          WHERE m.group_id = g.id
            AND m.student_id = g.owner_id
            AND m.role = 'OWNER'
            AND m.status = 'ACTIVE'
            AND m.left_at IS NULL
       )
  ) THEN
    RAISE EXCEPTION
      'GROUP_OWNER_REQUIRED: repair owner membership before applying migration 028'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE UNIQUE INDEX study_group_members_active_owner_unique
  ON study_group_members (group_id)
  WHERE role = 'OWNER' AND status = 'ACTIVE' AND left_at IS NULL;

CREATE OR REPLACE FUNCTION enforce_study_group_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_group uuid;
BEGIN
  IF TG_TABLE_NAME = 'study_group_members' THEN
    affected_group := COALESCE(NEW.group_id, OLD.group_id);
  ELSE
    affected_group := COALESCE(NEW.id, OLD.id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM study_groups g
     WHERE g.id = affected_group AND g.status IN ('ACTIVE', 'SUSPENDED')
  ) AND NOT EXISTS (
    SELECT 1
      FROM study_groups g
      JOIN study_group_members m
        ON m.group_id = g.id
       AND m.student_id = g.owner_id
       AND m.role = 'OWNER'
       AND m.status = 'ACTIVE'
       AND m.left_at IS NULL
     WHERE g.id = affected_group
  ) THEN
    RAISE EXCEPTION 'GROUP_OWNER_REQUIRED'
      USING ERRCODE = '23514',
            HINT = 'Transfer ownership or close the group before removing its owner.';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER study_group_members_owner_integrity
AFTER INSERT OR UPDATE OR DELETE ON study_group_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_study_group_owner();

CREATE CONSTRAINT TRIGGER study_groups_owner_integrity
AFTER INSERT OR UPDATE OF owner_id, status ON study_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_study_group_owner();
