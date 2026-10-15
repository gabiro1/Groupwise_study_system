import { Router } from "express";
import { asyncHandler, ok, created } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { writeLimiter, searchLimiter } from "../middleware/rateLimit.js";
import { query, queryRows, queryOne, withTransaction, healthcheck } from "../config/db.js";
import env from "../config/env.js";
import { NotFoundError, ConflictError, AppError, ForbiddenError } from "../lib/errors.js";
import { recordAudit, AUDIT } from "../lib/audit.js";
import {
  adminUserQuerySchema,
  changeRoleSchema,
  suspendUserSchema,
  restoreUserSchema,
  reportQuerySchema,
  resolveReportSchema,
  createReportSchema,
  settingsSchema,
  createCourseSchema,
  updateCourseSchema,
  courseIdParamSchema,
  adminCatalogueRequestQuerySchema,
  approveCatalogueRequestSchema,
  declineCatalogueRequestSchema,
  catalogueRequestIdParamSchema,
  z,
} from "../lib/schemas.js";
import * as catalogue from "../services/catalogue.service.js";

const router = Router();

/**
 * Admin routes.
 *
 * Two properties are load-bearing here.
 *
 * 1. **Every mutation is audited.** Suspension, role change, content removal and
 *    weight calibration all write to `audit_logs` with the acting admin, before
 *    the response is returned. An administrative action that leaves no trace is
 *    indistinguishable from a bug.
 * 2. **Admins cannot escalate their own privileges.** No admin can grant ADMIN,
 *    change another admin's role, or suspend a fellow admin. A compromised
 *    moderator account should not be able to hand itself the whole system.
 */

// The role guard below depends on `req.user` (set by `requireAuth`). The
// separately mounted `reportRouter` is intentionally unaffected and allows any
// signed-in user to file a report.
router.use(requireAuth);
router.use(requireAdmin);

/**
 * POST /api/admin/reports — file a report.
 *
 * Mounted before the admin-only middleware below so that any authenticated user
 * can report a group, message or profile. Without it, harassment would have no
 * reporting path, which is the opposite of what moderation is for.
 */
export const reportRouter = Router();

// Filing a report requires a signed-in account, but nothing else: no student role,
// no admin rights. A suspended user reaching this route is a policy question, not
// a technical one, and is deliberately not decided here.
reportRouter.use(requireAuth);

reportRouter.post(
  "/",
  writeLimiter,
  validate({ body: createReportSchema }),
  asyncHandler(async (req, res) => {
    // A user cannot report themselves: it is always a mistake, and it would let
    // someone manufacture a moderation record against their own account.
    if (req.body.targetType === "STUDENT" && req.body.targetId === req.user.id) {
      throw new AppError("You cannot report yourself.", { status: 422, code: "SELF_REPORT" });
    }

    const target = await resolveReportTarget(req.user.id, req.body.targetType, req.body.targetId);

    // Reporting content you cannot see is a way to probe for its existence, so the
    // 404 here is intentional and matches what a non-existent target returns.
    if (!target.exists || (target.type === "STUDENT" && !target.visible)) {
      throw new NotFoundError("That item");
    }

    // One open report per reporter per target: prevents both report spam and a
    // user burying an item under duplicates to skew the queue.
    const existing = await queryOne(
      `SELECT id FROM reports
        WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3 AND status IN ('OPEN', 'IN_REVIEW')`,
      [req.user.id, req.body.targetType, req.body.targetId],
      "admin:existingReport",
    );

    if (existing) {
      throw new ConflictError("You have already reported this. Our team is reviewing it.", {
        code: "ALREADY_REPORTED",
        fields: {},
      });
    }

    const report = await queryOne(
      `INSERT INTO reports (reporter_id, target_type, target_id, category, details)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, req.body.targetType, req.body.targetId, req.body.category, req.body.details],
      "admin:createReport",
    );

    return created(res, {
      report: { id: report.id, status: report.status, createdAt: report.created_at },
      message: "Thanks — our moderation team will take a look.",
    });
  }),
);

/** Confirm the target exists and, for a student, that the reporter may see them. */
async function resolveReportTarget(reporterId, targetType, targetId) {
  const table = {
    STUDENT: "users",
    GROUP: "study_groups",
    MESSAGE: "messages",
    RESOURCE: "resources",
  }[targetType];

  const where = {
    STUDENT: "deleted_at IS NULL",
    GROUP: "TRUE",
    MESSAGE: "deleted_at IS NULL",
    RESOURCE: "is_deleted = FALSE",
  }[targetType];

  const row = await queryOne(`SELECT 1 FROM ${table} WHERE id = $1 AND ${where}`, [targetId], "admin:reportTarget");

  if (!row) return { exists: false };

  if (targetType !== "STUDENT") return { exists: true };

  // A student is only reportable by someone who could otherwise see them. The
  // profile loader already applies every visibility rule, so reusing it means the
  // reporting path cannot drift from the browsing path — the same 404 for both.
  const { getStudentProfile } = await import("../services/discovery.service.js");

  try {
    // `viewerId` is the reporter, so this evaluates exactly what they can see.
    await getStudentProfile(reporterId, targetId);
    return { exists: true, visible: true };
  } catch {
    return { exists: true, visible: false };
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/users
 *
 * Search is scoped by the admin's own visibility rules rather than by a raw join:
 * a university admin listing students should not silently cross universities, so
 * the filter is explicit and optional rather than assumed.
 */
router.get(
  "/users",
  searchLimiter,
  validate({ query: adminUserQuerySchema }),
  asyncHandler(async (req, res) => {
    const filters = req.query;
    const params = [];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const clauses = ["u.deleted_at IS NULL"];

    if (filters.role) clauses.push(`r.key = ${bind(filters.role)}`);
    if (filters.status) clauses.push(`u.status = ${bind(filters.status)}`);
    if (filters.universityId) clauses.push(`sp.university_id = ${bind(filters.universityId)}`);
    if (filters.courseId) {
      clauses.push(
        `EXISTS (SELECT 1 FROM student_courses sc WHERE sc.student_id = u.id AND sc.course_id = ${bind(filters.courseId)})`,
      );
    }
    if (filters.q) {
      clauses.push(
        `(concat(u.first_name, ' ', u.last_name) ILIKE '%' || ${bind(filters.q)} || '%' OR u.email ILIKE '%' || ${bind(filters.q)} || '%')`,
      );
    }

    const rows = await queryRows(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.status, r.key AS role,
              u.email_verified_at, u.last_login_at, u.created_at, u.suspended_at, u.suspension_reason,
              sp.onboarding_step, sp.onboarding_done, sp.university_id,
              (SELECT count(*)::int FROM study_group_members m
                WHERE m.student_id = u.id AND m.left_at IS NULL) AS group_count
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN student_profiles sp ON sp.user_id = u.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY u.created_at DESC
        LIMIT ${bind(filters.limit)} OFFSET ${bind(filters.cursor ?? 0)}`,
      params,
      "admin:listUsers",
    );

    return ok(res, {
      users: rows,
      // Cursor is an offset here for simplicity. Correctness over cleverness: the
      // list is administrative and rarely deep enough for keyset paging to pay
      // for its complexity.
      cursor: Number(filters.cursor ?? 0) + rows.length < filters.limit ? Number(filters.cursor ?? 0) + rows.length : null,
    });
  }),
);

