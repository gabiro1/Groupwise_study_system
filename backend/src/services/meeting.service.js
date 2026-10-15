import { randomUUID } from "node:crypto";
import { query, queryOne, queryRows, withTransaction } from "../config/db.js";
import env from "../config/env.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { assertMember, assertModerator } from "./group.service.js";
import { notifyMany } from "../lib/notifications.js";
import { NOTIFICATION_TYPE, MEETING_TRANSITIONS, MEETING_JOIN_WINDOW_MINUTES } from "../config/constants.js";
import { PROVIDERS, buildRoomIdentifier, buildJoinConfig, normalizeGoogleMeetUrl } from "./videoProvider.service.js";
import logger from "../config/logger.js";

const MOD_ROLES = new Set(["OWNER", "MODERATOR"]);
const TERMINAL = new Set(["COMPLETED", "CANCELLED"]);

async function loadMeeting(meetingId) {
  const meeting = await queryOne(
    `SELECT m.*, g.name AS group_name, g.slug AS group_slug,
            u.first_name AS organizer_first_name, u.last_name AS organizer_last_name
       FROM group_meetings m
       JOIN study_groups g ON g.id = m.group_id
       LEFT JOIN users u ON u.id = m.created_by
      WHERE m.id = $1`,
    [meetingId], "meetings:load",
  );
  if (!meeting) throw new NotFoundError("That meeting");
  return { ...meeting };
}

async function meetingAccess(meetingId, userId) {
  const meeting = await loadMeeting(meetingId);
  const { membership } = await assertMember(meeting.group_id, userId);
  return { meeting, membership, isModerator: MOD_ROLES.has(membership.role) };
}

export function isJoinable(meeting, now = new Date()) {
  if (meeting.status === "CANCELLED" || meeting.status === "COMPLETED") return false;
  if (meeting.status === "LIVE") return true;
  const start = new Date(meeting.scheduled_start).getTime();
  if (Number.isNaN(start)) return false;
  const windowMs = MEETING_JOIN_WINDOW_MINUTES * 60 * 1000;
  const end = start + Number(meeting.expected_duration_minutes || 0) * 60 * 1000 + windowMs;
  return now.getTime() >= start - windowMs && now.getTime() <= end;
}

function assertTransition(from, to) {
  const allowed = MEETING_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new ConflictError(from === to
      ? `That meeting is already ${from.toLowerCase()}.`
      : `A ${from.toLowerCase()} meeting cannot become ${to.toLowerCase()}.`);
  }
}

async function notifyGroup(meeting, notification) {
  try {
    const members = await queryRows(
      `SELECT student_id FROM study_group_members WHERE group_id = $1 AND left_at IS NULL`,
      [meeting.group_id], "meetings:memberIds",
    );
    if (!members.length) return { delivered: 0, attempted: 0 };
    return await notifyMany(members.map((m) => m.student_id), {
      type: notification.type, title: notification.title, body: notification.body,
      link: `/dashboard/meetings/${meeting.id}`,
      metadata: { meetingId: meeting.id, groupId: meeting.group_id },
    });
  } catch (error) {
    logger.error("Meeting notification fan-out failed", { message: error.message });
    return { delivered: 0, attempted: 0 };
  }
}

function toOverlapError(error) {
  const msg = `${error?.message || ""} ${error?.detail || ""}`;
  if (msg.includes("MEETING_OVERLAP") || msg.includes("Another meeting")) {
    throw new ConflictError("Another meeting already occupies part of that time slot.");
  }
  if (error?.code === "DUPLICATE") {
    throw new ConflictError("A meeting with that room already exists. Please try again.");
  }
  throw error;
}

