import { Router } from "express";
import { asyncHandler, ok, created } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { writeLimiter, searchLimiter } from "../middleware/rateLimit.js";
import { query, queryRows, queryOne, withTransaction, healthcheck, poolStats } from "../config/db.js";
import env from "../config/env.js";
import logger from "../config/logger.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { recordAudit, AUDIT, sanitiseMetadata } from "../lib/audit.js";
import { notifyMany } from "../lib/notifications.js";
import { NOTIFICATION_TYPE } from "../config/constants.js";
import {
  userIdParamSchema,
  adminUpdateUserSchema,
  adminChangeUserRoleSchema,
  adminSuspendUserSchema,
  adminRestoreUserSchema,
  adminGroupQuerySchema,
  groupIdParamSchema,
  adminGroupSuspendSchema,
  adminGroupRestoreSchema,
  adminGroupArchiveSchema,
  adminGroupMemberParamSchema,
  sessionIdParamSchema,
  adminSessionCancelSchema,
  reportIdParamSchema,
  adminCourseIdParamSchema,
  adminAnnouncementQuerySchema,
  createAnnouncementSchema,
  updateAnnouncementSchema,
  announcementIdParamSchema,
  settingSectionKeySchema,
  settingSectionSchemas,
  aiRuntimeUpdateSchema,
  aiUsageQuerySchema,
  adminAuditQuerySchema,
  z,
} from "../lib/schemas.js";
import * as announcements from "../services/announcement.service.js";
import * as settings from "../services/settings.service.js";
import * as aiConfig from "../services/aiConfig.service.js";
import { aiStatus } from "../services/ai.service.js";
import { getTargets, configuredKeys, configuredEmbeddingModel } from "../modules/ai/registry.js";
import { getCircuitSnapshot, resetCircuit } from "../modules/ai/orchestration.js";

/**
 * Administrative console.
 *
 * This router adds the inspection and intervention endpoints the console needs
 * on top of the existing admin surface. It deliberately does not re-implement
 * anything that already exists: user listing, moderation, course creation,
 * analytics and broadcasts keep their original routes. Everything here is
 * mounted *before* those routers, so path collisions must be avoided — the
 * routes below use child paths and distinct methods for that reason.
 *
 * Two invariants:
 *   1. Authorisation is always server-side. `req.user.role` is re-read from the
 *      database by `requireAdmin`; nothing trusts a client-supplied role.
 *   2. Every mutation is audited before the response is returned.
 */

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

function actor(req) {
  return req.user;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** GET /api/admin/users/:userId — full account detail for the drawer. */
router.get(
  "/users/:userId",
  searchLimiter,
  validate({ params: userIdParamSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const user = await queryOne(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, u.status, r.key AS role,
              u.email_verified_at, u.failed_login_count, u.locked_until, u.last_login_at,
              u.password_changed_at, u.must_change_password, u.suspended_at, u.suspension_reason,
              u.created_at, u.updated_at,
              sp.university_id, sp.program_id, sp.year_of_study, sp.student_number,
              sp.onboarding_step, sp.onboarding_done, sp.last_active_at,
              un.name AS university_name, p.name AS program_name
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
         LEFT JOIN universities un ON un.id = sp.university_id
         LEFT JOIN programs p ON p.id = sp.program_id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
      "console:userDetail",
    );

    if (!user) throw new NotFoundError("That user");

    const [counts, groups, roleHistory, recentActivity] = await Promise.all([
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM study_group_members m WHERE m.student_id = $1 AND m.left_at IS NULL AND m.status = 'ACTIVE') AS groups,
           (SELECT count(*)::int FROM study_group_members m WHERE m.student_id = $1 AND m.left_at IS NULL AND m.status = 'ACTIVE'
              AND m.role IN ('OWNER', 'MODERATOR')) AS led_groups,
           (SELECT count(*)::int FROM reports WHERE reporter_id = $1) AS reports_filed,
           (SELECT count(*)::int FROM reports WHERE target_type = 'STUDENT' AND target_id = $1) AS reports_against,
           (SELECT count(*)::int FROM session_participants WHERE student_id = $1 AND attended) AS sessions_attended
         `,
        [userId],
        "console:userCounts",
      ),
      queryRows(
        `SELECT g.id, g.name, g.status, m.role AS member_role, m.joined_at, c.course_code
           FROM study_group_members m
           JOIN study_groups g ON g.id = m.group_id
           JOIN courses c ON c.id = g.course_id
           WHERE m.student_id = $1 AND m.left_at IS NULL AND m.status = 'ACTIVE'
          ORDER BY g.name
          LIMIT 25`,
        [userId],
        "console:userGroups",
      ),
      queryRows(
        `SELECT a.id, a.action, a.entity_id, a.metadata, a.outcome, a.created_at,
                actor.first_name AS actor_first_name, actor.last_name AS actor_last_name,
                actor.email AS actor_email
           FROM audit_logs a
           LEFT JOIN users actor ON actor.id = a.actor_id
          WHERE a.action IN ('admin.role.changed', 'admin.account.suspended', 'admin.account.restored')
            AND a.entity_id = $1
          ORDER BY a.id DESC
          LIMIT 20`,
        [userId],
        "console:userRoleHistory",
      ),
      queryRows(
        `SELECT id, action, entity_type, entity_id, metadata, outcome, created_at
           FROM audit_logs
          WHERE actor_id = $1
          ORDER BY id DESC
          LIMIT 10`,
        [userId],
        "console:userActivity",
      ),
    ]);

    return ok(res, {
      user,
      counts,
      groups,
      roleHistory: roleHistory.map((row) => ({ ...row, metadata: sanitiseMetadata(row.metadata) })),
      recentActivity: recentActivity.map((row) => ({ ...row, metadata: sanitiseMetadata(row.metadata) })),
    });
  }),
);

/** GET /api/admin/users/:userId/role-history — the role audit trail. */
router.get(
  "/users/:userId/role-history",
  searchLimiter,
  validate({ params: userIdParamSchema }),
  asyncHandler(async (req, res) => {
    const entries = await queryRows(
      `SELECT a.id, a.action, a.metadata, a.outcome, a.created_at,
              actor.email AS actor_email, actor.first_name AS actor_first_name,
              actor.last_name AS actor_last_name
         FROM audit_logs a
         LEFT JOIN users actor ON actor.id = a.actor_id
        WHERE a.action IN ('admin.role.changed', 'admin.account.suspended', 'admin.account.restored')
          AND a.entity_id = $1
        ORDER BY a.id DESC
        LIMIT 100`,
      [req.params.userId],
      "console:roleHistory",
    );
    return ok(res, {
      entries: entries.map((row) => ({ ...row, metadata: sanitiseMetadata(row.metadata) })),
    });
  }),
);

/** PATCH /api/admin/users/:userId — edit profile fields. */
router.patch(
  "/users/:userId",
  writeLimiter,
  validate({ params: userIdParamSchema, body: adminUpdateUserSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const body = req.body;

    let emailChanged = false;
    let previousEmail = null;
    const userColumns = { firstName: "first_name", lastName: "last_name", email: "email" };
    // Keep the target id in the parameter list while building assignments. This
    // prevents the SET placeholders from drifting when fields are optional.
    const userValues = [userId];
    const userAssignments = [];
    for (const [key, column] of Object.entries(userColumns)) {
      if (body[key] === undefined) continue;
      userValues.push(body[key]);
      userAssignments.push(`${column} = $${userValues.length}`);
    }
    const profileColumns = { yearOfStudy: "year_of_study", programId: "program_id" };
    const profileValues = [userId];
    const profileAssignments = [];
    for (const [key, column] of Object.entries(profileColumns)) {
      if (body[key] === undefined) continue;
      profileValues.push(body[key]);
      profileAssignments.push(`${column} = $${profileValues.length}`);
    }

    const updated = await withTransaction(async (tx) => {
      const target = await tx.queryOne(
        `SELECT u.id, u.email
           FROM users u
          WHERE u.id = $1 AND u.deleted_at IS NULL
          FOR UPDATE`,
        [userId],
        "console:loadUserForUpdate",
      );
      if (!target) throw new NotFoundError("That user");

      emailChanged = body.email !== undefined && body.email.toLowerCase() !== String(target.email).toLowerCase();
      previousEmail = target.email;
      if (emailChanged) {
        userAssignments.push("email_verified_at = NULL");
        userAssignments.push("status = CASE WHEN status = 'ACTIVE' THEN 'PENDING_VERIFICATION' ELSE status END");
      }

      let user;
      let sessionsRevoked = 0;
      if (userAssignments.length) {
        user = await tx.queryOne(
          `UPDATE users SET ${userAssignments.join(", ")}, updated_at = now()
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id, email, first_name, last_name, status, email_verified_at, updated_at`,
           userValues,
           "console:updateUser",
         );
      } else {
        user = await tx.queryOne(
          "SELECT id, email, first_name, last_name, status, email_verified_at, updated_at FROM users WHERE id = $1 AND deleted_at IS NULL",
          [userId],
        );
      }
      if (!user) throw new NotFoundError("That user");

      if (emailChanged) {
        const sessions = await tx.query(
          `UPDATE auth_sessions
              SET revoked_at = now(), revoked_reason = 'email_change'
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
          "console:revokeOnEmailChange",
        );
        sessionsRevoked = sessions.rowCount ?? 0;
        await tx.query(
          `UPDATE auth_tokens SET consumed_at = now()
             WHERE user_id = $1 AND purpose IN ('EMAIL_VERIFY', 'EMAIL_CHANGE', 'PASSWORD_RESET')
               AND consumed_at IS NULL`,
          [userId],
          "console:invalidateVerificationTokens",
        );
      }

      if (profileAssignments.length) {
        // A profile row is created on registration, but an admin may edit a
        // legacy account that predates the onboarding flow.
        const exists = await tx.queryOne("SELECT user_id FROM student_profiles WHERE user_id = $1", [userId]);
        if (exists) {
          await tx.query(
            `UPDATE student_profiles SET ${profileAssignments.join(", ")}, updated_at = now()
              WHERE user_id = $1`,
            profileValues,
            "console:updateProfile",
          );
        } else {
          // university_id is NOT NULL, so a profile cannot be conjured without it.
          throw new AppError("This account has no academic profile yet. Ask the student to complete onboarding.", {
            status: 422,
            code: "PROFILE_MISSING",
          });
        }
      }

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.USER_UPDATED_BY_ADMIN,
          entityType: "user",
          entityId: userId,
          metadata: {
            changes: Object.keys(body),
            previousEmail,
            emailChanged,
            sessionsRevoked,
          },
        },
        { tx },
      );

      return { user, emailChanged, sessionsRevoked };
    }, "console:updateUser");

    return ok(res, updated);
  }),
);