/**
 * POST /api/admin/users/role
 *
 * Role changes are one-directional by policy: an admin may grant GROUP_LEADER or
 * STUDENT, but never ADMIN, and never to another admin. Granting admin rights
 * should be a deliberate, out-of-band operation.
 */
router.post(
  "/users/role",
  writeLimiter,
  validate({ body: changeRoleSchema }),
  asyncHandler(async (req, res) => {
    const { userId, role, reason } = req.body;

    if (role === "ADMIN") {
      throw new ForbiddenError("Administrator access is granted out of band, not through this endpoint.");
    }

    const target = await queryOne(
      `SELECT u.id, u.status, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
      "admin:loadUser",
    );

    if (!target) throw new NotFoundError("That user");

    if (target.role === "ADMIN") {
      throw new ForbiddenError("An administrator's role cannot be changed here.");
    }

    if (target.role === role) {
      throw new ConflictError(`That user is already a ${role.toLowerCase()}.`);
    }

    // A group leader is only a leader while they actually lead a group. Demoting
    // them while memberships still say OWNER/MODERATOR would desynchronise the
    // role from the memberships that justify it.
    if (target.role === "GROUP_LEADER" && role === "STUDENT") {
      const leading = await queryOne(
        `SELECT count(*)::int AS groups
           FROM study_group_members m JOIN study_groups g ON g.id = m.group_id
          WHERE m.student_id = $1 AND m.left_at IS NULL AND m.status = 'ACTIVE'
            AND m.role IN ('OWNER', 'MODERATOR') AND g.status = 'ACTIVE'`,
        [userId],
        "admin:leaderGroups",
      );

      if (leading.groups > 0) {
        throw new ConflictError("That user still leads active groups. Remove them as a leader first.", {
          code: "STILL_LEADING",
          details: { groups: leading.groups },
        });
      }
    }

    const roleRow = await queryOne("SELECT id FROM roles WHERE key = $1", [role], "admin:role");
    if (!roleRow) throw new NotFoundError("That role");

    const updated = await withTransaction(async (tx) => {
      const user = await tx.queryOne(
        `UPDATE users SET role_id = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, email, first_name, last_name`,
        [userId, roleRow.id],
        "admin:changeRole",
      );

      // Sessions are revoked so a privilege change takes effect immediately
      // rather than at the user's next login.
      await tx.query(
        "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'role_change' WHERE user_id = $1 AND revoked_at IS NULL",
        [userId],
        "admin:revokeOnRoleChange",
      );

      await recordAudit(
        {
          actor: req.user,
          req,
          action: AUDIT.ROLE_CHANGED,
          entityType: "user",
          entityId: userId,
          metadata: { from: target.role, to: role, reason: reason ?? null },
        },
        { tx },
      );

      return user;
    }, "admin:changeRole");

    return ok(res, { user: updated, previousRole: target.role, sessionsRevoked: true });
  }),
);

/**
 * POST /api/admin/users/suspend
 *
 * Suspension is reversible and always reasoned. The reason is written to the user
 * row and the audit log, so the account can be restored later with the history
 * intact.
 */
router.post(
  "/users/suspend",
  writeLimiter,
  validate({ body: suspendUserSchema }),
  asyncHandler(async (req, res) => {
    const { userId, reason, suspendSessions } = req.body;

    if (userId === req.user.id) {
      throw new AppError("You cannot suspend your own account.", { status: 422, code: "SELF_SUSPEND" });
    }

    const target = await queryOne(
      `SELECT u.id, u.email, u.status, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
      "admin:loadSuspendTarget",
    );

    if (!target) throw new NotFoundError("That user");

    if (target.role === "ADMIN") {
      throw new ForbiddenError("Use a two-admin process to suspend another administrator.");
    }

    if (target.status === "SUSPENDED") {
      throw new ConflictError("That account is already suspended.");
    }

    const suspended = await withTransaction(async (tx) => {
      const user = await tx.queryOne(
        `UPDATE users SET status = 'SUSPENDED', suspended_at = now(), suspension_reason = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, email, status, suspended_at`,
        [userId, reason],
        "admin:suspend",
      );

      const sessions = suspendSessions
        ? await tx.query(
            `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'suspended'
              WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId],
            "admin:revokeOnSuspend",
          )
        : { rowCount: 0 };

      await recordAudit(
        {
          actor: req.user,
          req,
          action: AUDIT.ACCOUNT_SUSPENDED,
          entityType: "user",
          entityId: userId,
          metadata: { reason, sessionsRevoked: sessions.rowCount ?? 0 },
        },
        { tx },
      );

      return { user, sessionsRevoked: sessions.rowCount ?? 0 };
    }, "admin:suspend");

    return ok(res, suspended);
  }),
);

/** POST /api/admin/users/restore — undo a suspension. */
router.post(
  "/users/restore",
  writeLimiter,
  validate({ body: restoreUserSchema }),
  asyncHandler(async (req, res) => {
    const { userId, reason } = req.body;

    const target = await queryOne(
      "SELECT id, status FROM users WHERE id = $1 AND deleted_at IS NULL",
      [userId],
      "admin:loadRestoreTarget",
    );

    if (!target) throw new NotFoundError("That user");
    if (target.status !== "SUSPENDED") throw new ConflictError("That account is not suspended.");

    const restored = await withTransaction(async (tx) => {
      const user = await tx.queryOne(
        `UPDATE users
            SET status = CASE WHEN email_verified_at IS NULL THEN 'PENDING_VERIFICATION' ELSE 'ACTIVE' END,
                suspended_at = NULL, suspension_reason = NULL, updated_at = now()
          WHERE id = $1
          RETURNING id, email, status`,
        [userId],
        "admin:restore",
      );

      await recordAudit(
        {
          actor: req.user,
          req,
          action: AUDIT.ACCOUNT_RESTORED,
          entityType: "user",
          entityId: userId,
          metadata: { reason: reason ?? null },
        },
        { tx },
      );

      return user;
    }, "admin:restore");

    return ok(res, { user: restored });
  }),
);

// ---------------------------------------------------------------------------
// Moderation queue
// ---------------------------------------------------------------------------

router.get(
  "/reports",
  searchLimiter,
  validate({ query: reportQuerySchema }),
  asyncHandler(async (req, res) => {
    const filters = req.query;
    const params = [];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const clauses = [];
    if (filters.status) clauses.push(`rp.status = ${bind(filters.status)}`);
    if (filters.targetType) clauses.push(`rp.target_type = ${bind(filters.targetType)}`);
    if (!filters.status) clauses.push(`rp.status IN ('OPEN', 'IN_REVIEW')`);

    const reports = await queryRows(
      `SELECT rp.id, rp.target_type, rp.target_id, rp.category, rp.details, rp.status,
              rp.resolution, rp.created_at, rp.handled_at,
              reporter.first_name AS reporter_first_name, reporter.last_name AS reporter_last_name,
              reporter.email AS reporter_email
         FROM reports rp
         LEFT JOIN users reporter ON reporter.id = rp.reporter_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY rp.status, rp.created_at ASC
        LIMIT ${bind(filters.limit)}`,
      params,
      "admin:listReports",
    );

    return ok(res, { reports });
  }),
);

/**
 * POST /api/admin/reports/resolve
 *
 * The `action` decides what actually happens to the target, inside one
 * transaction with the report update — a report that says "removed" while the
 * content is still live is worse than no report at all.
 */
router.post(
  "/reports/resolve",
  writeLimiter,
  validate({ body: resolveReportSchema }),
  asyncHandler(async (req, res) => {
    const { reportId, status, resolution, action } = req.body;

    const report = await queryOne("SELECT id, target_type, target_id, status FROM reports WHERE id = $1", [
      reportId,
    ], "admin:loadReport");

    if (!report) throw new NotFoundError("That report");

    if (report.status === "RESOLVED" || report.status === "DISMISSED") {
      throw new ConflictError("That report is already closed.");
    }

    const result = await withTransaction(async (tx) => {
      let targetAffected = null;

      if (action === "REMOVE_CONTENT") {
        const affected =
          report.target_type === "MESSAGE"
            ? await tx.query("UPDATE messages SET deleted_at = now() WHERE id = $1", [report.target_id], "admin:removeMessage")
            : await tx.query("UPDATE resources SET is_deleted = TRUE, updated_at = now() WHERE id = $1", [report.target_id], "admin:removeResource");
        targetAffected = affected.rowCount;
      }

      if (action === "REMOVE_GROUP") {
        const affected = await tx.query(
          "UPDATE study_groups SET status = 'ARCHIVED', archived_at = now() WHERE id = $1 AND status <> 'ARCHIVED'",
          [report.target_id],
          "admin:archiveGroup",
        );
        targetAffected = affected.rowCount;
      }

      if (action === "SUSPEND_USER" && report.target_type === "STUDENT") {
        const target = await tx.queryOne(
          "SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL",
          [report.target_id],
          "admin:suspendReported",
        );

        if (target) {
          await tx.query(
            `UPDATE users SET status = 'SUSPENDED', suspended_at = now(), suspension_reason = $2, updated_at = now()
              WHERE id = $1`,
            [report.target_id, `Report ${report.id}: ${report.category}`],
            "admin:suspendReportedUser",
          );

          await tx.query(
            `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'moderation' WHERE user_id = $1 AND revoked_at IS NULL`,
            [report.target_id],
            "admin:revokeReported",
          );
          targetAffected = 1;
        }
      }

      if (action === "WARN_USER" && report.target_type === "STUDENT") {
        const { notify } = await import("../lib/notifications.js");
        await notify(
          {
            userId: report.target_id,
            type: "MODERATION",
            title: "A moderation notice",
            body: "Our team has reviewed a report about your activity. Please review the community guidelines.",
          },
          { tx },
        );
        targetAffected = 1;
      }

      const closed = await tx.queryOne(
        `UPDATE reports SET status = $2, resolution = $3, handled_by = $4, handled_at = now()
          WHERE id = $1 RETURNING *`,
        [reportId, status, resolution ?? null, req.user.id],
        "admin:resolveReport",
      );

      await recordAudit(
        {
          actor: req.user,
          req,
          action: AUDIT.REPORT_RESOLVED,
          entityType: "report",
          entityId: reportId,
          metadata: { status, action, targetType: report.target_type, targetId: report.target_id, targetAffected },
        },
        { tx },
      );

      return { report: closed, action, targetAffected };
    }, "admin:resolveReport");

    return ok(res, result);
  }),
);

// ---------------------------------------------------------------------------
// Audit log and settings
// ---------------------------------------------------------------------------

router.get(
  "/audit",
  searchLimiter,
  validate({
    query: z.object({
      action: z.string().max(80).optional(),
      entityType: z.string().max(40).optional(),
      entityId: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const rows = await queryRows(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.ip_address, a.created_at,
              u.email AS actor_email, u.first_name AS actor_first_name, u.last_name AS actor_last_name,
              a.actor_role
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::text IS NULL OR a.action = $1)
          AND ($2::text IS NULL OR a.entity_type = $2)
          AND ($3::text IS NULL OR a.entity_id = $3)
        ORDER BY a.id DESC LIMIT $4`,
      [req.query.action ?? null, req.query.entityType ?? null, req.query.entityId ?? null, req.query.limit],
      "admin:auditLog",
    );

    return ok(res, { entries: rows });
  }),
);

router.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    const settings = await queryRows("SELECT key, value, description, updated_at FROM system_settings ORDER BY key", [], "admin:settings");
    return ok(res, { settings });
  }),
);

