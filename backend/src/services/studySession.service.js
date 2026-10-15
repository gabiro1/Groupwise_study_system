import {
  query,
  queryOne,
  queryRows,
  withTransaction,
} from "../config/db.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.js";
import { assertMember } from "./group.service.js";
import { assertWorkspaceAccess } from "./workspace.service.js";
import { publishToSession } from "../lib/realtime.js";
import { notifyMany } from "../lib/notifications.js";
import {
  NOTIFICATION_TYPE,
  QUESTION_STATUS,
  RSVP_STATUS,
  SESSION_STATUS,
  SESSION_ACTIVITY_KIND,
  STUDY_ROLE,
} from "../config/constants.js";
import { authorizationForMeeting, meetingTokenFor } from "./livekit.service.js";
import logger from "../config/logger.js";

/**
 * Study sessions — the structured collaboration layer on top of the existing
 * `study_sessions`/`session_participants` model.
 *
 * Authorisation model (every endpoint, own re-verification):
 *  - any *member* of the group may view the session list entry for their groups;
 *  - participants (group members for open sessions, invited members for closed
 *    ones) may read the session detail, chat, notes, questions, prep and
 *    reflections, and participate in the meeting;
 *  - OWNER/MODERATOR (group leader) may manage: create, schedule edits, cancel
 *    /complete, add/remove participants, assign agenda, drive the timer and
 *    rotate roles;
 *  - the current round's TIMER assignee may also drive the timer;
 *  - ADMIN role has NO implicit access — sessions live inside a group's
 *    membership, exactly like workspaces do.
 */

const MEMBER_MOD_ROLES = ["OWNER", "MODERATOR"];
const canModerate = (membership) => MEMBER_MOD_ROLES.includes(membership.role);

