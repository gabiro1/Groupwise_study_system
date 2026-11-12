-- Global account roles are only STUDENT and ADMIN.
-- Group leadership remains in study_group_members (OWNER/MODERATOR).

-- Existing GROUP_LEADER accounts retain their student capabilities; leadership
-- is re-derived from their active group memberships after this migration.
UPDATE users
   SET role_id = (SELECT id FROM roles WHERE key = 'STUDENT')
 WHERE role_id = (SELECT id FROM roles WHERE key = 'GROUP_LEADER');

UPDATE study_groups
   SET created_by_role = 'STUDENT'
 WHERE created_by_role = 'GROUP_LEADER';

UPDATE resources
   SET uploaded_by_role = 'STUDENT'
 WHERE uploaded_by_role = 'GROUP_LEADER';

UPDATE audit_logs
   SET actor_role = 'STUDENT'
 WHERE actor_role = 'GROUP_LEADER';

DELETE FROM roles WHERE key = 'GROUP_LEADER';

ALTER TABLE roles          ALTER COLUMN key             TYPE text;
ALTER TABLE study_groups   ALTER COLUMN created_by_role  TYPE text;
ALTER TABLE resources      ALTER COLUMN uploaded_by_role TYPE text;
ALTER TABLE audit_logs     ALTER COLUMN actor_role       TYPE text;

ALTER TABLE study_groups   ALTER COLUMN created_by_role  DROP DEFAULT;
ALTER TABLE resources      ALTER COLUMN uploaded_by_role DROP DEFAULT;

DROP TYPE user_role;

CREATE TYPE user_role AS ENUM ('STUDENT', 'ADMIN');

ALTER TABLE roles          ALTER COLUMN key             TYPE user_role USING key::user_role;
ALTER TABLE study_groups   ALTER COLUMN created_by_role  TYPE user_role USING created_by_role::user_role;
ALTER TABLE resources      ALTER COLUMN uploaded_by_role TYPE user_role USING uploaded_by_role::user_role;
ALTER TABLE audit_logs     ALTER COLUMN actor_role       TYPE user_role USING actor_role::user_role;

ALTER TABLE study_groups   ALTER COLUMN created_by_role  SET DEFAULT 'STUDENT';
ALTER TABLE resources      ALTER COLUMN uploaded_by_role SET DEFAULT 'STUDENT';
