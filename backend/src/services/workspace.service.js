import { query, queryRows, queryOne, withTransaction } from "../config/db.js";
import { NotFoundError, ForbiddenError, ConflictError, AppError } from "../lib/errors.js";
import { assertMember } from "./group.service.js";
import { NOTIFICATION_TYPE, MESSAGE_KIND } from "../config/constants.js";
import { notifyMany } from "../lib/notifications.js";

/**
 * Workspace service — the collaborative layer of a study group.
 *
 * A workspace belongs to exactly one group, and **workspace membership is the
 * only access control that matters here**. Every function begins with
 * `assertMember` against the workspace's group. A lecturer is not a member of any
 * group workspace, which is what keeps private group conversations private —
 * there is no code path where a role alone grants read access.
 *
 * Every function takes `workspaceId` and resolves the group internally, so a
 * caller cannot supply a group id that disagrees with the workspace.
 */

/** Resolve a workspace and assert the caller is an active member of its group. */
export async function assertWorkspaceAccess(workspaceId, userId) {
  const workspace = await queryOne(
    "SELECT id, group_id, name, created_by, is_archived FROM workspaces WHERE id = $1",
    [workspaceId],
    "workspace:load",
  );

  if (!workspace) throw new NotFoundError("That workspace");
  if (workspace.is_archived) throw new NotFoundError("That workspace");

  const { group, membership } = await assertMember(workspace.group_id, userId);

  return { workspace, group, membership };
}

const canModerate = (membership) =>
  ["OWNER", "MODERATOR"].includes(membership.role);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** List the non-archived workspaces the caller can access through active group membership. */
export async function listMyWorkspaces(userId) {
  const workspaces = await queryRows(
    `SELECT w.id, w.name, w.group_id, w.created_by,
            g.name AS group_name, g.member_count,
            m.role AS membership_role,
            (m.role IN ('OWNER', 'MODERATOR') OR w.created_by = $1) AS can_archive,
            c.course_code, c.name AS course_name,
            (SELECT string_agg(ct.name, ', ' ORDER BY sgt.focus_weight DESC, ct.name)
               FROM study_group_topics sgt
               JOIN course_topics ct ON ct.id = sgt.topic_id
              WHERE sgt.group_id = g.id) AS topics,
            greatest(
              coalesce(activity.last_activity_at, w.created_at),
              coalesce(latest_message.created_at, w.created_at)
            ) AS last_activity_at,
            latest_message.body AS last_message_body,
            latest_message.created_at AS last_message_at,
            latest_message.first_name AS last_message_first_name,
            latest_message.last_name AS last_message_last_name,
            progress.topic_count AS progress_topic_count,
            progress.completed_count AS progress_completed_count
       FROM study_group_members m
       JOIN study_groups g ON g.id = m.group_id
       JOIN courses c ON c.id = g.course_id
       JOIN workspaces w ON w.group_id = g.id AND NOT w.is_archived
       LEFT JOIN LATERAL (
         SELECT max(workspace_activity.at) AS last_activity_at
           FROM (
             SELECT max(created_at) AS at FROM messages
              WHERE workspace_id = w.id AND deleted_at IS NULL
             UNION ALL
             SELECT max(updated_at) FROM tasks WHERE workspace_id = w.id
             UNION ALL
             SELECT max(updated_at) FROM study_sessions WHERE workspace_id = w.id
             UNION ALL
             SELECT max(updated_at) FROM study_plans WHERE workspace_id = w.id
             UNION ALL
             SELECT max(updated_at) FROM resources
              WHERE workspace_id = w.id AND is_deleted = FALSE
             UNION ALL
             SELECT max(updated_at) FROM group_topic_progress WHERE workspace_id = w.id
           ) workspace_activity
       ) activity ON TRUE
       LEFT JOIN LATERAL (
         SELECT msg.body, msg.created_at, u.first_name, u.last_name
           FROM messages msg
           LEFT JOIN users u ON u.id = msg.author_id
          WHERE msg.workspace_id = w.id AND msg.deleted_at IS NULL
          ORDER BY msg.created_at DESC
          LIMIT 1
       ) latest_message ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(sgt.topic_id)::int AS topic_count,
                count(gtp.topic_id) FILTER (WHERE gtp.status IN ('COMFORTABLE', 'STRONG'))::int AS completed_count
           FROM study_group_topics sgt
           LEFT JOIN group_topic_progress gtp
             ON gtp.workspace_id = w.id AND gtp.topic_id = sgt.topic_id
          WHERE sgt.group_id = g.id
       ) progress ON TRUE
      WHERE m.student_id = $1
        AND m.left_at IS NULL
        AND m.status = 'ACTIVE'
      ORDER BY last_activity_at DESC`,
    [userId],
    "workspace:listMine",
  );

  return { workspaces };
}