const SESSION_TRANSITIONS = Object.freeze({
  SCHEDULED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["PAUSED", "COMPLETED", "CANCELLED"],
  PAUSED: ["ACTIVE", "COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
});

const DEFAULT_AGENDA = Object.freeze([
  { kind: "INTRO", title: "Check-in & warm-up", plannedMinutes: 5 },
  { kind: "TEACH", title: "Lesson walk-through", plannedMinutes: 10 },
  { kind: "QUESTIONS", title: "Teaching round & questions", plannedMinutes: 15 },
  { kind: "EXERCISE", title: "Worked exercise", plannedMinutes: 20 },
  { kind: "DISCUSSION", title: "Group discussion", plannedMinutes: 10 },
  { kind: "BREAK", title: "Break", plannedMinutes: 5 },
  { kind: "REVIEW", title: "Review & clarifications", plannedMinutes: 10 },
  { kind: "WRAP_UP", title: "Wrap-up & next steps", plannedMinutes: 5 },
]);

// ---------------------------------------------------------------------------
// Shared loading helpers
// ---------------------------------------------------------------------------

/**
 * Load a session together with its group and workspace context. Does not check
 * membership — caller decides what to do with the data.
 */
async function loadSession(sessionId) {
  const session = await queryOne(
    `SELECT s.*, w.name AS workspace_name, w.is_archived,
            g.id AS group_id, g.name AS group_name, g.slug AS group_slug,
            c.id AS course_id, c.name AS course_name, c.course_code
       FROM study_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN study_groups g ON g.id = w.group_id
       JOIN courses c ON c.id = g.course_id
      WHERE s.id = $1`,
    [sessionId],
    "sessions:load",
  );
  if (!session) throw new NotFoundError("That study session");
  if (session.is_archived) throw new NotFoundError("That study session");
  return session;
}

/**
 * Full membership + participation gate. Returns enough for the caller to branch
 * between "view only" and "manage". Throws ForbiddenError when the user is not
 * even a group member.
 */
export async function assertSessionAccess(sessionId, userId) {
  const session = await loadSession(sessionId);
  const { membership } = await assertMember(session.group_id, userId);

  const participant = await queryOne(
    `SELECT rsvp, attended FROM session_participants WHERE session_id = $1 AND student_id = $2`,
    [sessionId, userId],
    "sessions:participant",
  );

  const isParticipant = Boolean(participant) || !session.participants_closed;

  return {
    session,
    membership,
    participant,
    isParticipant,
    isModerator: canModerate(membership),
  };
}

/**
 * Lightweight participation check used by the socket layer: true when the user
 * may subscribe to a session's live events.
 */
export async function canParticipateInSession(sessionId, userId) {
  const session = await loadSession(sessionId);
  const { membership } = await assertMember(session.group_id, userId);

  if (session.participants_closed) {
    const invited = await queryOne(
      `SELECT 1 FROM session_participants WHERE session_id = $1 AND student_id = $2`,
      [sessionId, userId],
      "sessions:canJoin",
    );
    if (!invited && !canModerate(membership)) {
      throw new ForbiddenError("You are not a participant of this session.");
    }
  }
  return { sessionId: session.id };
}

/** Strip the audit/chat helper columns no client needs. */
function sanitizeSession(row) {
  if (!row) return row;
  return { ...row };
}

const activeParticipants = (sessionId) =>
  queryRows(
    `SELECT p.student_id, p.rsvp, p.attended, u.first_name, u.last_name, u.avatar_url,
            COALESCE(pre.status, 'NOT_STARTED') AS prep_status
       FROM session_participants p
       JOIN users u ON u.id = p.student_id
       LEFT JOIN session_prep pre ON pre.session_id = p.session_id AND pre.student_id = p.student_id
      WHERE p.session_id = $1
      ORDER BY u.first_name, u.last_name`,
    [sessionId],
    "sessions:participants",
  );

const currentRoles = (sessionId) =>
  queryRows(
    `SELECT r.role, r.round_number, r.source, u.id AS student_id, u.first_name, u.last_name
       FROM session_roles r
       JOIN users u ON u.id = r.student_id
      WHERE r.session_id = $1
        AND r.round_number = (SELECT max(round_number) FROM session_roles WHERE session_id = $1)
      ORDER BY r.role`,
    [sessionId],
    "sessions:roles",
  );

const agendas = (sessionId) =>
  queryRows(
    `SELECT id, kind, title, position, planned_minutes
       FROM session_activities
      WHERE session_id = $1
      ORDER BY position`,
    [sessionId],
    "sessions:agenda",
  );

/**
 * Reconstruct the authoritative timer from the persisted start/pause points.
 * Never trusts anything the client sends.
 */
function computeTiming(session) {
  if (!session.active_activity_id) return null;

  let elapsed = session.activity_elapsed_seconds || 0;
  let isRunning = false;

  if (session.activity_started_at) {
    if (session.activity_paused_at) {
      // Paused: accumulated seconds already include the last run segment; the
      // started_at value is kept purely for recovery/debugging.
      elapsed = session.activity_elapsed_seconds || 0;
    } else {
      isRunning = true;
      elapsed = (session.activity_elapsed_seconds || 0) +
        Math.max(0, Math.floor((Date.now() - session.activity_started_at.getTime()) / 1000));
    }
  }

  const agenda = session._agenda ?? [];
  const activity = agenda.find((a) => a.id === session.active_activity_id) ?? null;
  const plannedSeconds = activity?.planned_minutes ? activity.planned_minutes * 60 : null;

  return {
    activityId: session.active_activity_id,
    activity: activity ? { id: activity.id, title: activity.title, kind: activity.kind } : null,
    plannedSeconds,
    remainingSeconds: plannedSeconds == null ? null : Math.max(0, plannedSeconds - elapsed),
    elapsedSeconds: elapsed,
    isRunning,
  };
}

async function notifyParticipants(session, notification, userIds = null) {
  const ids =
    userIds ??
    (await queryRows(
      `SELECT student_id FROM session_participants WHERE session_id = $1`,
      [session.id],
      "sessions:notifyIds",
    )).map((row) => row.student_id);

  if (!ids.length) return;
  await notifyMany(ids, {
    type: notification.type,
    title: notification.title,
    body: notification.body,
    link: `/groups/${session.group_slug}/workspace?session=${session.id}`,
    metadata: { sessionId: session.id },
  });
}

// ---------------------------------------------------------------------------
// Overview / reading
// ---------------------------------------------------------------------------

export async function listMySessions(userId, { scope = "all" } = {}) {
  const rows = await queryRows(
    `SELECT s.id, s.title, s.starts_at, s.ends_at, s.status, s.format, s.main_topic,
            s.mode, s.location, s.meeting_url, s.participants_closed, s.meeting_room,
            g.id AS group_id, g.name AS group_name, g.slug AS group_slug,
            c.name AS course_name, c.course_code,
            (p.student_id IS NOT NULL) AS is_participant, p.rsvp,
            (SELECT count(*)::int FROM session_participants pp WHERE pp.session_id = s.id AND pp.rsvp = 'GOING') AS going_count,
            (SELECT count(*)::int FROM session_participants pp WHERE pp.session_id = s.id) AS participant_count,
            (SELECT count(*)::int FROM session_roles r
               WHERE r.session_id = s.id AND r.student_id = $1
                 AND r.round_number = (SELECT max(round_number) FROM session_roles WHERE session_id = s.id)) AS my_current_role_count
       FROM study_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN study_groups g ON g.id = w.group_id
       JOIN courses c ON c.id = g.course_id
       JOIN study_group_members m ON m.group_id = g.id AND m.left_at IS NULL
       LEFT JOIN session_participants p ON p.session_id = s.id AND p.student_id = $1
      WHERE m.student_id = $1
        AND (${scopeClause(scope)})
      ORDER BY
        CASE WHEN s.status IN ('ACTIVE', 'PAUSED') THEN 0
             WHEN s.status = 'SCHEDULED' THEN 1
             ELSE 2 END,
        s.starts_at ASC
      LIMIT 200`,
    [userId],
    "sessions:myList",
  );
  return rows;
}

function scopeClause(scope) {
  switch (scope) {
    case "upcoming":
      return "s.status = 'SCHEDULED' AND s.starts_at >= now()";
    case "active":
      return "s.status IN ('ACTIVE', 'PAUSED')";
    case "past":
      return "s.status IN ('COMPLETED', 'CANCELLED') OR (s.status = 'SCHEDULED' AND s.starts_at < now())";
    default:
      return "TRUE";
  }
}

export async function getSession(sessionId, userId) {
  const { session, membership, isParticipant, isModerator } =
    await assertSessionAccess(sessionId, userId);

  // Non-participants of a closed session may see the schedule card only, not
  // the collaboration content.
  const [participants, roles, agenda, notes] = isParticipant || isModerator
    ? await Promise.all([
        activeParticipants(session.id),
        currentRoles(session.id),
        agendas(session.id),
        listNotes(session.id, userId),
      ])
    : [null, null, [], []];

  const withAgenda = { ...session, _agenda: agenda };
  const timing = computeTiming(withAgenda);
  delete withAgenda._agenda;

  const myRole = roles?.find((r) => r.student_id === userId)?.role ?? null;

  return sanitizeSession({
    ...withAgenda,
    membershipRole: membership.role,
    isModerator,
    isParticipant,
    myRole,
    timing,
    participants: participants ?? [],
    roles: roles ?? [],
    agenda,
    notes,
    myPrep: isParticipant || isModerator
      ? ((await queryOne(
          `SELECT status, updated_at FROM session_prep WHERE session_id = $1 AND student_id = $2`,
          [session.id, userId],
          "sessions:myPrep",
        )) ?? { status: "NOT_STARTED" })
      : null,
  });
}

// ---------------------------------------------------------------------------
// Creating / editing a session
// ---------------------------------------------------------------------------

/**
 * Create a structured study session. Moderators only.
 *
 * `participantIds` empty + `participantsClosed: false` => open to the whole
 * group (any member may RSVP). `participantsClosed: true` => invite the given
 * ids only. A GUIDED session comes with a starter agenda unless one is given.
 */
export async function createStudySession(userId, input) {
  const { workspace, group } = await assertWorkspaceAccess(input.workspaceId, userId);
  const { membership } = await assertMember(group.id, userId);
  if (!canModerate(membership)) {
    throw new ForbiddenError("Only the group leader can schedule study sessions.");
  }

  if (input.mode === "ONLINE" && !input.meetingUrl && !input.meetingRoom) {
    throw new AppError("Add a meeting link or a built-in meeting room for an online session.", {
      status: 422,
      code: "MEETING_URL_REQUIRED",
      fields: { meetingUrl: "Paste the call link your group will use." },
    });
  }

  const participantIds = [...new Set((input.participantIds ?? []).map(String))];
  if (input.participantsClosed && participantIds.length === 0) {
    throw new AppError("Choose at least one participant for a private session.", {
      status: 422,
      code: "PARTICIPANTS_REQUIRED",
      fields: { participantIds: "Pick the members this session is for." },
    });
  }

  const activities = normalizeAgenda(input.activities, input.format);

  const result = await withTransaction(async (tx) => {
    const session = await tx.queryOne(
      `INSERT INTO study_sessions
         (workspace_id, title, starts_at, ends_at, mode, location, meeting_url,
          format, main_topic, objectives, preparation, focus_interval_minutes,
          break_minutes, meeting_room, participants_closed, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        workspace.id,
        input.title,
        input.startsAt,
        input.endsAt,
        input.mode ?? "ONLINE",
        input.location ?? null,
        input.meetingUrl ?? null,
        input.format ?? "FLEXIBLE",
        input.mainTopic ?? null,
        input.objectives ?? [],
        JSON.stringify(input.preparation ?? []),
        input.focusIntervalMinutes ?? 50,
        input.breakMinutes ?? 5,
        input.meetingRoom ?? null,
        Boolean(input.participantsClosed),
        userId,
      ],
      "sessions:insert",
    );

    // Determine invitees now: explicit list, or every active member.
    let inviteeRows;
    if (session.participants_closed) {
      inviteeRows = [];
      for (const studentId of participantIds) {
        const member = await tx.queryOne(
          `SELECT 1 FROM study_group_members WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL`,
          [group.id, studentId],
          "sessions:inviteeCheck",
        );
        if (!member) {
          throw new AppError("One of the invited students is not an active group member.", {
            status: 422,
            code: "PARTICIPANT_NOT_MEMBER",
            fields: { participantIds: "Every invite must be an active member of this group." },
          });
        }
        inviteeRows.push({ student_id: studentId });
      }
    } else {
      inviteeRows = await tx.queryRows(
        `SELECT student_id FROM study_group_members WHERE group_id = $1 AND left_at IS NULL`,
        [group.id],
        "sessions:openInvitees",
      );
    }

    // The organiser is going by definition.
    const invited = new Set(inviteeRows.map((r) => String(r.student_id)));
    invited.add(userId);
    for (const studentId of invited) {
      await tx.query(
        `INSERT INTO session_participants (session_id, student_id, rsvp)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [session.id, studentId, studentId === String(userId) ? "GOING" : "MAYBE"],
        "sessions:invite",
      );
    }

    if (session.format === "GUIDED") {
      for (const [index, activity] of activities.entries()) {
        await tx.query(
          `INSERT INTO session_activities (session_id, kind, title, position, planned_minutes)
           VALUES ($1, $2, $3, $4, $5)`,
          [session.id, activity.kind, activity.title, index, activity.plannedMinutes],
          "sessions:activityInsert",
        );
      }
    }

    return session;
  }, "sessions:create");

  const loaded = await loadSession(result.id);
  await notifyParticipants(
    loaded,
    {
      type: NOTIFICATION_TYPE.SESSION_UPDATED,
      title: `New study session: ${loaded.title}`,
      body: group.name,
    },
  );

  publishToSession(result.id, "session:created", { sessionId: result.id, title: loaded.title });

  const { session: detail } = await getSessionWithReturn(result.id, userId);
  return detail;
}