/**
 * POST /api/admin/users/:userId/role
 *
 * Existing role-change route only grants STUDENT/GROUP_LEADER. This one keeps
 * administrator promotion out of the normal console, with guard rails that
 * cannot be bypassed by the client:
 *   - an admin cannot change their own role;
 *   - the last remaining administrator cannot be demoted;
 *   - demoting a leader who still leads an active group is refused.
 */
router.post(
  "/users/:userId/role",
  writeLimiter,
  validate({ params: userIdParamSchema, body: adminChangeUserRoleSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { role, reason } = req.body;

    if (userId === req.user.id) {
      throw new ForbiddenError("You cannot change your own role.");
    }
    if (role === "ADMIN") {
      throw new ForbiddenError("Administrator access is granted out of band, not through this endpoint.");
    }

    const updated = await withTransaction(async (tx) => {
      // Lock every non-deleted admin in a stable order before deciding whether a
      // peer may be demoted. The active-admin check preserves an operational
      // administrator, while the total count protects a platform whose only
      // admin is currently pending or suspended.
      const admins = await tx.queryRows(
        `SELECT u.id, u.status
           FROM users u JOIN roles r ON r.id = u.role_id
          WHERE r.key = 'ADMIN' AND u.deleted_at IS NULL
          ORDER BY u.id
           FOR UPDATE OF u`,
        [],
        "console:lockAdmins",
      );
      const roleRow = await tx.queryOne("SELECT id FROM roles WHERE key = $1", [role], "console:role");
      if (!roleRow) throw new NotFoundError("That role");

      const target = await tx.queryOne(
        `SELECT u.id, u.status, r.key AS role
           FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.id = $1 AND u.deleted_at IS NULL
          FOR UPDATE OF u`,
        [userId],
        "console:loadRoleTarget",
      );
      if (!target) throw new NotFoundError("That user");
      if (target.role === role) {
        throw new ConflictError(`That user is already a ${role.toLowerCase().replaceAll("_", " ")}.`);
      }

      const activeAdminCount = admins.filter((admin) => admin.status === "ACTIVE").length;
      if (
        target.role === "ADMIN" &&
        (admins.length <= 1 || (target.status === "ACTIVE" && activeAdminCount <= 1))
      ) {
        throw new ConflictError("You cannot demote the last administrator.", { code: "LAST_ADMIN" });
      }
      if (target.role === "ADMIN" && role !== "STUDENT") {
        throw new ForbiddenError("An administrator can only be demoted to a student account.");
      }

      if (["GROUP_LEADER", "ADMIN"].includes(target.role) && role === "STUDENT") {
        const leading = await tx.queryOne(
          `SELECT count(*)::int AS groups
             FROM study_group_members m JOIN study_groups g ON g.id = m.group_id
            WHERE m.student_id = $1 AND m.left_at IS NULL AND m.status = 'ACTIVE'
              AND m.role IN ('OWNER', 'MODERATOR') AND g.status = 'ACTIVE'`,
          [userId],
          "console:leaderGroups",
        );
        if ((leading?.groups ?? 0) > 0) {
          throw new ConflictError("That user still leads active groups. Remove them as a leader first.", {
            code: "STILL_LEADING",
            details: { groups: leading.groups },
          });
        }
      }

      const user = await tx.queryOne(
        `UPDATE users SET role_id = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, email, first_name, last_name`,
        [userId, roleRow.id],
        "console:changeRole",
      );
      if (!user) throw new ConflictError("That user changed state. Try again.");

      // Role changes take effect immediately, not at token expiry.
      const sessions = await tx.query(
        "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'role_change' WHERE user_id = $1 AND revoked_at IS NULL",
        [userId],
        "console:revokeOnRoleChange",
      );

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.ROLE_CHANGED,
          entityType: "user",
          entityId: userId,
          metadata: { from: target.role, to: role, reason, sessionsRevoked: sessions.rowCount ?? 0 },
        },
        { tx },
      );

      return { user, previousRole: target.role, sessionsRevoked: sessions.rowCount ?? 0 };
    }, "console:changeRole");

    return ok(res, updated);
  }),
);