export async function createMeeting(userId, input) {
  const { group } = await assertModerator(input.groupId, userId);
  const provider = input.provider || env.videoProviderDefault || "JITSI";
  if (!PROVIDERS.includes(provider)) {
    throw new AppError("Unknown video provider.", { status: 422, code: "INVALID_PROVIDER" });
  }
  let joinUrl = null;
  if (provider === "GOOGLE_MEET") {
    joinUrl = normalizeGoogleMeetUrl(input.joinUrl);
    if (!joinUrl) {
      throw new AppError(
        "That does not look like a Google Meet link (expected https://meet.google.com/xxx-xxxx-xxx).",
        { status: 422, code: "INVALID_JOIN_URL" },
      );
    }
  }
  // Room identifier is always server-generated and unique, even for Google
  // Meet — it is this meeting's identity in TWIGANE; the user-supplied link
  // lives in join_url and is what members actually open.
  const roomId = buildRoomIdentifier(env.jitsiRoomPrefix, randomUUID());
  let meeting;
  try {
    meeting = await queryOne(
      `INSERT INTO group_meetings
         (group_id, title, description, scheduled_start, expected_duration_minutes,
          status, created_by, provider, provider_room_identifier, join_url)
       VALUES ($1,$2,$3,$4,$5,'SCHEDULED',$6,$7,$8,$9) RETURNING *`,
      [group.id, input.title.trim(), (input.description || "").trim(),
        input.scheduledStart, input.expectedDurationMinutes, userId, provider, roomId, joinUrl],
      "meetings:create",
    );
  } catch (error) { toOverlapError(error); }
  await notifyGroup(meeting, {
    type: NOTIFICATION_TYPE.MEETING_SCHEDULED,
    title: `New meeting: ${meeting.title}`, body: group.name,
  });
  return loadMeeting(meeting.id);
}
export async function listGroupMeetings(groupId, userId, opts = {}) {
  await assertMember(groupId, userId);
  const { status, scope = "all", limit = 50, offset = 0 } = opts;
  const clauses = ["m.group_id = $1"];
  const params = [groupId];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  if (status) clauses.push(`m.status = ${bind(status)}`);
  else if (scope === "upcoming") clauses.push(`m.status = 'SCHEDULED'`);
  else if (scope === "live") clauses.push(`m.status = 'LIVE'`);
  else if (scope === "past") clauses.push(`m.status = 'COMPLETED'`);
  else if (scope === "cancelled") clauses.push(`m.status = 'CANCELLED'`);
  params.push(Math.min(limit, 100), Math.max(offset, 0));
  return queryRows(
    `SELECT m.*, g.name AS group_name, u.first_name AS organizer_first_name,
            u.last_name AS organizer_last_name,
            (SELECT count(*)::int FROM meeting_attendance a WHERE a.meeting_id = m.id) AS attendance_count
       FROM group_meetings m JOIN study_groups g ON g.id = m.group_id
       LEFT JOIN users u ON u.id = m.created_by
      WHERE ${clauses.join(" AND ")}
      ORDER BY CASE WHEN m.status='LIVE' THEN 0 WHEN m.status='SCHEDULED' THEN 1 ELSE 2 END,
        m.scheduled_start ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, "meetings:listGroup",
  );
}

export async function listMyMeetings(userId, opts = {}) {
  const { status, scope = "all", limit = 50, offset = 0 } = opts;
  const clauses = ["gm.left_at IS NULL"];
  const params = [userId];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  if (status) clauses.push(`m.status = ${bind(status)}`);
  else if (scope === "upcoming") clauses.push(`m.status = 'SCHEDULED' AND m.scheduled_start >= now()`);
  else if (scope === "live") clauses.push(`m.status = 'LIVE'`);
  else if (scope === "past") clauses.push(`m.status = 'COMPLETED'`);
  else if (scope === "cancelled") clauses.push(`m.status = 'CANCELLED'`);
  params.push(Math.min(limit, 100), Math.max(offset, 0));
  return queryRows(
    `SELECT m.*, g.name AS group_name, u.first_name AS organizer_first_name, u.last_name AS organizer_last_name
       FROM group_meetings m JOIN study_groups g ON g.id = m.group_id
       JOIN study_group_members gm ON gm.group_id = g.id AND gm.student_id = $1
       LEFT JOIN users u ON u.id = m.created_by
      WHERE ${clauses.join(" AND ")}
      ORDER BY CASE WHEN m.status='LIVE' THEN 0 WHEN m.status='SCHEDULED' THEN 1 ELSE 2 END,
        m.scheduled_start ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, "meetings:listMine",
  );
}

export async function getMeeting(meetingId, userId) {
  const { meeting, membership, isModerator } = await meetingAccess(meetingId, userId);
  return { meeting, myRole: membership.role, isModerator, joinable: isJoinable(meeting) };
}