/** Internal helper so createStudySession can return the full detail payload. */
async function getSessionWithReturn(sessionId, userId) {
  const session = await getSession(sessionId, userId);
  return { session };
}

/**
 * Edit schedule/settings for a session that has not started. Moderators only.
 * Agenda, timer and participant edits have dedicated endpoints.
 */
export async function updateSessionDetails(sessionId, userId, updates) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can edit this session.");
  if (access.session.status === "COMPLETED" || access.session.status === "CANCELLED") {
    throw new ConflictError("That session is already closed.");
  }

  const allowed = [
    "title", "startsAt", "endsAt", "mode", "location", "meetingUrl",
    "mainTopic", "objectives", "preparation",
  ];
  const sets = [];
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    if (value === undefined) continue;

    switch (key) {
      case "title":
        sets.push(`title = ${bind(value)}`);
        break;
      case "startsAt":
        sets.push(`starts_at = ${bind(value)}`);
        break;
      case "endsAt":
        sets.push(`ends_at = ${bind(value)}`);
        break;
      case "mode":
        sets.push(`mode = ${bind(value)}`);
        break;
      case "location":
        sets.push(`location = ${bind(value)}`);
        break;
      case "meetingUrl":
        sets.push(`meeting_url = ${bind(value)}`);
        break;
      case "mainTopic":
        sets.push(`main_topic = ${bind(value)}`);
        break;
      case "objectives":
        sets.push(`objectives = ${bind(value)}`);
        break;
      case "preparation":
        sets.push(`preparation = ${bind(JSON.stringify(value))}::jsonb`);
        break;
      default:
        break;
    }
  }

  if (!sets.length) return getSession(sessionId, userId);

  params.push(sessionId);
  await query(
    `UPDATE study_sessions SET ${sets.join(", ")} WHERE id = $${params.length}
     RETURNING id`,
    params,
    "sessions:updateDetails",
  );

  publishToSession(sessionId, "session:updated", { sessionId });

  const { session } = await getSessionWithReturn(sessionId, userId);
  return session;
}

// ---------------------------------------------------------------------------
// Lifecycle — server-validated status transitions
// ---------------------------------------------------------------------------

