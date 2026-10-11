import { queryRows, queryOne } from "../config/db.js";
import { NotFoundError } from "../lib/errors.js";

/**
 * Read-only access to the academic catalogue: universities → faculties →
 * departments → programs → courses → topics, plus skills and goals.
 *
 * Every function here is a single parameterised query. The catalogue is read
 * constantly (onboarding, discovery, filters) and changes rarely, so the schema
 * indexes on `courses(name)`, `courses(department_id)` and
 * `course_topics(course_id, position)` are the ones that matter.
 */

/** Universities, for the registration form. */
export async function listUniversities({ activeOnly = true } = {}) {
  return queryRows(
    `SELECT id, name, code, country, domain, logo_url, is_active
       FROM universities
      WHERE ($1::boolean IS FALSE OR is_active)
      ORDER BY name`,
    [activeOnly],
    "academic:universities",
  );
}

export async function getUniversity(id) {
  const row = await queryOne(
    `SELECT id, name, code, country, domain, logo_url, is_active FROM universities WHERE id = $1`,
    [id],
    "academic:university",
  );
  if (!row) throw new NotFoundError("That university");
  return row;
}

/** Faculties within a university. */
export async function listFaculties(universityId) {
  return queryRows(
    `SELECT id, university_id, name, code FROM faculties WHERE university_id = $1 ORDER BY name`,
    [universityId],
    "academic:faculties",
  );
}

/** Departments within a faculty. */
export async function listDepartments(facultyId) {
  return queryRows(
    `SELECT id, faculty_id, name, code FROM departments WHERE faculty_id = $1 ORDER BY name`,
    [facultyId],
    "academic:departments",
  );
}

/** Programs within a department. */
export async function listPrograms(departmentId) {
  return queryRows(
    `SELECT id, department_id, name, code, degree_level, duration_years
       FROM programs WHERE department_id = $1 ORDER BY name`,
    [departmentId],
    "academic:programs",
  );
}

/**
 * Full programme hierarchy in one round trip.
 *
 * Onboarding needs the whole tree to populate cascading selects without three
 * sequential requests, and the result is small enough to cache at the edge.
 */
export async function getAcademicTree() {
  const rows = await queryRows(
    `SELECT
       u.id   AS university_id, u.name AS university_name, u.code AS university_code,
       u.country AS university_country, u.domain AS university_domain, u.logo_url AS university_logo,
       f.id   AS faculty_id, f.name AS faculty_name, f.code AS faculty_code,
       d.id   AS department_id, d.name AS department_name, d.code AS department_code,
       p.id   AS program_id, p.name AS program_name, p.code AS program_code,
       p.degree_level, p.duration_years
     FROM universities u
     LEFT JOIN faculties   f ON f.university_id = u.id
     LEFT JOIN departments d ON d.faculty_id = f.id
     LEFT JOIN programs    p ON p.department_id = d.id
     WHERE u.is_active
     ORDER BY u.name, f.name, d.name, p.name`,
    [],
    "academic:tree",
  );

  const universities = [];
  for (const row of rows) {
    let university = universities.find((item) => item.id === row.university_id);
    if (!university) {
      university = { id: row.university_id, name: row.university_name, code: row.university_code, country: row.university_country, domain: row.university_domain, logoUrl: row.university_logo, faculties: [] };
      universities.push(university);
    }
    if (!row.faculty_id) continue;

    let faculty = university.faculties.find((item) => item.id === row.faculty_id);
    if (!faculty) {
      faculty = { id: row.faculty_id, name: row.faculty_name, code: row.faculty_code, departments: [] };
      university.faculties.push(faculty);
    }
    if (!row.department_id) continue;

    let department = faculty.departments.find((item) => item.id === row.department_id);
    if (!department) {
      department = { id: row.department_id, name: row.department_name, code: row.department_code, programs: [] };
      faculty.departments.push(department);
    }
    if (!row.program_id) continue;

    department.programs.push({
      id: row.program_id,
      name: row.program_name,
      code: row.program_code,
      degreeLevel: row.degree_level,
      durationYears: row.duration_years,
    });
  }

  return { universities };
}

/**
 * Course search for onboarding and filters.
 *
 * Uses full-text search with a trigram fallback: full-text handles "database
 * systems" and "normalisation" well, but not the typos students actually make
 * ("databse"), which the trigram index covers.
 */
export async function searchCourses({ q, departmentId, limit = 25, offset = 0, activeOnly = true } = {}) {
  const params = [q ?? null, q ?? null, departmentId ?? null, activeOnly];
  return queryRows(
    `SELECT c.id, c.course_code, c.name, c.description, c.credit_hours, c.level,
            d.id AS department_id, d.name AS department_name
       FROM courses c
       LEFT JOIN departments d ON d.id = c.department_id
      WHERE ($4::boolean IS FALSE OR c.is_active)
        AND ($3::uuid IS NULL OR c.department_id = $3)
        AND (
          $1::text IS NULL
          OR c.search_document @@ websearch_to_tsquery('english', $1)
          OR similarity(c.name, $1) > 0.25
          OR c.course_code::text ILIKE '%' || $1 || '%'
        )
      ORDER BY
        CASE WHEN $2::text IS NOT NULL
              THEN ts_rank(c.search_document, websearch_to_tsquery('english', $2))
              ELSE 0 END DESC,
        similarity(c.name, COALESCE($1, '')) DESC,
        c.name
      LIMIT $5 OFFSET $6`,
    [...params.slice(0, 3), activeOnly, limit, offset],
    "academic:courses",
  );
}