/** POST /api/admin/users/:userId/suspend */
router.post(
  "/users/:userId/suspend",
  writeLimiter,
  validate({ params: userIdParamSchema, body: adminSuspendUserSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;

    if (userId === req.user.id) {
      throw new AppError("You cannot suspend your own account.", { status: 422, code: "SELF_SUSPEND" });
    }

    const result = await withTransaction(async (tx) => {
      const target = await tx.queryOne(
        `SELECT u.id, u.status, r.key AS role
           FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.id = $1 AND u.deleted_at IS NULL
          FOR UPDATE OF u`,
        [userId],
        "console:loadSuspendTarget",
      );
      if (!target) throw new NotFoundError("That user");
      if (target.role === "ADMIN") {
        throw new ForbiddenError("Use a two-admin process to suspend another administrator.");
      }
      if (target.status === "SUSPENDED") throw new ConflictError("That account is already suspended.");

      const user = await tx.queryOne(
        `UPDATE users SET status = 'SUSPENDED', suspended_at = now(), suspension_reason = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, email, status, suspended_at`,
        [userId, reason],
        "console:suspend",
      );

      if (!user) throw new ConflictError("That user changed state. Try again.");

      const sessions = await tx.query(
        `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'suspended'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
        "console:revokeOnSuspend",
      );

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.ACCOUNT_SUSPENDED,
          entityType: "user",
          entityId: userId,
          metadata: { reason, sessionsRevoked: sessions.rowCount ?? 0 },
        },
        { tx },
      );

      return { user, sessionsRevoked: sessions.rowCount ?? 0 };
    }, "console:suspend");

    return ok(res, result);
  }),
);

/** POST /api/admin/users/:userId/restore */
router.post(
  "/users/:userId/restore",
  writeLimiter,
  validate({ params: userIdParamSchema, body: adminRestoreUserSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const user = await withTransaction(async (tx) => {
      const target = await tx.queryOne(
        "SELECT id, status FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [userId],
        "console:loadRestoreTarget",
      );
      if (!target) throw new NotFoundError("That user");
      if (target.status !== "SUSPENDED") throw new ConflictError("That account is not suspended.");

      const restored = await tx.queryOne(
        `UPDATE users
            SET status = CASE WHEN email_verified_at IS NULL THEN 'PENDING_VERIFICATION' ELSE 'ACTIVE' END,
                suspended_at = NULL, suspension_reason = NULL, updated_at = now()
          WHERE id = $1 AND status = 'SUSPENDED'
          RETURNING id, email, status`,
        [userId],
        "console:restore",
      );
      if (!restored) throw new ConflictError("That account changed state. Try again.");

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.ACCOUNT_RESTORED,
          entityType: "user",
          entityId: userId,
          metadata: { reason: req.body.reason ?? null },
        },
        { tx },
      );

      return restored;
    }, "console:restore");

    return ok(res, { user });
  }),
);

// ---------------------------------------------------------------------------
// Courses — deletion is refused when the course is still referenced.
// ---------------------------------------------------------------------------

router.delete(
  "/courses/:courseId",
  writeLimiter,
  validate({ params: adminCourseIdParamSchema }),
  asyncHandler(async (req, res) => {
    const { courseId } = req.params;

    const course = await queryOne(
      "SELECT id, course_code, name, is_active FROM courses WHERE id = $1",
      [courseId],
      "console:loadCourseForDelete",
    );
    if (!course) throw new NotFoundError("That course");

    const usage = await queryOne(
      `SELECT
         (SELECT count(*)::int FROM study_groups WHERE course_id = $1) AS groups,
         (SELECT count(*)::int FROM student_courses WHERE course_id = $1) AS enrolments,
         (SELECT count(*)::int FROM course_topics WHERE course_id = $1) AS topics`,
      [courseId],
      "console:courseUsage",
    );

    const references = usage.groups + usage.enrolments + usage.topics;
    if (references > 0) {
      throw new ConflictError(
        "This course is still in use. Archive it instead so enrolments and groups stay intact.",
        { code: "COURSE_IN_USE", details: usage },
      );
    }

    await withTransaction(async (tx) => {
      const deleted = await tx.query(
        "DELETE FROM courses WHERE id = $1",
        [courseId],
        "console:deleteCourse",
      );
      if ((deleted.rowCount ?? 0) !== 1) throw new NotFoundError("That course");

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.COURSE_DELETED,
          entityType: "course",
          entityId: courseId,
          metadata: { courseCode: course.course_code, name: course.name },
        },
        { tx },
      );
    }, "console:deleteCourse");

    return ok(res, { deleted: true });
  }),
);

// ---------------------------------------------------------------------------
// Study groups — detail and intervention
// ---------------------------------------------------------------------------

/** GET /api/admin/groups — the console list with suspension state. */
router.get(
  "/groups",
  searchLimiter,
  validate({ query: adminGroupQuerySchema }),
  asyncHandler(async (req, res) => {
    const { q, status, privacy, courseId, limit, cursor } = req.query;
    const params = [];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const clauses = [];
    if (status) clauses.push(`g.status = ${bind(status)}`);
    if (privacy) clauses.push(`g.privacy = ${bind(privacy)}`);
    if (courseId) clauses.push(`g.course_id = ${bind(courseId)}`);
    if (q) clauses.push(`(g.name ILIKE '%' || ${bind(q)} || '%' OR c.course_code ILIKE '%' || ${bind(q)} || '%')`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const groups = await queryRows(
      `SELECT g.id, g.name, g.slug, g.status, g.privacy, g.mode, g.member_count, g.max_size,
              g.suspended_at, g.suspended_reason, g.created_at,
              c.course_code, c.name AS course_name,
              owner.first_name AS owner_first_name, owner.last_name AS owner_last_name, owner.id AS owner_id,
              (SELECT count(*)::int FROM session_participants sp
                 JOIN study_sessions s ON s.id = sp.session_id
                 JOIN workspaces w ON w.id = s.workspace_id
                WHERE w.group_id = g.id) AS participations
         FROM study_groups g
         JOIN courses c ON c.id = g.course_id
         JOIN users owner ON owner.id = g.owner_id
         ${where}
        ORDER BY g.member_count DESC, g.created_at DESC
        LIMIT ${bind(limit + 1)} OFFSET ${bind(cursor)}`,
      params,
      "console:listGroups",
    );

    const hasMore = groups.length > limit;
    const page = hasMore ? groups.slice(0, limit) : groups;

    return ok(res, { groups: page, cursor: hasMore ? cursor + limit : null });
  }),
);

/** GET /api/admin/groups/:groupId — members, sessions, reports. */
router.get(
  "/groups/:groupId",
  searchLimiter,
  validate({ params: groupIdParamSchema }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;

    const group = await queryOne(
      `SELECT g.id, g.name, g.slug, g.description, g.status, g.privacy, g.mode, g.goal_id,
              g.member_count, g.max_size, g.require_approval, g.created_at, g.archived_at,
              g.suspended_at, g.suspended_reason,
              c.id AS course_id, c.course_code, c.name AS course_name,
              owner.id AS owner_id, owner.first_name AS owner_first_name,
              owner.last_name AS owner_last_name, owner.email AS owner_email,
              suspender.first_name AS suspended_by_first_name,
              suspender.last_name AS suspended_by_last_name
         FROM study_groups g
         JOIN courses c ON c.id = g.course_id
         JOIN users owner ON owner.id = g.owner_id
         LEFT JOIN users suspender ON suspender.id = g.suspended_by
        WHERE g.id = $1`,
      [groupId],
      "console:groupDetail",
    );
    if (!group) throw new NotFoundError("That group");

    const [members, sessions, reports, counts] = await Promise.all([
      queryRows(
        `SELECT m.student_id, m.role, m.status, m.joined_at, m.last_active_at,
                u.email, u.first_name, u.last_name, u.avatar_url, u.status AS account_status
           FROM study_group_members m
           JOIN users u ON u.id = m.student_id
          WHERE m.group_id = $1 AND m.left_at IS NULL
          ORDER BY CASE m.role WHEN 'OWNER' THEN 0 WHEN 'MODERATOR' THEN 1 ELSE 2 END, m.joined_at`,
        [groupId],
        "console:groupMembers",
      ),
      queryRows(
        `SELECT s.id, s.title, s.status, s.starts_at, s.ends_at, s.mode, s.cancelled_by,
                s.cancellation_reason,
                (SELECT count(*)::int FROM session_participants p WHERE p.session_id = s.id) AS participants,
                (SELECT count(*)::int FROM session_participants p WHERE p.session_id = s.id AND p.attended) AS attended
           FROM study_sessions s
           JOIN workspaces w ON w.id = s.workspace_id
          WHERE w.group_id = $1
          ORDER BY s.starts_at DESC
          LIMIT 10`,
        [groupId],
        "console:groupSessions",
      ),
      queryRows(
        `SELECT id, category, status, details, created_at
           FROM reports
          WHERE target_type = 'GROUP' AND target_id = $1
          ORDER BY created_at DESC
          LIMIT 10`,
        [groupId],
        "console:groupReports",
      ),
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM study_group_members WHERE group_id = $1 AND left_at IS NULL) AS members,
           (SELECT count(*)::int FROM workspaces WHERE group_id = $1 AND NOT is_archived) AS workspaces,
           (SELECT count(*)::int FROM study_sessions s JOIN workspaces w ON w.id = s.workspace_id
             WHERE w.group_id = $1) AS sessions,
           (SELECT count(*)::int FROM group_meetings WHERE group_id = $1) AS meetings`,
        [groupId],
        "console:groupCounts",
      ),
    ]);

    return ok(res, { group, members, sessions, reports, counts });
  }),
);

