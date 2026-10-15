import { Router } from "express";
import { randomUUID } from "node:crypto";
import { asyncHandler, ok } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { writeLimiter, searchLimiter } from "../middleware/rateLimit.js";
import { queryRows, queryOne, withTransaction } from "../config/db.js";
import env from "../config/env.js";
import { NotFoundError, ConflictError, ForbiddenError } from "../lib/errors.js";
import { recordAudit, AUDIT } from "../lib/audit.js";
import { notify, notifyMany } from "../lib/notifications.js";
import { NOTIFICATION_TYPE } from "../config/constants.js";
import { aiStatus } from "../services/ai.service.js";
import { getTargets, configuredKeys, configuredEmbeddingModel } from "../modules/ai/registry.js";
import { getCircuitState, resetCircuit } from "../modules/ai/orchestration.js";
import { z } from "../lib/schemas.js";

/**
 * Admin management surface.
 *
 * The original `admin.routes.js` covers accounts, moderation, courses and the
 * overview dashboard. This router adds the management tools an administrator
 * needs around *groups and their leaders*, the academic delivery surfaces
 * (workspaces, sessions, meetings), analytics/export, platform announcements,
 * AI configuration and support visibility.
 *
 * Three invariants, matching the rest of the admin area:
 *   1. Every mutation is audited with the acting admin.
 *   2. The console never exposes a secret (AI keys, env values) or private
 *      student content (direct messages, private notes).
 *   3. Oversight is read-only unless the spec explicitly calls for a write.
 */

// The router only ever sees `req.user` after `requireAuth`; `requireAdmin`
// re-reads the role from the database so a demotion takes effect immediately.
const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

const limitQuery = z.coerce.number().int().min(1).max(100).default(50);
const cursorQuery = z.coerce.number().int().min(0).default(0);
const searchQuery = z.string().trim().max(120).optional();

// ---------------------------------------------------------------------------
// Group leaders
//
// A "group leader" is an account that owns or moderates at least one active
// group. Leadership is a membership permission (OWNER/MODERATOR) plus the
// GROUP_LEADER account role; this surface keeps the two in step.
// ---------------------------------------------------------------------------

const LEADERS_SUBQUERY = `
  (SELECT count(*)::int
     FROM study_group_members m JOIN study_groups g ON g.id = m.group_id
    WHERE m.student_id = u.id AND m.left_at IS NULL AND m.status = 'ACTIVE'
      AND m.role IN ('OWNER', 'MODERATOR') AND g.status = 'ACTIVE')`;