router.put(
  "/settings/:key",
  writeLimiter,
  validate({ params: z.object({ key: z.string().max(80) }), body: settingsSchema }),
  asyncHandler(async (req, res) => {
    const setting = await queryOne(
      `INSERT INTO system_settings (key, value, description, updated_by)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, description = EXCLUDED.description,
             updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING key, value, description, updated_at`,
      [req.params.key, JSON.stringify(req.body.value ?? null), req.body.description ?? "", req.user.id],
      "admin:updateSetting",
    );

    await recordAudit({
          actor: req.user,
          req,
      action: AUDIT.SETTINGS_UPDATED,
      entityType: "system_setting",
      entityId: req.params.key,
      metadata: { value: req.body.value },
    });

    return ok(res, { setting });
  }),
);

router.delete(
  "/settings/:key",
  writeLimiter,
  validate({ params: z.object({ key: z.string().max(80) }) }),
  asyncHandler(async (req, res) => {
    const result = await query("DELETE FROM system_settings WHERE key = $1", [req.params.key], "admin:deleteSetting");
    if (result.rowCount === 0) throw new NotFoundError("That setting");

    await recordAudit({
          actor: req.user,
          req,
      action: "setting.deleted",
      entityType: "system_setting",
      entityId: req.params.key,
    });

    return ok(res, { deleted: true });
  }),
);