export async function updateMeeting(meetingId, userId, updates) {
  const { meeting, isModerator } = await meetingAccess(meetingId, userId);
  if (!isModerator) throw new ForbiddenError("Only the group leader can edit this meeting.");
  if (TERMINAL.has(meeting.status)) throw new ConflictError("That meeting is already closed.");
  const sets = [];
  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  if (updates.title !== undefined) sets.push(`title = ${bind(updates.title.trim())}`);
  if (updates.description !== undefined) sets.push(`description = ${bind((updates.description || "").trim())}`);
  if (updates.scheduledStart !== undefined) sets.push(`scheduled_start = ${bind(updates.scheduledStart)}`);
  if (updates.expectedDurationMinutes !== undefined) sets.push(`expected_duration_minutes = ${bind(updates.expectedDurationMinutes)}`);
  if (updates.joinUrl !== undefined) {
    if (meeting.provider !== "GOOGLE_MEET") {
      throw new AppError("Only Google Meet meetings have an editable link.", { status: 422, code: "INVALID_JOIN_URL" });
    }
    const joinUrl = normalizeGoogleMeetUrl(updates.joinUrl);
    if (!joinUrl) {
      throw new AppError(
        "That does not look like a Google Meet link (expected https://meet.google.com/xxx-xxxx-xxx).",
        { status: 422, code: "INVALID_JOIN_URL" },
      );
    }
    sets.push(`join_url = ${bind(joinUrl)}`);
  }
  if (!sets.length) return getMeeting(meetingId, userId);
  if (updates.scheduledStart !== undefined) {
    const when = new Date(updates.scheduledStart).getTime();
    if (Number.isNaN(when)) throw new AppError("Enter a valid date.", { status: 422, code: "INVALID_DATE" });
    if (meeting.status !== "SCHEDULED" && when !== new Date(meeting.scheduled_start).getTime()) {
      throw new ConflictError("Only scheduled meetings can be rescheduled.");
    }
  }
  params.push(meetingId);
  try {
    await query(`UPDATE group_meetings SET ${sets.join(", ")} WHERE id = $${params.length}`, params, "meetings:update");
  } catch (error) { toOverlapError(error); }
  const fresh = await loadMeeting(meetingId);
  await notifyGroup(fresh, {
    type: NOTIFICATION_TYPE.MEETING_UPDATED,
    title: `Meeting updated: ${fresh.title}`, body: fresh.group_name,
  });
  return getMeeting(meetingId, userId);
}
async function transition(meetingId, userId, to, extraSet = "", errMsg = "") {
  const acc = await meetingAccess(meetingId, userId);
  if (!acc.isModerator) throw new ForbiddenError(errMsg || "Only the group leader can change this meeting's status.");
  assertTransition(acc.meeting.status, to);
  const updated = await queryOne(
    `UPDATE group_meetings SET status = $2${extraSet} WHERE id = $1 AND status = $3 RETURNING *`,
    [meetingId, to, acc.meeting.status], "meetings:transition",
  );
  if (!updated) throw new ConflictError("That meeting changed just now. Please refresh and try again.");
  return updated;
}

async function closeOpenAttendance(meetingId, ctx) {
  await query(
    `UPDATE meeting_attendance SET left_at = COALESCE(left_at, now()), status = 'LEFT', updated_at = now()
      WHERE meeting_id = $1 AND left_at IS NULL`, [meetingId], ctx,
  );
}

export async function startMeeting(meetingId, userId) {
  await transition(meetingId, userId, "LIVE",
    ", live_started_at = COALESCE(live_started_at, now()), started_at = COALESCE(started_at, now())");
  const fresh = await loadMeeting(meetingId);
  await notifyGroup(fresh, {
    type: NOTIFICATION_TYPE.MEETING_STARTED,
    title: `Meeting is live: ${fresh.title}`, body: fresh.group_id,
  });
  return getMeeting(meetingId, userId);
}

export async function completeMeeting(meetingId, userId) {
  await transition(meetingId, userId, "COMPLETED", ", ended_at = now()");
  await closeOpenAttendance(meetingId, "meetings:closeAttendance");
  return getMeeting(meetingId, userId);
}

export async function cancelMeeting(meetingId, userId) {
  await transition(meetingId, userId, "CANCELLED", ", cancelled_at = now()",
    "Only the group leader can cancel this meeting.");
  await closeOpenAttendance(meetingId, "meetings:closeAttendanceCancel");
  const fresh = await loadMeeting(meetingId);
  await notifyGroup(fresh, {
    type: NOTIFICATION_TYPE.MEETING_CANCELLED,
    title: `Meeting cancelled: ${fresh.title}`, body: fresh.group_id,
  });
  return { status: "CANCELLED" };
}
export async function joinMeeting(meetingId, userId) {
  const acc = await meetingAccess(meetingId, userId);
  if (!isJoinable(acc.meeting)) {
    if (acc.meeting.status === "CANCELLED") throw new ForbiddenError("That meeting was cancelled.");
    if (acc.meeting.status === "COMPLETED") throw new ForbiddenError("That meeting has ended.");
    throw new ForbiddenError("That meeting is not open for joining yet.");
  }
  const user = await queryOne(
    `SELECT id, first_name, last_name, email FROM users WHERE id = $1`,
    [userId], "meetings:joinUser",
  );
  const joinConfig = buildJoinConfig({ meeting: acc.meeting, user, role: acc.membership.role });
  let effective = acc.meeting;
  if (acc.meeting.status === "SCHEDULED" && MOD_ROLES.has(acc.membership.role)) {
    const started = await queryOne(
      `UPDATE group_meetings SET status = 'LIVE',
        live_started_at = COALESCE(live_started_at, now()),
        started_at = COALESCE(started_at, now())
        WHERE id = $1 AND status = 'SCHEDULED' RETURNING *`,
      [meetingId], "meetings:autoStart",
    );
    if (started) {
      effective = { ...started };
      await notifyGroup(effective, {
        type: NOTIFICATION_TYPE.MEETING_STARTED,
        title: `Meeting is live: ${effective.title}`, body: effective.group_id,
      });
    }
  }
  return { meeting: effective, joinConfig, joinable: true };
}