/** GET /api/admin/group-leaders — accounts currently leading active groups. */
router.get(
  "/group-leaders",
  searchLimiter,
  validate({ query: z.object({ q: searchQuery, limit: limitQuery, cursor: cursorQuery }) }),
  asyncHandler(async (req, res) => {
    const { q = null, limit, cursor } = req.query;

    const rows = await queryRows(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.status, u.created_at, u.last_login_at,
              ${LEADERS_SUBQUERY} AS leading_groups,
              (SELECT array_agg(g.name ORDER BY g.name)
                 FROM study_group_members m JOIN study_groups g ON g.id = m.group_id
                WHERE m.student_id = u.id AND m.left_at IS NULL AND m.status = 'ACTIVE'
                  AND m.role IN ('OWNER', 'MODERATOR') AND g.status = 'ACTIVE') AS group_names
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.key = 'GROUP_LEADER' AND u.deleted_at IS NULL
          AND ($1::text IS NULL
               OR concat(u.first_name, ' ', u.last_name) ILIKE '%' || $1 || '%'
               OR u.email ILIKE '%' || $1 || '%')
        ORDER BY leading_groups DESC, u.first_name ASC
        LIMIT $2 OFFSET $3`,
      [q, limit, cursor],
      "admin:listGroupLeaders",
    );

    return ok(res, { leaders: rows, cursor: rows.length === limit ? cursor + limit : null });
  }),
);

/** GET /api/admin/group-leaders/candidates — search accounts that could lead. */
router.get(
  "/group-leaders/candidates",
  searchLimiter,
  validate({
    query: z.object({ q: z.string().trim().min(2).max(120), limit: z.coerce.number().int().min(1).max(25).default(10) }),
  }),
  asyncHandler(async (req, res) => {
    const { q, limit } = req.query;
    const rows = await queryRows(
      `SELECT u.id, u.email, u.first_name, u.last_name, r.key AS role, u.status
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.deleted_at IS NULL AND r.key IN ('STUDENT', 'GROUP_LEADER')
          AND (concat(u.first_name, ' ', u.last_name) ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
        ORDER BY u.first_name ASC
        LIMIT $2`,
      [q, limit],
      "admin:leaderCandidates",
    );
    return ok(res, { candidates: rows });
  }),
);

/** GET /api/admin/groups/:groupId/leaders — owners and moderators of a group. */
router.get(
  "/groups/:groupId/leaders",
  searchLimiter,
  validate({ params: z.object({ groupId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const group = await queryOne(
      "SELECT id, name, status FROM study_groups WHERE id = $1",
      [req.params.groupId],
      "admin:groupForLeaders",
    );
    if (!group) throw new NotFoundError("That study group");

    const leaders = await queryRows(
      `SELECT u.id, u.email, u.first_name, u.last_name, m.role, m.joined_at
         FROM study_group_members m JOIN users u ON u.id = m.student_id
        WHERE m.group_id = $1 AND m.left_at IS NULL AND m.status = 'ACTIVE'
          AND m.role IN ('OWNER', 'MODERATOR')
        ORDER BY (m.role = 'OWNER') DESC, u.first_name ASC`,
      [req.params.groupId],
      "admin:groupLeaders",
    );

    return ok(res, { group, leaders });
  }),
);

/**
 * POST /api/admin/groups/:groupId/leaders — assign a leader to a group.
 *
 * The membership row is the source of truth for *which* group; the account role
 * is raised to GROUP_LEADER so leadership is visible everywhere. The two are
 * written in one transaction.
 */
router.post(
  "/groups/:groupId/leaders",
  writeLimiter,
  validate({ params: z.object({ groupId: z.string().uuid() }), body: z.object({ userId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.params;
    const { userId } = req.body;

    const group = await queryOne("SELECT id, name, status FROM study_groups WHERE id = $1", [groupId], "admin:loadGroup");
    if (!group) throw new NotFoundError("That study group");
    if (group.status !== "ACTIVE") {
      throw new ConflictError("Leaders can only be assigned to an active group.");
    }

    const user = await queryOne(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.status, r.key AS role
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
      "admin:loadLeaderTarget",
    );
    if (!user) throw new NotFoundError("That user");
    if (user.role === "ADMIN") throw new ForbiddenError("Administrators do not take group-leader memberships here.");

    const result = await withTransaction(async (tx) => {
      const membership = await tx.queryOne(
        `INSERT INTO study_group_members (group_id, student_id, role, status, joined_via, left_at)
         VALUES ($1, $2, 'MODERATOR', 'ACTIVE', 'DIRECT', NULL)
         ON CONFLICT (group_id, student_id) DO UPDATE
           SET role = CASE WHEN study_group_members.role = 'OWNER' THEN 'OWNER' ELSE 'MODERATOR' END,
               status = 'ACTIVE', left_at = NULL
         RETURNING id, role, status`,
        [groupId, userId],
        "admin:assignLeader",
      );

      // Raise a plain student to group leader; never touch an existing admin.
      await tx.query(
        `UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'GROUP_LEADER'), updated_at = now()
          WHERE id = $1
            AND role_id = (SELECT id FROM roles WHERE key = 'STUDENT')`,
        [userId],
        "admin:promoteLeaderRole",
      );

      await recordAudit(
        {
          actor: req.user,
          req,
          action: AUDIT.GROUP_LEADER_ASSIGNED,
          entityType: "study_group",
          entityId: groupId,
          metadata: { userId, groupName: group.name, membershipRole: membership.role },
        },
        { tx },
      );

      await notify(
        {
          userId,
          type: NOTIFICATION_TYPE.ROLE_ASSIGNED,
          title: "You are now a group leader",
          body: `You were added as a leader of “${group.name}”.`,
          link: "/dashboard/leader",
          metadata: { groupId },
        },
        { tx },
      );

      return membership;
    }, "admin:assignLeader");

    return ok(res, { membership: result, userId, groupId });
  }),
);

/**
 * DELETE /api/admin/groups/:groupId/leaders/:userId — remove a leader.
 *
 * Only moderators can be removed here; the owner must be transferred first so a
 * group is never left ownerless. If the user leads no other group their account
 * role drops back to STUDENT.
 */
router.delete(
  "/groups/:groupId/leaders/:userId",
  writeLimiter,
  validate({ params: z.object({ groupId: z.string().uuid(), userId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const { groupId, userId } = req.params;

    const membership = await queryOne(
      `SELECT id, role FROM study_group_members
        WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL AND status = 'ACTIVE'`,
      [groupId, userId],
      "admin:loadLeaderMembership",
    );
    if (!membership) throw new NotFoundError("That leadership assignment");
    if (membership.role === "OWNER") {
      throw new ConflictError("The group owner must transfer ownership before their leadership is removed.", {
        code: "OWNS_GROUP",
      });
    }

    const stillLeading = await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE study_group_members SET role = 'MEMBER'
          WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL AND role = 'MODERATOR'`,
        [groupId, userId],
        "admin:demoteLeaderMembership",
      );

      const remaining = await tx.queryOne(
        `SELECT count(*)::int AS n
           FROM study_group_members m JOIN study_groups g ON g.id = m.group_id
          WHERE m.student_id = $1 AND m.left_at IS NULL AND m.status = 'ACTIVE'
            AND m.role IN ('OWNER', 'MODERATOR') AND g.status = 'ACTIVE'`,
        [userId],
        "admin:countLeadingGroups",
      );

      if (remaining.n === 0) {
        await tx.query(
          `UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'STUDENT'), updated_at = now()
            WHERE id = $1 AND role_id = (SELECT id FROM roles WHERE key = 'GROUP_LEADER')`,
          [userId],
          "admin:demoteLeaderRole",
        );
      }

      await recordAudit(
        {
          actor: req.user,
          req,
          action: AUDIT.GROUP_LEADER_REMOVED,
          entityType: "study_group",
          entityId: groupId,
          metadata: { userId, remainingGroups: remaining.n },
        },
        { tx },
      );

      return remaining.n;
    }, "admin:removeLeader");

    return ok(res, { removed: true, userId, groupId, stillLeading });
  }),
);

