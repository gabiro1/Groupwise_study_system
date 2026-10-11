-- =============================================================================
-- Lien â€” 002_academic.sql
-- The university hierarchy, courses, topics, skills, and everything a student
-- declares about themselves. This is the substrate the matching engine reads.
-- =============================================================================

-- btree_gist is required so that `=` and `&&` can be mixed in one exclusion
-- constraint (used to reject overlapping availability slots).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =============================================================================
-- University â†’ Faculty â†’ Department â†’ Program
--
-- Split into separate tables rather than one denormalised tree because each
-- level is queried independently (e.g. "all departments in faculty X" when a
-- student picks a programme) and each is independently admin-managed.
-- =============================================================================

CREATE TABLE universities (
  id          uuid PRIMARY KEY DEFAULT gen_uuid(),
  name        TEXT NOT NULL,
  code        citext NOT NULL UNIQUE,
  country     TEXT NOT NULL DEFAULT 'Malaysia',
  domain      citext,             -- e.g. student.upm.edu.my â€” enables domain-restricted signup
  logo_url    TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER universities_touch BEFORE UPDATE ON universities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE faculties (
  id            uuid PRIMARY KEY DEFAULT gen_uuid(),
  university_id uuid NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  code          citext NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faculties_code_per_university UNIQUE (university_id, code)
);

CREATE INDEX faculties_university_idx ON faculties (university_id, name);

CREATE TABLE departments (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  faculty_id   uuid NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  code         citext NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT departments_code_per_faculty UNIQUE (faculty_id, code)
);

CREATE INDEX departments_faculty_idx ON departments (faculty_id, name);

CREATE TABLE programs (
  id            uuid PRIMARY KEY DEFAULT gen_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  code          citext NOT NULL,
  degree_level  TEXT NOT NULL DEFAULT 'UNDERGRADUATE'
                CHECK (degree_level IN ('FOUNDATION', 'DIPLOMA', 'UNDERGRADUATE', 'POSTGRADUATE')),
  duration_years SMALLINT CHECK (duration_years IS NULL OR duration_years BETWEEN 1 AND 10),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT programs_code_per_department UNIQUE (department_id, code)
);

CREATE INDEX programs_department_idx ON programs (department_id, name);

-- =============================================================================
-- Courses
--
-- `course_code` is the human-facing identifier (e.g. CS2309) that students and
-- lecturers actually recognise.
-- =============================================================================

CREATE TABLE courses (
  id             uuid PRIMARY KEY DEFAULT gen_uuid(),
  department_id  uuid REFERENCES departments(id) ON DELETE SET NULL,
  course_code    citext NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  credit_hours   SMALLINT CHECK (credit_hours IS NULL OR credit_hours BETWEEN 1 AND 12),
  level          SMALLINT CHECK (level IS NULL OR level BETWEEN 100 AND 900),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT courses_code_shape CHECK (course_code ~ '^[A-Za-z0-9]{2,4}\s?\d{3,4}[A-Za-z]?$')
);

CREATE TRIGGER courses_touch BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX courses_department_idx ON courses (department_id, name) WHERE is_active;
CREATE INDEX courses_active_name_idx ON courses (name) WHERE is_active;

-- Searchable document for trigram/fuzzy course-name lookup on the onboarding
-- and discovery screens.
ALTER TABLE courses ADD COLUMN search_document tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(course_code, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX courses_search_idx ON courses USING GIN (search_document);

-- =============================================================================
-- Course topics â€” the syllabus units that carry difficulty.
--
-- `difficulty_index` is the aggregate of cohort quiz/self-assessment data, not
-- an opinion. Until enough data exists it is NULL and the UI says so honestly
-- rather than inventing a number.
-- =============================================================================

CREATE TABLE course_topics (
  id                uuid PRIMARY KEY DEFAULT gen_uuid(),
  course_id         uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  position          SMALLINT NOT NULL DEFAULT 0,
  estimated_minutes SMALLINT CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  difficulty_index  NUMERIC(4,3) CHECK (difficulty_index IS NULL OR difficulty_index BETWEEN 0 AND 1),
  sample_size       INTEGER NOT NULL DEFAULT 0,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_topics_unique_name UNIQUE (course_id, name)
);

CREATE INDEX course_topics_course_position_idx ON course_topics (course_id, position);
CREATE INDEX course_topics_hardest_idx       ON course_topics (course_id, difficulty_index DESC NULLS LAST);

-- =============================================================================
-- Skills â€” a global, cross-course competence catalogue.
--
-- Kept separate from topics because a skill is a capability ("query
-- optimisation") that recurs across courses, while a topic is a syllabus
-- position scoped to exactly one course.
-- =============================================================================

CREATE TABLE skills (
  id         uuid PRIMARY KEY DEFAULT gen_uuid(),
  name       citext NOT NULL UNIQUE,
  category   TEXT NOT NULL DEFAULT 'GENERAL',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX skills_category_idx ON skills (category, name);

-- Many-to-many: which skills a course actually assesses.
CREATE TABLE course_skills (
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  skill_id  uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (course_id, skill_id)
);

CREATE INDEX course_skills_skill_idx ON course_skills (skill_id, course_id);

-- =============================================================================
-- Lecturer assignments â€” who teaches what.
-- =============================================================================

CREATE TABLE lecturer_courses (
  id          uuid PRIMARY KEY DEFAULT gen_uuid(),
  lecturer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  academic_year TEXT NOT NULL DEFAULT 'default',
  is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lecturer_courses_unique UNIQUE (lecturer_id, course_id, academic_year)
);

CREATE INDEX lecturer_courses_course_idx ON lecturer_courses (course_id, lecturer_id);

-- =============================================================================
-- Student academic standing
-- =============================================================================

CREATE TABLE student_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  university_id    uuid NOT NULL REFERENCES universities(id) ON DELETE RESTRICT,
  program_id       uuid REFERENCES programs(id) ON DELETE SET NULL,
  year_of_study    SMALLINT NOT NULL DEFAULT 1 CHECK (year_of_study BETWEEN 1 AND 12),
  student_number   citext,
  bio              TEXT CHECK (bio IS NULL OR length(bio) <= 600),
  profile_photo_url TEXT,
  onboarding_step  SMALLINT NOT NULL DEFAULT 0 CHECK (onboarding_step BETWEEN 0 AND 7),
  onboarding_done  BOOLEAN NOT NULL DEFAULT FALSE,
  last_active_at   timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER student_profiles_touch BEFORE UPDATE ON student_profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX student_profiles_university_idx ON student_profiles (university_id, year_of_study);
CREATE INDEX student_profiles_program_idx    ON student_profiles (program_id);
CREATE INDEX student_profiles_active_idx     ON student_profiles (last_active_at DESC);
CREATE UNIQUE INDEX student_profiles_number_unique ON student_profiles (student_number)
  WHERE student_number IS NOT NULL;

-- =============================================================================
-- Enrolments
-- =============================================================================

CREATE TABLE student_courses (
  id             uuid PRIMARY KEY DEFAULT gen_uuid(),
  student_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id      uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  semester       TEXT NOT NULL DEFAULT 'default',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  enrolled_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_courses_unique UNIQUE (student_id, course_id, semester)
);

-- Both directions are queried: "my courses" and "students in this course".
CREATE INDEX student_courses_student_idx ON student_courses (student_id, is_active);
CREATE INDEX student_courses_course_idx  ON student_courses (course_id, is_active);

-- =============================================================================
-- Self-declared skill proficiency.
--
-- `scope` lets a student say "Advanced at SQL, but only in Database Systems",
-- which is far more useful than a single global number.
-- =============================================================================

CREATE TABLE student_skills (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id     uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  course_id    uuid REFERENCES courses(id) ON DELETE CASCADE,
  proficiency  proficiency_level NOT NULL,
  confidence   SMALLINT NOT NULL DEFAULT 3 CHECK (confidence BETWEEN 1 AND 5),
  is_learning  BOOLEAN NOT NULL DEFAULT FALSE,  -- "I want to improve this"
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per (student, skill, course-scope). A table-level UNIQUE constraint
-- cannot express this because `COALESCE` is an expression, not a column, so it
-- has to be a unique index. The sentinel UUID stands in for "global scope" so
-- that the SQL NULL in `course_id` does not make every global row distinct.
CREATE UNIQUE INDEX student_skills_unique
  ON student_skills (student_id, skill_id, COALESCE(course_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX student_skills_student_idx ON student_skills (student_id);
CREATE INDEX student_skills_skill_idx   ON student_skills (skill_id, student_id);
CREATE INDEX student_skills_course_idx  ON student_skills (course_id, proficiency);

-- =============================================================================
-- Topic self-assessment â€” strengths and weaknesses.
--
-- This table is the single most important input to the complementarity model.
-- `status` records what the student wants/needs; `self_rating` records how
-- confident they currently are. The gap between the two drives recommendations.
-- =============================================================================

CREATE TABLE student_topics (
  id            uuid PRIMARY KEY DEFAULT gen_uuid(),
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id      uuid NOT NULL REFERENCES course_topics(id) ON DELETE CASCADE,
  status        topic_status NOT NULL,
  self_rating   NUMERIC(3,2) CHECK (self_rating IS NULL OR self_rating BETWEEN 0 AND 1),
  note          TEXT CHECK (note IS NULL OR length(note) <= 300),
  source        TEXT NOT NULL DEFAULT 'SELF'
                CHECK (source IN ('SELF', 'QUIZ', 'LECTURER', 'IMPORTED')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_topics_unique UNIQUE (student_id, topic_id)
);

CREATE INDEX student_topics_student_idx ON student_topics (student_id, status);
CREATE INDEX student_topics_topic_idx   ON student_topics (topic_id, status);
CREATE INDEX student_topics_gaps_idx    ON student_topics (student_id) WHERE status IN ('NEEDS_HELP', 'LEARNING');
CREATE INDEX student_topics_assets_idx  ON student_topics (student_id) WHERE status IN ('COMFORTABLE', 'STRONG');

-- =============================================================================
-- Learning goals
-- =============================================================================

CREATE TABLE learning_goals (
  id          uuid PRIMARY KEY DEFAULT gen_uuid(),
  code        learning_goal_code NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    SMALLINT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE student_learning_goals (
  student_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id     uuid NOT NULL REFERENCES learning_goals(id) ON DELETE CASCADE,
  priority    SMALLINT NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 5),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, goal_id)
);

CREATE INDEX student_learning_goals_goal_idx ON student_learning_goals (goal_id, student_id);

-- =============================================================================
-- Availability â€” the core scheduling signal.
--
-- Stored as minute offsets from midnight local time rather than timestamps:
-- a weekly recurring slot has no meaningful absolute instant, and comparing
-- overlaps is then pure integer arithmetic.
-- =============================================================================

CREATE TABLE student_availability (
  id           uuid PRIMARY KEY DEFAULT gen_uuid(),
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_minute SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   SMALLINT NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  is_preferred BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_availability_valid_range CHECK (end_minute > start_minute),
  -- Overlap is expressed over the raw minute integers with `int4range`, not over
  -- timestamps. An earlier version built a `tstzrange` from a fixed epoch plus an
  -- interval, which PostgreSQL rejects here: `tstzrange` is STABLE rather than
  -- IMMUTABLE because its result depends on the session TimeZone, and expressions
  -- in an index must be IMMUTABLE. Comparing integer minutes is also a truer
  -- expression of the rule - there is no date involved to get wrong, and no
  -- DST edge case to reason about.
  CONSTRAINT student_availability_no_overlap
    EXCLUDE USING gist (student_id WITH =, day_of_week WITH =,
                       int4range(start_minute, end_minute, '[)') WITH &&)
);

CREATE INDEX student_availability_lookup_idx ON student_availability (student_id, day_of_week, start_minute);

-- =============================================================================
-- Study preferences
-- =============================================================================

CREATE TABLE study_preferences (
  student_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferred_mode   study_mode NOT NULL DEFAULT 'EITHER',
  preferred_style  study_style NOT NULL DEFAULT 'MIXED',
  min_group_size   SMALLINT NOT NULL DEFAULT 3 CHECK (min_group_size BETWEEN 2 AND 12),
  max_group_size   SMALLINT NOT NULL DEFAULT 6 CHECK (max_group_size BETWEEN 2 AND 12),
  session_minutes  SMALLINT NOT NULL DEFAULT 120 CHECK (session_minutes BETWEEN 30 AND 480),
  weekly_goal_hours SMALLINT NOT NULL DEFAULT 4 CHECK (weekly_goal_hours BETWEEN 0 AND 60),
  preferred_days   SMALLINT[] NOT NULL DEFAULT '{}',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT study_preferences_size_order CHECK (max_group_size >= min_group_size)
);

CREATE TRIGGER study_preferences_touch BEFORE UPDATE ON study_preferences
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();