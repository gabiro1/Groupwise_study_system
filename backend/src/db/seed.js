/**
 * Seed data.
 *
 * Two layers, deliberately separated:
 *
 * 1. **Reference data** (roles, goals, universities, courses, topics, skills, the
 *    active model version) is required for the app to work at all. It is
 *    idempotent and safe to run against any database.
 * 2. **Demo data** (accounts, a study group, a workspace with tasks and sessions) is
 *    only written when `SEED_DEMO_DATA=true`, because it creates real accounts with
 *    real-looking names and a known password.
 *
 * Everything is idempotent: re-running converges rather than duplicating. That
 * matters because the first thing anyone does with a new checkout is run the seed
 * twice.
 *
 * Reference data is written with `ON CONFLICT ... DO UPDATE` against the natural
 * key (code, email, slug) rather than against a generated id, because the ids are
 * created by the database and are not known ahead of time.
 */

import { queryRows, queryOne, withTransaction, closePool } from "../config/db.js";
import { hashPassword } from "../lib/crypto.js";
import { DEFAULT_WEIGHTS } from "../lib/weights.js";
import { LEARNING_GOALS, LEARNING_GOAL_LABELS } from "../config/constants.js";

/** Deterministic ids for the demo dataset, so re-running updates rather than adds. */
const DEMO_PASSWORD = "Lien!2026";

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const ROLES = [
  { key: "STUDENT", label: "Student", description: "Matches, joins groups, collaborates." },
  { key: "LECTURER", label: "Lecturer", description: "Course aggregates and activities." },
  { key: "ADMIN", label: "Administrator", description: "Platform administration and moderation." },
];

const GOAL_DESCRIPTIONS = {
  EXAM_PREPARATION: "Work through past papers and consolidate before an exam.",
  ASSIGNMENT: "Get a group project or assignment over the line.",
  IMPROVE_UNDERSTANDING: "Fill in the parts of the course that never quite clicked.",
  PRACTICE: "Solve more problems, especially the hard ones.",
  PEER_TEACHING: "Explain concepts to others to find the gaps in your own understanding.",
  GENERAL_REVISION: "Keep the whole course fresh rather than cramming.",
  RESEARCH_PROJECT: "Make progress on a final-year or postgraduate project.",
};

