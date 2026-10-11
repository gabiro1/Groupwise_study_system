-- Academic details are collected after account creation, not at signup.
ALTER TABLE student_profiles
  ALTER COLUMN university_id DROP NOT NULL;
