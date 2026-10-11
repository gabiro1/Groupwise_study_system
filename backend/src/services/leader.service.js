import { query, queryRows, queryOne } from "../config/db.js";
import { NotFoundError, ConflictError } from "../lib/errors.js";
import { notify, notifyMany } from "../lib/notifications.js";
import { NOTIFICATION_TYPE } from "../config/constants.js";
import { assertModerator } from "./group.service.js";

const MANAGED_ROLES = "('OWNER', 'MODERATOR')";

export async function managedGroupIds(userId) {
  const rows = await queryRows(
    `SELECT group_id FROM study_group_members
      WHERE student_id = $1 AND left_at IS NULL AND role IN ${MANAGED_ROLES}`,
    [userId],
    "leader:managedGroupIds",
  );
  return rows.map((row) => row.group_id);
}

export async function listPendingRequests(actorId, { groupId } = {}) {
  const params = [actorId];
  const clauses = [
    "jr.status = 'PENDING'",
    `EXISTS (SELECT 1 FROM study_group_members mm
              WHERE mm.group_id = jr.group_id AND mm.student_id = $1
                AND mm.left_at IS NULL AND mm.role IN ${MANAGED_ROLES})`,
  ];

  if (groupId) {
    await assertModerator(groupId, actorId);
    params.push(groupId);
    clauses.push(`jr.group_id = $${params.length}`);
  }

  const requests = await queryRows(
    `SELECT jr.id, jr.status, jr.message, jr.compatibility_score, jr.created_at,
            g.id AS group_id, g.name AS group_name, g.slug, g.privacy,
            g.member_count, g.max_size,
            c.course_code, c.name AS course_name,
            u.id AS student_id, u.first_name, u.last_name, u.avatar_url,
            sp.year_of_study
       FROM study_group_join_requests jr
       JOIN study_groups g ON g.id = jr.group_id
       JOIN courses c ON c.id = g.course_id
       JOIN users u ON u.id = jr.student_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY jr.created_at DESC`,
    params,
    "leader:pendingRequests",
  );

  return { requests };
}

export async function listPendingInvitations(actorId, { groupId } = {}) {
  const params = [actorId];
  const clauses = [
    "i.status = 'PENDING'",
    "i.expires_at > now()",
    `EXISTS (SELECT 1 FROM study_group_members mm
              WHERE mm.group_id = i.group_id AND mm.student_id = $1
                AND mm.left_at IS NULL AND mm.role IN ${MANAGED_ROLES})`,
  ];

  if (groupId) {
    await assertModerator(groupId, actorId);
    params.push(groupId);
    clauses.push(`i.group_id = $${params.length}`);
  }

  const invitations = await queryRows(
    `SELECT i.id, i.status, i.message, i.compatibility_score, i.expires_at, i.created_at,
            g.id AS group_id, g.name AS group_name, g.slug,
            c.course_code, c.name AS course_name,
            u.id AS student_id, u.first_name, u.last_name, u.avatar_url
       FROM study_group_invitations i
       JOIN study_groups g ON g.id = i.group_id
       JOIN courses c ON c.id = g.course_id
       JOIN users u ON u.id = i.invitee_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY i.created_at DESC`,
    params,
    "leader:pendingInvitations",
  );

  return { invitations };
}

export async function cancelInvitation(groupId, actorId, invitationId) {
  const { group } = await assertModerator(groupId, actorId);

  const invitation = await queryOne(
    `SELECT id, invitee_id, status FROM study_group_invitations
      WHERE id = $1 AND group_id = $2`,
    [invitationId, groupId],
    "leader:loadInvitation",
  );

  if (!invitation) throw new NotFoundError("That invitation");

  if (invitation.status !== "PENDING") {
    throw new ConflictError("That invitation is no longer pending.");
  }

  await query(
    `UPDATE study_group_invitations SET status = 'CANCELLED'
      WHERE id = $1 AND status = 'PENDING'`,
    [invitationId],
    "leader:cancelInvitation",
  );

  await query(
    `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
     VALUES ($1, $2, 'INVITATION_CANCELLED', 'invitation', $3)`,
    [groupId, actorId, invitationId],
    "leader:logCancelInvitation",
  );

  await notify({
    userId: invitation.invitee_id,
    type: NOTIFICATION_TYPE.SYSTEM,
    title: "Invitation withdrawn",
    body: `An invitation to ${group.name} was withdrawn.`,
    metadata: { groupId },
  });

  return { cancelled: true, invitationId };
}