// ---------------------------------------------------------------------------
// Workspaces — read-only oversight (metadata only, never private content).
// ---------------------------------------------------------------------------

router.get(
  "/workspaces",
  searchLimiter,
  validate({ query: z.object({ q: searchQuery, limit: limitQuery, cursor: cursorQuery }) }),
  asyncHandler(async (req, res) => {
    const { q = null, limit, cursor } = req.query;

    const workspaces = await queryRows(
      `SELECT w.id, w.name, w.description, w.is_archived, w.created_at,
              g.id AS group_id, g.name AS group_name, g.status AS group_status,
              c.course_code, c.name AS course_name,
              (SELECT count(*)::int FROM tasks t WHERE t.workspace_id = w.id) AS task_count,
              (SELECT count(*)::int FROM resources r WHERE r.workspace_id = w.id AND NOT r.is_deleted) AS resource_count,
              (SELECT count(*)::int FROM study_sessions s WHERE s.workspace_id = w.id) AS session_count
         FROM workspaces w
         LEFT JOIN study_groups g ON g.id = w.group_id
         LEFT JOIN courses c ON c.id = g.course_id
        WHERE ($1::text IS NULL OR w.name ILIKE '%' || $1 || '%' OR g.name ILIKE '%' || $1 || '%')
        ORDER BY w.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q, limit, cursor],
      "admin:listWorkspaces",
    );

    return ok(res, { workspaces, cursor: workspaces.length === limit ? cursor + limit : null });
  }),
);

/** GET /api/admin/workspaces/:workspaceId — aggregate detail, no private content. */
router.get(
  "/workspaces/:workspaceId",
  searchLimiter,
  validate({ params: z.object({ workspaceId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const workspace = await queryOne(
      `SELECT w.id, w.name, w.description, w.is_archived, w.created_at, w.archived_at,
              g.id AS group_id, g.name AS group_name, g.status AS group_status, g.member_count,
              c.course_code, c.name AS course_name
         FROM workspaces w
         LEFT JOIN study_groups g ON g.id = w.group_id
         LEFT JOIN courses c ON c.id = g.course_id
        WHERE w.id = $1`,
      [req.params.workspaceId],
      "admin:workspaceDetail",
    );
    if (!workspace) throw new NotFoundError("That workspace");

    const [counts, recentSessions] = await Promise.all([
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM tasks t WHERE t.workspace_id = $1) AS tasks,
           (SELECT count(*)::int FROM tasks t WHERE t.workspace_id = $1 AND t.status = 'COMPLETED') AS tasks_done,
           (SELECT count(*)::int FROM resources r WHERE r.workspace_id = $1 AND NOT r.is_deleted) AS resources,
           (SELECT count(*)::int FROM study_sessions s WHERE s.workspace_id = $1) AS sessions`,
        [req.params.workspaceId],
        "admin:workspaceCounts",
      ),
      queryRows(
        `SELECT id, title, status, starts_at FROM study_sessions
          WHERE workspace_id = $1 ORDER BY starts_at DESC LIMIT 5`,
        [req.params.workspaceId],
        "admin:workspaceSessions",
      ),
    ]);

    return ok(res, { workspace, counts, recentSessions });
  }),
);