/** POST /api/admin/groups/:groupId/suspend */
router.post(
  "/groups/:groupId/suspend",
  writeLimiter,
  validate({ params: groupIdParamSchema, body: adminGroupSuspendSchema }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;
    const { reason } = req.body;

    const group = await queryOne(
      "SELECT id, name, status FROM study_groups WHERE id = $1",
      [groupId],
      "console:loadGroupForSuspend",
    );
    if (!group) throw new NotFoundError("That group");
    if (group.status === "SUSPENDED") throw new ConflictError("That group is already suspended.");
    if (["ARCHIVED", "DISBANDED"].includes(group.status)) {
      throw new ConflictError("A closed group cannot be suspended.");
    }

    const updated = await withTransaction(async (tx) => {
      const suspended = await tx.queryOne(
          `UPDATE study_groups
              SET status = 'SUSPENDED', suspended_at = now(), suspended_reason = $2, suspended_by = $3, updated_at = now()
           WHERE id = $1 AND status = 'ACTIVE'
           RETURNING id, name, status, suspended_at, suspended_reason`,
        [groupId, reason, req.user.id],
        "console:suspendGroup",
      );
      if (!suspended) throw new ConflictError("That group changed state. Try again.");

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.GROUP_SUSPENDED,
          entityType: "study_group",
          entityId: groupId,
          metadata: { reason, previousStatus: group.status },
        },
        { tx },
      );

      return suspended;
    }, "console:suspendGroup");

    const members = await queryRows(
      "SELECT student_id FROM study_group_members WHERE group_id = $1 AND left_at IS NULL",
      [groupId],
      "console:groupMemberIds",
    );

    const delivery = await notifyMany(
      members.map((row) => row.student_id),
      {
        type: NOTIFICATION_TYPE.SYSTEM,
        title: `“${group.name}” has been paused`,
        body: `An administrator has paused this group. Reason: ${reason}`,
        metadata: { groupId, source: "admin", action: "GROUP_SUSPENDED" },
      },
    );

    return ok(res, { group: updated, notified: delivery });
  }),
);

