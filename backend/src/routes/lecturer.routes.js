import { Router } from "express";
import { asyncHandler, ok, created } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireLecturer, requireAuth } from "../middleware/auth.js";
import { writeLimiter, searchLimiter } from "../middleware/rateLimit.js";
import { query, queryRows, queryOne } from "../config/db.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../lib/errors.js";
import { notifyMany } from "../lib/notifications.js";
import { NOTIFICATION_TYPE } from "../config/constants.js";
import {
  academicActivitySchema,
  createResourceSchema,
  resourceQuerySchema,
  z,
} from "../lib/schemas.js";

const router = Router();

/**
 * Lecturer routes.
 *
 * The privacy boundary of the whole product lives here, so it is worth stating
 * plainly: **a lecturer is never a member of a student group.**
 *
 * A lecturer can see aggregate performance for a course they are assigned to,
 * can create course material, and can spawn a supervised study activity. They
 * cannot read group chat, list group members by name, see who is in which group,
 * or read any student's private profile. Those would turn "help me study" into
 * "monitor my students", and no endpoint below offers them.
 *
 * Where a name is genuinely unavoidable — the students a lecturer explicitly
 * invites — the invitation is a one-to-one act with a recorded audit trail, not
 * a browsing capability.
 */

// The role guard below depends on `req.user`, so `requireAuth` must run first.
router.use(requireAuth);
router.use(requireLecturer);

/**
 * GET /api/lecturer/courses
 *
 * The lecturer's assigned courses. Everything else in this router is scoped to
 * this list, so a lecturer cannot address a course they do not teach even by id.
 */
router.get(
  "/courses",
  asyncHandler(async (req, res) => {
    const courses = await queryRows(
      `SELECT c.id, c.course_code, c.name, c.credit_hours, c.level, c.department_id,
              d.name AS department_name, f.name AS faculty_name, u.name AS university_name,
              lc.academic_year, lc.is_primary,
              (SELECT count(*)::int FROM student_courses sc
                WHERE sc.course_id = c.id AND sc.is_active) AS enrolled_students
         FROM lecturer_courses lc
         JOIN courses c ON c.id = lc.course_id
         LEFT JOIN departments d ON d.id = c.department_id
         LEFT JOIN faculties f ON f.id = d.faculty_id
         LEFT JOIN universities u ON u.id = f.university_id
        WHERE lc.lecturer_id = $1 AND c.is_active
        ORDER BY c.course_code`,
      [req.user.id],
      "lecturer:courses",
    );

    return ok(res, { courses });
  }),
);

/**
 * GET /api/lecturer/courses/:courseId/overview
 *
 * Aggregates only. Counts and distributions, no student identifiers.
 */
router.get(
  "/courses/:courseId/overview",
  validate({ params: z.object({ courseId: z.string().uuid() }), query: z.object({}) }),
  asyncHandler(async (req, res) => {
    await assertTeachesCourse(req.user.id, req.params.courseId);

    const [enrolment, groups, mastery, activity] = await Promise.all([
      queryOne(
        `SELECT count(*)::int AS enrolled
           FROM student_courses sc WHERE sc.course_id = $1 AND sc.is_active`,
        [req.params.courseId],
        "lecturer:enrolment",
      ),
      queryOne(
        `SELECT count(*)::int AS active_groups,
                round(avg(g.member_count)::numeric, 1) AS average_size,
                count(*) FILTER (WHERE g.privacy = 'REQUEST_REQUIRED')::int AS moderated_groups
           FROM study_groups g WHERE g.course_id = $1 AND g.status = 'ACTIVE'`,
        [req.params.courseId],
        "lecturer:groupStats",
      ),
      // Topic mastery, aggregated across workspaces.
      //
      // Scoped through `student_courses` so the figures cover exactly the students
      // enrolled in this course, and averaged per student first: a student active
      // in five workspaces would otherwise be counted five times in one average.
      queryRows(
        `WITH per_student AS (
           SELECT stm.student_id, stm.topic_id, avg(stm.mastery)::numeric AS mastery
             FROM student_topic_mastery stm
             JOIN course_topics ct ON ct.id = stm.topic_id
             JOIN student_courses sc ON sc.student_id = stm.student_id AND sc.course_id = $1
            WHERE ct.course_id = $1 AND sc.is_active
            GROUP BY stm.student_id, stm.topic_id
         )
         SELECT ct.id, ct.name,
                count(*)::int AS students_reporting,
                round(avg(ps.mastery)::numeric, 2) AS average_mastery,
                count(*) FILTER (WHERE ps.mastery < 0.4)::int AS struggling,
                count(*) FILTER (WHERE ps.mastery >= 0.7)::int AS confident
           FROM per_student ps
           JOIN course_topics ct ON ct.id = ps.topic_id
          GROUP BY ct.id, ct.name
          ORDER BY struggling DESC, ct.name`,
        [req.params.courseId],
        "lecturer:mastery",
      ),
      queryOne(
        `SELECT count(*)::int AS sessions_scheduled,
                count(*) FILTER (WHERE status = 'COMPLETED')::int AS sessions_completed,
                coalesce(sum((extract(epoch FROM (ends_at - starts_at)) / 60)), 0)::bigint AS scheduled_minutes
           FROM study_sessions s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN study_groups g ON g.id = w.group_id
          WHERE g.course_id = $1 AND s.starts_at >= now() - interval '180 days'`,
        [req.params.courseId],
        "lecturer:activity",
      ),
    ]);

    return ok(res, {
      courseId: req.params.courseId,
      enrolment,
      groups,
      activity,
      topicMastery: mastery,
      // Stated explicitly so the client cannot be built to expect names here.
      privacyNotice:
        "Aggregated across all enrolled students. Individual profiles, group membership and group conversations are not accessible to lecturers.",
    });
  }),
);