// ---------------------------------------------------------------------------
// Study sessions
// ---------------------------------------------------------------------------

router.get(
  "/sessions",
  searchLimiter,
  validate({
    query: z.object({
      status: z.enum(["SCHEDULED", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]).optional(),
      q: searchQuery,
      limit: limitQuery,
      cursor: cursorQuery,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status = null, q = null, limit, cursor } = req.query;

    const sessions = await queryRows(
      `SELECT s.id, s.title, s.status, s.mode, s.starts_at, s.ends_at, s.created_at,
              w.id AS workspace_id, w.name AS workspace_name,
              g.id AS group_id, g.name AS group_name, c.course_code,
              host.first_name AS host_first_name, host.last_name AS host_last_name,
              (SELECT count(*)::int FROM session_participants p WHERE p.session_id = s.id) AS participants,
              (SELECT count(*)::int FROM session_participants p WHERE p.session_id = s.id AND p.attended) AS attended
         FROM study_sessions s
         JOIN workspaces w ON w.id = s.workspace_id
         JOIN study_groups g ON g.id = w.group_id
         LEFT JOIN courses c ON c.id = g.course_id
         LEFT JOIN users host ON host.id = s.created_by
        WHERE ($1::text IS NULL OR s.status::text = $1)
          AND ($2::text IS NULL OR s.title ILIKE '%' || $2 || '%' OR g.name ILIKE '%' || $2 || '%')
        ORDER BY s.starts_at DESC
        LIMIT $3 OFFSET $4`,
      [status, q, limit, cursor],
      "admin:listSessions",
    );

    return ok(res, { sessions, cursor: sessions.length === limit ? cursor + limit : null });
  }),
);

router.get(
  "/sessions/stats",
  searchLimiter,
  asyncHandler(async (_req, res) => {
    const stats = await queryOne(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'SCHEDULED')::int AS scheduled,
         count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
         count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
         count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
         count(*) FILTER (WHERE status = 'SCHEDULED' AND starts_at >= now())::int AS upcoming,
         count(*) FILTER (WHERE starts_at >= date_trunc('month', now())
                            AND starts_at < date_trunc('month', now()) + interval '1 month')::int AS this_month,
         (SELECT count(*)::int FROM session_participants) AS total_participations
       FROM study_sessions`,
      [],
      "admin:sessionStats",
    );
    return ok(res, { stats });
  }),
);

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

router.get(
  "/meetings",
  searchLimiter,
  validate({
    query: z.object({
      status: z.enum(["SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
      q: searchQuery,
      limit: limitQuery,
      cursor: cursorQuery,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status = null, q = null, limit, cursor } = req.query;

    const meetings = await queryRows(
      `SELECT m.id, m.title, m.status, m.provider, m.scheduled_start, m.expected_duration_minutes,
              m.created_at, g.id AS group_id, g.name AS group_name, c.course_code,
              host.first_name AS host_first_name, host.last_name AS host_last_name,
              (SELECT count(DISTINCT a.user_id)::int FROM meeting_attendance a WHERE a.meeting_id = m.id) AS attendees
         FROM group_meetings m
         JOIN study_groups g ON g.id = m.group_id
         LEFT JOIN courses c ON c.id = g.course_id
         LEFT JOIN users host ON host.id = m.created_by
        WHERE ($1::text IS NULL OR m.status::text = $1)
          AND ($2::text IS NULL OR m.title ILIKE '%' || $2 || '%' OR g.name ILIKE '%' || $2 || '%')
        ORDER BY m.scheduled_start DESC
        LIMIT $3 OFFSET $4`,
      [status, q, limit, cursor],
      "admin:listMeetings",
    );

    return ok(res, { meetings, cursor: meetings.length === limit ? cursor + limit : null });
  }),
);

router.get(
  "/meetings/stats",
  searchLimiter,
  asyncHandler(async (_req, res) => {
    const stats = await queryOne(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'SCHEDULED')::int AS scheduled,
         count(*) FILTER (WHERE status = 'LIVE')::int AS live,
         count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
         count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
         count(*) FILTER (WHERE status = 'SCHEDULED' AND scheduled_start >= now())::int AS upcoming,
         (SELECT count(*)::int FROM meeting_attendance) AS total_attendance_events
       FROM group_meetings`,
      [],
      "admin:meetingStats",
    );
    return ok(res, { stats });
  }),
);