// ---------------------------------------------------------------------------
// Dashboard overview
// ---------------------------------------------------------------------------

/**
 * Build a dense day-by-day series from sparse grouped rows.
 *
 * The database returns one row per day that actually had activity; a chart needs
 * a point for every day in the window, zeros included, or the x-axis would
 * silently skip quiet days and misrepresent the trend.
 */
function buildDailySeries(range, rows) {
  const days = [];
  const now = new Date();
  for (let offset = range - 1; offset >= 0; offset -= 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - offset);
    days.push(day.toISOString().slice(0, 10));
  }

  const bySeries = { registration: {}, group: {}, session: {} };
  for (const row of rows) {
    if (bySeries[row.series]) bySeries[row.series][row.day] = row.n;
  }

  return {
    labels: days,
    registrations: days.map((day) => bySeries.registration[day] || 0),
    groups: days.map((day) => bySeries.group[day] || 0),
    sessions: days.map((day) => bySeries.session[day] || 0),
  };
}

/** Acceptance rate per day, from shown vs accepted recommendation counts. */
function buildAcceptanceTrend(range, rows) {
  const labels = buildDailySeries(range, []).labels;
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const shown = labels.map((day) => byDay.get(day)?.shown ?? 0);
  const accepted = labels.map((day) => byDay.get(day)?.accepted ?? 0);
  return {
    labels,
    shown,
    accepted,
    // Null (not zero) on a day with nothing shown: "no recommendations shown" and
    // "0% accepted" are materially different, and a chart must not conflate them.
    rate: labels.map((day, index) => (shown[index] > 0 ? Math.round((accepted[index] / shown[index]) * 1000) / 10 : null)),
  };
}