/** Compare-and-set transition so duplicate clicks cannot double-apply. */
export async function startSession(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can start the session.");
  const { session } = access;

  if (!SESSION_TRANSITIONS[session.status].includes("ACTIVE")) {
    throw new ConflictError(`A session in ${session.status} state cannot be started.`);
  }

  const updated = await queryOne(
    `UPDATE study_sessions
        SET status = 'ACTIVE', started_at = COALESCE(started_at, now()), paused_at = NULL,
            updated_at = now()
      WHERE id = $1 AND status = $2
      RETURNING id`,
    [sessionId, SESSION_STATUS.SCHEDULED],
    "sessions:start",
  );
  if (!updated) throw new ConflictError("That session was already started.");

  await notifyParticipants(
    await loadSession(sessionId),
    {
      type: NOTIFICATION_TYPE.SESSION_STARTED,
      title: `The study session started`,
      body: session.title,
    },
  );
  publishToSession(sessionId, "session:lifecycle", { sessionId, status: "ACTIVE" });

  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

export async function pauseSession(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can pause the session.");
  if (access.session.status !== SESSION_STATUS.ACTIVE) {
    throw new ConflictError("Only a running session can be paused.");
  }

  const updated = await queryOne(
    `UPDATE study_sessions
        SET status = 'PAUSED', paused_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING id`,
    [sessionId],
    "sessions:pause",
  );
  if (!updated) throw new ConflictError("That session is not running.");

  publishToSession(sessionId, "session:lifecycle", { sessionId, status: "PAUSED" });
  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

export async function resumeSession(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can resume the session.");
  if (access.session.status !== SESSION_STATUS.PAUSED) {
    throw new ConflictError("Only a paused session can be resumed.");
  }

  const updated = await queryOne(
    `UPDATE study_sessions
        SET status = 'ACTIVE', paused_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'PAUSED'
      RETURNING id`,
    [sessionId],
    "sessions:resume",
  );
  if (!updated) throw new ConflictError("That session is not paused.");

  publishToSession(sessionId, "session:lifecycle", { sessionId, status: "ACTIVE" });
  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

export async function completeSession(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can complete the session.");
  if (access.session.status === SESSION_STATUS.COMPLETED) {
    throw new ConflictError("That session is already completed.");
  }
  if (access.session.status === SESSION_STATUS.CANCELLED) {
    throw new ConflictError("A cancelled session cannot be completed.");
  }

  await query(
    `UPDATE study_sessions
        SET status = 'COMPLETED', completed_at = now(), activity_started_at = NULL,
            activity_paused_at = NULL, updated_at = now()
      WHERE id = $1`,
    [sessionId],
    "sessions:complete",
  );

  publishToSession(sessionId, "session:lifecycle", { sessionId, status: "COMPLETED" });
  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

export async function cancelSession(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can cancel the session.");
  if (access.session.status === "COMPLETED") throw new ConflictError("That session already happened.");
  if (access.session.status === "CANCELLED") throw new ConflictError("That session is already cancelled.");

  const [updated, memberRows] = await Promise.all([
    query(
      `UPDATE study_sessions SET status = 'CANCELLED', updated_at = now() WHERE id = $1`,
      [sessionId],
      "sessions:cancel",
    ),
    queryRows(
      `SELECT student_id FROM session_participants WHERE session_id = $1 AND rsvp = 'GOING'`,
      [sessionId],
      "sessions:cancelGoing",
    ),
  ]);
  void updated;

  if (memberRows.length) {
    await notifyMany(
      memberRows.map((row) => row.student_id),
      {
        type: NOTIFICATION_TYPE.SESSION_UPDATED,
        title: "A study session was cancelled",
        body: access.session.title,
        link: `/groups/${access.session.group_slug}/workspace`,
        metadata: { sessionId: sessionId },
      },
    );
  }

  publishToSession(sessionId, "session:lifecycle", { sessionId, status: "CANCELLED" });
  return { status: "CANCELLED" };
}

// ---------------------------------------------------------------------------
// Participants / RSVP
// ---------------------------------------------------------------------------

export async function addParticipant(sessionId, userId, studentId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can add participants.");

  const member = await queryOne(
    `SELECT 1 FROM study_group_members WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL`,
    [access.session.group_id, studentId],
    "sessions:addMemberCheck",
  );
  if (!member) throw new NotFoundError("That student");

  await query(
    `INSERT INTO session_participants (session_id, student_id, rsvp)
     VALUES ($1, $2, 'MAYBE') ON CONFLICT (session_id, student_id) DO NOTHING`,
    [sessionId, studentId],
    "sessions:addParticipant",
  );

  publishToSession(sessionId, "session:participants", { sessionId });

  if (access.session.participants_closed) {
    await query(
      `UPDATE study_sessions SET participants_closed = TRUE WHERE id = $1`,
      [sessionId],
      "sessions:keepClosed",
    );
  }

  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

export async function removeParticipant(sessionId, userId, studentId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can remove participants.");
  if (String(studentId) === String(userId)) {
    throw new AppError("Leave the session from your own profile instead.", {
      status: 422,
      code: "CANNOT_SELF_REMOVE",
    });
  }

  await query(
    `DELETE FROM session_participants WHERE session_id = $1 AND student_id = $2`,
    [sessionId, studentId],
    "sessions:removeParticipant",
  );

  // Remove their temp role claims for the current and future rounds.
  await query(
    `DELETE FROM session_roles
      WHERE session_id = $1
        AND student_id = $2
        AND round_number >= (SELECT COALESCE(max(round_number), 1) FROM session_roles WHERE session_id = $1)`,
    [sessionId, studentId],
    "sessions:purgeRoles",
  );

  publishToSession(sessionId, "session:participants", { sessionId });
  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

/** A member updates their own RSVP (open sessions: also joins the participant list). */
export async function setRsvp(sessionId, userId, rsvp) {
  if (!Object.values(RSVP_STATUS).includes(rsvp)) {
    throw new AppError("Pick an RSVP option.", { status: 422, code: "INVALID_RSVP" });
  }
  const access = await assertSessionAccess(sessionId, userId);
  if (access.session.status !== "SCHEDULED") {
    throw new ConflictError("RSVP is only available before the session starts.");
  }

  if (!access.participant && !access.session.participants_closed) {
    throw new ForbiddenError("This session has a fixed participant list.");
  }

  await query(
    `INSERT INTO session_participants (session_id, student_id, rsvp)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id, student_id) DO UPDATE SET rsvp = EXCLUDED.rsvp`,
    [sessionId, userId, rsvp],
    "sessions:rsvp",
  );

  publishToSession(sessionId, "session:participants", { sessionId });
  return getSession(sessionId, userId);
}

// ---------------------------------------------------------------------------
// Study roles (Teacher / Questioner / Timer) and rotation
// ---------------------------------------------------------------------------

/**
 * Assign the roles for a round by rotation. Deterministic and fair: with N
 * participants and a full rotation scheme, nobody repeats while alternatives
 * exist.
 *
 *   1 participant : nobody teaches single-handedly is risky — the leader
 *                   (moderator) is named TEACHER so the round can flow.
 *   2 participants: member A TEACHER, member B QUESTIONER+TIMER (combined).
 *   3+            : three distinct members hold the three roles.
 */
export async function rotateRoles(sessionId, userId, { roundNumber = null } = {}) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can rotate roles.");

  let participants = await activeParticipants(sessionId);
  if (!participants.length) {
    participants = await queryRows(
      `SELECT u.id AS student_id, u.first_name, u.last_name
         FROM study_group_members m
         JOIN users u ON u.id = m.student_id
        WHERE m.group_id = $1 AND m.left_at IS NULL
        ORDER BY u.first_name, u.last_name`,
      [access.session.group_id],
      "sessions:rolesFallback",
    );
  }
  if (!participants.length) throw new ConflictError("This session has no participants yet.");

  if (access.session.status === "COMPLETED" || access.session.status === "CANCELLED") {
    throw new ConflictError("Closed sessions cannot be re-assigned.");
  }

  const round = roundNumber ??
    (await queryOne(
      `SELECT COALESCE(max(round_number), 0) + 1 AS next FROM session_roles WHERE session_id = $1`,
      [sessionId],
      "sessions:nextRound",
    )).next;

  const ordered = participants
    .map((p) => String(p.student_id))
    .sort((a, b) => a.localeCompare(b));

  const picks = { [STUDY_ROLE.TEACHER]: ordered[0] };
  if (ordered.length >= 2) picks[STUDY_ROLE.QUESTIONER] = ordered[1];
  if (ordered.length >= 3) picks[STUDY_ROLE.TIMER] = ordered[2];

  const created = await withTransaction(async (tx) => {
    const rows = [];
    for (const [role, studentId] of Object.entries(picks)) {
      rows.push(
        await tx.queryOne(
          `INSERT INTO session_roles (session_id, round_number, student_id, role, source)
           VALUES ($1, $2, $3, $4, 'ROTATION')
           ON CONFLICT (session_id, round_number, role)
           DO UPDATE SET student_id = EXCLUDED.student_id, source = 'ROTATION', assigned_at = now()
           RETURNING *`,
          [sessionId, round, studentId, role],
          "sessions:rolesInsert",
        ),
      );
    }
    return rows;
  }, "sessions:roles");

  const withNames = created.map((row) => {
    const p = participants.find((x) => String(x.student_id) === String(row.student_id));
    return { ...row, first_name: p?.first_name ?? null, last_name: p?.last_name ?? null };
  });

  publishToSession(sessionId, "session:roles", { sessionId, roundNumber: round, roles: withNames });

  await notifyParticipants(
    await loadSession(sessionId),
    {
      type: NOTIFICATION_TYPE.ROLE_ASSIGNED,
      title: `Round ${round} roles assigned`,
      body: withNames.map((r) => `${r.role}: ${r.first_name}`).join(", "),
    },
    withNames.map((r) => r.student_id),
  );

  return { roundNumber: round, roles: withNames };
}

/** Manually pin a role holder for an already-declared round (leader meets one person's gap). */
export async function assignRole(sessionId, userId, { roundNumber, studentId, role }) {
  validateRoleValue(role);

  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can assign roles.");

  const participant = await queryOne(
    `SELECT 1 FROM session_participants WHERE session_id = $1 AND student_id = $2`,
    [sessionId, studentId],
    "sessions:assignRoleCheck",
  );
  if (!participant) throw new NotFoundError("That participant");

  const row = await queryOne(
    `INSERT INTO session_roles (session_id, round_number, student_id, role, source)
     VALUES ($1, $2, $3, $4, 'MANUAL')
     ON CONFLICT (session_id, round_number, role)
     DO UPDATE SET student_id = EXCLUDED.student_id, source = 'MANUAL', assigned_at = now()
     RETURNING *`,
    [sessionId, roundNumber, studentId, role],
    "sessions:assignRole",
  );

  publishToSession(sessionId, "session:roles", { sessionId, roundNumber, roles: [row] });
  return row;
}

function validateRoleValue(role) {
  if (!Object.values(STUDY_ROLE).includes(role)) {
    throw new AppError("Unknown study role.", { status: 422, code: "INVALID_ROLE" });
  }
}

// ---------------------------------------------------------------------------
// Agenda + server-authoritative timer
// ---------------------------------------------------------------------------

/** Only the agenda of a not-started session can be replaced wholesale. */
export async function setAgenda(sessionId, userId, { activities }) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can edit the agenda.");
  if (access.session.status !== "SCHEDULED") {
    throw new ConflictError("The agenda is locked once the session has started.");
  }
  if (!Array.isArray(activities) || activities.length < 1 || activities.length > 12) {
    throw new AppError("The agenda needs between 1 and 12 activities.", {
      status: 422,
      code: "AGENDA_SIZE",
    });
  }

  const normalized = normalizeAgenda(activities);

  await withTransaction(async (tx) => {
    await tx.query(`DELETE FROM session_activities WHERE session_id = $1`, [sessionId], "sessions:agendaReset");
    for (const [index, activity] of normalized.entries()) {
      await tx.query(
        `INSERT INTO session_activities (session_id, kind, title, position, planned_minutes)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, activity.kind, activity.title, index, activity.plannedMinutes],
        "sessions:agendaInsert",
      );
    }
  }, "sessions:agenda");

  publishToSession(sessionId, "session:activity", { sessionId, agenda: normalized });
  return getSession(sessionId, userId);
}

function normalizeAgenda(activities, format = "FLEXIBLE") {
  if (format !== "GUIDED") return null;

  if (!Array.isArray(activities) || activities.length === 0) return DEFAULT_AGENDA;

  if (activities.length > 12) {
    throw new AppError("A guided session can have at most 12 agenda items.", {
      status: 422,
      code: "AGENDA_SIZE",
    });
  }
  return activities.map((activity, index) => {
    if (!(activity.kind in SESSION_ACTIVITY_KIND)) {
      throw new AppError(`Unknown activity kind "${activity.kind}".`, {
        status: 422,
        code: "INVALID_ACTIVITY_KIND",
      });
    }
    const plannedMinutes =
      activity.plannedMinutes == null || activity.plannedMinutes === 0
        ? null
        : Math.max(1, Math.min(240, Math.round(activity.plannedMinutes)));
    return {
      kind: activity.kind,
      title: activity.title ?? defaultAgendaTitle(activity.kind, index),
      plannedMinutes,
    };
  });
}

function defaultAgendaTitle(kind, index) {
  return DEFAULT_AGENDA[index]?.title ?? `Activity ${index + 1}`;
}

/** Who may drive the timer: the group leader or the current Timer assignee. */
async function assertTimerControl(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (access.isModerator) return access;

  const timerClaim = await queryOne(
    `SELECT 1 FROM session_roles r
      WHERE r.session_id = $1 AND r.student_id = $2 AND r.role = 'TIMER'
        AND r.round_number = (SELECT max(round_number) FROM session_roles WHERE session_id = $1)`,
    [sessionId, userId],
    "sessions:timerClaim",
  );
  if (!timerClaim) throw new ForbiddenError("Only the group leader or Timer can drive the timer.");
  return access;
}

async function requireAgenda(session) {
  const agenda = await agendas(session.id);
  if (!agenda.length) {
    throw new ConflictError("This session has no agenda items yet — ask the group leader to set one.");
  }
  return agenda;
}

async function requireRunning(session) {
  if (session.status !== SESSION_STATUS.ACTIVE) {
    throw new ConflictError("The timer only runs while the session is live.");
  }
}

export async function advanceActivity(sessionId, userId) {
  const access = await assertTimerControl(sessionId, userId);
  await requireRunning(access.session);
  const agenda = await requireAgenda(access.session);

  if (!access.session.active_activity_id) {
    const first = agenda[0];
    await query(
      `UPDATE study_sessions
          SET active_activity_id = $2, activity_started_at = now(),
              activity_paused_at = NULL, activity_elapsed_seconds = 0
        WHERE id = $1`,
      [sessionId, first.id],
      "sessions:advanceFirst",
    );
    publishToSession(sessionId, "session:activity", { sessionId, activeActivityId: first.id });
    return getSession(sessionId, userId);
  }

  const currentIndex = agenda.findIndex((a) => a.id === access.session.active_activity_id);
  const next = agenda[currentIndex + 1];
  if (!next) {
    publishToSession(sessionId, "session:activity", { sessionId, done: true });
    const { session: detail } = await getSessionWithReturn(sessionId, userId);
    return detail;
  }

  await query(
    `UPDATE study_sessions
        SET active_activity_id = $2, activity_started_at = now(),
            activity_paused_at = NULL, activity_elapsed_seconds = 0
      WHERE id = $1`,
    [sessionId, next.id],
    "sessions:advance",
  );

  publishToSession(sessionId, "session:activity", { sessionId, activeActivityId: next.id });
  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

export async function pauseTimer(sessionId, userId) {
  const access = await assertTimerControl(sessionId, userId);
  await requireRunning(access.session);
  if (!access.session.active_activity_id) throw new ConflictError("No activity is running yet.");

  const session = await queryOne(
    `SELECT activity_started_at, activity_paused_at, activity_elapsed_seconds FROM study_sessions WHERE id = $1`,
    [sessionId],
    "sessions:pauseTimerLoad",
  );
  if (!session.activity_started_at || session.activity_paused_at) {
    throw new ConflictError("The timer is not running.");
  }

  const elapsed =
    (session.activity_elapsed_seconds || 0) +
    Math.max(0, Math.floor((Date.now() - session.activity_started_at.getTime()) / 1000));

  await query(
    `UPDATE study_sessions
        SET activity_elapsed_seconds = $2, activity_paused_at = now(), updated_at = now()
      WHERE id = $1`,
    [sessionId, elapsed],
    "sessions:pauseTimer",
  );

  publishToSession(sessionId, "session:activity", { sessionId, paused: true, elapsedSeconds: elapsed });
  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

export async function resumeTimer(sessionId, userId) {
  const access = await assertTimerControl(sessionId, userId);
  await requireRunning(access.session);
  if (!access.session.active_activity_id) throw new ConflictError("No activity is running yet.");

  const updated = await queryOne(
    `UPDATE study_sessions
        SET activity_started_at = now(), activity_paused_at = NULL, updated_at = now()
      WHERE id = $1 AND activity_paused_at IS NOT NULL AND active_activity_id IS NOT NULL
      RETURNING id`,
    [sessionId],
    "sessions:resumeTimer",
  );
  if (!updated) throw new ConflictError("The timer is not paused.");

  publishToSession(sessionId, "session:activity", { sessionId, paused: false });
  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

/**
 * Add time to the current activity (a "five more minutes") or — for a flexible
 * item with no planned duration (planned_minutes NULL) — cap it explicitly.
 */
export async function extendActivity(sessionId, userId, { minutes }) {
  const access = await assertTimerControl(sessionId, userId);
  await requireRunning(access.session);
  if (!access.session.active_activity_id) throw new ConflictError("No activity is running yet.");

  const add = Math.min(60, Math.max(1, Math.round(Number(minutes))));
  const activity = await queryOne(
    `SELECT planned_minutes FROM session_activities WHERE id = $1 AND session_id = $2`,
    [access.session.active_activity_id, sessionId],
    "sessions:extendLoad",
  );
  if (!activity) throw new NotFoundError("That activity");

  const nextPlan = activity.planned_minutes == null ? add : activity.planned_minutes + add;
  await query(
    `UPDATE session_activities SET planned_minutes = $2 WHERE id = $1 AND session_id = $3`,
    [access.session.active_activity_id, Math.min(240, nextPlan), sessionId],
    "sessions:extend",
  );

  publishToSession(sessionId, "session:activity", { sessionId, activeActivityId: access.session.active_activity_id });
  const { session: detail } = await getSessionWithReturn(sessionId, userId);
  return detail;
}

// ---------------------------------------------------------------------------
// Session chat (authoritative REST; socket only pushes)
// ---------------------------------------------------------------------------

export async function listSessionMessages(sessionId, userId, { before, limit = 50 } = {}) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");

  const params = [sessionId];
  let beforeClause = "";
  if (before) {
    params.push(new Date(before).toISOString());
    beforeClause = `AND (m.created_at, m.id) < ($2::timestamptz, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)`;
  }

  const rows = await queryRows(
    `SELECT m.id, m.body, m.client_id, m.created_at, m.edited_at, m.deleted_at,
            u.id AS author_id, u.first_name, u.last_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.author_id
      WHERE m.session_id = $1 AND m.deleted_at IS NULL
            ${beforeClause}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${Math.min(100, Math.max(1, limit))}`,
    params,
    "sessions:messages",
  );

  return { messages: rows.reverse(), hasMore: rows.length >= Math.min(100, limit) };
}

export async function sendSessionMessage(sessionId, userId, { body, clientId }) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");
  if (access.session.status === "COMPLETED" || access.session.status === "CANCELLED") {
    throw new ConflictError("Closed sessions are read-only.");
  }

  const text = typeof body === "string" ? body.replace(/\r\n/g, "\n").trim() : "";
  if (!text || text.length > 4000) {
    throw new AppError("Write a message between 1 and 4000 characters.", {
      status: 422,
      code: "MESSAGE_BODY",
      fields: { body: "Message cannot be empty." },
    });
  }

  let message;
  try {
    message = await queryOne(
      `INSERT INTO messages (workspace_id, session_id, author_id, client_id, body)
       VALUES (NULL, $1, $2, $3, $4)
       RETURNING id, body, client_id, created_at`,
      [sessionId, userId, clientId ?? null, text],
      "sessions:sendMessage",
    );
  } catch (error) {
    // Duplicate client_id => the client already delivered this message.
    if (error.code === "DUPLICATE" && clientId) {
      message = await queryOne(
        `SELECT id, body, client_id, created_at FROM messages
          WHERE session_id = $1 AND client_id = $2`,
        [sessionId, clientId],
        "sessions:sendMessageIdempotent",
      );
    } else {
      throw error;
    }
  }

  const withAuthor = await queryOne(
    `SELECT m.id, m.body, m.client_id, m.created_at,
            u.id AS author_id, u.first_name, u.last_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.author_id
      WHERE m.id = $1`,
    [message.id],
    "sessions:messageAuthor",
  );

  publishToSession(sessionId, "session:message", { sessionId, message: withAuthor });
  return { message: withAuthor };
}

// ---------------------------------------------------------------------------
// Question queue
// ---------------------------------------------------------------------------

export async function listQuestions(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");

  const rows = await queryRows(
    `SELECT q.id, q.author_id, q.topic, q.body, q.status, q.resolved_at, q.created_at,
            au.first_name, au.last_name,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', r.id, 'authorId', r.author_id, 'body', r.body, 'createdAt', r.created_at,
                'firstName', ru.first_name, 'lastName', ru.last_name)
                ORDER BY r.created_at)
              FROM session_question_responses r
              LEFT JOIN users ru ON ru.id = r.author_id
              WHERE r.question_id = q.id
            ), '[]'::json) AS responses
       FROM session_questions q
       LEFT JOIN users au ON au.id = q.author_id
      WHERE q.session_id = $1
      ORDER BY
        CASE WHEN q.status = 'OPEN' THEN 0 WHEN q.status = 'ANSWERED' THEN 1 WHEN q.status = 'NEEDS_VERIFICATION' THEN 2 ELSE 3 END,
        q.created_at ASC`,
    [sessionId],
    "sessions:questions",
  );
  return rows;
}

export async function createQuestion(sessionId, userId, { topic, body }) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");
  if (access.session.status === "COMPLETED" || access.session.status === "CANCELLED") {
    throw new ConflictError("Closed sessions are read-only.");
  }

  const question = await queryOne(
    `INSERT INTO session_questions (session_id, author_id, topic, body)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [sessionId, userId, topic ?? null, body],
    "sessions:createQuestion",
  );

  publishToSession(sessionId, "session:question", { sessionId, question });
  return question;
}

export async function answerQuestion(sessionId, userId, questionId, { body }) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");
  if (access.session.status === "COMPLETED" || access.session.status === "CANCELLED") {
    throw new ConflictError("Closed sessions are read-only.");
  }

  const response = await queryOne(
    `INSERT INTO session_question_responses (question_id, author_id, body)
     SELECT q.id, $2, $3 FROM session_questions q WHERE q.id = $1 AND q.session_id = $4
     RETURNING *`,
    [questionId, userId, body, sessionId],
    "sessions:answerQuestion",
  );
  if (!response) throw new NotFoundError("That question");

  const withAuthor = await queryOne(
    `SELECT r.*, u.first_name, u.last_name
       FROM session_question_responses r
       LEFT JOIN users u ON u.id = r.author_id
      WHERE r.id = $1`,
    [response.id],
    "sessions:answerAuthor",
  );

  publishToSession(sessionId, "session:question", {
    sessionId,
    questionId,
    kind: "response",
    response: withAuthor,
  });
  return withAuthor;
}

const QUESTION_TRANSITIONS = Object.freeze({
  OPEN: ["ANSWERED", "NEEDS_VERIFICATION", "RESOLVED"],
  ANSWERED: ["NEEDS_VERIFICATION", "RESOLVED", "OPEN"],
  NEEDS_VERIFICATION: ["RESOLVED", "ANSWERED", "OPEN"],
  RESOLVED: [],
});

export async function updateQuestionStatus(sessionId, userId, questionId, status) {
  if (!Object.values(QUESTION_STATUS).includes(status)) {
    throw new AppError("Unknown question status.", { status: 422, code: "INVALID_QUESTION_STATUS" });
  }
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");

  const current = await queryOne(
    `SELECT status FROM session_questions WHERE id = $1 AND session_id = $2`,
    [questionId, sessionId],
    "sessions:questionLoad",
  );
  if (!current) throw new NotFoundError("That question");

  if (status !== current.status && !QUESTION_TRANSITIONS[current.status].includes(status)) {
    throw new ConflictError(`A question in ${current.status} cannot move to ${status}.`);
  }

  const updated = await queryOne(
    `UPDATE session_questions SET status = $3 WHERE id = $1 AND session_id = $2 RETURNING *`,
    [questionId, sessionId, status],
    "sessions:questionStatus",
  );

  publishToSession(sessionId, "session:question", { sessionId, question: updated });
  return updated;
}

// ---------------------------------------------------------------------------
// Shared notes (versioned — last-write-wins with conflict detection)
// ---------------------------------------------------------------------------

export async function listNotes(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");

  return queryRows(
    `SELECT n.id, n.title, n.body, n.version, n.updated_at, n.author_id,
            u.first_name, u.last_name
       FROM session_notes n
       LEFT JOIN users u ON u.id = n.author_id
      WHERE n.session_id = $1
      ORDER BY n.updated_at DESC`,
    [sessionId],
    "sessions:notes",
  );
}

export async function createNote(sessionId, userId, { title, body }) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");
  if (access.session.status === "CANCELLED") throw new ConflictError("Cancelled sessions are read-only.");

  const note = await queryOne(
    `INSERT INTO session_notes (session_id, author_id, title, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, title, body, version, updated_at, author_id`,
    [sessionId, userId, title, body ?? ""],
    "sessions:createNote",
  );

  publishToSession(sessionId, "session:note", { sessionId, note });
  return note;
}

export async function updateNote(sessionId, userId, noteId, { title, body, version }) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");
  if (access.session.status === "CANCELLED") throw new ConflictError("Cancelled sessions are read-only.");

  const updated = await queryOne(
    `UPDATE session_notes SET title = $3, body = $4, version = version + 1
      WHERE id = $1 AND session_id = $2 AND version = $5
      RETURNING id, title, body, version, updated_at, author_id`,
    [noteId, sessionId, title, body ?? "", version ?? 0],
    "sessions:updateNote",
  );

  if (!updated) {
    const current = await queryOne(
      `SELECT id, title, body, version FROM session_notes WHERE id = $1 AND session_id = $2`,
      [noteId, sessionId],
      "sessions:noteConflict",
    );
    if (!current) throw new NotFoundError("That note");
    throw new ConflictError(
      `Another participant updated that note (now v${current.version}). Please refresh and merge.`,
    );
  }

  publishToSession(sessionId, "session:note", { sessionId, note: updated });
  return updated;
}