/** POST /api/admin/groups/:groupId/restore */
router.post(
  "/groups/:groupId/restore",
  writeLimiter,
  validate({ params: groupIdParamSchema, body: adminGroupRestoreSchema }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;

    const group = await queryOne(
      "SELECT id, name, status, archived_at FROM study_groups WHERE id = $1",
      [groupId],
      "console:loadGroupForRestore",
    );
    if (!group) throw new NotFoundError("That group");
    if (group.status !== "SUSPENDED" || group.archived_at) {
      throw new ConflictError("That group is not an active administrative suspension.");
    }

    const updated = await withTransaction(async (tx) => {
      const restored = await tx.queryOne(
          `UPDATE study_groups
              SET status = 'ACTIVE', suspended_at = NULL, suspended_reason = NULL,
                  suspended_by = NULL, updated_at = now()
           WHERE id = $1 AND status = 'SUSPENDED' AND archived_at IS NULL
           RETURNING id, name, status`,
        [groupId],
        "console:restoreGroup",
      );
      if (!restored) throw new ConflictError("That group changed state and cannot be restored.");

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.GROUP_RESTORED,
          entityType: "study_group",
          entityId: groupId,
          metadata: { reason: req.body.reason ?? null },
        },
        { tx },
      );

      return restored;
    }, "console:restoreGroup");

    const members = await queryRows(
      "SELECT student_id FROM study_group_members WHERE group_id = $1 AND left_at IS NULL",
      [groupId],
      "console:groupMemberIds",
    );

    const delivery = await notifyMany(
      members.map((row) => row.student_id),
      {
        type: NOTIFICATION_TYPE.SYSTEM,
        title: `“${group.name}” is active again`,
        body: "An administrator has lifted the pause on this group.",
        metadata: { groupId, source: "admin", action: "GROUP_RESTORED" },
      },
    );

    return ok(res, { group: updated, notified: delivery });
  }),
);

/** POST /api/admin/groups/:groupId/archive */
router.post(
  "/groups/:groupId/archive",
  writeLimiter,
  validate({ params: groupIdParamSchema, body: adminGroupArchiveSchema }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;

    const group = await queryOne(
      "SELECT id, name, status FROM study_groups WHERE id = $1",
      [groupId],
      "console:loadGroupForArchive",
    );
    if (!group) throw new NotFoundError("That group");
    if (["ARCHIVED", "DISBANDED"].includes(group.status)) {
      throw new ConflictError("That group is already closed.");
    }

    const updated = await withTransaction(async (tx) => {
      const archived = await tx.queryOne(
        `UPDATE study_groups SET status = 'ARCHIVED', archived_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('ACTIVE', 'SUSPENDED')
          RETURNING id, name, status, archived_at`,
        [groupId],
        "console:archiveGroup",
      );
      if (!archived) throw new ConflictError("That group changed state and cannot be archived.");

      await tx.query(
        `UPDATE workspaces SET is_archived = TRUE, archived_at = now()
          WHERE id IN (SELECT workspace_id FROM workspace_groups WHERE group_id = $1)
            AND NOT is_archived`,
        [groupId],
        "console:archiveGroupWorkspaces",
      );
      await tx.query(
        "UPDATE study_group_invitations SET status = 'CANCELLED' WHERE group_id = $1 AND status = 'PENDING'",
        [groupId],
        "console:cancelGroupInvitations",
      );
      await tx.query(
        "UPDATE study_group_join_requests SET status = 'CANCELLED' WHERE group_id = $1 AND status = 'PENDING'",
        [groupId],
        "console:cancelGroupRequests",
      );

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.GROUP_ARCHIVED_BY_ADMIN,
          entityType: "study_group",
          entityId: groupId,
          metadata: { previousStatus: group.status, reason: req.body.reason ?? null },
        },
        { tx },
      );

      return archived;
    }, "console:archiveGroup");

    return ok(res, { group: updated });
  }),
);

/** DELETE /api/admin/groups/:groupId/members/:userId — remove a member. */
router.delete(
  "/groups/:groupId/members/:userId",
  writeLimiter,
  validate({ params: adminGroupMemberParamSchema }),
  asyncHandler(async (req, res) => {
    const { groupId, userId } = req.params;

    const membership = await queryOne(
      `SELECT m.student_id, m.role, u.first_name, u.last_name
         FROM study_group_members m JOIN users u ON u.id = m.student_id
        WHERE m.group_id = $1 AND m.student_id = $2 AND m.left_at IS NULL`,
      [groupId, userId],
      "console:loadMembership",
    );
    if (!membership) throw new NotFoundError("That group member");
    if (membership.role === "OWNER") {
      throw new ConflictError("The group owner cannot be removed. Archive the group or transfer ownership first.");
    }

    await withTransaction(async (tx) => {
      const removed = await tx.query(
        `UPDATE study_group_members
            SET left_at = now(), status = 'DEACTIVATED'
          WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL AND role <> 'OWNER'
          RETURNING id`,
        [groupId, userId],
        "console:removeMember",
      );
      if ((removed.rowCount ?? 0) !== 1) {
        throw new ConflictError("That group member changed state and was not removed.");
      }

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.GROUP_MEMBER_REMOVED_BY_ADMIN,
          entityType: "study_group",
          entityId: groupId,
          metadata: { memberId: userId, memberName: `${membership.first_name} ${membership.last_name}`, role: membership.role },
        },
        { tx },
      );
    }, "console:removeMember");

    return ok(res, { removed: true });
  }),
);

// ---------------------------------------------------------------------------
// Study sessions
// ---------------------------------------------------------------------------