// ---------------------------------------------------------------------------
// Analytics (date-ranged) + CSV export
// ---------------------------------------------------------------------------

const rangeQuery = z.object({
  range: z.coerce
    .number()
    .int()
    .refine((value) => [7, 30, 90].includes(value), "Range must be 7, 30 or 90 days.")
    .default(30),
});

/** Dense day-by-day series so a chart never skips a quiet day. */
function dailySeries(range, rows) {
  const days = [];
  const now = new Date();
  for (let offset = range - 1; offset >= 0; offset -= 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - offset);
    days.push(day.toISOString().slice(0, 10));
  }
  const bySeries = { registrations: {}, groups: {}, sessions: {}, meetings: {} };
  for (const row of rows) {
    if (bySeries[row.series]) bySeries[row.series][row.day] = row.n;
  }
  return {
    labels: days,
    registrations: days.map((day) => bySeries.registrations[day] || 0),
    groups: days.map((day) => bySeries.groups[day] || 0),
    sessions: days.map((day) => bySeries.sessions[day] || 0),
    meetings: days.map((day) => bySeries.meetings[day] || 0),
  };
}

async function collectAnalytics(range) {
  const since = new Date(Date.now() - range * 86_400_000);

  const [totals, seriesRows, active] = await Promise.all([
    queryOne(
      `SELECT
         (SELECT count(*)::int FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'STUDENT' AND u.deleted_at IS NULL) AS students,
         (SELECT count(*)::int FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'GROUP_LEADER' AND u.deleted_at IS NULL) AS group_leaders,
         (SELECT count(*)::int FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'ADMIN' AND u.deleted_at IS NULL) AS admins,
         (SELECT count(*)::int FROM users WHERE status = 'ACTIVE' AND deleted_at IS NULL) AS active_accounts,
         (SELECT count(*)::int FROM study_groups) AS groups,
         (SELECT count(*)::int FROM study_groups WHERE status = 'ACTIVE') AS active_groups,
         (SELECT count(*)::int FROM workspaces WHERE NOT is_archived) AS workspaces,
         (SELECT count(*)::int FROM study_sessions WHERE status <> 'CANCELLED') AS sessions,
         (SELECT count(*)::int FROM group_meetings WHERE status <> 'CANCELLED') AS meetings,
         (SELECT count(*)::int FROM reports WHERE status IN ('OPEN', 'IN_REVIEW')) AS pending_reports`,
      [],
      "admin:analyticsTotals",
    ),
    queryRows(
      `SELECT 'registrations' AS series, to_char(date_trunc('day', u.created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.key IN ('STUDENT', 'GROUP_LEADER') AND u.deleted_at IS NULL AND u.created_at >= $1
        GROUP BY 2
       UNION ALL
       SELECT 'groups', to_char(date_trunc('day', g.created_at), 'YYYY-MM-DD'), count(*)::int
         FROM study_groups g WHERE g.created_at >= $1 GROUP BY 2
       UNION ALL
       SELECT 'sessions', to_char(date_trunc('day', s.created_at), 'YYYY-MM-DD'), count(*)::int
         FROM study_sessions s WHERE s.status <> 'CANCELLED' AND s.created_at >= $1 GROUP BY 2
       UNION ALL
       SELECT 'meetings', to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD'), count(*)::int
         FROM group_meetings m WHERE m.status <> 'CANCELLED' AND m.created_at >= $1 GROUP BY 2
       ORDER BY 2`,
      [since],
      "admin:analyticsSeries",
    ),
    queryOne(
      `SELECT
         count(*) FILTER (WHERE last_login_at >= now() - interval '7 days')::int AS last_7,
         count(*) FILTER (WHERE last_login_at >= now() - interval '30 days')::int AS last_30
       FROM users WHERE deleted_at IS NULL`,
      [],
      "admin:analyticsActive",
    ),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    range,
    totals: {
      students: totals.students,
      groupLeaders: totals.group_leaders,
      admins: totals.admins,
      activeAccounts: totals.active_accounts,
      groups: totals.groups,
      activeGroups: totals.active_groups,
      workspaces: totals.workspaces,
      sessions: totals.sessions,
      meetings: totals.meetings,
      pendingReports: totals.pending_reports,
    },
    activeUsers: { last7Days: active.last_7, last30Days: active.last_30 },
    series: dailySeries(range, seriesRows),
  };
}

router.get(
  "/analytics",
  searchLimiter,
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const data = await collectAnalytics(req.query.range);
    return ok(res, data);
  }),
);