export async function recordJoin(meetingId, userId) {
  const acc = await meetingAccess(meetingId, userId);
  if (!isJoinable(acc.meeting)) throw new ForbiddenError("That meeting is not open for joining.");
  return withTransaction(async (tx) => {
    const open = await tx.queryOne(
      `SELECT * FROM meeting_attendance WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [meetingId, userId], "meetings:openRow",
    );
    if (open) return { attendance: open, duplicate: true };
    const row = await tx.queryOne(
      `INSERT INTO meeting_attendance (meeting_id, user_id, status) VALUES ($1, $2, 'JOINED') RETURNING *`,
      [meetingId, userId], "meetings:joinInsert",
    );
    return { attendance: row, duplicate: false };
  }, "meetings:recordJoin");
}

export async function recordLeave(meetingId, userId) {
  await meetingAccess(meetingId, userId);
  const closed = await queryOne(
    `UPDATE meeting_attendance SET left_at = now(), status = 'LEFT'
      WHERE id = (SELECT id FROM meeting_attendance
        WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL
        ORDER BY joined_at DESC LIMIT 1)
      RETURNING *, EXTRACT(EPOCH FROM (left_at - joined_at))::int AS duration_seconds`,
    [meetingId, userId], "meetings:leave",
  );
  if (!closed) return { attendance: null, duplicate: true };
  return { attendance: closed, duplicate: false };
}

export async function listAttendance(meetingId, userId) {
  const acc = await meetingAccess(meetingId, userId);
  if (!acc.isModerator) throw new ForbiddenError("Only the group leader can view attendance.");
  return queryRows(
    `SELECT a.*, u.first_name, u.last_name, u.email,
            EXTRACT(EPOCH FROM (COALESCE(a.left_at, now()) - a.joined_at))::int AS duration_seconds
       FROM meeting_attendance a JOIN users u ON u.id = a.user_id
      WHERE a.meeting_id = $1 ORDER BY a.joined_at ASC`,
    [meetingId], "meetings:attendance",
  );
}
export async function myAttendance(userId, opts = {}) {
  const limit = Math.min(opts.limit || 50, 100);
  return queryRows(
    `SELECT a.*, m.title, m.status AS meeting_status, m.scheduled_start, g.name AS group_name,
            EXTRACT(EPOCH FROM (COALESCE(a.left_at, now()) - a.joined_at))::int AS duration_seconds
       FROM meeting_attendance a
       JOIN group_meetings m ON m.id = a.meeting_id
       JOIN study_groups g ON g.id = m.group_id
      WHERE a.user_id = $1 ORDER BY a.joined_at DESC LIMIT $2`,
    [userId, limit], "meetings:myAttendance",
  );
}

export async function sweepStaleLiveMeetings(opts = {}) {
  const grace = String(opts.graceMinutes || 60);
  const rows = await queryRows(
    `UPDATE group_meetings SET status = 'COMPLETED', ended_at = COALESCE(ended_at, now())
      WHERE status = 'LIVE'
        AND scheduled_start + (expected_duration_minutes || ' minutes')::interval
            + ($1 || ' minutes')::interval < now()
      RETURNING id`,
    [grace], "meetings:sweep",
  );
  if (rows.length) {
    await query(
      `UPDATE meeting_attendance SET left_at = COALESCE(left_at, now()), status = 'LEFT'
        WHERE meeting_id = ANY($1) AND left_at IS NULL`,
      [rows.map((r) => r.id)], "meetings:sweepAttendance",
    );
    logger.info("Swept stale live meetings", { count: rows.length });
  }
  return { completed: rows.length, ids: rows.map((r) => r.id) };
}

export default {
  createMeeting, listGroupMeetings, listMyMeetings, getMeeting, updateMeeting,
  startMeeting, completeMeeting, cancelMeeting, joinMeeting,
  recordJoin, recordLeave, listAttendance, myAttendance,
  isJoinable, sweepStaleLiveMeetings,
};
