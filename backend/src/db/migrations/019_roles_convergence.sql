-- 019_roles_convergence.sql
--
-- Converge on exactly three account roles: STUDENT, GROUP_LEADER, ADMIN.
--
-- The retired LECTURER role is removed completely: its role row, the
-- lecturer_courses table, every DDL CHECK that named it, and every historical
-- row that carried it. A GROUP_LEADER role is introduced for accounts that lead
-- at least one active study group, and is backfilled from existing memberships.
--
-- Postgres cannot drop a single value from an existing enum in place, so the
-- `user_role` type is rebuilt. Every column typed `user_role` is detached to
-- text, the type is recreated without LECTURER (and with GROUP_LEADER), and the
-- columns are cast back. All LECTURER data is normalised BEFORE the cast so the
-- rebuild can never fail on a stray value.

-- ---------------------------------------------------------------------------
-- 1. Normalise data that referenced the retired role.
-- ---------------------------------------------------------------------------

-- Accounts that were lecturers become students (they lose no student ability).
UPDATE users
   SET role_id = (SELECT id FROM roles WHERE key = 'STUDENT')
 WHERE role_id = (SELECT id FROM roles WHERE key = 'LECTURER');

-- Lecturer-authored groups/workspaces and audit rows fall back to STUDENT/ADMIN.
UPDATE study_groups SET created_by_role = 'STUDENT' WHERE created_by_role = 'LECTURER';
UPDATE workspaces   SET uploaded_by_role = 'STUDENT' WHERE uploaded_by_role = 'LECTURER';
UPDATE audit_logs   SET actor_role = 'ADMIN' WHERE actor_role = 'LECTURER';

-- The lecturer assignment table is retired entirely.
DROP TABLE IF EXISTS lecturer_courses CASCADE;

-- Joined-via and topic-source CHECKs that named LECTURER-related values.
UPDATE study_group_members SET joined_via = 'DIRECT' WHERE joined_via = 'LECTURER_ASSIGNED';
UPDATE student_topics      SET source = 'SELF'     WHERE source = 'LECTURER';

ALTER TABLE study_groups DROP CONSTRAINT IF EXISTS study_groups_lecturer_created;
ALTER TABLE study_group_members DROP CONSTRAINT IF EXISTS study_group_members_joined_via_check;
ALTER TABLE study_group_members
  ADD CONSTRAINT study_group_members_joined_via_check
  CHECK (joined_via IN ('DIRECT', 'INVITATION', 'JOIN_REQUEST', 'AI_ASSISTED'));
ALTER TABLE student_topics DROP CONSTRAINT IF EXISTS student_topics_source_check;
ALTER TABLE student_topics
  ADD CONSTRAINT student_topics_source_check
  CHECK (source IN ('SELF', 'QUIZ', 'IMPORTED'));

-- ---------------------------------------------------------------------------
-- 2. Rebuild the `user_role` enum without LECTURER, with GROUP_LEADER.
-- ---------------------------------------------------------------------------

ALTER TABLE roles          ALTER COLUMN key             TYPE text;
ALTER TABLE study_groups   ALTER COLUMN created_by_role  TYPE text;
ALTER TABLE workspaces     ALTER COLUMN uploaded_by_role TYPE text;
ALTER TABLE audit_logs     ALTER COLUMN actor_role       TYPE text;

DROP TYPE user_role;

CREATE TYPE user_role AS ENUM ('STUDENT', 'GROUP_LEADER', 'ADMIN');

ALTER TABLE roles          ALTER COLUMN key             TYPE user_role USING key::user_role;
ALTER TABLE study_groups   ALTER COLUMN created_by_role  TYPE user_role USING created_by_role::user_role;
ALTER TABLE workspaces     ALTER COLUMN uploaded_by_role TYPE user_role USING uploaded_by_role::user_role;
ALTER TABLE audit_logs     ALTER COLUMN actor_role       TYPE user_role USING actor_role::user_role;

-- ---------------------------------------------------------------------------
-- 3. Reset the role catalogue and backfill GROUP_LEADER from memberships.
-- ---------------------------------------------------------------------------

DELETE FROM roles WHERE key = 'LECTURER';

INSERT INTO roles (key, label, description)
VALUES ('GROUP_LEADER', 'Group Leader', 'Leads one or more study groups and manages their members.')
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description;

-- Anyone who currently owns or moderates an active group becomes a group leader.
UPDATE users u
   SET role_id = (SELECT id FROM roles WHERE key = 'GROUP_LEADER')
 WHERE u.deleted_at IS NULL
   AND EXISTS (
     SELECT 1
       FROM study_group_members m
       JOIN study_groups g ON g.id = m.group_id
      WHERE m.student_id = u.id
        AND m.left_at IS NULL
        AND m.status = 'ACTIVE'
        AND m.role IN ('OWNER', 'MODERATOR')
        AND g.status = 'ACTIVE'
   );