/** GET /api/admin/analytics/export — the same data as a CSV download. */
router.get(
  "/analytics/export",
  searchLimiter,
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { range } = req.query;
    const data = await collectAnalytics(range);

    const escape = (value) => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [];
    lines.push(`Lien analytics export,last ${range} days,generated,${data.generatedAt}`);
    lines.push("");
    lines.push("Metric,Value");
    for (const [key, value] of Object.entries(data.totals)) lines.push(`${escape(key)},${escape(value)}`);
    lines.push("");
    lines.push("Date,Registrations,Groups,Sessions,Meetings");
    data.series.labels.forEach((label, index) => {
      lines.push(
        [
          label,
          data.series.registrations[index],
          data.series.groups[index],
          data.series.sessions[index],
          data.series.meetings[index],
        ].join(","),
      );
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="lien-analytics-${range}d.csv"`);
    return res.send(lines.join("\n"));
  }),
);

// ---------------------------------------------------------------------------
// Platform announcements (reuses the notification pipeline)
// ---------------------------------------------------------------------------

const AUDIENCE = z.enum(["ALL", "STUDENTS", "GROUP_LEADERS", "ADMINS"]);

const AUDIENCE_ROLE = {
  STUDENTS: "STUDENT",
  GROUP_LEADERS: "GROUP_LEADER",
  ADMINS: "ADMIN",
};

/** GET /api/admin/notifications — recent platform broadcasts, newest first. */
router.get(
  "/notifications",
  searchLimiter,
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) }),
  asyncHandler(async (req, res) => {
    const broadcasts = await queryRows(
      `SELECT metadata->>'broadcastId' AS broadcast_id,
              min(title) AS title,
              min(body) AS body,
              metadata->>'audience' AS audience,
              count(*)::int AS recipients,
              count(*) FILTER (WHERE read_at IS NULL)::int AS unread,
              min(created_at) AS created_at
         FROM notifications
        WHERE type = 'SYSTEM' AND metadata->>'broadcastId' IS NOT NULL
        GROUP BY metadata->>'broadcastId', metadata->>'audience'
        ORDER BY created_at DESC
        LIMIT $1`,
      [req.query.limit],
      "admin:listBroadcasts",
    );

    return ok(res, { broadcasts });
  }),
);

/**
 * POST /api/admin/notifications/broadcast — send a platform announcement.
 *
 * Delivery is honest: the pipeline respects each user's notification
 * preferences, so the response reports both what was attempted and what was
 * actually recorded.
 */
router.post(
  "/notifications/broadcast",
  writeLimiter,
  validate({
    body: z.object({
      title: z.string().trim().min(3, "Give the announcement a title.").max(120),
      body: z.string().trim().min(3, "Write a short message.").max(2000),
      audience: AUDIENCE.default("ALL"),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { title, body, audience } = req.body;

    const params = [];
    let where = "u.deleted_at IS NULL AND u.status = 'ACTIVE'";
    if (audience !== "ALL") {
      params.push(AUDIENCE_ROLE[audience]);
      where += ` AND r.key = $${params.length}`;
    }

    const recipients = await queryRows(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where}`,
      params,
      "admin:broadcastRecipients",
    );

    const userIds = recipients.map((row) => row.id);
    const broadcastId = randomUUID();

    // A single advisory row per recipient keeps the pipeline unchanged while
    // still letting the console group a broadcast back together.
    const delivery = await notifyMany(userIds, {
      type: NOTIFICATION_TYPE.SYSTEM,
      title,
      body,
      metadata: { broadcastId, audience, source: "admin" },
    });

    await recordAudit({
      actor: req.user,
      req,
      action: AUDIT.ANNOUNCEMENT_SENT,
      entityType: "notification_broadcast",
      entityId: broadcastId,
      metadata: { audience, attempted: delivery.attempted, delivered: delivery.delivered },
    });

    return ok(res, {
      broadcastId,
      audience,
      attempted: delivery.attempted,
      delivered: delivery.delivered,
      // "delivered" means the notification was recorded for that user; users who
      // disabled notifications are counted as attempted but not delivered.
      skipped: delivery.attempted - delivery.delivered,
    });
  }),
);