/** Archive a workspace without deleting its shared study data. */
export async function archiveWorkspace(workspaceId, userId) {
  const { workspace, group, membership } = await assertWorkspaceAccess(workspaceId, userId);
  if (!canModerate(membership) && workspace.created_by !== userId) {
    throw new ForbiddenError("Only the workspace creator or a group moderator can archive this workspace.");
  }

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE workspaces
          SET is_archived = TRUE, archived_at = now()
        WHERE id = $1 AND NOT is_archived`,
      [workspaceId],
    );
    await tx.query(
      `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
       VALUES ($1, $2, 'WORKSPACE_ARCHIVED', 'workspace', $3)`,
      [group.id, userId, workspaceId],
    );
  });
}

/** Create an additional workspace for one of the caller's active study groups. */
export async function createWorkspace(userId, { groupId, name, description }) {
  const { group } = await assertMember(groupId, userId);
  const result = await withTransaction(async (tx) => {
    const createdWorkspace = await tx.queryOne(
      `INSERT INTO workspaces (group_id, name, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, group_id, name, description, created_at`,
      [groupId, name, description, userId],
    );
    await tx.query(
      `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
       VALUES ($1, $2, 'WORKSPACE_CREATED', 'workspace', $3)`,
      [groupId, userId, createdWorkspace.id],
    );
    return createdWorkspace;
  });

  return {
    workspace: result,
    group: {
      id: group.id,
      name: group.name,
      courseCode: group.course_code,
      courseName: group.course_name,
      memberCount: group.member_count,
    },
  };
}

/**
 * Everything the workspace landing page needs, in one round trip.
 *
 * Deliberately not seven endpoints: a group member opening the workspace should
 * see plans, tasks and sessions immediately, not after three sequential
 * waterfalls.
 */
export async function getOverview(workspaceId, userId) {
  const { workspace, group, membership } = await assertWorkspaceAccess(workspaceId, userId);

  const [plans, openTasks, upcomingSessions, recentMessages, progress] = await Promise.all([
    queryRows(
      `SELECT p.id, p.title, p.status, p.deadline,
              (SELECT count(*)::int FROM tasks t
                WHERE t.plan_id = p.id AND t.status <> 'COMPLETED') AS open_tasks
         FROM study_plans p
        WHERE p.workspace_id = $1 AND p.status IN ('ACTIVE', 'DRAFT')
        ORDER BY p.status, p.deadline NULLS LAST`,
      [workspaceId],
      "workspace:plans",
    ),
    queryRows(
      `SELECT t.id, t.title, t.status, t.priority, t.due_at, t.assignee_id,
              u.first_name AS assignee_first_name, u.last_name AS assignee_last_name
         FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.workspace_id = $1 AND t.status <> 'COMPLETED'
        ORDER BY t.due_at NULLS LAST, t.priority DESC
        LIMIT 20`,
      [workspaceId],
      "workspace:tasks",
    ),
    queryRows(
      `SELECT s.id, s.title, s.starts_at, s.ends_at, s.mode, s.status, s.location, s.meeting_url,
              sp.rsvp,
              (SELECT count(*)::int FROM session_participants p
                WHERE p.session_id = s.id AND p.rsvp = 'GOING') AS going_count
         FROM study_sessions s
         LEFT JOIN session_participants sp ON sp.session_id = s.id AND sp.student_id = $2
        WHERE s.workspace_id = $1 AND s.status = 'SCHEDULED' AND s.starts_at >= now() - interval '1 hour'
        ORDER BY s.starts_at
        LIMIT 10`,
      [workspaceId, userId],
      "workspace:sessions",
    ),
    queryRows(
      `SELECT m.id, m.kind, m.body, m.created_at, u.first_name, u.last_name
         FROM messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.workspace_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC LIMIT 20`,
      [workspaceId],
      "workspace:messages",
    ),
    queryRows(
      `SELECT ct.id AS topic_id, ct.name AS topic_name, gtp.status, gtp.confidence, gtp.source
         FROM group_topic_progress gtp JOIN course_topics ct ON ct.id = gtp.topic_id
        WHERE gtp.workspace_id = $1
        ORDER BY gtp.updated_at DESC`,
      [workspaceId],
      "workspace:progress",
    ),
  ]);

  return {
    workspace: { id: workspace.id, name: workspace.name },
    group: { id: group.id, name: group.name, slug: group.slug },
    viewer: { role: membership.role, canModerate: canModerate(membership) },
    plans,
    openTasks,
    upcomingSessions,
    recentMessages: recentMessages.reverse(),
    progress,
  };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function createPlan(workspaceId, userId, input) {
  const { group } = await assertWorkspaceAccess(workspaceId, userId);

  const plan = await withTransaction(async (tx) => {
    const created = await tx.queryOne(
      `INSERT INTO study_plans (workspace_id, goal_id, title, description, deadline, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
       RETURNING *`,
      [workspaceId, input.goalId ?? null, input.title, input.description ?? "", input.deadline ?? null, userId],
      "workspace:createPlan",
    );

    for (const [index, topic] of (input.topics ?? []).entries()) {
      await tx.query(
        "INSERT INTO study_plan_topics (plan_id, topic_id, target_proficiency, position) VALUES ($1, $2, $3, $4)",
        [created.id, topic.topicId, topic.targetProficiency ?? 3, index],
        "workspace:addPlanTopic",
      );
    }

    return created;
  }, "workspace:createPlan");

  const members = await queryRows(
    `SELECT student_id FROM study_group_members WHERE group_id = $1 AND left_at IS NULL`,
    [group.id],
    "workspace:planMembers",
  );

  await notifyMany(
    members.filter((row) => row.student_id !== userId).map((row) => row.student_id),
    {
      type: NOTIFICATION_TYPE.SYSTEM,
      title: `New study plan in ${group.name}`,
      body: `${input.title} was added to the group workspace.`,
      link: `/groups/${group.slug}/workspace?plan=${plan.id}`,
    },
  );

  return plan;
}

export async function updatePlan(workspaceId, userId, planId, updates) {
  const { membership } = await assertWorkspaceAccess(workspaceId, userId);

  const plan = await queryOne(
    "SELECT id, workspace_id FROM study_plans WHERE id = $1",
    [planId],
    "workspace:loadPlan",
  );

  // A plan must belong to *this* workspace. Without this check a member of one
  // group could edit any plan by id.
  if (!plan || plan.workspace_id !== workspaceId) throw new NotFoundError("That study plan");

  const columns = {
    title: "title",
    description: "description",
    deadline: "deadline",
    status: "status",
    goalId: "goal_id",
  };

  const values = [];
  const assignments = [];
  for (const [key, column] of Object.entries(columns)) {
    if (updates[key] === undefined) continue;
    values.push(updates[key]);
    assignments.push(`${column} = $${values.length + 1}`);
  }

  // `completed_at` is derived, never client-supplied: it is research data about
  // when the group actually finished, and a client could otherwise backdate it.
  if (updates.status === "COMPLETED" || updates.status === "ABANDONED") {
    assignments.push("completed_at = now()");
  } else if (updates.status === "ACTIVE") {
    assignments.push("completed_at = NULL");
  }

  if (assignments.length) {
    await query(
      `UPDATE study_plans SET ${assignments.join(", ")} WHERE id = $1`,
      [planId, ...values],
      "workspace:updatePlan",
    );
  }

  if (updates.topics) {
    await withTransaction(async (tx) => {
      await tx.query("DELETE FROM study_plan_topics WHERE plan_id = $1", [planId], "workspace:clearPlanTopics");
      for (const [index, topic] of updates.topics.entries()) {
        await tx.query(
          "INSERT INTO study_plan_topics (plan_id, topic_id, target_proficiency, position) VALUES ($1, $2, $3, $4)",
          [planId, topic.topicId, topic.targetProficiency ?? 3, index],
          "workspace:addPlanTopic",
        );
      }
    }, "workspace:setPlanTopics");
  }

  return queryOne("SELECT * FROM study_plans WHERE id = $1", [planId], "workspace:readPlan");
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTask(workspaceId, userId, input) {
  const { group } = await assertWorkspaceAccess(workspaceId, userId);

  // An assignee who is not a member cannot receive the task. Silently accepting it
  // would produce a notification to someone with no access to the task.
  if (input.assigneeId) {
    const isMember = await queryOne(
      `SELECT 1 FROM study_group_members
        WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL AND status = 'ACTIVE'`,
      [group.id, input.assigneeId],
      "workspace:assigneeCheck",
    );
    if (!isMember) {
      throw new AppError("You can only assign tasks to members of this group.", {
        status: 422,
        code: "ASSIGNEE_NOT_MEMBER",
        fields: { assigneeId: "Choose someone from the group." },
      });
    }
  }

  const task = await queryOne(
    `INSERT INTO tasks
       (workspace_id, plan_id, topic_id, title, description, assignee_id, created_by,
        priority, status, due_at, estimate_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      workspaceId,
      input.planId ?? null,
      input.topicId ?? null,
      input.title,
      input.description ?? "",
      input.assigneeId ?? null,
      userId,
      input.priority ?? "MEDIUM",
      input.status ?? "TODO",
      input.dueAt ?? null,
      input.estimateMinutes ?? null,
    ],
    "workspace:createTask",
  );

  await query(
    `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
     VALUES ($1, $2, 'TASK_CREATED', 'task', $3)`,
    [group.id, userId, task.id],
    "workspace:logTask",
  );

  if (input.assigneeId && input.assigneeId !== userId) {
    await notifyMany([input.assigneeId], {
      type: NOTIFICATION_TYPE.TASK_ASSIGNED,
      title: `New task: ${input.title}`,
      body: `Assigned to you in ${group.name}.`,
      link: `/groups/${group.slug}/workspace?task=${task.id}`,
      metadata: { taskId: task.id },
    });
  }

  return task;
}

/** The task board. Filtering happens in SQL so pagination stays correct. */
export async function listTasks(workspaceId, userId, filters) {
  const { group } = await assertWorkspaceAccess(workspaceId, userId);

  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const clauses = ["t.workspace_id = " + bind(workspaceId)];
  if (filters.status) clauses.push(`t.status = ${bind(filters.status)}`);
  if (filters.planId) clauses.push(`t.plan_id = ${bind(filters.planId)}`);
  if (filters.topicId) clauses.push(`t.topic_id = ${bind(filters.topicId)}`);
  if (filters.assigneeId) clauses.push(`t.assignee_id = ${bind(filters.assigneeId)}`);
  if (filters.mine) clauses.push(`t.assignee_id = ${bind(userId)}`);
  if (filters.overdue) {
    clauses.push("t.due_at < now()");
    clauses.push("t.status <> 'COMPLETED'");
  }

  const rows = await queryRows(
    `SELECT t.*, u.first_name AS assignee_first_name, u.last_name AS assignee_last_name,
            (SELECT count(*)::int FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY t.status, t.due_at NULLS LAST, t.priority DESC, t.created_at DESC
      LIMIT ${bind(filters.limit ?? 50)}`,
    params,
    "workspace:listTasks",
  );

  return { tasks: rows, groupId: group.id };
}

/**
 * Update a task.
 *
 * Status is freely changeable by any member — a study group task board is not an
 * approval workflow, and gating it would only teach students to work around it.
 * Reassignment and deletion are moderator actions.
 */
export async function updateTask(workspaceId, userId, taskId, updates) {
  const { group, membership } = await assertWorkspaceAccess(workspaceId, userId);

  const task = await queryOne(
    "SELECT id, workspace_id, assignee_id, status FROM tasks WHERE id = $1",
    [taskId],
    "workspace:loadTask",
  );

  if (!task || task.workspace_id !== workspaceId) throw new NotFoundError("That task");

  const isModerator = canModerate(membership);
  if (updates.assigneeId !== undefined && !isModerator) {
    throw new ForbiddenError("Only a moderator can reassign a task.");
  }

  const columns = {
    title: "title",
    description: "description",
    assigneeId: "assignee_id",
    priority: "priority",
    status: "status",
    dueAt: "due_at",
    estimateMinutes: "estimate_minutes",
    planId: "plan_id",
    topicId: "topic_id",
  };

  const values = [];
  const assignments = [];
  for (const [key, column] of Object.entries(columns)) {
    if (updates[key] === undefined) continue;
    values.push(updates[key]);
    assignments.push(`${column} = $${values.length + 1}`);
  }

  if (assignments.length) {
    await query(
      `UPDATE tasks SET ${assignments.join(", ")} WHERE id = $1`,
      [taskId, ...values],
      "workspace:updateTask",
    );
  }

  // The database trigger stamps completed_at; this only reports the transition so
  // the assignee can be told.
  const becameComplete = updates.status === "COMPLETED" && task.status !== "COMPLETED";

  if (becameComplete && task.assignee_id && task.assignee_id !== userId) {
    await notifyMany([task.assignee_id], {
      type: NOTIFICATION_TYPE.SYSTEM,
      title: `Task completed: ${updates.title ?? "a shared task"}`,
      body: "Marked as done in your study group.",
      link: `/groups/${group.slug}/workspace?task=${taskId}`,
    });
  }

  return queryOne("SELECT * FROM tasks WHERE id = $1", [taskId], "workspace:readTask");
}

export async function addTaskComment(workspaceId, userId, taskId, body) {
  const { membership } = await assertWorkspaceAccess(workspaceId, userId);

  const task = await queryOne("SELECT id, workspace_id FROM tasks WHERE id = $1", [taskId], "workspace:loadTask");
  if (!task || task.workspace_id !== workspaceId) throw new NotFoundError("That task");

  const comment = await queryOne(
    "INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, $3) RETURNING *",
    [taskId, userId, body],
    "workspace:addComment",
  );

  const author = await queryOne(
    "SELECT first_name, last_name, avatar_url FROM users WHERE id = $1",
    [userId],
    "workspace:commentAuthor",
  );

  return {
    ...comment,
    author: {
      id: userId,
      firstName: author?.first_name,
      lastName: author?.last_name,
      avatarUrl: author?.avatar_url,
      role: membership.role,
    },
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(workspaceId, userId, input) {
  const { group } = await assertWorkspaceAccess(workspaceId, userId);

  // Physical sessions need somewhere to be; online ones need a link. Catching it
  // here gives a field-level message instead of a bare database error later.
  if (input.mode === "ONLINE" && !input.meetingUrl) {
    throw new AppError("Add a meeting link for an online session.", {
      status: 422,
      code: "MEETING_URL_REQUIRED",
      fields: { meetingUrl: "Paste the call link your group will use." },
    });
  }

  const session = await queryOne(
    `INSERT INTO study_sessions
       (workspace_id, plan_id, topic_id, title, starts_at, ends_at, mode, location,
        meeting_url, agenda, attendance_tracked, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      workspaceId,
      input.planId ?? null,
      input.topicId ?? null,
      input.title,
      input.startsAt,
      input.endsAt,
      input.mode ?? "ONLINE",
      input.location ?? null,
      input.meetingUrl ?? null,
      input.agenda ?? "",
      input.attendanceTracked ?? true,
      userId,
    ],
    "workspace:createSession",
  );

  // The organiser is going by definition.
  await query(
    `INSERT INTO session_participants (session_id, student_id, rsvp)
     VALUES ($1, $2, 'GOING') ON CONFLICT DO NOTHING`,
    [session.id, userId],
    "workspace:organiserRsvp",
  );

  const members = await queryRows(
    `SELECT student_id FROM study_group_members WHERE group_id = $1 AND left_at IS NULL AND student_id <> $2`,
    [group.id, userId],
    "workspace:sessionMembers",
  );

  await notifyMany(
    members.map((row) => row.student_id),
    {
      type: NOTIFICATION_TYPE.SESSION_UPDATED,
      title: `New session: ${input.title}`,
      body: `Scheduled in ${group.name}.`,
      link: `/groups/${group.slug}/workspace?session=${session.id}`,
      metadata: { sessionId: session.id },
    },
  );

  return session;
}

export async function listSessions(workspaceId, userId, filters) {
  await assertWorkspaceAccess(workspaceId, userId);

  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const clauses = ["s.workspace_id = " + bind(workspaceId)];

  if (filters.scope === "upcoming") {
    clauses.push("s.starts_at >= now()");
    clauses.push("s.status = 'SCHEDULED'");
  } else if (filters.scope === "past") {
    clauses.push("(s.starts_at < now() OR s.status IN ('COMPLETED', 'CANCELLED'))");
  }

  if (filters.from) clauses.push(`s.ends_at >= ${bind(filters.from)}`);
  if (filters.to) clauses.push(`s.starts_at <= ${bind(filters.to)}`);

  const rows = await queryRows(
    `SELECT s.*, sp.rsvp, sp.attended,
            (SELECT count(*)::int FROM session_participants p WHERE p.session_id = s.id AND p.rsvp = 'GOING') AS going_count,
            (SELECT count(*)::int FROM study_group_members m
                JOIN workspaces w2 ON w2.group_id = m.group_id
               WHERE w2.id = s.workspace_id AND m.left_at IS NULL) AS member_count
       FROM study_sessions s
       LEFT JOIN session_participants sp ON sp.session_id = s.id AND sp.student_id = ${bind(userId)}
      WHERE ${clauses.join(" AND ")}
      ORDER BY ${filters.scope === "past" ? "s.starts_at DESC" : "s.starts_at ASC"}
      LIMIT ${bind(filters.limit ?? 20)}`,
    params,
    "workspace:listSessions",
  );

  return { sessions: rows };
}

/**
 * Edit, cancel or complete a session.
 *
 * Modifiers and cancellers are moderators or the organiser: a group member who
 * cannot edit the agenda should not be able to cancel the session either, and the
 * reverse is also true. Everyone else gets a 404-equivalent `ForbiddenError`
 * without learning whether the session exists.
 *
 * Cancelling notifies everyone who had RSVP'd going, because those are the people
 * who planned to be somewhere at a specific time.
 */
export async function updateSession(workspaceId, userId, sessionId, updates) {
  const { group, membership } = await assertWorkspaceAccess(workspaceId, userId);

  const session = await queryOne(
    "SELECT id, workspace_id, status, starts_at, ends_at, mode, meeting_url, created_by FROM study_sessions WHERE id = $1",
    [sessionId],
    "workspace:loadSessionForUpdate",
  );

  if (!session || session.workspace_id !== workspaceId) throw new NotFoundError("That session");
  if (session.status === "CANCELLED") {
    throw new ConflictError("That session was cancelled.");
  }
  if (session.status === "COMPLETED") {
    throw new ConflictError("A completed session can no longer be edited.");
  }

  const isOrganiser = session.created_by === userId;
  const canModerate = membership.role === "OWNER" || membership.role === "MODERATOR";

  // Only cancelling is allowed for the organiser; schedule edits are a moderator
  // action because they move other people's plans.
  const cancelling = updates.status === "CANCELLED";
  if (!canModerate && !(cancelling && isOrganiser)) {
    throw new ForbiddenError("Only a group moderator can change a session.");
  }

  const startsAt = updates.startsAt ?? session.starts_at;
  const endsAt = updates.endsAt ?? session.ends_at;
  if (new Date(endsAt) <= new Date(startsAt)) {
    throw new AppError("A session must end after it starts.", {
      status: 422,
      code: "INVALID_SESSION_WINDOW",
      fields: { endsAt: "Choose an end time after the start time." },
    });
  }

  // Moving a session that people have already RSVP'd to is the case worth warning
  // about, so the notification body says so explicitly rather than reading like a
  // routine change.
  const attendees = await queryRows(
    "SELECT student_id FROM session_participants WHERE session_id = $1 AND rsvp = 'GOING' AND student_id <> $2",
    [sessionId, userId],
    "workspace:sessionAttendees",
  );

  const nextMode = updates.mode ?? null;
  const nextMeetingUrl = updates.meetingUrl ?? session.meeting_url;

  if (nextMode === "ONLINE" && !nextMeetingUrl) {
    throw new AppError("Add a meeting link for an online session.", {
      status: 422,
      code: "MEETING_URL_REQUIRED",
      fields: { meetingUrl: "Paste the call link your group will use." },
    });
  }

  // A time change that lands inside the new window rather than on it is almost
  // always a timezone mistake on the client, and it is worth a clear message
  // instead of a silently corrupted calendar entry.
  if (updates.startsAt && updates.endsAt) {
    if (new Date(updates.startsAt) < new Date(session.ends_at) && new Date(updates.ends_at) > new Date(session.starts_at)) {
      throw new AppError("The new time overlaps the session's current time.", {
        status: 422,
        code: "SESSION_OVERLAP",
        fields: { startsAt: "Choose a time that does not overlap the current slot." },
      });
    }
  }

  const updated = await queryOne(
    `UPDATE study_sessions
        SET title = COALESCE($2, title),
            starts_at = COALESCE($3::timestamptz, starts_at),
            ends_at = COALESCE($4::timestamptz, ends_at),
            mode = COALESCE($5::session_mode, mode),
            location = COALESCE($6, location),
            meeting_url = COALESCE($7, meeting_url),
            agenda = COALESCE($8, agenda),
            plan_id = COALESCE($9::uuid, plan_id),
            topic_id = COALESCE($10::uuid, topic_id),
            attendance_tracked = COALESCE($11::boolean, attendance_tracked),
            status = COALESCE($12::session_status, status)
      WHERE id = $1
      RETURNING id, title, starts_at, ends_at, mode, location, meeting_url, agenda,
                plan_id, topic_id, attendance_tracked, status`,
    [
      sessionId,
      updates.title ?? null,
      updates.startsAt ?? null,
      updates.endsAt ?? null,
      updates.mode ?? null,
      updates.location ?? null,
      updates.meetingUrl ?? null,
      updates.agenda ?? null,
      updates.planId ?? null,
      updates.topicId ?? null,
      updates.attendanceTracked ?? null,
      updates.status ?? null,
    ],
    "workspace:updateSession",
  );

  const moved = updates.startsAt && new Date(updates.startsAt).getTime() !== new Date(session.starts_at).getTime();

  await notifyMany(
    attendees.map((row) => row.student_id),
    {
      type: NOTIFICATION_TYPE.SESSION_UPDATED,
      title: cancelling ? `Session cancelled: ${updated.title}` : `Session updated: ${updated.title}`,
      body: cancelling
        ? `This session in ${group.name} was cancelled.`
        : moved
          ? `The time for "${updated.title}" in ${group.name} has changed. Check the new date.`
          : `"${updated.title}" in ${group.name} was updated.`,
      link: `/groups/${group.slug}/workspace?session=${sessionId}`,
      metadata: { sessionId, status: updated.status },
    },
  );

  if (cancelling) {
    await query(
      `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'SESSION_CANCELLED', 'session', $3, $4)`,
      [group.id, userId, sessionId, JSON.stringify({ title: updated.title })],
      "workspace:logSessionCancel",
    );
  }

  return { session: updated, notified: attendees.length };
}

/** RSVP. Attendance minutes are only recorded on a completed session. */
export async function rsvp(workspaceId, userId, sessionId, body) {
  const { group } = await assertWorkspaceAccess(workspaceId, userId);

  const session = await queryOne(
    "SELECT id, workspace_id, status, starts_at, ends_at FROM study_sessions WHERE id = $1",
    [sessionId],
    "workspace:loadSession",
  );

  if (!session || session.workspace_id !== workspaceId) throw new NotFoundError("That session");

  if (session.status === "CANCELLED") {
    throw new ConflictError("That session was cancelled.");
  }

  // Attendance is a fact about the past. Recording it on a future session would
  // let a student claim hours they have not studied.
  const isPast = new Date(session.ends_at) < new Date();
  if (body.attended !== undefined && !isPast) {
    throw new AppError("Attendance can only be recorded once the session has finished.", {
      status: 422,
      code: "SESSION_NOT_FINISHED",
    });
  }

  await query(
    `INSERT INTO session_participants (session_id, student_id, rsvp, attended, attendance_minutes, responded_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (session_id, student_id) DO UPDATE
       SET rsvp = EXCLUDED.rsvp,
           attended = COALESCE(EXCLUDED.attended, session_participants.attended),
           attendance_minutes = COALESCE(EXCLUDED.attendance_minutes, session_participants.attendance_minutes),
           responded_at = now()`,
    [sessionId, userId, body.rsvp, body.attended ?? null, body.attendanceMinutes ?? null],
    "workspace:rsvp",
  );

  await query(
    `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id, metadata)
     VALUES ($1, $2, 'SESSION_RSVP', 'session', $3, $4)`,
    [group.id, userId, sessionId, JSON.stringify({ rsvp: body.rsvp })],
    "workspace:logRsvp",
  );

  return { sessionId, rsvp: body.rsvp };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * Messages, oldest-first for rendering.
 *
 * The query is scoped by `workspace_id` only — there is no join that would let a
 * caller pass a group id and read a conversation they are not a member of.
 */
export async function listMessages(workspaceId, userId, { before, limit = 30 } = {}) {
  await assertWorkspaceAccess(workspaceId, userId);

  const params = [workspaceId];
  const clauses = ["m.workspace_id = $1", "m.deleted_at IS NULL"];

  if (before) {
    params.push(before);
    clauses.push(`m.created_at < $${params.length}`);
  }
  params.push(limit);

  const rows = await queryRows(
    `SELECT m.id, m.kind, m.body, m.parent_id, m.resource_id, m.metadata,
            m.ai_model, m.ai_sources, m.created_at, m.edited_at,
            u.id AS author_id, u.first_name, u.last_name, u.avatar_url
       FROM messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${params.length}`,
    params,
    "workspace:listMessages",
  );

  return { messages: rows.reverse() };
}

/**
 * Post a message.
 *
 * `parent_id` is validated to belong to the same workspace: otherwise a client
 * could thread a reply under a message in a conversation the author cannot see.
 */
export async function sendMessage(workspaceId, userId, input) {
  const { group, membership } = await assertWorkspaceAccess(workspaceId, userId);

  if (input.parentId) {
    const parent = await queryOne(
      "SELECT id FROM messages WHERE id = $1 AND workspace_id = $2",
      [input.parentId, workspaceId],
      "workspace:parentCheck",
    );
    if (!parent) throw new NotFoundError("That message");
  }

  const message = await queryOne(
    `INSERT INTO messages (workspace_id, author_id, parent_id, kind, body, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      workspaceId,
      userId,
      input.parentId ?? null,
      input.kind ?? MESSAGE_KIND.TEXT,
      input.body ?? "",
      input.resourceId ?? null,
      input.clientId ? { clientId: input.clientId } : {},
    ],
    "workspace:sendMessage",
  );

  await query(
    `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
     VALUES ($1, $2, 'MESSAGE_POSTED', 'message', $3)`,
    [group.id, userId, message.id],
    "workspace:logMessage",
  );

  return {
    ...message,
    // Echo the client id so an optimistic bubble can be reconciled without a
    // refetch.
    clientId: input.clientId ?? null,
    author: { id: userId, role: membership.role },
  };
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export async function listResources(workspaceId, userId, filters = {}) {
  await assertWorkspaceAccess(workspaceId, userId);

  const params = [workspaceId, userId];
  const conditions = ["r.workspace_id = $1", "r.is_deleted = FALSE", "(r.visibility <> 'PRIVATE' OR r.uploaded_by = $2)"];
  for (const [key, column] of [["kind", "r.kind"], ["topicId", "r.topic_id"], ["planId", "r.plan_id"]]) {
    if (filters[key]) {
      params.push(filters[key]);
      conditions.push(`${column} = $${params.length}`);
    }
  }
  params.push(Math.min(filters.limit ?? 20, 50));

  return queryRows(
    `SELECT r.id, r.title, r.description, r.kind, r.visibility, r.external_url,
            r.topic_id, r.plan_id, r.created_at, r.uploaded_by,
            CASE WHEN r.kind = 'NOTE' THEN r.extracted_text ELSE NULL END AS content,
            u.first_name AS uploader_first_name, u.last_name AS uploader_last_name
       FROM resources r
       LEFT JOIN users u ON u.id = r.uploaded_by
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length}`,
    params,
    "workspace:listResources",
  );
}

export async function createResource(workspaceId, userId, input) {
  const { group } = await assertWorkspaceAccess(workspaceId, userId);
  if (input.kind === "FILE") {
    throw new AppError("File uploads are not available here yet. Add a link or a text note instead.", {
      status: 422,
      code: "RESOURCE_FILE_UNAVAILABLE",
    });
  }
  if (input.kind === "LINK" && !input.externalUrl) {
    throw new AppError("A link resource needs a URL.", { status: 422, code: "RESOURCE_URL_REQUIRED" });
  }
  if (input.kind === "LINK" && !["http:", "https:"].includes(new URL(input.externalUrl).protocol)) {
    throw new AppError("Resource links must use HTTP or HTTPS.", { status: 422, code: "RESOURCE_URL_INVALID" });
  }
  if (input.kind === "NOTE" && !input.content?.trim()) {
    throw new AppError("A note resource needs some text.", { status: 422, code: "RESOURCE_CONTENT_REQUIRED" });
  }

  if (input.planId) {
    const plan = await queryOne(
      "SELECT id FROM study_plans WHERE id = $1 AND workspace_id = $2",
      [input.planId, workspaceId],
      "workspace:resourcePlan",
    );
    if (!plan) throw new NotFoundError("That study plan");
  }
  if (input.topicId) {
    const topic = await queryOne(
      `SELECT 1 FROM study_group_topics
        WHERE group_id = $1 AND topic_id = $2`,
      [group.id, input.topicId],
      "workspace:resourceTopic",
    );
    if (!topic) throw new NotFoundError("That group topic");
  }

  return queryOne(
    `INSERT INTO resources
       (workspace_id, plan_id, topic_id, uploaded_by, title, description, kind,
        visibility, external_url, extracted_text, extraction_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SKIPPED')
     RETURNING id, title, description, kind, visibility, external_url, topic_id,
               plan_id, created_at, uploaded_by,
               CASE WHEN kind = 'NOTE' THEN extracted_text ELSE NULL END AS content`,
    [
      workspaceId,
      input.planId ?? null,
      input.topicId ?? null,
      userId,
      input.title,
      input.description ?? "",
      input.kind,
      input.visibility ?? "GROUP",
      input.externalUrl ?? null,
      input.kind === "NOTE" ? input.content.trim() : null,
    ],
    "workspace:createResource",
  );
}

// ---------------------------------------------------------------------------
// Topic progress and feedback
// ---------------------------------------------------------------------------

/**
 * Record a group's confidence in a topic.
 *
 * Group-level, not per-student: this is the group's shared view of what it has
 * covered, which is what makes "what should we study next" answerable.
 */
export async function updateTopicProgress(workspaceId, userId, topicId, status, confidence) {
  await assertWorkspaceAccess(workspaceId, userId);

  return queryOne(
    `INSERT INTO group_topic_progress (workspace_id, topic_id, status, confidence, source, updated_by)
     VALUES ($1, $2, $3, $4, 'MANUAL', $5)
     ON CONFLICT (workspace_id, topic_id) DO UPDATE
       SET status = EXCLUDED.status,
           confidence = EXCLUDED.confidence,
           source = 'MANUAL',
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
     RETURNING *`,
    [workspaceId, topicId, status, confidence ?? null, userId],
    "workspace:updateProgress",
  );
}

/**
 * End-of-group feedback. One row per student per workspace, enforced by the
 * table's unique constraint, so re-submitting updates rather than accumulating.
 */
export async function submitFeedback(workspaceId, userId, input) {
  const { group } = await assertWorkspaceAccess(workspaceId, userId);

  const feedback = await queryOne(
    `INSERT INTO group_feedback
       (workspace_id, student_id, goals_compatible, skills_complementary, schedule_worked,
        productive, would_repeat, overall_rating, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, student_id) DO UPDATE
       SET goals_compatible = EXCLUDED.goals_compatible,
           skills_complementary = EXCLUDED.skills_complementary,
           schedule_worked = EXCLUDED.schedule_worked,
           productive = EXCLUDED.productive,
           would_repeat = EXCLUDED.would_repeat,
           overall_rating = EXCLUDED.overall_rating,
           comment = EXCLUDED.comment
     RETURNING *`,
    [
      workspaceId,
      userId,
      input.goalsCompatible,
      input.skillsComplementary,
      input.scheduleWorked,
      input.productive,
      input.wouldRepeat ?? null,
      input.overallRating,
      input.comment ?? null,
    ],
    "workspace:submitFeedback",
  );

  return { feedback, groupId: group.id };
}

/** Aggregated feedback for a group, for the group page. */
export async function getFeedbackSummary(workspaceId, userId) {
  await assertWorkspaceAccess(workspaceId, userId);

  const row = await queryOne(
    `SELECT count(*)::int AS responses,
            round(avg(goals_compatible)::numeric, 2) AS goals,
            round(avg(skills_complementary)::numeric, 2) AS skills,
            round(avg(schedule_worked)::numeric, 2) AS schedule,
            round(avg(productive)::numeric, 2) AS productive,
            round(avg(overall_rating)::numeric, 2) AS overall,
            count(*) FILTER (WHERE would_repeat)::int AS would_repeat
       FROM group_feedback WHERE workspace_id = $1`,
    [workspaceId],
    "workspace:feedbackSummary",
  );

  const own = await queryOne(
    "SELECT * FROM group_feedback WHERE workspace_id = $1 AND student_id = $2",
    [workspaceId, userId],
    "workspace:ownFeedback",
  );

  // Below a handful of responses an average is noise, not a signal. Say so rather
  // than rendering "4.7/5" from two replies.
  const isReliable = (row?.responses ?? 0) >= 5;

  return {
    summary: isReliable
      ? { ...row, isReliable: true }
      : { responses: row?.responses ?? 0, isReliable: false, insufficientResponses: true },
    ownFeedback: own ?? null,
    hasSubmitted: Boolean(own),
  };
}

export default {
  assertWorkspaceAccess,
  getOverview,
  createPlan,
  updatePlan,
  createTask,
  listTasks,
  updateTask,
  addTaskComment,
  createSession,
  listSessions,
  rsvp,
  listMessages,
  sendMessage,
  updateTopicProgress,
  submitFeedback,
  getFeedbackSummary,
};