export async function listLeaderSessions(actorId, { groupId, scope = "upcoming", limit = 20 } = {}) {
  const params = [actorId];
  const clauses = [
    `EXISTS (SELECT 1 FROM study_group_members mm
              WHERE mm.group_id = g.id AND mm.student_id = $1
                AND mm.left_at IS NULL AND mm.role IN ${MANAGED_ROLES})`,
  ];

  if (groupId) {
    await assertModerator(groupId, actorId);
    params.push(groupId);
    clauses.push(`g.id = $${params.length}`);
  }

  if (scope === "upcoming") {
    clauses.push("s.starts_at >= now()", "s.status = 'SCHEDULED'");
  } else if (scope === "past") {
    clauses.push("(s.starts_at < now() OR s.status IN ('COMPLETED', 'CANCELLED'))");
  }

  params.push(limit);

  const sessions = await queryRows(
    `SELECT s.id, s.title, s.starts_at, s.ends_at, s.mode, s.location, s.meeting_url,
            s.status, s.attendance_tracked,
            g.id AS group_id, g.name AS group_name, g.slug,
            w.id AS workspace_id,
            (SELECT count(*)::int FROM session_participants p
              WHERE p.session_id = s.id AND p.rsvp = 'GOING') AS going_count,
            (SELECT count(*)::int FROM study_group_members m2
              WHERE m2.group_id = g.id AND m2.left_at IS NULL) AS member_count
       FROM study_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN study_groups g ON g.id = w.group_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY ${scope === "past" ? "s.starts_at DESC" : "s.starts_at ASC"}
      LIMIT $${params.length}`,
    params,
    "leader:listSessions",
  );

  return { sessions };
}