export async function deleteNote(sessionId, userId, noteId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");

  if (access.session.status === "CANCELLED") throw new ConflictError("Cancelled sessions are read-only.");

  const deleted = await query(
    `DELETE FROM session_notes WHERE id = $1 AND session_id = $2`,
    [noteId, sessionId],
    "sessions:deleteNote",
  );
  if (!deleted.rowCount) throw new NotFoundError("That note");

  publishToSession(sessionId, "session:note", { sessionId, noteId, deleted: true });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Preparation checklist
// ---------------------------------------------------------------------------

export async function myPrep(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");

  return (
    (await queryOne(
      `SELECT status, updated_at FROM session_prep WHERE session_id = $1 AND student_id = $2`,
      [sessionId, userId],
      "sessions:myPrep",
    )) ?? { status: "NOT_STARTED" }
  );
}

export async function setMyPrep(sessionId, userId, status) {
  if (!["NOT_STARTED", "IN_PROGRESS", "READY"].includes(status)) {
    throw new AppError("Unknown preparation status.", { status: 422, code: "INVALID_PREP_STATUS" });
  }
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");

  await query(
    `INSERT INTO session_prep (session_id, student_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id, student_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [sessionId, userId, status],
    "sessions:setPrep",
  );

  publishToSession(sessionId, "session:prep", { sessionId, studentId: userId, status });
  return { status };
}

/** Leader-facing readiness board. */
export async function prepOverview(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isModerator) throw new ForbiddenError("Only the group leader can see the readiness board.");

  const rows = await queryRows(
    `SELECT u.id AS student_id, u.first_name, u.last_name,
            COALESCE(pre.status, 'NOT_STARTED') AS status,
            pre.updated_at
       FROM session_participants p
       JOIN users u ON u.id = p.student_id
       LEFT JOIN session_prep pre ON pre.session_id = p.session_id AND pre.student_id = p.student_id
      WHERE p.session_id = $1
      ORDER BY u.first_name, u.last_name`,
    [sessionId],
    "sessions:prepOverview",
  );

  return {
    rows,
    readyCount: rows.filter((r) => r.status === "READY").length,
    total: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Reflections (post-session)
// ---------------------------------------------------------------------------

export async function submitReflection(sessionId, userId, reflection) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");

  if (access.session.status !== SESSION_STATUS.COMPLETED) {
    throw new ConflictError("Reflections can only be written after the session is completed.");
  }

  await query(
    `INSERT INTO session_reflections
       (session_id, student_id, learned, unclear, review, understanding)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (session_id, student_id)
     DO UPDATE SET learned = EXCLUDED.learned, unclear = EXCLUDED.unclear,
                  review = EXCLUDED.review, understanding = EXCLUDED.understanding`,
    [
      sessionId,
      userId,
      reflection.learned ?? null,
      reflection.unclear ?? null,
      reflection.review ?? null,
      reflection.understanding ?? null,
    ],
    "sessions:reflection",
  );

  const saved = await queryOne(
    `SELECT * FROM session_reflections WHERE session_id = $1 AND student_id = $2`,
    [sessionId, userId],
    "sessions:reflectionGet",
  );

  publishToSession(sessionId, "session:reflection", { sessionId, reflection: saved });
  return saved;
}

export async function listReflections(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");

  const rows = await queryRows(
    `SELECT r.student_id, r.learned, r.unclear, r.review, r.understanding, r.created_at,
            u.first_name, u.last_name
       FROM session_reflections r
       JOIN users u ON u.id = r.student_id
      WHERE r.session_id = $1
      ORDER BY r.created_at DESC`,
    [sessionId],
    "sessions:reflections",
  );

  // Peers see an aggregate, the leader sees every card.
  if (access.isModerator) return { reflections: rows, mine: rows.filter((r) => String(r.student_id) === String(userId)) };
  const mine = rows.filter((r) => String(r.student_id) === String(userId));
  return {
    reflections: [],
    mine,
    aggregate: {
      submitted: rows.length,
      avgUnderstanding: rows.some((r) => r.understanding != null)
        ? Math.round((rows.reduce((sum, r) => sum + (r.understanding ?? 0), 0) / rows.filter((r) => r.understanding != null).length) * 10) / 10
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Session summary — derived from the persisted state, never fabricated
// ---------------------------------------------------------------------------

export async function getSummary(sessionId, userId) {
  const { session } = await assertSessionAccess(sessionId, userId);

  const [participants, roles, activities, questions, notes, prepRows, livedSeconds] =
    await Promise.all([
      activeParticipants(sessionId),
      queryRows(
        `SELECT round_number,
                json_agg(json_build_object('role', role, 'studentId', student_id, 'firstName', u.first_name, 'lastName', u.last_name)) AS round
           FROM session_roles r
           JOIN users u ON u.id = r.student_id
          WHERE r.session_id = $1
          GROUP BY round_number ORDER BY round_number`,
        [sessionId],
        "sessions:summaryRounds",
      ),
      agendas(sessionId),
      queryRows(
        `SELECT
              (SELECT count(*)::int FROM session_questions WHERE session_id = $1) AS total,
              (SELECT count(*)::int FROM session_questions WHERE session_id = $1 AND status = 'RESOLVED') AS resolved`,
        [sessionId],
        "sessions:summaryQuestions",
      ),
      queryRows(
        `SELECT count(*)::int AS count, count(body) FILTER (WHERE length(btrim(body)) > 0)::int AS with_capture
           FROM session_notes WHERE session_id = $1`,
        [sessionId],
        "sessions:summaryNotes",
      ),
      queryRows(
        `SELECT status, count(*)::int AS count FROM session_prep WHERE session_id = $1 GROUP BY status`,
        [sessionId],
        "sessions:summaryPrep",
      ),
      queryOne(
        `SELECT COALESCE(extract(epoch FROM COALESCE(completed_at, now()) - started_at), 0)::int AS seconds
           FROM study_sessions WHERE id = $1`,
        [sessionId],
        "sessions:summaryDuration",
      ),
    ]);

  const questionTotals = questions[0] ?? { total: 0, resolved: 0 };

  return {
    sessionId,
    status: session.status,
    title: session.title,
    format: session.format,
    startedAt: session.started_at,
    completedAt: session.completed_at,
    durationSeconds: livedSeconds.seconds,
    participants: participants.map((p) => ({ ...p, attended: p.attended ?? false })),
    rolesPerRound: roles,
    agenda: activities,
    agendaCompleted: activities.filter((a) => a.position < (session.active_activity_id ? 0 : activities.length)).length,
    questions: questionTotals,
    notesCount: notes[0].count,
    notesWithCapture: notes[0].with_capture,
    preparation: prepRows,
    preparationReady: prepRows.find((r) => r.status === "READY")?.count ?? 0,
    preparationTotal: participants.length,
    averageUnderstanding: null,
  };
}

// ---------------------------------------------------------------------------
// Meeting tokens
// ---------------------------------------------------------------------------

export async function meetingToken(sessionId, userId) {
  const access = await assertSessionAccess(sessionId, userId);
  if (!access.isParticipant && !access.isModerator) throw new ForbiddenError("You are not a participant.");
  if (access.session.status === "CANCELLED" || access.session.status === "COMPLETED") {
    throw new ConflictError("This session is closed — meetings are unavailable.");
  }

  // LiveKit grants come from the membership tier only — never from the client.
  const auth = await authorizationForMeeting(sessionId, userId);
  const user = await queryOne(
    `SELECT id, first_name, last_name FROM users WHERE id = $1`,
    [userId],
    "sessions:meetingUser",
  );

  const result = await meetingTokenFor(
    { id: userId, first_name: user?.first_name ?? "", last_name: user?.last_name ?? "" },
    sessionId,
    auth.grants,
  );

  return { ...result, displayRole: auth.displayRole };
}

export default {
  listMySessions,
  getSession,
  createStudySession,
  updateSessionDetails,
  startSession,
  pauseSession,
  resumeSession,
  completeSession,
  cancelSession,
  addParticipant,
  removeParticipant,
  setRsvp,
  rotateRoles,
  assignRole,
  setAgenda,
  advanceActivity,
  pauseTimer,
  resumeTimer,
  extendActivity,
  listSessionMessages,
  sendSessionMessage,
  listQuestions,
  createQuestion,
  answerQuestion,
  updateQuestionStatus,
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  myPrep,
  setMyPrep,
  prepOverview,
  submitReflection,
  listReflections,
  getSummary,
  meetingToken,
  canParticipateInSession,
  assertSessionAccess,
};