/** GET /api/admin/sessions/:sessionId — detail with participation. */
router.get(
  "/sessions/:sessionId",
  searchLimiter,
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    const session = await queryOne(
      `SELECT s.id, s.title, s.status, s.mode, s.format, s.location, s.meeting_url, s.agenda,
              s.main_topic, s.objectives, s.starts_at, s.ends_at, s.created_at, s.updated_at,
              s.started_at, s.completed_at, s.cancelled_by, s.cancellation_reason,
              w.id AS workspace_id, w.name AS workspace_name,
              g.id AS group_id, g.name AS group_name, g.status AS group_status,
              c.course_code, c.name AS course_name,
              host.id AS host_id, host.first_name AS host_first_name, host.last_name AS host_last_name,
              canceller.first_name AS cancelled_by_first_name, canceller.last_name AS cancelled_by_last_name
         FROM study_sessions s
         JOIN workspaces w ON w.id = s.workspace_id
         JOIN study_groups g ON g.id = w.group_id
         LEFT JOIN courses c ON c.id = g.course_id
         LEFT JOIN users host ON host.id = s.created_by
         LEFT JOIN users canceller ON canceller.id = s.cancelled_by
        WHERE s.id = $1`,
      [sessionId],
      "console:sessionDetail",
    );
    if (!session) throw new NotFoundError("That session");

    const [participants, activities, counts] = await Promise.all([
      queryRows(
        `SELECT p.student_id, p.rsvp, p.attended, p.attendance_minutes, p.responded_at,
                u.first_name, u.last_name, u.email
           FROM session_participants p
           JOIN users u ON u.id = p.student_id
          WHERE p.session_id = $1
          ORDER BY u.first_name, u.last_name`,
        [sessionId],
        "console:sessionParticipants",
      ),
      queryRows(
        `SELECT id, title, kind, position, planned_minutes FROM session_activities
          WHERE session_id = $1 ORDER BY position`,
        [sessionId],
        "console:sessionActivities",
      ),
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM session_participants WHERE session_id = $1) AS invited,
           (SELECT count(*)::int FROM session_participants WHERE session_id = $1 AND rsvp = 'GOING') AS going,
           (SELECT count(*)::int FROM session_participants WHERE session_id = $1 AND attended) AS attended`,
        [sessionId],
        "console:sessionCounts",
      ),
    ]);

    return ok(res, { session, participants, activities, counts });
  }),
);

/** POST /api/admin/sessions/:sessionId/cancel */
router.post(
  "/sessions/:sessionId/cancel",
  writeLimiter,
  validate({ params: sessionIdParamSchema, body: adminSessionCancelSchema }),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { reason } = req.body;

    const session = await queryOne(
      `SELECT s.id, s.title, s.status, s.starts_at, w.group_id, g.name AS group_name
         FROM study_sessions s
         JOIN workspaces w ON w.id = s.workspace_id
         JOIN study_groups g ON g.id = w.group_id
        WHERE s.id = $1`,
      [sessionId],
      "console:loadSessionForCancel",
    );
    if (!session) throw new NotFoundError("That session");
    if (["COMPLETED", "CANCELLED"].includes(session.status)) {
      throw new ConflictError(`That session is already ${session.status.toLowerCase()}.`);
    }

    const cancelled = await withTransaction(async (tx) => {
      const updated = await tx.queryOne(
        `UPDATE study_sessions
            SET status = 'CANCELLED', cancelled_by = $2, cancellation_reason = $3,
                paused_at = NULL, updated_at = now()
          WHERE id = $1
          RETURNING id, title, status, cancelled_by, cancellation_reason, updated_at`,
        [sessionId, req.user.id, reason],
        "console:cancelSession",
      );

      await recordAudit(
        {
          actor: actor(req),
          req,
          action: AUDIT.SESSION_CANCELLED,
          entityType: "study_session",
          entityId: sessionId,
          metadata: { reason, previousStatus: session.status, groupId: session.group_id },
        },
        { tx },
      );

      return updated;
    }, "console:cancelSession");

    // Notify the invited list plus the group owner, so nobody turns up to a
    // session that has been cancelled.
    const recipients = await queryRows(
      `SELECT student_id AS user_id FROM session_participants WHERE session_id = $1
       UNION
       SELECT student_id FROM study_group_members WHERE group_id = $2 AND left_at IS NULL`,
      [sessionId, session.group_id],
      "console:cancelRecipients",
    );

    const delivery = await notifyMany(
      recipients.map((row) => row.user_id),
      {
        type: NOTIFICATION_TYPE.SESSION_UPDATED,
        title: `Session cancelled: ${session.title}`,
        body: `An administrator cancelled this session. Reason: ${reason}`,
        metadata: { sessionId, groupId: session.group_id, source: "admin" },
      },
    );

    return ok(res, { session: cancelled, notified: delivery });
  }),
);

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

async function loadReportTarget(report) {
  switch (report.target_type) {
    case "STUDENT":
      return queryOne(
        "SELECT id, email, first_name, last_name, status, suspended_at FROM users WHERE id = $1",
        [report.target_id],
        "console:reportStudent",
      );
    case "GROUP":
      return queryOne(
        `SELECT g.id, g.name, g.slug, g.status, g.member_count, c.course_code
           FROM study_groups g JOIN courses c ON c.id = g.course_id WHERE g.id = $1`,
        [report.target_id],
        "console:reportGroup",
      );
    case "MESSAGE":
      {
        // Message bodies are intentionally absent from admin detail. The report
        // category/details and safe target metadata are enough to act without
        // turning moderation into a private-message reading surface.
        const workspaceMessage = await queryOne(
          `SELECT m.id, m.created_at, m.deleted_at, m.kind, 'WORKSPACE' AS source,
                  u.first_name AS author_first_name, u.last_name AS author_last_name
             FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = $1`,
          [report.target_id],
          "console:reportMessage",
        );
        if (workspaceMessage) return workspaceMessage;

        return queryOne(
          `SELECT dm.id, dm.created_at, dm.deleted_at, 'DIRECT' AS source,
                  u.first_name AS author_first_name, u.last_name AS author_last_name
             FROM direct_messages dm LEFT JOIN users u ON u.id = dm.sender_id WHERE dm.id = $1`,
          [report.target_id],
          "console:reportDirectMessage",
        );
      }
    case "RESOURCE":
      return queryOne(
        `SELECT r.id, r.title, r.kind, r.visibility, r.is_deleted, r.created_at,
                u.first_name AS uploader_first_name, u.last_name AS uploader_last_name
           FROM resources r LEFT JOIN users u ON u.id = r.uploaded_by WHERE r.id = $1`,
        [report.target_id],
        "console:reportResource",
      );
    default:
      return null;
  }
}

/** GET /api/admin/reports/:reportId — the moderation detail view. */
router.get(
  "/reports/:reportId",
  searchLimiter,
  validate({ params: reportIdParamSchema }),
  asyncHandler(async (req, res) => {
    const report = await queryOne(
      `SELECT rp.*,
              reporter.email AS reporter_email,
              reporter.first_name AS reporter_first_name,
              reporter.last_name AS reporter_last_name,
              handler.first_name AS handler_first_name,
              handler.last_name AS handler_last_name
         FROM reports rp
         LEFT JOIN users reporter ON reporter.id = rp.reporter_id
         LEFT JOIN users handler ON handler.id = rp.handled_by
        WHERE rp.id = $1`,
      [req.params.reportId],
      "console:reportDetail",
    );
    if (!report) throw new NotFoundError("That report");

    const target = await loadReportTarget(report);
    const history = await queryRows(
      `SELECT id, action, outcome, metadata, created_at
         FROM audit_logs
        WHERE entity_type = 'report' AND entity_id = $1
        ORDER BY id DESC LIMIT 20`,
      [report.id],
      "console:reportHistory",
    );

    return ok(res, {
      report,
      target,
      history: history.map((row) => ({ ...row, metadata: sanitiseMetadata(row.metadata) })),
    });
  }),
);

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

router.get(
  "/announcements",
  searchLimiter,
  validate({ query: adminAnnouncementQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await announcements.listAnnouncements(req.query);
    const summary = await announcements.announcementSummary();
    return ok(res, { ...result, summary });
  }),
);

router.get(
  "/announcements/:announcementId",
  searchLimiter,
  validate({ params: announcementIdParamSchema }),
  asyncHandler(async (req, res) => {
    const announcement = await announcements.getAnnouncement(req.params.announcementId);
    return ok(res, { announcement });
  }),
);

router.post(
  "/announcements",
  writeLimiter,
  validate({ body: createAnnouncementSchema }),
  asyncHandler(async (req, res) => {
    const announcement = await announcements.createAnnouncement(req.user.id, req.body, { req });
    return created(res, { announcement });
  }),
);

router.patch(
  "/announcements/:announcementId",
  writeLimiter,
  validate({ params: announcementIdParamSchema, body: updateAnnouncementSchema }),
  asyncHandler(async (req, res) => {
    const announcement = await announcements.updateAnnouncement(
      req.params.announcementId,
      req.user.id,
      req.body,
      { req },
    );
    return ok(res, { announcement });
  }),
);

router.post(
  "/announcements/:announcementId/publish",
  writeLimiter,
  validate({ params: announcementIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await announcements.publishAnnouncement(req.params.announcementId, req.user.id, { req });
    return ok(res, result);
  }),
);

router.post(
  "/announcements/:announcementId/archive",
  writeLimiter,
  validate({ params: announcementIdParamSchema }),
  asyncHandler(async (req, res) => {
    const announcement = await announcements.archiveAnnouncement(
      req.params.announcementId,
      req.user.id,
      { req },
    );
    return ok(res, { announcement });
  }),
);

router.delete(
  "/announcements/:announcementId",
  writeLimiter,
  validate({ params: announcementIdParamSchema }),
  asyncHandler(async (req, res) => {
    await announcements.deleteAnnouncement(req.params.announcementId, { req });
    return ok(res, { deleted: true });
  }),
);

// ---------------------------------------------------------------------------
// Structured settings
// ---------------------------------------------------------------------------

router.get(
  "/settings/sections",
  asyncHandler(async (_req, res) => {
    const values = await settings.getSettings();
    const raw = await settings.getRawSettings();
    return ok(res, {
      sections: values,
      metadata: raw.map((row) => ({
        key: row.key,
        description: row.description,
        updatedAt: row.updated_at,
        updatedByFirstName: row.updated_by_first_name,
        updatedByLastName: row.updated_by_last_name,
      })),
    });
  }),
);

router.patch(
  "/settings/sections/:key",
  writeLimiter,
  validate({
    params: settingSectionKeySchema,
    body: z.object({ value: z.record(z.string(), z.unknown()) }),
  }),
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    const patch = req.body.value;

    const schema = settingSectionSchemas[key];
    const current = await settings.getSection(key);
    const merged = { ...current, ...patch };

    const parsed = schema.safeParse(merged);
    if (!parsed.success) {
      const fields = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path.join(".") || "value";
        if (!fields[field]) fields[field] = issue.message;
      }
      throw new AppError("Please check the highlighted settings.", {
        status: 422,
        code: "VALIDATION_FAILED",
        fields,
      });
    }

    const before = await settings.getSection(key);
    const section = await settings.setSection(key, parsed.data, { updatedBy: req.user.id });

    await recordAudit({
      actor: actor(req),
      req,
      action: AUDIT.SETTINGS_UPDATED,
      entityType: "system_setting",
      entityId: key,
      metadata: { changed: Object.keys(patch) },
      required: true,
    });

    // Maintenance mode is significant enough to deserve its own audit entry.
    if (key === "maintenance.settings" && before.enabled !== parsed.data.enabled) {
      await recordAudit({
        actor: actor(req),
        req,
        action: parsed.data.enabled ? AUDIT.MAINTENANCE_ENABLED : AUDIT.MAINTENANCE_DISABLED,
        entityType: "system_setting",
        entityId: key,
        metadata: { message: parsed.data.message },
        required: true,
      });
    }

    return ok(res, { section });
  }),
);

// ---------------------------------------------------------------------------
// AI configuration and usage
// ---------------------------------------------------------------------------

/** PATCH /api/admin/ai/config — runtime knobs only, never credentials. */
router.patch(
  "/ai/config",
  writeLimiter,
  validate({ body: aiRuntimeUpdateSchema }),
  asyncHandler(async (req, res) => {
    const current = await settings.getSection("ai.runtime");
    const merged = { ...current, ...req.body };

    // Re-validate the merged shape; a partial patch cannot persist an invalid
    // combination (for example a zero timeout).
    const parsed = settingSectionSchemas["ai.runtime"].safeParse(merged);
    if (!parsed.success) {
      const fields = {};
      for (const issue of parsed.error.issues) fields[issue.path.join(".") || "value"] = issue.message;
      throw new AppError("Please check the AI settings.", { status: 422, code: "VALIDATION_FAILED", fields });
    }

    await settings.setSection("ai.runtime", parsed.data, { updatedBy: req.user.id });

    await recordAudit({
      actor: actor(req),
      req,
      action: AUDIT.AI_CONFIG_UPDATED,
      entityType: "system_setting",
      entityId: "ai.runtime",
      metadata: { changes: req.body },
      required: true,
    });

    return ok(res, { config: await aiConfig.aiConfiguration() });
  }),
);

/** GET /api/admin/ai/usage — real telemetry, not inferred numbers. */
router.get(
  "/ai/usage",
  searchLimiter,
  validate({ query: aiUsageQuerySchema }),
  asyncHandler(async (req, res) => {
    const report = await aiConfig.aiUsageReport(req.query.range);
    return ok(res, { ...report, configuration: await aiConfig.aiConfiguration() });
  }),
);

/** POST /api/admin/ai/test — live provider probe. */
router.post(
  "/ai/test",
  writeLimiter,
  asyncHandler(async (req, res) => {
    const result = await aiConfig.testProvider();
    await recordAudit({
      actor: actor(req),
      req,
      action: AUDIT.AI_PROVIDER_TESTED,
      entityType: "ai_provider",
      entityId: result.provider ?? "unconfigured",
      metadata: { ok: result.ok, latencyMs: result.latencyMs ?? null, code: result.code ?? null },
      outcome: result.ok ? "SUCCESS" : "FAILURE",
      required: true,
    });
    return ok(res, { result });
  }),
);

/** GET /api/admin/ai/chain — circuit breaker state for every target. */
router.get(
  "/ai/chain",
  asyncHandler(async (_req, res) => {
    const circuits = getCircuitSnapshot();
    const chain = getTargets().map((target) => ({
      id: target.id,
      provider: target.provider,
      label: target.label,
      model: target.chatModel,
      circuit: circuits[target.id]?.state ?? "CLOSED",
      failures: circuits[target.id]?.failures ?? 0,
      lastFailureAt: circuits[target.id]?.lastFailureAt ?? null,
    }));

    return ok(res, {
      chain,
      providers: configuredKeys(),
      embeddingModel: configuredEmbeddingModel(),
      configured: aiStatus().configured,
    });
  }),
);

/** POST /api/admin/ai/chain/:id/reset — clear a tripped breaker. */
router.post(
  "/ai/chain/:id/reset",
  writeLimiter,
  validate({ params: z.object({ id: z.string().trim().min(3).max(200) }) }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!getTargets().some((target) => target.id === id)) throw new NotFoundError("That AI provider target");

    resetCircuit(id);

    await recordAudit({
      actor: actor(req),
      req,
      action: AUDIT.AI_PROVIDER_RESET,
      entityType: "ai_provider",
      entityId: id,
      metadata: {},
      required: true,
    });

    return ok(res, { id, circuit: getCircuitSnapshot(id) });
  }),
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** GET /api/admin/audit/search — filtered, paginated audit trail. */
router.get(
  "/audit/search",
  searchLimiter,
  validate({ query: adminAuditQuerySchema }),
  asyncHandler(async (req, res) => {
    const { action, entityType, entityId, actorId, outcome, from, to, limit, cursor } = req.query;

    const params = [];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const clauses = [];
    if (action) clauses.push(`a.action = ${bind(action)}`);
    if (entityType) clauses.push(`a.entity_type = ${bind(entityType)}`);
    if (entityId) clauses.push(`a.entity_id = ${bind(entityId)}`);
    if (actorId) clauses.push(`a.actor_id = ${bind(actorId)}`);
    if (outcome) clauses.push(`a.outcome = ${bind(outcome)}`);
    if (from) clauses.push(`a.created_at >= ${bind(from)}`);
    if (to) clauses.push(`a.created_at <= ${bind(to)}`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const entries = await queryRows(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.outcome,
              a.ip_address, a.user_agent, a.created_at, a.actor_role,
              u.email AS actor_email, u.first_name AS actor_first_name, u.last_name AS actor_last_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         ${where}
        ORDER BY a.id DESC
        LIMIT ${bind(limit + 1)} OFFSET ${bind(cursor)}`,
      params,
      "console:auditSearch",
    );

    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;

    const actions = await queryRows(
      "SELECT DISTINCT action FROM audit_logs ORDER BY action",
      [],
      "console:auditActions",
    );

    return ok(res, {
      entries: page.map((row) => ({ ...row, metadata: sanitiseMetadata(row.metadata) })),
      cursor: hasMore ? cursor + limit : null,
      actions: actions.map((row) => row.action),
    });
  }),
);

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/system/health
 *
 * Every value is measured at request time. Nothing here is a placeholder: the
 * database check is a real round-trip, migration counts come from
 * `schema_migrations`, and each integration reports its honest configured state.
 */