// ---------------------------------------------------------------------------
// Support visibility (honest: no ticket system exists, so none is faked)
// ---------------------------------------------------------------------------

router.get(
  "/support/config",
  asyncHandler(async (_req, res) => {
    return ok(res, {
      supportEmail: env.SUPPORT_EMAIL ?? null,
      emailDelivery: Boolean(env.SMTP_HOST || env.RESEND_API_KEY),
      directMessagesPrivate: true,
      channels: [
        { key: "email", label: "Support email", detail: env.SUPPORT_EMAIL ?? "Not configured" },
        { key: "contact-form", label: "Public contact form", detail: "Routes to the support inbox" },
      ],
      note: "Support is handled over email. Direct messages between accounts are private and are never readable from the admin console.",
    });
  }),
);

// ---------------------------------------------------------------------------
// AI configuration (masked — provider metadata and failover state only)
// ---------------------------------------------------------------------------

function safeCircuitState(targetId) {
  try {
    return getCircuitState(targetId) ?? "CLOSED";
  } catch {
    return "CLOSED";
  }
}

/** GET /api/admin/ai/config — which providers are live, and their health. */
router.get(
  "/ai/config",
  asyncHandler(async (_req, res) => {
    const status = aiStatus();
    const chain = getTargets().map((target) => ({
      id: target.id,
      provider: target.provider,
      label: target.label,
      model: target.chatModel,
      circuit: safeCircuitState(target.id),
    }));

    return ok(res, {
      configured: status.configured,
      primary: status.provider ? { provider: status.provider, model: status.model } : null,
      providers: configuredKeys(),
      embeddingModel: configuredEmbeddingModel(),
      fallbacks: status.fallbacks,
      required: false,
      chain,
      // Stated plainly so the UI can say it without hedging.
      secretsExposed: false,
      note: "API keys are configured through environment variables and are never returned to the browser.",
    });
  }),
);

/** POST /api/admin/ai/providers/:id/reset — clear a tripped circuit breaker. */
router.post(
  "/ai/providers/:id/reset",
  writeLimiter,
  validate({ params: z.object({ id: z.string().trim().min(3).max(200) }) }),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const known = getTargets().some((target) => target.id === id);
    if (!known) throw new NotFoundError("That AI provider target");

    resetCircuit(id);

    await recordAudit({
      actor: req.user,
      req,
      action: AUDIT.AI_PROVIDER_RESET,
      entityType: "ai_provider",
      entityId: id,
      metadata: { circuit: safeCircuitState(id) },
    });

    return ok(res, { id, circuit: safeCircuitState(id) });
  }),
);

export default router;