const UNIVERSITIES = [
  {
    name: "Universiti Teknologi Malaysia",
    code: "UTM",
    country: "Malaysia",
    domain: "student.utm.edu.my",
    faculties: [
      {
        name: "Faculty of Computing, Engineering and Technology",
        code: "FKUKP",
        departments: [
          {
            name: "School of Computer Science",
            code: "SCS",
            programs: [
              { name: "Bachelor of Information Technology", code: "BIT", level: "UNDERGRADUATE", years: 4 },
              { name: "Bachelor of Information Systems", code: "BIS", level: "UNDERGRADUATE", years: 4 },
            ],
          },
          {
            name: "School of Mathematical Sciences",
            code: "SMATHS",
            programs: [
              { name: "Bachelor of Science (Mathematics)", code: "BSMATH", level: "UNDERGRADUATE", years: 4 },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "University of Malaya",
    code: "UM",
    country: "Malaysia",
    domain: "student.um.edu.my",
    faculties: [
      {
        name: "Faculty of Computer Science and Technology",
        code: "FCST",
        departments: [
          {
            name: "Department of Computer Science",
            code: "DCS",
            programs: [
              { name: "Bachelor of Computer Science", code: "BCS", level: "UNDERGRADUATE", years: 4 },
            ],
          },
        ],
      },
    ],
  },
];

// A deliberately small course catalogue: enough for recommendations to have
// something to rank, small enough to read in one sitting.
const COURSES = [
  {
    code: "SCS 2103",
    name: "Database Systems",
    description: "Relational modelling, SQL, normalisation, transactions and indexing.",
    creditHours: 3,
    level: 200,
    department: "DCS",
    topics: [
      { name: "Normalisation", difficulty: 0.55 },
      { name: "SQL Querying", difficulty: 0.4 },
      { name: "Transactions and Concurrency", difficulty: 0.75 },
      { name: "Indexing and Query Planning", difficulty: 0.7 },
      { name: "Access Control", difficulty: 0.6 },
    ],
  },
  {
    code: "SCS 2203",
    name: "Operating Systems",
    description: "Processes, scheduling, memory management, concurrency and file systems.",
    creditHours: 3,
    level: 200,
    department: "DCS",
    topics: [
      { name: "Scheduling", difficulty: 0.5 },
      { name: "Memory Management", difficulty: 0.72 },
      { name: "Concurrency", difficulty: 0.68 },
      { name: "File Systems", difficulty: 0.45 },
    ],
  },
  {
    code: "SCS 2303",
    name: "Artificial Intelligence",
    description: "Search, knowledge representation, learning and reasoning.",
    creditHours: 3,
    level: 200,
    department: "DCS",
    topics: [
      { name: "Search", difficulty: 0.5 },
      { name: "Knowledge Representation", difficulty: 0.6 },
      { name: "Supervised Learning", difficulty: 0.55 },
      { name: "Reinforcement Learning", difficulty: 0.78 },
    ],
  },
  {
    code: "SCS 2109",
    name: "Discrete Mathematics",
    description: "Logic, sets, relations, graph theory and counting.",
    creditHours: 3,
    level: 200,
    department: "SCS",
    topics: [
      { name: "Logic and Proof", difficulty: 0.45 },
      { name: "Relations and Functions", difficulty: 0.5 },
      { name: "Graph Theory", difficulty: 0.6 },
      { name: "Counting", difficulty: 0.65 },
    ],
  },
];

const SKILLS = [
  { name: "SQL", category: "TECHNICAL" },
  { name: "Data Modelling", category: "TECHNICAL" },
  { name: "Python", category: "TECHNICAL" },
  { name: "Algorithm Design", category: "TECHNICAL" },
  { name: "Statistics", category: "TECHNICAL" },
  { name: "Technical Writing", category: "SOFT" },
  { name: "Time Management", category: "SOFT" },
  { name: "Explaining Concepts", category: "SOFT" },
  { name: "Note Taking", category: "SOFT" },
  { name: "Exam Technique", category: "SOFT" },
];

const SYSTEM_SETTINGS = [
  {
    key: "matching.default_weights",
    description: "Default scoring weights for new model versions.",
    value: DEFAULT_WEIGHTS,
  },
  {
    key: "matching.ai_disclaimer",
    description: "Shown wherever a compatibility score is displayed.",
    value: {
      text: "Compatibility is calculated from the information students choose to share. It is a suggestion, not a verdict.",
    },
  },
  {
    key: "privacy.hidden_profile_message",
    description: "Response shape for a profile the viewer is not allowed to see.",
    // The same 404 as a missing profile: confirming that a hidden student exists
    // would leak exactly what the privacy setting was meant to protect.
    value: { status: 404, body: { error: { code: "NOT_FOUND", message: "That profile" } } },
  },
];

async function seedRoles() {
  for (const role of ROLES) {
    await queryRows(
      `INSERT INTO roles (key, label, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description
       RETURNING id`,
      [role.key, role.label, role.description],
      "seed:roles",
    );
  }
}

async function seedLearningGoals() {
  let position = 0;

  for (const code of Object.values(LEARNING_GOALS)) {
    position += 1;

    await queryRows(
      `INSERT INTO learning_goals (code, label, description, position, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (code) DO UPDATE
         SET label = EXCLUDED.label, description = EXCLUDED.description, position = EXCLUDED.position
       RETURNING id`,
      [code, LEARNING_GOAL_LABELS[code], GOAL_DESCRIPTIONS[code] ?? "", position],
      "seed:learningGoals",
    );
  }
}

async function seedAcademic() {
  const departments = new Map();

  for (const university of UNIVERSITIES) {
    const row = await queryOne(
      `INSERT INTO universities (name, code, country, domain)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, country = EXCLUDED.country, domain = EXCLUDED.domain
       RETURNING id`,
      [university.name, university.code, university.country, university.domain ?? null],
      "seed:university",
    );

    for (const faculty of university.faculties) {
      const facultyRow = await queryOne(
        `INSERT INTO faculties (university_id, name, code)
         VALUES ($1, $2, $3)
         ON CONFLICT (university_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [row.id, faculty.name, faculty.code],
        "seed:faculty",
      );

      for (const department of faculty.departments) {
        const departmentRow = await queryOne(
          `INSERT INTO departments (faculty_id, name, code)
           VALUES ($1, $2, $3)
           ON CONFLICT (faculty_id, code) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [facultyRow.id, department.name, department.code],
          "seed:department",
        );

        departments.set(department.code, departmentRow.id);

        for (const program of department.programs) {
          await queryRows(
            `INSERT INTO programs (department_id, name, code, degree_level, duration_years)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (department_id, code) DO UPDATE
               SET name = EXCLUDED.name, degree_level = EXCLUDED.degree_level, duration_years = EXCLUDED.duration_years
             RETURNING id`,
            [departmentRow.id, program.name, program.code, program.level, program.years ?? null],
            "seed:program",
          );
        }
      }
    }
  }

  for (const course of COURSES) {
    const courseRow = await queryOne(
      `INSERT INTO courses (department_id, course_code, name, description, credit_hours, level)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (course_code) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description,
             credit_hours = EXCLUDED.credit_hours, level = EXCLUDED.level
       RETURNING id`,
      [
        departments.get(course.department) ?? null,
        course.code,
        course.name,
        course.description,
        course.creditHours,
        course.level,
      ],
      "seed:course",
    );

    let position = 0;
    for (const topic of course.topics) {
      position += 1;

      await queryRows(
        `INSERT INTO course_topics (course_id, name, description, position, difficulty_index)
         VALUES ($1, $2, '', $3, $4)
         ON CONFLICT (course_id, name) DO UPDATE
           SET position = EXCLUDED.position, difficulty_index = EXCLUDED.difficulty_index
         RETURNING id`,
        [courseRow.id, topic.name, position, topic.difficulty],
        "seed:topic",
      );
    }
  }
}

async function seedSkills() {
  for (const skill of SKILLS) {
    await queryRows(
      `INSERT INTO skills (name, category)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category
       RETURNING id`,
      [skill.name, skill.category],
      "seed:skill",
    );
  }
}

async function seedModelVersion() {
  // The active version is what a stored recommendation was scored against, so the
  // id is stored on the row and the UI can say "scored by weighted-v1.0.0".
  await queryRows(
    `INSERT INTO recommendation_model_versions (id, algorithm, description, weights, config, is_active)
     VALUES ('weighted-v1.0.0', 'WEIGHTED_SCORING', $1, $2, $3, TRUE)
     ON CONFLICT (id) DO UPDATE
       SET weights = EXCLUDED.weights, description = EXCLUDED.description, is_active = TRUE, retired_at = NULL
     RETURNING id`,
    [
      "Deterministic weighted scoring. Course, skills, goals, availability, preferences and topics.",
      JSON.stringify(DEFAULT_WEIGHTS),
      JSON.stringify({ version: "1.0.0", ties: "score desc, then created_at desc" }),
    ],
    "seed:modelVersion",
  );

  // Exactly one active version: the engine reads a single row, and two active rows
  // would make a stored recommendation impossible to reproduce.
  await queryRows(
    `UPDATE recommendation_model_versions
        SET is_active = FALSE, retired_at = now()
      WHERE id <> 'weighted-v1.0.0' AND is_active`,
    [],
    "seed:retireOldVersions",
  );
}

async function seedSettings() {
  for (const setting of SYSTEM_SETTINGS) {
    await queryRows(
      `INSERT INTO system_settings (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description
       RETURNING key`,
      [setting.key, JSON.stringify(setting.value), setting.description],
      "seed:setting",
    );
  }
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

const DEMO_USERS = [
  {
    email: "admin@yopmail.com",
    role: "ADMIN",
    firstName: "Amara",
    lastName: "Rahman",
  },
  {
    email: "lecturer@yopmail.com",
    role: "LECTURER",
    firstName: "Wei",
    lastName: "Tan",
  },
  {
    email: "nur@yopmail.com",
    role: "STUDENT",
    firstName: "Nur",
    lastName: "Aisyah",
    profile: {
      university: "UTM",
      program: "BIT",
      year: 3,
      bio: "Third-year IT student. Comfortable with SQL, still suspicious of indexes.",
      discoverable: true,
      mode: "PHYSICAL",
      style: "PROBLEM_SOLVING",
      minGroupSize: 3,
      maxGroupSize: 6,
      sessionMinutes: 120,
      weeklyGoalHours: 6,
      goals: ["EXAM_PREPARATION", "IMPROVE_UNDERSTANDING"],
      skills: [
        { name: "SQL", proficiency: "ADVANCED", confidence: 4 },
        { name: "Data Modelling", proficiency: "INTERMEDIATE", confidence: 3 },
        { name: "Python", proficiency: "INTERMEDIATE", confidence: 3 },
        { name: "Time Management", proficiency: "ADVANCED", confidence: 4 },
        { name: "Note Taking", proficiency: "ADVANCED", confidence: 5 },
        { name: "Explaining Concepts", proficiency: "BEGINNER", confidence: 2, isLearning: true },
      ],
      topics: [
        { course: "SCS 2103", topic: "SQL Querying", status: "STRONG", rating: 0.85 },
        { course: "SCS 2103", topic: "Normalisation", status: "LEARNING", rating: 0.6 },
        { course: "SCS 2103", topic: "Transactions and Concurrency", status: "NEEDS_HELP", rating: 0.25 },
      ],
      availability: [
        { day: 2, start: 540, end: 720 },
        { day: 4, start: 540, end: 720 },
        { day: 6, start: 300, end: 480 },
      ],
    },
  },
  {
    email: "danial@yopmail.com",
    role: "STUDENT",
    firstName: "Danial",
    lastName: "Hakim",
    profile: {
      university: "UTM",
      program: "BIT",
      year: 3,
      bio: "Likes algorithms, tolerates databases. Looking for people who actually do the reading.",
      discoverable: true,
      mode: "ONLINE",
      style: "MIXED",
      minGroupSize: 2,
      maxGroupSize: 4,
      sessionMinutes: 90,
      weeklyGoalHours: 8,
      goals: ["EXAM_PREPARATION", "PRACTICE"],
      skills: [
        { name: "Algorithm Design", proficiency: "ADVANCED", confidence: 5 },
        { name: "Python", proficiency: "ADVANCED", confidence: 4 },
        { name: "Statistics", proficiency: "ADVANCED", confidence: 4 },
        { name: "Exam Technique", proficiency: "INTERMEDIATE", confidence: 3 },
        { name: "Data Modelling", proficiency: "BEGINNER", confidence: 2, isLearning: true },
      ],
      topics: [
        { course: "SCS 2103", topic: "SQL Querying", status: "LEARNING", rating: 0.55 },
        { course: "SCS 2103", topic: "Transactions and Concurrency", status: "STRONG", rating: 0.8 },
        { course: "SCS 2103", topic: "Access Control", status: "STRONG", rating: 0.75 },
        { course: "SCS 2303", topic: "Search", status: "STRONG", rating: 0.8 },
      ],
      availability: [
        { day: 2, start: 600, end: 780 },
        { day: 4, start: 600, end: 780 },
        { day: 6, start: 480, end: 660 },
      ],
    },
  },
  {
    email: "syafiq@yopmail.com",
    role: "STUDENT",
    firstName: "Syafiq",
    lastName: "Hakimi",
    profile: {
      university: "UM",
      program: "BCS",
      year: 3,
      bio: "Struggles with theory, strong with practice. Wants a group that actually finishes things.",
      discoverable: true,
      mode: "EITHER",
      style: "DISCUSS",
      minGroupSize: 3,
      maxGroupSize: 8,
      sessionMinutes: 150,
      weeklyGoalHours: 5,
      goals: ["ASSIGNMENT", "PRACTICE"],
      skills: [
        { name: "Python", proficiency: "ADVANCED", confidence: 4 },
        { name: "Time Management", proficiency: "INTERMEDIATE", confidence: 3 },
        { name: "Technical Writing", proficiency: "INTERMEDIATE", confidence: 3 },
        { name: "Data Modelling", proficiency: "BEGINNER", confidence: 2, isLearning: true },
        { name: "SQL", proficiency: "BEGINNER", confidence: 2, isLearning: true },
      ],
      topics: [
        { course: "SCS 2103", topic: "Normalisation", status: "NEEDS_HELP", rating: 0.3 },
        { course: "SCS 2103", topic: "SQL Querying", status: "NEEDS_HELP", rating: 0.35 },
        { course: "SCS 2109", topic: "Graph Theory", status: "STRONG", rating: 0.8 },
      ],
      availability: [
        { day: 1, start: 960, end: 1140 },
        { day: 3, start: 960, end: 1140 },
        { day: 5, start: 780, end: 1020 },
      ],
    },
  },
  {
    // Deliberately undiscoverable, so there is something in the database that the
    // privacy rules must actually hide.
    email: "private@yopmail.com",
    role: "STUDENT",
    firstName: "Hana",
    lastName: "Sofia",
    profile: {
      university: "UTM",
      program: "BIT",
      year: 4,
      bio: "Profile visibility set to private. Seeded so privacy behaviour is testable.",
      discoverable: false,
      mode: "PHYSICAL",
      style: "QUIET_FOCUS",
      minGroupSize: 2,
      maxGroupSize: 3,
      sessionMinutes: 60,
      weeklyGoalHours: 3,
      goals: ["GENERAL_REVISION"],
      skills: [{ name: "SQL", proficiency: "EXPERT", confidence: 5 }],
      topics: [{ course: "SCS 2103", topic: "Indexing and Query Planning", status: "STRONG", rating: 0.9 }],
      availability: [{ day: 0, start: 600, end: 720 }],
    },
  },
];

async function upsertUser({ email, role, firstName, lastName }, passwordHash) {
  const roleRow = await queryOne("SELECT id FROM roles WHERE key = $1", [role], "seed:roleLookup");

  const user = await queryOne(
    `INSERT INTO users (email, password_hash, role_id, status, first_name, last_name,
                        email_verified_at, password_changed_at)
     VALUES ($1, $2, $3, 'ACTIVE', $4, $5, now(), now())
     -- The conflict target must repeat the index predicate. The email unique index is
       -- partial (WHERE deleted_at IS NULL), and an ON CONFLICT (email) without the
       -- matching WHERE does not designate a usable arbiter index, so Postgres
       -- rejects the statement with 42P10 rather than silently upserting.
       ON CONFLICT (email) WHERE deleted_at IS NULL DO UPDATE
       SET role_id = EXCLUDED.role_id,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           status = 'ACTIVE',
           -- Re-seeding deliberately restores the documented demo password. Without
           -- this the hash stays whatever it was, so the credentials that the seed
           -- script prints silently stop working after a password change.
           password_hash = EXCLUDED.password_hash,
           password_changed_at = now(),
           email_verified_at = COALESCE(users.email_verified_at, now())
     RETURNING id`,
    [email, passwordHash, roleRow.id, firstName, lastName],
    "seed:user",
  );

  return user.id;
}

async function seedDemo() {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const ids = new Map();

  for (const account of DEMO_USERS) {
    ids.set(account.email, await upsertUser(account, passwordHash));
  }

  const universities = new Map(
    (
      await queryRows(
        "SELECT id, code FROM universities",
        [],
        "seed:universities",
      )
    ).map((row) => [row.code, row.id]),
  );

  const programs = new Map(
    (
      await queryRows(
        "SELECT id, code FROM programs",
        [],
        "seed:programs",
      )
    ).map((row) => [row.code, row.id]),
  );

  const courses = new Map(
    (
      await queryRows(
        "SELECT id, course_code FROM courses",
        [],
        "seed:courses",
      )
    ).map((row) => [row.course_code, row.id]),
  );

  const topics = new Map(
    (
      await queryRows(
        `SELECT ct.id, ct.name, c.course_code
           FROM course_topics ct JOIN courses c ON c.id = ct.course_id`,
        [],
        "seed:topics",
      )
    ).map((row) => [`${row.course_code}::${row.name}`, row.id]),
  );

  const skills = new Map(
    (await queryRows("SELECT id, name FROM skills", [], "seed:skills")).map((row) => [row.name, row.id]),
  );

  const goals = new Map(
    (await queryRows("SELECT id, code FROM learning_goals", [], "seed:goals")).map((row) => [
      row.code,
      row.id,
    ]),
  );

  for (const account of DEMO_USERS) {
    const profile = account.profile;
    if (!profile) continue;

    const userId = ids.get(account.email);

    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO student_profiles (user_id, university_id, program_id, year_of_study, bio,
                                       onboarding_step, onboarding_done)
         VALUES ($1, $2, $3, $4, $5, 7, TRUE)
         ON CONFLICT (user_id) DO UPDATE
           SET university_id = EXCLUDED.university_id,
               program_id = EXCLUDED.program_id,
               year_of_study = EXCLUDED.year_of_study,
               bio = EXCLUDED.bio,
               onboarding_done = TRUE`,
        [userId, universities.get(profile.university), programs.get(profile.program) ?? null, profile.year, profile.bio],
        "seed:profile",
      );

      await tx.query(
        `INSERT INTO study_preferences
           (student_id, preferred_mode, preferred_style, min_group_size, max_group_size,
            session_minutes, weekly_goal_hours, preferred_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (student_id) DO UPDATE
           SET preferred_mode = EXCLUDED.preferred_mode,
               preferred_style = EXCLUDED.preferred_style,
               min_group_size = EXCLUDED.min_group_size,
               max_group_size = EXCLUDED.max_group_size,
               session_minutes = EXCLUDED.session_minutes,
               weekly_goal_hours = EXCLUDED.weekly_goal_hours,
               preferred_days = EXCLUDED.preferred_days`,
        [
          userId,
          profile.mode,
          profile.style,
          profile.minGroupSize,
          profile.maxGroupSize,
          profile.sessionMinutes,
          profile.weeklyGoalHours,
          profile.availability.map((slot) => slot.day),
        ],
        "seed:preferences",
      );

      await tx.query(
        `INSERT INTO privacy_settings (user_id, discoverable, profile_visibility, show_full_schedule)
         VALUES ($1, $2, $3, FALSE)
         ON CONFLICT (user_id) DO UPDATE SET discoverable = EXCLUDED.discoverable`,
        [userId, profile.discoverable, profile.discoverable ? "STUDENTS" : "PRIVATE"],
        "seed:privacy",
      );

      for (const skill of profile.skills ?? []) {
        await tx.query(
          `INSERT INTO student_skills (student_id, skill_id, proficiency, confidence, is_learning)
           VALUES ($1, $2, $3, $4, $5)
           -- The real index folds a NULL course_id to a sentinel
           -- UUID, because a plain unique constraint would treat every global-scope
           -- row as distinct. The conflict target must repeat that expression
           -- verbatim, or Postgres cannot find an arbiter index and raises 42P10.
           ON CONFLICT (student_id, skill_id, COALESCE(course_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE
             SET proficiency = EXCLUDED.proficiency,
                 confidence = EXCLUDED.confidence,
                 is_learning = EXCLUDED.is_learning`,
          [userId, skills.get(skill.name), skill.proficiency, skill.confidence, skill.isLearning ?? false],
          "seed:studentSkill",
        );
      }

      for (const topic of profile.topics ?? []) {
        await tx.query(
          `INSERT INTO student_topics (student_id, topic_id, status, self_rating, source)
           VALUES ($1, $2, $3, $4, 'SELF')
           ON CONFLICT (student_id, topic_id) DO UPDATE
             SET status = EXCLUDED.status, self_rating = EXCLUDED.self_rating`,
          [userId, topics.get(`${topic.course}::${topic.topic}`), topic.status, topic.rating],
          "seed:studentTopic",
        );
      }

      for (const goalCode of profile.goals ?? []) {
        await tx.query(
          `INSERT INTO student_learning_goals (student_id, goal_id, priority)
           VALUES ($1, $2, 1)
           ON CONFLICT (student_id, goal_id) DO NOTHING`,
          [userId, goals.get(goalCode)],
          "seed:studentGoal",
        );
      }

      for (const slot of profile.availability ?? []) {
        await tx.query(
          `INSERT INTO student_availability (student_id, day_of_week, start_minute, end_minute)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [userId, slot.day, slot.start, slot.end],
          "seed:availability",
        );
      }
    }, "seed:studentProfile");

    // Enrolments, outside the per-student transaction so one student's data cannot
    // roll back another's.
    for (const topic of profile.topics ?? []) {
      await queryRows(
        `INSERT INTO student_courses (student_id, course_id, semester)
         VALUES ($1, $2, 'default')
         ON CONFLICT (student_id, course_id, semester) DO NOTHING
         RETURNING id`,
        [userId, courses.get(topic.course)],
        "seed:enrolment",
      );
    }
  }

  // The lecturer is assigned to every seeded course so the lecturer endpoints have
  // something to authorise against.
  await queryRows(
    `INSERT INTO lecturer_courses (lecturer_id, course_id, academic_year, is_primary)
     SELECT $1, c.id, 'default', TRUE
       FROM courses c
     ON CONFLICT (lecturer_id, course_id, academic_year) DO NOTHING
     RETURNING id`,
    [ids.get("lecturer@yopmail.com")],
    "seed:lecturerCourses",
  );

  await seedDemoGroup(ids, { courses, topics, goals });
  await seedDemoSecondGroup(ids, { courses, topics, goals });
  await seedDemoPartners(ids);
}

/**
 * One real study group with two members, a workspace, tasks and a session.
 *
 * Inserted with SQL rather than through the services because the seed needs the
 * outcome rows the services create, and duplicating that logic here would mean two
 * places to keep in step. The point of the demo group is that the research
 * endpoints have non-zero numbers to report.
 */
async function seedDemoGroup(ids, { courses, topics, goals }) {
  const ownerId = ids.get("nur@yopmail.com");
  const memberId = ids.get("danial@yopmail.com");
  const hiddenMemberId = ids.get("syafiq@yopmail.com");
  const courseId = courses.get("SCS 2103");

  await withTransaction(async (tx) => {
    const existing = await tx.query("SELECT id FROM study_groups WHERE slug = $1", [
      "database-systems-exam-prep",
    ]);
    let groupId = existing.rows[0]?.id;
    const fresh = !groupId;

    // A fresh database: create the flagship group and its supporting rows.
    if (!groupId) {
      // `study_groups_created_by_role` requires an owner, so one is always supplied.
      const group = await tx.query(
        `INSERT INTO study_groups (slug, name, course_id, goal_id, description, mode, privacy,
                                   min_size, max_size, owner_id, created_by_role, location_hint)
         VALUES ('database-systems-exam-prep', 'Database Systems Exam Prep', $1, $2,
                 'Working through past papers together. We meet twice a week and actually mark each other''s answers.',
                 'EITHER', 'REQUEST_REQUIRED', 3, 8, $3, 'STUDENT', 'Library study room 2')
         RETURNING id`,
        [courseId, goals.get("EXAM_PREPARATION"), ownerId],
        "seed:group",
      );
      groupId = group.rows[0].id;

      for (const topicName of ["SQL Querying", "Transactions and Concurrency"]) {
        await tx.query(
          `INSERT INTO study_group_topics (group_id, topic_id, focus_weight)
           VALUES ($1, $2, 4)`,
          [groupId, topics.get(`SCS 2103::${topicName}`)],
          "seed:groupTopic",
        );
      }

      for (const slot of [
        { day: 2, start: 600, end: 720 },
        { day: 4, start: 600, end: 720 },
      ]) {
        await tx.query(
          `INSERT INTO study_group_schedule (group_id, day_of_week, start_minute, end_minute)
           VALUES ($1, $2, $3, $4)`,
          [groupId, slot.day, slot.start, slot.end],
          "seed:groupSchedule",
        );
      }
    }

    if (!groupId) return;

    // Danial is a co-leader (MODERATOR) rather than a plain member: leadership is a
    // membership permission in this system, and a moderation queue for that group
    // needs at least one actor who can act on it. Recomputed on every seed run so a
    // database seeded under legacy demo emails picks up the current demo accounts.
    for (const [studentId, role, joinedVia] of [
      [ownerId, "OWNER", "DIRECT"],
      [memberId, "MODERATOR", "INVITATION"],
      [hiddenMemberId, "MEMBER", "JOIN_REQUEST"],
    ]) {
      await tx.query(
        `INSERT INTO study_group_members (group_id, student_id, role, status, joined_via)
         VALUES ($1, $2, $3, 'ACTIVE', $4)
         ON CONFLICT (group_id, student_id)
         DO UPDATE SET role = EXCLUDED.role, status = 'ACTIVE', joined_via = EXCLUDED.joined_via`,
        [groupId, studentId, role, joinedVia],
        "seed:membership",
      );
    }

    // Clear leftover memberships from this group's demo students under any earlier
    // demo domain, so the roster never shows duplicate Nur/Danial/Syafiq accounts.
    await tx.query(
      `DELETE FROM study_group_members m
        USING users u
        WHERE m.group_id = $1 AND m.student_id = u.id
          AND split_part(u.email::text, '@', 1) = ANY($2)
          AND u.email::text NOT ILIKE '%@yopmail.com'`,
      [groupId, ["nur", "danial", "syafiq"]],
      "seed:legacyMembers",
    );

    // The group row itself may still name a legacy owner, and a legacy invitee may
    // hold an old pending invitation. Re-point both to the current demo accounts.
    await tx.query(
      "UPDATE study_groups SET owner_id = $2 WHERE id = $1",
      [groupId, ownerId],
      "seed:repointOwner",
    );
    await tx.query(
      `DELETE FROM study_group_invitations i
        USING users u
        WHERE i.invitee_id = u.id AND i.group_id = $1
          AND split_part(u.email::text, '@', 1) = ANY($2)
          AND u.email::text NOT ILIKE '%@yopmail.com'`,
      [groupId, ["nur", "danial", "syafiq", "private"]],
      "seed:legacyInvites",
    );

    // A workspace is created by the trigger on study_groups, so it is read back
    // rather than inserted. Outcome rows are written here because the activity
    // triggers in migration 006 credit a row that already exists; inserting them
    // after the tasks and messages would leave the activity counters at zero.
    const workspace = await tx.query(
      "SELECT id FROM workspaces WHERE group_id = $1 AND NOT is_archived",
      [groupId],
      "seed:workspace",
    );
    const workspaceId = workspace.rows[0]?.id;
    if (workspaceId) {
      for (const [studentId, joinedVia] of [
        [ownerId, "DIRECT"],
        [memberId, "INVITATION"],
        [hiddenMemberId, "JOIN_REQUEST"],
      ]) {
        await tx.query(
          `INSERT INTO group_membership_outcomes (workspace_id, student_id, joined_via)
           VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, student_id)
           DO UPDATE SET joined_via = EXCLUDED.joined_via`,
          [workspaceId, studentId, joinedVia],
          "seed:outcome",
        );
      }
    }

    // Everything below is part of the initial population and would be duplicated
    // (students, tasks, sessions) if it were replayed every seed run.
    if (!fresh) return;

    const plan = await tx.query(
      `INSERT INTO study_plans (workspace_id, title, description, deadline, created_by)
       VALUES ($1, 'Exam revision plan', 'Three weeks to the final.', CURRENT_DATE + 21, $2)
       RETURNING id`,
      [workspaceId, ownerId],
      "seed:plan",
    );

    await tx.query(
      `INSERT INTO tasks (workspace_id, plan_id, title, description, assignee_id, created_by, status, priority)
       VALUES
         ($1, $2, 'Redo 2023 paper Q4 and Q7', 'Focus on the join ordering.', $3, $3, 'TODO', 'HIGH'),
         ($1, $2, 'Write normalisation notes', 'Third normal form, with examples that are not from the textbook.', $4, $4, 'TODO', 'MEDIUM'),
         ($1, $2, 'Indexing reading', 'B-tree vs hash, and when the planner ignores you.', $3, $4, 'COMPLETED', 'MEDIUM')`,
      [workspaceId, plan.rows[0].id, ownerId, memberId],
      "seed:tasks",
    );

    // A session in the future, so the "upcoming" filter has a row to return.
    await tx.query(
      `INSERT INTO study_sessions (workspace_id, plan_id, topic_id, title, starts_at, ends_at,
                                   mode, location, agenda, created_by)
       VALUES ($1, $2, $3, 'Past paper walkthrough',
               date_trunc('hour', now()) + interval '2 days',
               date_trunc('hour', now()) + interval '2 days' + interval '2 hours',
               'PHYSICAL', 'Library study room 2', 'Bring your attempted answers.', $4)`,
      [workspaceId, plan.rows[0].id, topics.get("SCS 2103::SQL Querying"), ownerId],
      "seed:session",
    );
  }, "seed:demoGroup");

  // Invited to Hana, who is *not* a member of the group. Inviting somebody who
  // already holds an active membership would produce an invitation that cannot be
  // acted on without first removing them.
  const inviteeId = ids.get("private@yopmail.com");
  if (inviteeId) {
    await queryRows(
      `INSERT INTO study_group_invitations (group_id, inviter_id, invitee_id, status, message, expires_at)
       SELECT g.id, $1, $2, 'PENDING', 'Want to join the past paper sessions?', now() + interval '7 days'
         FROM study_groups g
        WHERE g.slug = 'database-systems-exam-prep'
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [ownerId, inviteeId],
      "seed:invitation",
    );
  }
}

/**
 * A second group led by Danial, so the leader-overview endpoint and the
 * leadership UI have more than one non-empty row to show. Kept deliberately
 * lighter than the flagship demo group: memberships, topics, outcomes, and the
 * auto-created workspace are enough.
 */
async function seedDemoSecondGroup(ids, { courses, topics, goals }) {
  const leaderId = ids.get("danial@yopmail.com");
  const memberIds = [ids.get("nur@yopmail.com"), ids.get("syafiq@yopmail.com")].filter(Boolean);
  const courseId = courses.get("SCS 2303");
  if (!leaderId || !courseId) return;

  await withTransaction(async (tx) => {
    const existing = await tx.query("SELECT id FROM study_groups WHERE slug = $1", ["ai-study-circle"]);
    if (existing.rows.length > 0) return;

    const group = await tx.query(
      `INSERT INTO study_groups (slug, name, course_id, goal_id, description, mode, privacy,
                                 min_size, max_size, owner_id, created_by_role)
       VALUES ('ai-study-circle', 'AI Study Circle', $1, $2,
               'Working through search, knowledge representation and learning together ahead of the AI midterms.',
               'ONLINE', 'REQUEST_REQUIRED', 3, 6, $3, 'STUDENT')
       RETURNING id`,
      [courseId, goals.get("EXAM_PREPARATION"), leaderId],
      "seed:group2",
    );
    const groupId = group.rows[0].id;

    await tx.query(
      `INSERT INTO study_group_members (group_id, student_id, role, status, joined_via)
       VALUES ($1, $2, 'OWNER', 'ACTIVE', 'DIRECT')
       ON CONFLICT (group_id, student_id) DO NOTHING`,
      [groupId, leaderId],
      "seed:group2Leader",
    );

    for (const studentId of memberIds) {
      await tx.query(
        `INSERT INTO study_group_members (group_id, student_id, role, status, joined_via)
         VALUES ($1, $2, 'MEMBER', 'ACTIVE', 'DIRECT')
         ON CONFLICT (group_id, student_id) DO NOTHING`,
        [groupId, studentId],
        "seed:group2Membership",
      );
    }

    for (const topicName of ["Search", "Knowledge Representation"]) {
      const topicId = topics.get(`SCS 2303::${topicName}`);
      if (!topicId) continue;
      await tx.query(
        `INSERT INTO study_group_topics (group_id, topic_id, focus_weight)
         VALUES ($1, $2, 4)`,
        [groupId, topicId],
        "seed:group2Topic",
      );
    }

    // The workspace is created by a trigger on study_groups; outcome rows are
    // written here for the same reason as in `seedDemoGroup`.
    const workspace = await tx.query(
      "SELECT id FROM workspaces WHERE group_id = $1 AND NOT is_archived",
      [groupId],
      "seed:group2Workspace",
    );
    const workspaceId = workspace.rows[0]?.id;
    if (workspaceId) {
      for (const studentId of [leaderId, ...memberIds]) {
        await tx.query(
          `INSERT INTO group_membership_outcomes (workspace_id, student_id, joined_via)
           VALUES ($1, $2, 'DIRECT')
           ON CONFLICT (workspace_id, student_id) DO NOTHING`,
          [workspaceId, studentId],
          "seed:group2Outcome",
        );
      }
    }
  }, "seed:demoSecondGroup");
}

/**
 * Study-partner connections and their direct conversations.
 *
 * Connections are demo data, so they are inserted with `WHERE NOT EXISTS` on the
 * ordered pair rather than through the service: re-running the seed must not
 * duplicate an existing connection, and the pending-pair partial unique index
 * only guards PENDING rows.
 *
 * Accepted pairs get a two-member direct conversation and a few messages, which
 * is what makes the Messages and Study partners dashboards non-empty for a fresh
 * sign-in.
 */
async function seedDemoPartners(ids) {
  const nur = ids.get("nur@yopmail.com");
  const danial = ids.get("danial@yopmail.com");
  const syafiq = ids.get("syafiq@yopmail.com");
  if (!nur || !danial || !syafiq) return;

  await withTransaction(async (tx) => {
    const addConnection = (requesterId, recipientId, status, message) =>
      tx.query(
        `INSERT INTO partner_connections (requester_id, recipient_id, status, message, requested_at, responded_at)
         SELECT $1, $2, $3::partner_connection_status, $4, now(), CASE WHEN $3 = 'ACCEPTED' THEN now() ELSE NULL END
          WHERE NOT EXISTS (
            SELECT 1 FROM partner_connections WHERE requester_id = $1 AND recipient_id = $2
          )`,
        [requesterId, recipientId, status, message],
        "seed:partnerConnection",
      );

    await addConnection(nur, danial, "ACCEPTED", "We prep for the same database finals — study together?");
    await addConnection(danial, syafiq, "ACCEPTED", "Your algorithm cheat sheets are gold. Pair up?");
    await addConnection(syafiq, nur, "PENDING", "I could really use help with normalisation before the exam.");

    const addConversation = async (firstId, secondId, messages) => {
      const found = await tx.query(
        `SELECT id FROM direct_conversations dc
          WHERE EXISTS (SELECT 1 FROM direct_conversation_members m WHERE m.conversation_id = dc.id AND m.user_id = $1)
            AND EXISTS (SELECT 1 FROM direct_conversation_members m WHERE m.conversation_id = dc.id AND m.user_id = $2)`,
        [firstId, secondId],
        "seed:findConversation",
      );
      let conversationId = found.rows[0]?.id;

      if (!conversationId) {
        const created = await tx.query(
          "INSERT INTO direct_conversations (created_by) VALUES ($1) RETURNING id",
          [firstId],
          "seed:createConversation",
        );
        conversationId = created.rows[0].id;
        await tx.query(
          `INSERT INTO direct_conversation_members (conversation_id, user_id)
           VALUES ($1, $2), ($1, $3)`,
          [conversationId, firstId, secondId],
          "seed:conversationMembers",
        );
      }

      const counted = await tx.query(
        "SELECT count(*)::int AS count FROM direct_messages WHERE conversation_id = $1",
        [conversationId],
        "seed:countMessages",
      );
      if (counted.rows[0].count > 0) return;

      for (const [senderId, body] of messages) {
        await tx.query(
          "INSERT INTO direct_messages (conversation_id, sender_id, body) VALUES ($1, $2, $3)",
          [conversationId, senderId, body],
          "seed:directMessage",
        );
      }
      await tx.query(
        "UPDATE direct_conversations SET last_message_at = now() WHERE id = $1",
        [conversationId],
        "seed:conversationTouch",
      );
    };

    await addConversation(nur, danial, [
      [nur, "Hey Danial! Ready for the past paper session this week?"],
      [danial, "Absolutely — I did Q4 from the 2023 paper. The join ordering was brutal."],
      [nur, "Same. Let me share my normalisation notes before Thursday."],
      [danial, "Perfect, thanks Nur!"],
    ]);

    await addConversation(danial, syafiq, [
      [danial, "Your search algorithm cheat sheet helped a lot last week."],
      [syafiq, "Glad it was useful! Want to review knowledge representation together?"],
      [danial, "Sure, Saturday afternoon works for me."],
    ]);
  }, "seed:demoPartners");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const withDemo = process.env.SEED_DEMO_DATA === "true";

  console.log("Seeding reference data...");

  await seedRoles();
  await seedLearningGoals();
  await seedAcademic();
  await seedSkills();
  await seedModelVersion();
  await seedSettings();

  console.log(`Reference data seeded (${ROLES.length} roles, ${UNIVERSITIES.length} universities, ${COURSES.length} courses).`);

  if (withDemo) {
    console.log("Seeding demo data...");
    await seedDemo();
    console.log(`Demo data seeded. Sign in with any @yopmail.com account and the password: ${DEMO_PASSWORD}`);
  } else {
    console.log("Skipping demo data. Set SEED_DEMO_DATA=true to create sample accounts.");
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nSeed failed: ${error.message}`);
  if (error.code) console.error(`  SQLSTATE ${error.code}`);
  if (error.detail) console.error(`  ${error.detail}`);
  process.exitCode = 1;
} finally {
  await closePool();
}