router.get(
  "/system/health",
  asyncHandler(async (_req, res) => {
    let database = { ok: false, latencyMs: null };
    try {
      const check = await healthcheck();
      database = { ok: true, latencyMs: check.latencyMs };
    } catch (error) {
      logger.error("Admin health check failed to reach the database", { message: error.message });
    }

    const pool = poolStats();

    let details = null;
    let migrations = null;
    let queues = null;
    let activity = null;

    if (database.ok) {
      try {
        [details, migrations, queues, activity] = await Promise.all([
          queryOne(
            `SELECT current_database() AS database,
                    version() AS version,
                    pg_size_pretty(pg_database_size(current_database())) AS size,
                    (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections`,
            [],
            "console:dbDetails",
          ),
          queryOne(
            `SELECT count(*)::int AS applied, max(applied_at) AS last_applied, max(duration_ms) AS slowest_ms
               FROM schema_migrations`,
            [],
            "console:migrations",
          ),
          queryOne(
            `SELECT
               (SELECT count(*)::int FROM admin_announcements WHERE status = 'SCHEDULED') AS scheduled_announcements,
               (SELECT count(*)::int FROM admin_announcements WHERE status = 'SCHEDULED' AND scheduled_for <= now()) AS due_announcements,
               (SELECT count(*)::int FROM notifications WHERE created_at >= now() - interval '1 hour') AS notifications_last_hour,
               (SELECT count(*)::int FROM ai_usage_events WHERE created_at >= now() - interval '1 hour') AS ai_requests_last_hour`,
            [],
            "console:queues",
          ),
          queryOne(
            `SELECT
               (SELECT count(*)::int FROM users WHERE deleted_at IS NULL AND status = 'ACTIVE') AS active_users,
               (SELECT count(*)::int FROM study_groups WHERE status = 'ACTIVE') AS active_groups,
               (SELECT count(*)::int FROM study_sessions WHERE status = 'ACTIVE') AS live_sessions,
               (SELECT count(*)::int FROM reports WHERE status IN ('OPEN', 'IN_REVIEW')) AS open_reports,
               (SELECT count(*)::int FROM audit_logs WHERE created_at >= now() - interval '24 hours') AS audit_events_24h,
               (SELECT max(created_at) FROM audit_logs) AS last_audit_at`,
            [],
            "console:activity",
          ),
        ]);
      } catch (error) {
        // A partially failing diagnostic query should degrade the report, not
        // fail the whole page.
        logger.warn("System health detail query failed", { message: error.message });
      }
    }

    const ai = aiStatus();
    const emailConfigured = Boolean(env.SMTP_HOST || env.RESEND_API_KEY);
    const memory = process.memoryUsage();

    const services = [
      {
        key: "database",
        label: "PostgreSQL",
        ok: database.ok,
        detail: database.ok ? `${details?.connections ?? pool.total} connections · ${details?.size ?? "size unavailable"}` : "Unreachable",
        latencyMs: database.latencyMs,
      },
      {
        key: "ai",
        label: "AI provider",
        ok: ai.configured,
        detail: ai.configured ? `${ai.provider} · ${ai.model}` : "Not configured (optional)",
        required: false,
      },
      {
        key: "email",
        label: "Email delivery",
        ok: emailConfigured,
        detail: emailConfigured ? "SMTP/API credentials present" : "Not configured (in-app only)",
        required: false,
      },
      {
        key: "realtime",
        label: "Realtime transport",
        ok: true,
        detail: "In-process WebSocket hub attached to the API",
      },
      {
        key: "scheduler",
        label: "Announcement scheduler",
        ok: database.ok,
        detail: database.ok ? `${queues?.due_announcements ?? 0} due now` : "Requires the database",
      },
    ];

    return ok(res, {
      status: database.ok ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      app: {
        name: env.APP_NAME,
        environment: env.NODE_ENV,
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        pid: process.pid,
      },
      database: {
        ...database,
        pool,
        details,
      },
      migrations,
      queues,
      activity,
      services,
      memory: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      },
      ai: {
        configured: ai.configured,
        provider: ai.provider,
        model: ai.model,
        embeddingModel: configuredEmbeddingModel(),
        chains: getCircuitSnapshot(),
      },
    });
  }),
);

export default router;
