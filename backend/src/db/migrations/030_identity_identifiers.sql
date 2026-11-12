-- University identity identifiers.
--
-- Existing student_numbers are preserved. The normalized expression indexes make
-- whitespace/case variants collide without rewriting official records in place.

ALTER TABLE users
  ADD COLUMN staff_identifier citext;

ALTER TABLE student_profiles
  ADD COLUMN admission_year SMALLINT
    CHECK (admission_year IS NULL OR admission_year BETWEEN 1900 AND 2100),
  ADD COLUMN current_semester TEXT
    CHECK (current_semester IS NULL OR length(btrim(current_semester)) BETWEEN 1 AND 40),
  ADD COLUMN registration_number_verified_at timestamptz,
  ADD COLUMN registration_number_verified_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX users_staff_identifier_normalized_unique
  ON users (regexp_replace(upper(staff_identifier::text), '\s+', '', 'g'))
  WHERE staff_identifier IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX student_profiles_registration_number_normalized_unique
  ON student_profiles (regexp_replace(upper(student_number::text), '\s+', '', 'g'))
  WHERE student_number IS NOT NULL;

CREATE INDEX student_profiles_registration_pending_idx
  ON student_profiles (registration_number_verified_at, user_id)
  WHERE student_number IS NOT NULL AND registration_number_verified_at IS NULL;