export async function getCourse(id) {
  const row = await queryOne(
    `SELECT c.id, c.course_code, c.name, c.description, c.credit_hours, c.level, c.is_active,
            d.id AS department_id, d.name AS department_name,
            f.id AS faculty_id, f.name AS faculty_name,
            u.id AS university_id, u.name AS university_name
       FROM courses c
       LEFT JOIN departments d ON d.id = c.department_id
       LEFT JOIN faculties   f ON f.id = d.faculty_id
       LEFT JOIN universities u ON u.id = f.university_id
      WHERE c.id = $1`,
    [id],
    "academic:course",
  );
  if (!row) throw new NotFoundError("That course");
  return row;
}

/** Courses a student is enrolled in, with their topics attached. */
export async function getStudentCourses(studentId) {
  const courses = await queryRows(
    `SELECT c.id, c.course_code, c.name, c.description, c.credit_hours,
            sc.semester, sc.enrolled_at
       FROM student_courses sc
       JOIN courses c ON c.id = sc.course_id
      WHERE sc.student_id = $1 AND sc.is_active
      ORDER BY c.name`,
    [studentId],
    "academic:studentCourses",
  );

  if (courses.length === 0) return [];

  // One follow-up query rather than one per course — avoids N+1 on a page that
  // renders several course cards with their topics.
  const topics = await queryRows(
    `SELECT ct.course_id, ct.id, ct.name, ct.position, ct.difficulty_index,
            st.status AS my_status
       FROM course_topics ct
       LEFT JOIN student_topics st ON st.topic_id = ct.id AND st.student_id = $2
      WHERE ct.course_id = ANY($1::uuid[])
      ORDER BY ct.course_id, ct.position`,
    [courses.map((course) => course.id), studentId],
    "academic:studentCourseTopics",
  );

  const byCourse = new Map(courses.map((course) => [course.id, []]));
  for (const topic of topics) byCourse.get(topic.course_id)?.push(topic);

  return courses.map((course) => ({ ...course, topics: byCourse.get(course.id) ?? [] }));
}

/** Topics for a course. */
export async function getCourseTopics(courseId) {
  return queryRows(
    `SELECT id, course_id, name, description, position, estimated_minutes, difficulty_index, sample_size
       FROM course_topics WHERE course_id = $1 ORDER BY position, name`,
    [courseId],
    "academic:courseTopics",
  );
}

/** Topics across several courses at once, keyed by course. */
export async function getTopicsForCourses(courseIds) {
  if (!courseIds?.length) return [];
  return queryRows(
    `SELECT ct.id, ct.course_id, c.course_code, c.name AS course_name,
            ct.name, ct.position, ct.estimated_minutes, ct.difficulty_index
       FROM course_topics ct
       JOIN courses c ON c.id = ct.course_id
      WHERE ct.course_id = ANY($1::uuid[])
      ORDER BY ct.course_id, ct.position`,
    [courseIds],
    "academic:topicsForCourses",
  );
}

export async function getTopic(topicId) {
  const row = await queryOne(
    `SELECT ct.id, ct.course_id, ct.name, ct.description, ct.position,
            ct.estimated_minutes, ct.difficulty_index, c.course_code, c.name AS course_name
       FROM course_topics ct
       JOIN courses c ON c.id = ct.course_id
      WHERE ct.id = $1`,
    [topicId],
    "academic:topic",
  );
  if (!row) throw new NotFoundError("That topic");
  return row;
}

/** Skill catalogue, optionally narrowed to skills used by specific courses. */
export async function searchSkills({ q, courseId, limit = 30 } = {}) {
  return queryRows(
    `SELECT s.id, s.name, s.category,
            COALESCE(count(cs.course_id)::int, 0) AS course_count
       FROM skills s
       LEFT JOIN course_skills cs ON cs.skill_id = s.id
      WHERE ($2::uuid IS NULL OR cs.course_id = $2)
        AND ($1::text IS NULL OR s.name::text ILIKE '%' || $1 || '%')
      GROUP BY s.id
      ORDER BY course_count DESC, s.name
      LIMIT $3`,
    [q ?? null, courseId ?? null, limit],
    "academic:skills",
  );
}

/** All skills that map to a set of courses — the student's picker. */
export async function getSkillsForCourses(courseIds) {
  if (!courseIds?.length) return [];
  return queryRows(
    `SELECT s.id, s.name, s.category, cs.course_id
       FROM course_skills cs
       JOIN skills s ON s.id = cs.skill_id
      WHERE cs.course_id = ANY($1::uuid[])
      ORDER BY s.name`,
    [courseIds],
    "academic:skillsForCourses",
  );
}

/** Learning goals, which are a fixed catalogue rather than user-defined. */
export async function listLearningGoals() {
  return queryRows(
    `SELECT id, code, label, description, position
       FROM learning_goals WHERE is_active ORDER BY position, label`,
    [],
    "academic:goals",
  );
}

/** Lookup table used to translate goal codes to labels in one place. */
export async function getGoalMap() {
  const rows = await listLearningGoals();
  return new Map(rows.map((row) => [row.code, row]));
}

export default {
  listUniversities,
  getUniversity,
  listFaculties,
  listDepartments,
  listPrograms,
  getAcademicTree,
  searchCourses,
  getCourse,
  getStudentCourses,
  getCourseTopics,
  getTopicsForCourses,
  getTopic,
  searchSkills,
  getSkillsForCourses,
  listLearningGoals,
  getGoalMap,
};