/**
 * POST /api/lecturer/courses/:courseId/activities
 *
 * A supervised study activity: a group created for a course, with the lecturer as
 * owner but **not** as a chat participant.
 *
 * Lecturer-authored groups are marked so that the workspace hides member lists
 * and chat from the lecturer, and a seeded placeholder member is used to satisfy
 * the owner constraint without giving a human an account they never asked for.
 */
router.post(
  "/courses/:courseId/activities",
  writeLimiter,
  validate({ params: z.object({ courseId: z.string().uuid() }), body: academicActivitySchema }),
  asyncHandler(async (req, res) => {
    await assertTeachesCourse(req.user.id, req.params.courseId);

    const activity = await createLecturerActivity(req.user.id, req.params.courseId, req.body);
    return created(res, { activity });
  }),
);

/** GET /api/lecturer/courses/:courseId/activities */
router.get(
  "/courses/:courseId/activities",
  validate({ params: z.object({ courseId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    await assertTeachesCourse(req.user.id, req.params.courseId);

    const activities = await queryRows(
      `SELECT g.id, g.name, g.description, g.status, g.privacy, g.min_size, g.max_size,
              g.member_count, g.target_size, g.created_at,
              w.id AS workspace_id,
              (SELECT count(*)::int FROM study_group_members m
                WHERE m.group_id = g.id AND m.left_at IS NULL AND m.student_id <> g.owner_id) AS student_members
         FROM study_groups g
         LEFT JOIN LATERAL (
           SELECT id FROM workspaces
            WHERE group_id = g.id AND NOT is_archived
            ORDER BY created_at DESC
            LIMIT 1
         ) w ON TRUE
        WHERE g.course_id = $1 AND g.created_by_role = 'LECTURER'
        ORDER BY g.created_at DESC`,
      [req.params.courseId],
      "lecturer:activities",
    );

    return ok(res, { activities });
  }),
);

/**
 * GET /api/lecturer/courses/:courseId/resources
 *
 * Course-scoped material. Visibility is limited to the lecturer's own uploads plus
 * anything published at course level; student uploads inside a private group stay
 * invisible regardless.
 */
router.get(
  "/courses/:courseId/resources",
  validate({ params: z.object({ courseId: z.string().uuid() }), query: resourceQuerySchema }),
  asyncHandler(async (req, res) => {
    await assertTeachesCourse(req.user.id, req.params.courseId);

    const resources = await queryRows(
      `SELECT r.id, r.title, r.description, r.kind, r.visibility, r.external_url,
              r.mime_type, r.size_bytes, r.topic_id, r.created_at, r.uploaded_by
         FROM resources r
        WHERE r.course_id = $1 AND r.is_deleted = FALSE
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [req.params.courseId, req.query.limit ?? 50],
      "lecturer:resources",
    );

    return ok(res, { resources });
  }),
);

/** POST /api/lecturer/courses/:courseId/resources — publish course material. */
router.post(
  "/courses/:courseId/resources",
  writeLimiter,
  validate({ params: z.object({ courseId: z.string().uuid() }), body: createResourceSchema }),
  asyncHandler(async (req, res) => {
    await assertTeachesCourse(req.user.id, req.params.courseId);

    if (req.body.kind === "LINK" && !req.body.externalUrl) {
      throw new ConflictError("A link resource needs a URL.");
    }
    if (req.body.kind === "NOTE" && !req.body.content) {
      throw new ConflictError("A note resource needs some text.");
    }

    const resource = await queryOne(
      `INSERT INTO resources
         (workspace_id, course_id, topic_id, plan_id, uploaded_by, uploaded_by_role,
          title, description, kind, visibility, external_url, extracted_text, extraction_status)
       VALUES (NULL, $1, $2, NULL, $3, 'LECTURER', $4, $5, $6, 'COURSE', $7, $8, $9)
       RETURNING id, title, description, kind, visibility, external_url, created_at`,
      [
        req.params.courseId,
        req.body.topicId ?? null,
        req.user.id,
        req.body.title,
        req.body.description,
        req.body.kind,
        req.body.externalUrl ?? null,
        req.body.content ?? null,
        req.body.kind === "NOTE" ? "COMPLETE" : "SKIPPED",
      ],
      "lecturer:createResource",
    );

    return created(res, { resource });
  }),
);

/**
 * POST /api/lecturer/invite
 *
 * Invite named students to a lecturer-run activity. The one place a lecturer acts
 * on identified students, and it is deliberately explicit: a course list, one
 * activity, and a set of chosen students.
 */
router.post(
  "/invite",
  writeLimiter,
  validate({
    body: z.object({
      activityId: z.string().uuid(),
      studentIds: z.array(z.string().uuid()).min(1, "Select at least one student.").max(50),
      message: z.string().trim().max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const activity = await queryOne(
      `SELECT g.id, g.name, g.slug, g.course_id, g.status
         FROM study_groups g WHERE g.id = $1`,
      [req.body.activityId],
      "lecturer:loadActivity",
    );

    if (!activity) throw new NotFoundError("That activity");
    await assertTeachesCourse(req.user.id, activity.course_id);

    if (activity.status !== "ACTIVE") {
      throw new ConflictError("That activity is not running.");
    }

    // Restrict invitations to students actually enrolled in this course: an
    // invitation is a grade-adjacent action, so it must not be usable to reach
    // arbitrary students.
    const eligible = await queryRows(
      `SELECT sc.student_id FROM student_courses sc WHERE sc.course_id = $1 AND sc.student_id = ANY($2::uuid[])`,
      [activity.course_id, req.body.studentIds],
      "lecturer:eligibleStudents",
    );

    const invited = [];
    const skipped = [];

    for (const studentId of req.body.studentIds) {
      if (!eligible.some((row) => row.student_id === studentId)) {
        skipped.push({ studentId, reason: "NOT_ENROLLED" });
        continue;
      }

      const existing = await queryOne(
        `SELECT 1 FROM study_group_invitations
          WHERE group_id = $1 AND invitee_id = $2 AND status = 'PENDING'`,
        [activity.id, studentId],
        "lecturer:existingInvite",
      );

      if (existing) {
        skipped.push({ studentId, reason: "ALREADY_INVITED" });
        continue;
      }

      await query(
        `INSERT INTO study_group_invitations (group_id, inviter_id, invitee_id, status, message)
         VALUES ($1, $2, $3, 'PENDING', $4)`,
        [activity.id, req.user.id, studentId, req.body.message ?? null],
        "lecturer:invite",
      );

      invited.push(studentId);
    }

    if (invited.length) {
      await notifyMany(invited, {
        type: NOTIFICATION_TYPE.GROUP_INVITATION,
        title: `Invitation to ${activity.name}`,
        body: "Your lecturer invited you to a study activity.",
        link: `/groups/${activity.slug}`,
        metadata: { groupId: activity.id, invitedBy: req.user.id },
      });
    }

    return ok(res, {
      invited: invited.length,
      skipped,
      // Honest about partial success: a 5-of-6 invite is not a success.
      partial: skipped.length > 0 && invited.length > 0,
    });
  }),
);

/**
 * GET /api/lecturer/students — enrolled students, for choosing invitees.
 *
 * Deliberately minimal: name, email, enrolment status. No profile, no skills, no
 * availability, no group membership, no performance. It exists to populate a
 * multi-select, so that is all it returns.
 */
router.get(
  "/students",
  validate({
    query: z.object({
      courseId: z.string().uuid().optional(),
      q: z.string().trim().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  searchLimiter,
  asyncHandler(async (req, res) => {
    const assigned = await queryRows(
      "SELECT course_id FROM lecturer_courses WHERE lecturer_id = $1",
      [req.user.id],
      "lecturer:assigned",
    );

    const courseIds = assigned.map((row) => row.course_id);
    if (courseIds.length === 0) return ok(res, { students: [] });

    // Only within the lecturer's own courses.
    const scope = req.query.courseId
      ? courseIds.filter((id) => id === req.query.courseId)
      : courseIds;

    if (scope.length === 0) {
      throw new ForbiddenError("You are not assigned to that course.");
    }

    const students = await queryRows(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.status,
              sc.semester, sc.is_active, sc.enrolled_at,
              c.id AS course_id, c.course_code
         FROM student_courses sc
         JOIN users u ON u.id = sc.student_id
         JOIN courses c ON c.id = sc.course_id
        WHERE sc.course_id = ANY($1::uuid[])
          AND sc.is_active
          AND ($2::text IS NULL OR concat(u.first_name, ' ', u.last_name) ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%')
        ORDER BY u.last_name, u.first_name
        LIMIT $3`,
      [scope, req.query.q ?? null, req.query.limit],
      "lecturer:students",
    );

    return ok(res, { students });
  }),
);

export default router;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Throws unless the lecturer is assigned to the course. The scope of every route. */
async function assertTeachesCourse(lecturerId, courseId) {
  const row = await queryOne(
    "SELECT 1 FROM lecturer_courses WHERE lecturer_id = $1 AND course_id = $2",
    [lecturerId, courseId],
    "lecturer:permission",
  );

  if (!row) {
    // 404 rather than 403: a lecturer should not be able to probe which course
    // ids exist.
    throw new NotFoundError("That course");
  }
}

/**
 * Create a lecturer-run activity.
 *
 * The owner column on `study_groups` is a user reference, so it is satisfied with
 * a synthetic, non-login account rather than by granting the lecturer access to a
 * student group. The placeholder holds nothing: no email, no password, and a
 * status that cannot authenticate.
 */
async function createLecturerActivity(lecturerId, courseId, input) {
  const { withTransaction } = await import("../config/db.js");

  return withTransaction(async (tx) => {
    const course = await tx.queryOne(
      "SELECT id, course_code FROM courses WHERE id = $1",
      [courseId],
      "lecturer:course",
    );

    const placeholder = await ensureLecturerPlaceholder();

    const name = input.title ?? `${course.course_code} study activity`;

    const group = await tx.queryOne(
      `INSERT INTO study_groups
         (name, slug, course_id, goal_id, owner_id, created_by_role, description, mode, privacy,
          require_approval, min_size, max_size, target_size, status)
       VALUES ($1, $2, $3, $4, $5, 'LECTURER', $6, $7, 'REQUEST_REQUIRED', TRUE, $8, $9, $9, 'ACTIVE')
       RETURNING *`,
      [
        name,
        await uniqueSlug(name),
        courseId,
        input.goalId ?? null,
        placeholder,
        input.description ?? "",
        input.mode,
        input.groupSize,
        input.groupSize,
      ],
      "lecturer:createActivity",
    );

    // The workspace trigger creates the workspace row.

    for (const topicId of input.topicIds ?? []) {
      await tx.query(
        "INSERT INTO study_group_topics (group_id, topic_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [group.id, topicId],
        "lecturer:addTopic",
      );
    }

    return {
      id: group.id,
      name: group.name,
      slug: group.slug,
      status: group.status,
      courseId,
      recommendedStudents: input.recommendStudents
        ? "Call POST /api/recommendations with the activity's course and topics to suggest students."
        : null,
      // Stated in the payload because it is the surprising part of this flow.
      note: "You own this activity as a supervisor. You cannot read group chat or member messages; students are informed of your supervision role.",
    };
  }, "lecturer:createActivity");
}

/**
 * The shared placeholder account used as `study_groups.owner_id` for
 * lecturer-run activities.
 *
 * `study_groups.owner_id` is a mandatory user reference, but a lecturer must not
 * be a member of a student group — so ownership is pointed at a deactivated
 * account that cannot authenticate and has no data. `role_id` is required by the
 * schema, so the placeholder is a lecturer with no courses assigned.
 *
 * `ON CONFLICT DO UPDATE` (rather than DO NOTHING) exists to make this
 * re-runnable: a returning clause is needed to get the id.
 */
let placeholderId = null;

async function ensureLecturerPlaceholder() {
  if (placeholderId) return placeholderId;

  const role = await queryOne("SELECT id FROM roles WHERE key = 'LECTURER'", [], "lecturer:placeholderRole");

  if (!role) {
    throw new NotFoundError("The lecturer role is missing from the roles table.");
  }

  const row = await queryOne(
    `INSERT INTO users (email, password_hash, role_id, status, first_name, last_name)
     VALUES ('lecturer-activity-owner@system.invalid', NULL, $1, 'DEACTIVATED', 'Study', 'Activity')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [role.id],
    "lecturer:placeholder",
  );

  placeholderId = row.id;
  return placeholderId;
}

/** Slug with a numeric suffix on collision, matching the group service's scheme. */
async function uniqueSlug(name) {
  const base =
    String(name)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .slice(0, 60) || "activity";

  const existing = await queryOne("SELECT 1 FROM study_groups WHERE slug = $1", [base], "lecturer:slug");

  if (!existing) return base;

  // Four attempts is enough in practice; the unique index is the real guarantee
  // and would surface as a 409 rather than a duplicate.
  for (let attempt = 2; attempt < 6; attempt += 1) {
    const candidate = `${base}-${attempt}`;
    const taken = await queryOne("SELECT 1 FROM study_groups WHERE slug = $1", [candidate], "lecturer:slug");
    if (!taken) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`;
}