/**
 * GET /api/admin/overview
 *
 * Every number here is a database aggregate, computed with COUNT/AVG rather than
 * by shipping rows to the client. The whole dashboard is one request so the page
 * has a single loading state instead of eight staggered ones.
 *
 * Definitions are deliberately narrow and stated in the response so the UI can
 * label them honestly:
 *   - activeAccounts   = status ACTIVE (an enabled account, not "recently online")
 *   - totalMemberships = live, confirmed memberships (pending requests excluded)
 *   - sessionsThisMonth = non-cancelled sessions starting in the current calendar month
 *   - acceptanceRate   = recommendations accepted / recommendations shown
 */
router.get(
  "/overview",
  searchLimiter,
  validate({
    query: z.object({
      range: z.coerce
        .number()
        .int()
        .refine((value) => [7, 30, 90].includes(value), "Range must be 7, 30 or 90 days.")
        .default(30),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { range } = req.query;
    const since = new Date(Date.now() - range * 86_400_000);

    const [counts, seriesRows, activity, topGroups, recentReports, matching, acceptanceRows] =
      await Promise.all([
        queryOne(
          `SELECT
             (SELECT count(*)::int FROM users u JOIN roles r ON r.id = u.role_id
               WHERE r.key = 'STUDENT' AND u.deleted_at IS NULL)                       AS total_students,
             (SELECT count(*)::int FROM users u JOIN roles r ON r.id = u.role_id
               WHERE r.key = 'GROUP_LEADER' AND u.deleted_at IS NULL)                  AS total_group_leaders,
             (SELECT count(*)::int FROM users WHERE status = 'ACTIVE' AND deleted_at IS NULL)        AS active_accounts,
             (SELECT count(*)::int FROM users WHERE status = 'SUSPENDED' AND deleted_at IS NULL)     AS suspended_accounts,
             (SELECT count(*)::int FROM users WHERE status = 'DEACTIVATED' AND deleted_at IS NULL)   AS deactivated_accounts,
             (SELECT count(*)::int FROM users WHERE status = 'PENDING_VERIFICATION' AND deleted_at IS NULL) AS pending_accounts,
             (SELECT count(*)::int FROM study_groups)                                 AS total_groups,
             (SELECT count(*)::int FROM study_groups WHERE status = 'ACTIVE')         AS active_groups,
             (SELECT count(*)::int FROM workspaces WHERE NOT is_archived)             AS total_workspaces,
             (SELECT count(*)::int FROM study_group_members
               WHERE left_at IS NULL AND status = 'ACTIVE')                           AS total_memberships,
             (SELECT count(*)::int FROM reports WHERE status IN ('OPEN', 'IN_REVIEW')) AS pending_reports,
             (SELECT count(*)::int FROM study_sessions
               WHERE status = 'SCHEDULED' AND starts_at >= now())                      AS upcoming_sessions,
             (SELECT count(*)::int FROM users
               WHERE deleted_at IS NULL AND created_at >= now() - interval '7 days')   AS recent_registrations,
             (SELECT count(*)::int FROM study_sessions
               WHERE status <> 'CANCELLED'
                 AND starts_at >= date_trunc('month', now())
                 AND starts_at <  date_trunc('month', now()) + interval '1 month')    AS sessions_this_month`,
          [],
          "admin:overviewCounts",
        ),
        queryRows(
          `SELECT 'registration' AS series, to_char(date_trunc('day', u.created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
             FROM users u JOIN roles r ON r.id = u.role_id
            WHERE r.key = 'STUDENT' AND u.deleted_at IS NULL AND u.created_at >= $1
            GROUP BY 2
           UNION ALL
           SELECT 'group', to_char(date_trunc('day', g.created_at), 'YYYY-MM-DD'), count(*)::int
             FROM study_groups g WHERE g.created_at >= $1 GROUP BY 2
           UNION ALL
           SELECT 'session', to_char(date_trunc('day', s.created_at), 'YYYY-MM-DD'), count(*)::int
             FROM study_sessions s WHERE s.status <> 'CANCELLED' AND s.created_at >= $1 GROUP BY 2
           ORDER BY 2`,
          [since],
          "admin:overviewSeries",
        ),
        queryRows(
          `SELECT feed.type, feed.title, feed.detail, feed.link, feed.at
             FROM (
               SELECT 'registration' AS type, u.created_at AS at, 'New student registered' AS title,
                      (u.first_name || ' ' || u.last_name) AS detail, NULL::text AS link
                 FROM users u JOIN roles r ON r.id = u.role_id
                WHERE r.key = 'STUDENT' AND u.deleted_at IS NULL
               UNION ALL
               SELECT 'group', g.created_at, 'Study group created', g.name, '/admin/groups'
                 FROM study_groups g
               UNION ALL
               SELECT 'session', s.created_at, 'Study session scheduled', s.title, NULL
                 FROM study_sessions s WHERE s.status <> 'CANCELLED'
               UNION ALL
               SELECT 'report', rp.created_at, 'Report submitted',
                      initcap(replace(rp.category::text, '_', ' ')), '/admin/reports'
                 FROM reports rp
               UNION ALL
               SELECT 'join_request', jr.created_at, 'Membership request submitted', g.name, NULL
                 FROM study_group_join_requests jr JOIN study_groups g ON g.id = jr.group_id
             ) AS feed
            ORDER BY feed.at DESC NULLS LAST
            LIMIT 7`,
          [],
          "admin:overviewActivity",
        ),
        queryRows(
          `SELECT g.id, g.name, g.slug, g.status, g.member_count, g.max_size,
                  c.course_code, c.name AS course_name
             FROM study_groups g JOIN courses c ON c.id = g.course_id
            WHERE g.status <> 'ARCHIVED'
            ORDER BY g.member_count DESC, g.created_at DESC
            LIMIT 6`,
          [],
          "admin:overviewTopGroups",
        ),
        queryRows(
          `SELECT id, target_type, category, status, created_at
             FROM reports ORDER BY created_at DESC LIMIT 5`,
          [],
          "admin:overviewRecentReports",
        ),
        queryOne(
          `SELECT
             count(DISTINCT rr.id)::int AS requests,
             count(r.id)::int AS generated,
             count(r.id) FILTER (WHERE r.shown_at IS NOT NULL)::int AS shown,
             count(r.id) FILTER (WHERE r.accepted_at IS NOT NULL)::int AS accepted,
             round(avg(rr.latency_ms) FILTER (WHERE rr.latency_ms IS NOT NULL))::int AS avg_latency_ms
             FROM recommendation_requests rr
             LEFT JOIN recommendations r ON r.request_id = rr.id
            WHERE rr.created_at >= $1`,
          [since],
          "admin:overviewMatching",
        ),
        queryRows(
          `SELECT to_char(date_trunc('day', rr.created_at), 'YYYY-MM-DD') AS day,
                  count(r.id) FILTER (WHERE r.shown_at IS NOT NULL)::int AS shown,
                  count(r.id) FILTER (WHERE r.accepted_at IS NOT NULL)::int AS accepted
             FROM recommendation_requests rr
             LEFT JOIN recommendations r ON r.request_id = rr.id
            WHERE rr.created_at >= $1
            GROUP BY 1 ORDER BY 1`,
          [since],
          "admin:overviewAcceptanceTrend",
        ),
      ]);

    const distributionTotal =
      counts.active_accounts + counts.suspended_accounts + counts.deactivated_accounts + counts.pending_accounts;

    return ok(res, {
      generatedAt: new Date().toISOString(),
      range,
      metrics: {
        totalStudents: counts.total_students,
        totalGroupLeaders: counts.total_group_leaders,
        activeAccounts: counts.active_accounts,
        suspendedAccounts: counts.suspended_accounts,
        totalGroups: counts.total_groups,
        activeGroups: counts.active_groups,
        totalWorkspaces: counts.total_workspaces,
        totalMemberships: counts.total_memberships,
        pendingReports: counts.pending_reports,
        upcomingSessions: counts.upcoming_sessions,
        recentRegistrations: counts.recent_registrations,
        sessionsThisMonth: counts.sessions_this_month,
      },
      accountDistribution: {
        total: distributionTotal,
        statuses: [
          { key: "ACTIVE", count: counts.active_accounts },
          { key: "SUSPENDED", count: counts.suspended_accounts },
          { key: "PENDING_VERIFICATION", count: counts.pending_accounts },
          { key: "DEACTIVATED", count: counts.deactivated_accounts },
        ],
      },
      activitySeries: buildDailySeries(range, seriesRows),
      recentActivity: activity,
      topGroups,
      recentReports,
      matching: {
        requests: matching.requests,
        generated: matching.generated,
        shown: matching.shown,
        accepted: matching.accepted,
        acceptanceRate:
          matching.shown > 0 ? Math.round((matching.accepted / matching.shown) * 1000) / 10 : null,
        avgLatencyMs: matching.avg_latency_ms,
        acceptanceTrend: buildAcceptanceTrend(range, acceptanceRows),
      },
    });
  }),
);

/** GET /api/admin/groups — monitoring list for the Study Groups page. */
router.get(
  "/groups",
  searchLimiter,
  validate({
    query: z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum(["ACTIVE", "ARCHIVED", "DISBANDED"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { q, status, limit, cursor } = req.query;
    const params = [];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const clauses = [];
    if (status) clauses.push(`g.status = ${bind(status)}`);
    if (q) clauses.push(`(g.name ILIKE '%' || ${bind(q)} || '%' OR c.course_code ILIKE '%' || ${bind(q)} || '%')`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const groups = await queryRows(
      `SELECT g.id, g.name, g.slug, g.status, g.privacy, g.member_count, g.max_size, g.created_at,
              c.course_code, c.name AS course_name,
              owner.first_name AS owner_first_name, owner.last_name AS owner_last_name
         FROM study_groups g
         JOIN courses c ON c.id = g.course_id
         JOIN users owner ON owner.id = g.owner_id
         ${where}
        ORDER BY g.member_count DESC, g.created_at DESC
        LIMIT ${bind(limit)} OFFSET ${bind(cursor)}`,
      params,
      "admin:listGroups",
    );

    return ok(res, {
      groups,
      cursor: groups.length === limit ? cursor + limit : null,
    });
  }),
);

/** GET /api/admin/academic — catalogue sizes and the course register. */
router.get(
  "/academic",
  searchLimiter,
  validate({
    query: z.object({
      q: z.string().trim().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { q = null, limit } = req.query;

    const [counts, courses] = await Promise.all([
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM universities) AS universities,
           (SELECT count(*)::int FROM faculties)    AS faculties,
           (SELECT count(*)::int FROM departments)  AS departments,
           (SELECT count(*)::int FROM programs)     AS programs,
           (SELECT count(*)::int FROM courses)      AS courses,
           (SELECT count(*)::int FROM courses WHERE is_active) AS active_courses,
           (SELECT count(*)::int FROM skills)       AS skills,
           (SELECT count(*)::int FROM course_topics) AS topics`,
        [],
        "admin:academicCounts",
      ),
      queryRows(
        `SELECT c.id, c.course_code, c.name, c.level, c.is_active, c.credit_hours,
                d.name AS department_name, f.name AS faculty_name, un.name AS university_name,
                (SELECT count(*)::int FROM student_courses sc WHERE sc.course_id = c.id AND sc.is_active) AS enrolled_students,
                (SELECT count(*)::int FROM study_groups g WHERE g.course_id = c.id) AS groups_count
           FROM courses c
           LEFT JOIN departments d ON d.id = c.department_id
           LEFT JOIN faculties f ON f.id = d.faculty_id
           LEFT JOIN universities un ON un.id = f.university_id
          WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR c.course_code ILIKE '%' || $1 || '%')
          ORDER BY c.course_code
          LIMIT $2`,
        [q, limit],
        "admin:academicCourses",
      ),
    ]);

    return ok(res, { counts, courses });
  }),
);

// ---------------------------------------------------------------------------
// Academic taxonomy — course CRUD
//
// Courses are the taxonomy entity the admin console manages. Archiving is a
// soft toggle on the existing `courses.is_active` column: it never deletes the
// row, so enrolments, groups and topics stay referentially intact. Every
// mutation is audited, matching the rest of this router.
// ---------------------------------------------------------------------------

/** POST /api/admin/academic/courses — create a course. */
router.post(
  "/academic/courses",
  writeLimiter,
  validate({ body: createCourseSchema }),
  asyncHandler(async (req, res) => {
    const { courseCode, name, departmentId, description, creditHours, level } = req.body;

    // Validate the department relationship before inserting, so a bad FK is a
    // clean 422 rather than a raw driver error surfaced as a 400.
    if (departmentId) {
      const department = await queryOne("SELECT id FROM departments WHERE id = $1", [departmentId], "admin:courseDept");
      if (!department) throw new AppError("Select a valid department.", { status: 422, code: "INVALID_DEPARTMENT" });
    }

    let course;
    try {
      course = await queryOne(
        `INSERT INTO courses (course_code, name, department_id, description, credit_hours, level)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, course_code, name, level, is_active, credit_hours, department_id`,
        [courseCode.trim(), name.trim(), departmentId ?? null, description ?? "", creditHours ?? null, level ?? null],
        "admin:createCourse",
      );
    } catch (error) {
      // The unique index on course_code raises 23505; present it as a 409 the
      // form can show on the offending field.
      if (error.code === "DUPLICATE") {
        throw new ConflictError("A course with that code already exists.", { code: "DUPLICATE", fields: { courseCode: "That course code is already in use." } });
      }
      throw error;
    }

    await recordAudit({
      actor: req.user,
      req,
      action: AUDIT.COURSE_CREATED,
      entityType: "course",
      entityId: course.id,
      metadata: { courseCode: course.course_code, name: course.name },
    });

    return created(res, { course });
  }),
);

/** PATCH /api/admin/academic/courses/:courseId — edit or archive a course. */
router.patch(
  "/academic/courses/:courseId",
  writeLimiter,
  validate({ params: courseIdParamSchema, body: updateCourseSchema }),
  asyncHandler(async (req, res) => {
    const { courseId } = req.params;
    const updates = req.body;

    const existing = await queryOne(
      "SELECT id, course_code, name, is_active FROM courses WHERE id = $1",
      [courseId],
      "admin:loadCourse",
    );
    if (!existing) throw new NotFoundError("That course");

    if (updates.departmentId) {
      const department = await queryOne("SELECT id FROM departments WHERE id = $1", [updates.departmentId], "admin:courseDept");
      if (!department) throw new AppError("Select a valid department.", { status: 422, code: "INVALID_DEPARTMENT" });
    }

    // Build the SET clause only from provided fields, so a partial edit never
    // nulls out columns the caller did not send.
    const columns = {
      courseCode: "course_code",
      name: "name",
      departmentId: "department_id",
      description: "description",
      creditHours: "credit_hours",
      level: "level",
      isActive: "is_active",
    };
    const values = [];
    const assignments = [];
    for (const [key, column] of Object.entries(columns)) {
      if (updates[key] === undefined) continue;
      values.push(typeof updates[key] === "string" ? updates[key].trim() : updates[key]);
      assignments.push(`${column} = $${values.length + 1}`);
    }

    if (assignments.length === 0) {
      throw new AppError("Provide at least one field to update.", { status: 422, code: "NOTHING_TO_UPDATE" });
    }

    let updated;
    try {
      updated = await queryOne(
        `UPDATE courses SET ${assignments.join(", ")} WHERE id = $1
         RETURNING id, course_code, name, level, is_active, credit_hours, department_id`,
        [courseId, ...values],
        "admin:updateCourse",
      );
    } catch (error) {
      if (error.code === "DUPLICATE") {
        throw new ConflictError("A course with that code already exists.", { code: "DUPLICATE", fields: { courseCode: "That course code is already in use." } });
      }
      throw error;
    }

    const wasArchived = updates.isActive !== undefined && existing.is_active !== updates.isActive;
    await recordAudit({
      actor: req.user,
      req,
      action: wasArchived && updates.isActive === false ? AUDIT.COURSE_ARCHIVED : AUDIT.COURSE_UPDATED,
      entityType: "course",
      entityId: courseId,
      metadata: { courseCode: updated.course_code, changes: Object.keys(updates) },
    });

    return ok(res, { course: updated });
  }),
);

// ---------------------------------------------------------------------------
// Catalogue requests — the admin approval path.
//
// Students can only ask; the catalogue grows here. Approving creates the
// entity inside the same transaction that resolves the request.
// ---------------------------------------------------------------------------

/** GET /api/admin/catalogue-requests — the request queue. */
router.get(
  "/catalogue-requests",
  searchLimiter,
  validate({ query: adminCatalogueRequestQuerySchema }),
  asyncHandler(async (req, res) => {
    const requests = await catalogue.listAdminRequests({ status: req.query.status });
    return ok(res, { requests });
  }),
);

/** POST /api/admin/catalogue-requests/:catalogueRequestId/approve */
router.post(
  "/catalogue-requests/:catalogueRequestId/approve",
  writeLimiter,
  validate({ params: catalogueRequestIdParamSchema, body: approveCatalogueRequestSchema }),
  asyncHandler(async (req, res) => {
    const result = await catalogue.approveRequest(req.user.id, req.params.catalogueRequestId, req.body, { req });
    return ok(res, result);
  }),
);

/** POST /api/admin/catalogue-requests/:catalogueRequestId/decline */
router.post(
  "/catalogue-requests/:catalogueRequestId/decline",
  writeLimiter,
  validate({ params: catalogueRequestIdParamSchema, body: declineCatalogueRequestSchema }),
  asyncHandler(async (req, res) => {
    const result = await catalogue.declineRequest(req.user.id, req.params.catalogueRequestId, req.body, { req });
    return ok(res, result);
  }),
);


router.get(
  "/search",
  searchLimiter,
  validate({ query: z.object({ q: z.string().trim().min(2).max(120) }) }),
  asyncHandler(async (req, res) => {
    const { q } = req.query;

    const [users, groups] = await Promise.all([
      queryRows(
        `SELECT u.id, u.first_name, u.last_name, u.email, r.key AS role, u.status
           FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.deleted_at IS NULL
            AND (concat(u.first_name, ' ', u.last_name) ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
          ORDER BY u.created_at DESC
          LIMIT 6`,
        [q],
        "admin:searchUsers",
      ),
      queryRows(
        `SELECT g.id, g.name, g.slug, g.status, c.course_code
           FROM study_groups g JOIN courses c ON c.id = g.course_id
          WHERE g.name ILIKE '%' || $1 || '%' OR c.course_code ILIKE '%' || $1 || '%'
          ORDER BY g.member_count DESC
          LIMIT 6`,
        [q],
        "admin:searchGroups",
      ),
    ]);

    return ok(res, { users, groups });
  }),
);

/** GET /api/admin/system — real service health for the sidebar status footer. */
router.get(
  "/system",
  asyncHandler(async (_req, res) => {
    let database = { ok: false };
    try {
      const result = await healthcheck();
      database = { ok: true, latencyMs: result.latencyMs };
    } catch {
      database = { ok: false };
    }

    return ok(res, {
      status: database.ok ? "online" : "degraded",
      appName: env.APP_NAME,
      environment: env.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
      database,
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;