export async function groupAnalytics(groupId, actorId, { days = 30 } = {}) {
  const { group } = await assertModerator(groupId, actorId);
  const window = String(days);

  const [membership, activity, byType, sessions, tasks, chat, joinSources] = await Promise.all([
    queryOne(
      `SELECT count(*) FILTER (WHERE left_at IS NULL)::int AS active,
              count(*) FILTER (WHERE left_at IS NULL AND role = 'OWNER')::int AS owners,
              count(*) FILTER (WHERE left_at IS NULL AND role = 'MODERATOR')::int AS moderators,
              count(*) FILTER (WHERE left_at IS NULL AND role = 'MEMBER')::int AS members,
              count(*) FILTER (WHERE joined_at > now() - ($2 || ' days')::interval)::int AS joined_in_window,
              count(*) FILTER (WHERE left_at > now() - ($2 || ' days')::interval)::int AS left_in_window
         FROM study_group_members WHERE group_id = $1`,
      [groupId, window],
      "leader:analyticsMembership",
    ),
    queryOne(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE created_at > now() - ($2 || ' days')::interval)::int AS in_window
         FROM group_activity_events WHERE group_id = $1`,
      [groupId, window],
      "leader:analyticsActivity",
    ),
    queryRows(
      `SELECT event_type, count(*)::int AS count
         FROM group_activity_events
        WHERE group_id = $1 AND created_at > now() - ($2 || ' days')::interval
        GROUP BY event_type ORDER BY count DESC, event_type LIMIT 8`,
      [groupId, window],
      "leader:analyticsEventTypes",
    ),
    queryOne(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE s.status = 'SCHEDULED' AND s.starts_at > now())::int AS upcoming,
              count(*) FILTER (WHERE s.status = 'COMPLETED')::int AS completed,
              count(*) FILTER (WHERE s.status = 'CANCELLED')::int AS cancelled
         FROM study_sessions s
         JOIN workspaces w ON w.id = s.workspace_id
        WHERE w.group_id = $1`,
      [groupId],
      "leader:analyticsSessions",
    ),
    queryOne(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE t.status = 'COMPLETED')::int AS completed,
              count(*) FILTER (WHERE t.status <> 'COMPLETED'
                                 AND t.due_at IS NOT NULL AND t.due_at < now())::int AS overdue
         FROM tasks t
         JOIN workspaces w ON w.id = t.workspace_id
        WHERE w.group_id = $1`,
      [groupId],
      "leader:analyticsTasks",
    ),
    queryOne(
      `SELECT count(*)::int AS messages
         FROM messages msg
         JOIN workspaces w ON w.id = msg.workspace_id
        WHERE w.group_id = $1 AND msg.deleted_at IS NULL
          AND msg.created_at > now() - ($2 || ' days')::interval`,
      [groupId, window],
      "leader:analyticsChat",
    ),
    queryRows(
      `SELECT joined_via, count(*)::int AS count
         FROM study_group_members WHERE group_id = $1
        GROUP BY joined_via ORDER BY count DESC`,
      [groupId],
      "leader:analyticsSources",
    ),
  ]);

  const attendance = await queryOne(
    `SELECT count(*) FILTER (WHERE p.rsvp = 'GOING')::int AS going,
            count(*) FILTER (WHERE p.attended IS TRUE)::int AS attended
       FROM session_participants p
       JOIN study_sessions s ON s.id = p.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE w.group_id = $1`,
    [groupId],
    "leader:analyticsAttendance",
  );

  return {
    group: {
      id: group.id,
      name: group.name,
      slug: group.slug,
      memberCount: group.member_count,
      maxSize: group.max_size,
    },
    windowDays: days,
    membership,
    activity: { ...activity, byType },
    sessions: { ...sessions, going: attendance?.going ?? 0, attended: attendance?.attended ?? 0 },
    tasks,
    chat,
    joinSources,
  };
}

export async function recommendMembers(groupId, actorId, { limit = 12, q } = {}) {
  const { group } = await assertModerator(groupId, actorId);
  const { searchStudents } = await import("./discovery.service.js");

  const result = await searchStudents(actorId, {
    courseId: group.course_id,
    excludeGroupId: groupId,
    limit,
    ...(q ? { q } : {}),
  });

  return {
    candidates: result.students.filter((student) => !student.alreadyInGroup).slice(0, limit),
    hasMore: result.hasMore,
  };
}

export async function postAnnouncement(groupId, actorId, { title, body }) {
  const { group } = await assertModerator(groupId, actorId);

  const recipients = await queryRows(
    `SELECT student_id FROM study_group_members
      WHERE group_id = $1 AND left_at IS NULL AND status = 'ACTIVE' AND student_id <> $2`,
    [groupId, actorId],
    "leader:announcementRecipients",
  );

  const workspace = await queryOne(
    `SELECT id FROM workspaces
      WHERE group_id = $1 AND NOT is_archived
      ORDER BY created_at DESC LIMIT 1`,
    [groupId],
    "leader:announcementWorkspace",
  );

  if (workspace) {
    await query(
      `INSERT INTO messages (workspace_id, author_id, kind, body, metadata)
       VALUES ($1, $2, 'SYSTEM', $3, $4)`,
      [
        workspace.id,
        actorId,
        `Announcement: ${title}\n\n${body}`,
        JSON.stringify({ announcement: true, title }),
      ],
      "leader:announcementMessage",
    );
  }

  await query(
    `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, metadata)
     VALUES ($1, $2, 'ANNOUNCEMENT', 'study_group', $3)`,
    [groupId, actorId, JSON.stringify({ title })],
    "leader:logAnnouncement",
  );

  await notifyMany(
    recipients.map((row) => row.student_id),
    {
      type: NOTIFICATION_TYPE.GROUP_ANNOUNCEMENT,
      title: `Announcement in ${group.name}: ${title}`,
      body,
      link: `/groups/${group.slug}`,
      metadata: { groupId },
    },
  );

  return {
    posted: true,
    groupId,
    notified: recipients.length,
    workspaceId: workspace?.id ?? null,
  };
}

export default {
  managedGroupIds,
  listPendingRequests,
  listPendingInvitations,
  cancelInvitation,
  listLeaderSessions,
  groupAnalytics,
  recommendMembers,
  postAnnouncement,
};
