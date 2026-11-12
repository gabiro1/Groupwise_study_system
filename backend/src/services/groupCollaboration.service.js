import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { query, queryOne, queryRows, withTransaction } from "../config/db.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { MESSAGE_KIND, NOTIFICATION_TYPE } from "../config/constants.js";
import { notifyMany } from "../lib/notifications.js";
import env from "../config/env.js";

const LEADER_ROLES = ["OWNER", "MODERATOR"];

const canModerate = (membership) => LEADER_ROLES.includes(membership.role);

/** Convert database group scope into the group-only API contract. */
function publicRow(row) {
  if (!row) return row;
  const { group_id: groupId, ...rest } = row;
  return groupId === undefined ? rest : { ...rest, groupId };
}

const publicRows = (rows) => rows.map(publicRow);

/**
 * Resolve the group and the caller's current membership directly from the two
 * authoritative tables. This is intentionally group based.
 */
export async function assertGroupAccess(groupId, userId) {
  const group = await queryOne(
    `SELECT g.id, g.slug, g.name, g.description, g.status, g.course_id, g.goal_id,
            g.member_count, g.owner_id
       FROM study_groups g
      WHERE g.id = $1`,
    [groupId],
    "collaboration:group",
  );

  if (!group || group.status !== "ACTIVE") throw new NotFoundError("That study group");

  const membership = await queryOne(
    `SELECT m.id, m.role, m.status, m.joined_at, m.joined_via
       FROM study_group_members m
      WHERE m.group_id = $1
        AND m.student_id = $2
        AND m.left_at IS NULL
        AND m.status = 'ACTIVE'
        AND m.role IN ('OWNER', 'MODERATOR', 'MEMBER')`,
    [groupId, userId],
    "collaboration:membership",
  );

  if (!membership) {
    throw new ForbiddenError("You need to be an active member of this study group to do that.");
  }

  return { group, membership };
}

/** Require an active owner or moderator membership for group management. */
async function assertGroupManager(groupId, userId) {
  const access = await assertGroupAccess(groupId, userId);
  if (!canModerate(access.membership)) {
    throw new ForbiddenError("Only a group owner or moderator can manage this group.");
  }
  return access;
}

async function assertChildScope(groupId, { planId = null, topicId = null, topicIds = [] } = {}) {
  if (planId) {
    const plan = await queryOne(
      "SELECT id FROM study_plans WHERE id = $1 AND group_id = $2",
      [planId, groupId],
      "collaboration:planScope",
    );
    if (!plan) throw new NotFoundError("That study plan");
  }

  const ids = [...new Set([topicId, ...topicIds].filter(Boolean))];
  if (!ids.length) return;

  const topics = await queryOne(
    `SELECT count(DISTINCT topic_id)::int AS count
       FROM study_group_topics
      WHERE group_id = $1 AND topic_id = ANY($2::uuid[])`,
    [groupId, ids],
    "collaboration:topicScope",
  );

  if ((topics?.count ?? 0) !== ids.length) throw new NotFoundError("That group topic");
}

async function assertAssignee(groupId, studentId, context) {
  if (!studentId) return;
  const member = await queryOne(
    `SELECT 1
       FROM study_group_members
      WHERE group_id = $1 AND student_id = $2
        AND left_at IS NULL AND status = 'ACTIVE'`,
    [groupId, studentId],
    context,
  );
  if (!member) {
    throw new AppError("You can only assign tasks to members of this group.", {
      status: 422,
      code: "ASSIGNEE_NOT_MEMBER",
      fields: { assigneeId: "Choose someone from the group." },
    });
  }
}

const planColumns = `p.id, p.group_id, p.goal_id, p.title, p.description, p.deadline,
                     p.status, p.created_by, p.completed_at, p.created_at, p.updated_at`;

async function loadPlan(groupId, planId) {
  return queryOne(
    `SELECT ${planColumns},
            (SELECT count(*)::int FROM tasks t
              WHERE t.plan_id = p.id AND t.group_id = p.group_id
                AND t.status <> 'COMPLETED') AS open_tasks,
            COALESCE(
              (SELECT json_agg(
                        json_build_object(
                          'topicId', spt.topic_id,
                          'topicName', ct.name,
                          'targetProficiency', spt.target_proficiency,
                          'position', spt.position
                        ) ORDER BY spt.position
                      )
                 FROM study_plan_topics spt
                 JOIN course_topics ct ON ct.id = spt.topic_id
                WHERE spt.plan_id = p.id),
              '[]'::json
            ) AS topics
       FROM study_plans p
      WHERE p.id = $1 AND p.group_id = $2`,
    [planId, groupId],
    "collaboration:loadPlan",
  );
}

// ---------------------------------------------------------------------------
// Overview and plans
// ---------------------------------------------------------------------------

export async function getOverview(groupId, userId) {
  const { group, membership } = await assertGroupAccess(groupId, userId);

  const [plans, openTasks, upcomingSessions, recentMessages, progress] = await Promise.all([
    queryRows(
      `SELECT ${planColumns},
              (SELECT count(*)::int FROM tasks t
                WHERE t.plan_id = p.id AND t.group_id = p.group_id
                  AND t.status <> 'COMPLETED') AS open_tasks,
              COALESCE(
                (SELECT json_agg(
                          json_build_object(
                            'topicId', spt.topic_id,
                            'topicName', ct.name,
                            'targetProficiency', spt.target_proficiency,
                            'position', spt.position
                          ) ORDER BY spt.position
                        )
                   FROM study_plan_topics spt
                   JOIN course_topics ct ON ct.id = spt.topic_id
                  WHERE spt.plan_id = p.id),
                '[]'::json
              ) AS topics
         FROM study_plans p
        WHERE p.group_id = $1 AND p.status IN ('ACTIVE', 'DRAFT')
        ORDER BY p.status, p.deadline NULLS LAST`,
      [groupId],
      "collaboration:overviewPlans",
    ),
    queryRows(
      `SELECT t.id, t.group_id, t.title, t.description, t.status, t.priority, t.due_at,
              t.assignee_id, u.first_name AS assignee_first_name,
              u.last_name AS assignee_last_name
         FROM tasks t
         LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.group_id = $1 AND t.status <> 'COMPLETED'
        ORDER BY t.due_at NULLS LAST, t.priority DESC
        LIMIT 20`,
      [groupId],
      "collaboration:overviewTasks",
    ),
    queryRows(
      `SELECT s.id, s.group_id, s.title, s.starts_at, s.ends_at, s.mode, s.status,
              s.location, s.meeting_url, s.participants_closed, sp.rsvp,
              (SELECT count(*)::int FROM session_participants p
                WHERE p.session_id = s.id AND p.rsvp = 'GOING') AS going_count
         FROM study_sessions s
         LEFT JOIN session_participants sp
           ON sp.session_id = s.id AND sp.student_id = $2
        WHERE s.group_id = $1 AND s.status = 'SCHEDULED'
          AND s.starts_at >= now() - interval '1 hour'
        ORDER BY s.starts_at
        LIMIT 10`,
      [groupId, userId],
      "collaboration:overviewSessions",
    ),
    queryRows(
      `SELECT m.id, m.group_id, m.kind, m.body, m.parent_id, m.resource_id,
              m.metadata, m.created_at, m.edited_at,
              u.id AS author_id, u.first_name, u.last_name, u.avatar_url
         FROM messages m
         LEFT JOIN users u ON u.id = m.author_id
        WHERE m.group_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 20`,
      [groupId],
      "collaboration:overviewMessages",
    ),
    queryRows(
      `SELECT gtp.group_id, gtp.topic_id, ct.name AS topic_name,
              gtp.status, gtp.confidence, gtp.source, gtp.updated_at
         FROM group_topic_progress gtp
         JOIN course_topics ct ON ct.id = gtp.topic_id
        WHERE gtp.group_id = $1
        ORDER BY gtp.updated_at DESC`,
      [groupId],
      "collaboration:overviewProgress",
    ),
  ]);

  return {
    group: { id: group.id, name: group.name, slug: group.slug },
    viewer: { role: membership.role, canModerate: canModerate(membership) },
    plans: publicRows(plans),
    openTasks: publicRows(openTasks),
    upcomingSessions: publicRows(upcomingSessions),
    recentMessages: publicRows(recentMessages).reverse(),
    progress: publicRows(progress),
  };
}

export async function listPlans(groupId, userId) {
  await assertGroupAccess(groupId, userId);
  const plans = await queryRows(
    `SELECT ${planColumns},
            (SELECT count(*)::int FROM tasks t
              WHERE t.plan_id = p.id AND t.group_id = p.group_id
                AND t.status <> 'COMPLETED') AS open_tasks,
            COALESCE(
              (SELECT json_agg(
                        json_build_object(
                          'topicId', spt.topic_id,
                          'topicName', ct.name,
                          'targetProficiency', spt.target_proficiency,
                          'position', spt.position
                        ) ORDER BY spt.position
                      )
                 FROM study_plan_topics spt
                 JOIN course_topics ct ON ct.id = spt.topic_id
                WHERE spt.plan_id = p.id),
              '[]'::json
            ) AS topics
       FROM study_plans p
      WHERE p.group_id = $1
      ORDER BY p.status, p.deadline NULLS LAST, p.created_at DESC`,
    [groupId],
    "collaboration:listPlans",
  );
  return { plans: publicRows(plans) };
}

export async function getPlan(groupId, userId, planId) {
  await assertGroupAccess(groupId, userId);
  const plan = await loadPlan(groupId, planId);
  if (!plan) throw new NotFoundError("That study plan");
  return { plan: publicRow(plan) };
}

export async function getPlanTopics(groupId, userId, planId) {
  await assertGroupAccess(groupId, userId);
  const plan = await queryOne(
    "SELECT id FROM study_plans WHERE id = $1 AND group_id = $2",
    [planId, groupId],
    "collaboration:planTopicsPlan",
  );
  if (!plan) throw new NotFoundError("That study plan");

  const topics = await queryRows(
    `SELECT spt.topic_id, ct.name AS topic_name, spt.target_proficiency, spt.position
       FROM study_plan_topics spt
       JOIN course_topics ct ON ct.id = spt.topic_id
      WHERE spt.plan_id = $1
      ORDER BY spt.position`,
    [planId],
    "collaboration:listPlanTopics",
  );
  return { topics };
}

export async function createPlan(groupId, userId, input) {
  const { group } = await assertGroupManager(groupId, userId);
  await assertChildScope(groupId, { topicIds: (input.topics ?? []).map((topic) => topic.topicId) });

  const plan = await withTransaction(async (tx) => {
    const created = await tx.queryOne(
      `INSERT INTO study_plans
         (group_id, goal_id, title, description, deadline, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
       RETURNING id, group_id, goal_id, title, description, deadline, status,
                 created_by, completed_at, created_at, updated_at`,
      [groupId, input.goalId ?? null, input.title, input.description ?? "", input.deadline ?? null, userId],
    );

    for (const [position, topic] of (input.topics ?? []).entries()) {
      await tx.query(
        `INSERT INTO study_plan_topics (plan_id, topic_id, target_proficiency, position)
         VALUES ($1, $2, $3, $4)`,
        [created.id, topic.topicId, topic.targetProficiency ?? 3, position],
      );
    }
    return created;
  }, "collaboration:createPlan");

  const members = await queryRows(
    `SELECT student_id
       FROM study_group_members
      WHERE group_id = $1 AND left_at IS NULL AND status = 'ACTIVE'`,
    [groupId],
    "collaboration:planMembers",
  );
  await notifyMany(
    members.filter((row) => row.student_id !== userId).map((row) => row.student_id),
    {
      type: NOTIFICATION_TYPE.SYSTEM,
      title: `New study plan in ${group.name}`,
      body: `${input.title} was added to the group.`,
      link: `/groups/${group.slug}?plan=${plan.id}`,
    },
  );

  return { plan: publicRow(plan) };
}

export async function updatePlan(groupId, userId, planId, updates) {
  await assertGroupManager(groupId, userId);
  const existing = await queryOne(
    "SELECT id, group_id FROM study_plans WHERE id = $1 AND group_id = $2",
    [planId, groupId],
    "collaboration:loadPlanForUpdate",
  );
  if (!existing) throw new NotFoundError("That study plan");

  if (updates.topics) {
    await assertChildScope(groupId, { topicIds: updates.topics.map((topic) => topic.topicId) });
  }

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
    assignments.push(`${column} = $${values.length + 3}`);
  }
  if (updates.status === "COMPLETED" || updates.status === "ABANDONED") assignments.push("completed_at = now()");
  if (updates.status === "ACTIVE") assignments.push("completed_at = NULL");

  if (assignments.length) {
    await query(
      `UPDATE study_plans SET ${assignments.join(", ")}
        WHERE id = $1 AND group_id = $2`,
      [planId, groupId, ...values],
      "collaboration:updatePlan",
    );
  }

  if (updates.topics) {
    await withTransaction(async (tx) => {
      await tx.query("DELETE FROM study_plan_topics WHERE plan_id = $1", [planId]);
      for (const [position, topic] of updates.topics.entries()) {
        await tx.query(
          `INSERT INTO study_plan_topics (plan_id, topic_id, target_proficiency, position)
           VALUES ($1, $2, $3, $4)`,
          [planId, topic.topicId, topic.targetProficiency ?? 3, position],
        );
      }
    }, "collaboration:updatePlanTopics");
  }

  const plan = await loadPlan(groupId, planId);
  return { plan: publicRow(plan) };
}

// ---------------------------------------------------------------------------
// Tasks and comments
// ---------------------------------------------------------------------------

export async function createTask(groupId, userId, input) {
  const { group } = await assertGroupManager(groupId, userId);
  await assertChildScope(groupId, input);
  await assertAssignee(groupId, input.assigneeId, "collaboration:assigneeCheck");

  const task = await withTransaction(async (tx) => {
    return tx.queryOne(
      `INSERT INTO tasks
         (group_id, plan_id, topic_id, title, description, assignee_id,
          created_by, priority, status, due_at, estimate_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, group_id, plan_id, topic_id, title, description, assignee_id,
                 created_by, priority, status, due_at, estimate_minutes, completed_at,
                 created_at, updated_at`,
      [
        groupId,
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
    );
  }, "collaboration:createTask");

  await query(
    `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
     VALUES ($1, $2, 'TASK_CREATED', 'task', $3)`,
    [groupId, userId, task.id],
    "collaboration:logTask",
  );

  if (input.assigneeId && input.assigneeId !== userId) {
    await notifyMany([input.assigneeId], {
      type: NOTIFICATION_TYPE.TASK_ASSIGNED,
      title: `New task: ${input.title}`,
      body: `Assigned to you in ${group.name}.`,
      link: `/groups/${group.slug}?task=${task.id}`,
      metadata: { taskId: task.id },
    });
  }

  return { task: publicRow(task) };
}

export async function listTasks(groupId, userId, filters = {}) {
  await assertGroupAccess(groupId, userId);
  await assertChildScope(groupId, filters);
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const clauses = [`t.group_id = ${bind(groupId)}`];
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
    `SELECT t.id, t.group_id, t.plan_id, t.topic_id, t.title, t.description, t.assignee_id,
            t.created_by, t.priority, t.status, t.due_at, t.estimate_minutes,
            t.completed_at, t.created_at, t.updated_at,
            u.first_name AS assignee_first_name, u.last_name AS assignee_last_name,
            (SELECT count(*)::int FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY t.status, t.due_at NULLS LAST, t.priority DESC, t.created_at DESC
      LIMIT ${bind(filters.limit ?? 50)}`,
    params,
    "collaboration:listTasks",
  );
  return { tasks: publicRows(rows), groupId };
}

async function loadTask(groupId, taskId) {
  return queryOne(
    `SELECT id, group_id, plan_id, topic_id, title, description, assignee_id, created_by,
            priority, status, due_at, estimate_minutes, completed_at, created_at, updated_at
       FROM tasks
      WHERE id = $1 AND group_id = $2`,
    [taskId, groupId],
    "collaboration:readTask",
  );
}

export async function updateTask(groupId, userId, taskId, updates) {
  const access = updates.assigneeId !== undefined
    ? await assertGroupManager(groupId, userId)
    : await assertGroupAccess(groupId, userId);
  const { group } = access;
  const task = await queryOne(
    "SELECT id, group_id, assignee_id, status FROM tasks WHERE id = $1 AND group_id = $2",
    [taskId, groupId],
    "collaboration:loadTask",
  );
  if (!task) throw new NotFoundError("That task");

  await assertChildScope(groupId, updates);
  await assertAssignee(groupId, updates.assigneeId, "collaboration:updateAssigneeCheck");

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
    assignments.push(`${column} = $${values.length + 3}`);
  }
  if (assignments.length) {
    await query(
      `UPDATE tasks SET ${assignments.join(", ")}
        WHERE id = $1 AND group_id = $2`,
      [taskId, groupId, ...values],
      "collaboration:updateTask",
    );
  }

  const becameComplete = updates.status === "COMPLETED" && task.status !== "COMPLETED";
  if (becameComplete && task.assignee_id && task.assignee_id !== userId) {
    await notifyMany([task.assignee_id], {
      type: NOTIFICATION_TYPE.SYSTEM,
      title: `Task completed: ${updates.title ?? "a shared task"}`,
      body: "Marked as done in your study group.",
      link: `/groups/${group.slug}?task=${taskId}`,
    });
  }

  return { task: publicRow(await loadTask(groupId, taskId)) };
}

export async function addTaskComment(groupId, userId, taskId, body) {
  const { membership } = await assertGroupAccess(groupId, userId);
  const task = await queryOne(
    "SELECT id FROM tasks WHERE id = $1 AND group_id = $2",
    [taskId, groupId],
    "collaboration:loadCommentTask",
  );
  if (!task) throw new NotFoundError("That task");

  const comment = await queryOne(
    `INSERT INTO task_comments (task_id, author_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, task_id, author_id, body, created_at, updated_at`,
    [taskId, userId, body],
    "collaboration:addComment",
  );
  const author = await queryOne(
    "SELECT first_name, last_name, avatar_url FROM users WHERE id = $1",
    [userId],
    "collaboration:commentAuthor",
  );
  return {
    comment: {
      ...comment,
      author: {
        id: userId,
        firstName: author?.first_name,
        lastName: author?.last_name,
        avatarUrl: author?.avatar_url,
        role: membership.role,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Study sessions and RSVP
// ---------------------------------------------------------------------------

const sessionColumns = `id, group_id, plan_id, topic_id, title, starts_at, ends_at, mode,
                        location, meeting_url, agenda, status, attendance_tracked,
                        participants_closed, format, main_topic, objectives, preparation,
                        focus_interval_minutes, break_minutes, started_at, paused_at,
                        completed_at, active_activity_id, activity_started_at,
                        activity_paused_at, activity_elapsed_seconds, meeting_room,
                        created_by, created_at, updated_at`;

async function loadSession(groupId, sessionId) {
  return queryOne(
    `SELECT ${sessionColumns}
       FROM study_sessions
      WHERE id = $1 AND group_id = $2`,
    [sessionId, groupId],
    "collaboration:loadSession",
  );
}

export async function createSession(groupId, userId, input) {
  const { group } = await assertGroupManager(groupId, userId);
  await assertChildScope(groupId, input);
  if (input.mode === "ONLINE" && !input.meetingUrl) {
    throw new AppError("Add a meeting link for an online session.", {
      status: 422,
      code: "MEETING_URL_REQUIRED",
      fields: { meetingUrl: "Paste the call link your group will use." },
    });
  }

  const session = await withTransaction(async (tx) => {
    const created = await tx.queryOne(
      `INSERT INTO study_sessions
         (group_id, plan_id, topic_id, title, starts_at, ends_at, mode,
          location, meeting_url, agenda, attendance_tracked, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${sessionColumns}`,
      [
        groupId,
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
    );
    await tx.query(
      `INSERT INTO session_participants (session_id, student_id, rsvp)
       VALUES ($1, $2, 'GOING') ON CONFLICT DO NOTHING`,
      [created.id, userId],
    );
    return created;
  }, "collaboration:createSession");

  const members = await queryRows(
    `SELECT student_id
       FROM study_group_members
      WHERE group_id = $1 AND left_at IS NULL AND status = 'ACTIVE' AND student_id <> $2`,
    [groupId, userId],
    "collaboration:sessionMembers",
  );
  await notifyMany(
    members.map((row) => row.student_id),
    {
      type: NOTIFICATION_TYPE.SESSION_UPDATED,
      title: `New session: ${input.title}`,
      body: `Scheduled in ${group.name}.`,
      link: `/groups/${group.slug}?session=${session.id}`,
      metadata: { sessionId: session.id },
    },
  );

  return { session: publicRow(session) };
}

export async function listSessions(groupId, userId, filters = {}) {
  await assertGroupAccess(groupId, userId);
  const params = [groupId, userId];
  const clauses = ["s.group_id = $1"];
  if (filters.scope === "upcoming") {
    clauses.push("s.starts_at >= now()", "s.status = 'SCHEDULED'");
  } else if (filters.scope === "past") {
    clauses.push("(s.starts_at < now() OR s.status IN ('COMPLETED', 'CANCELLED'))");
  }
  if (filters.from) {
    params.push(filters.from);
    clauses.push(`s.ends_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    clauses.push(`s.starts_at <= $${params.length}`);
  }
  params.push(filters.limit ?? 20);
  const rows = await queryRows(
    `SELECT ${sessionColumns}, sp.rsvp, sp.attended,
            (SELECT count(*)::int FROM session_participants p
              WHERE p.session_id = s.id AND p.rsvp = 'GOING') AS going_count,
            (SELECT count(*)::int FROM study_group_members m
              WHERE m.group_id = s.group_id AND m.left_at IS NULL AND m.status = 'ACTIVE') AS member_count
       FROM study_sessions s
       LEFT JOIN session_participants sp ON sp.session_id = s.id AND sp.student_id = $2
      WHERE ${clauses.join(" AND ")}
      ORDER BY ${filters.scope === "past" ? "s.starts_at DESC" : "s.starts_at ASC"}
      LIMIT $${params.length}`,
    params,
    "collaboration:listSessions",
  );
  return { sessions: publicRows(rows) };
}

export async function updateSession(groupId, userId, sessionId, updates) {
  const { group } = await assertGroupManager(groupId, userId);
  const session = await queryOne(
    `SELECT id, group_id, status, starts_at, ends_at, mode, meeting_url
       FROM study_sessions
      WHERE id = $1 AND group_id = $2`,
    [sessionId, groupId],
    "collaboration:loadSessionForUpdate",
  );
  if (!session) throw new NotFoundError("That session");
  if (session.status === "CANCELLED") throw new ConflictError("That session was cancelled.");
  if (session.status === "COMPLETED") throw new ConflictError("A completed session can no longer be edited.");

  await assertChildScope(groupId, updates);
  const cancelling = updates.status === "CANCELLED";

  const startsAt = updates.startsAt ?? session.starts_at;
  const endsAt = updates.endsAt ?? session.ends_at;
  if (new Date(endsAt) <= new Date(startsAt)) {
    throw new AppError("A session must end after it starts.", {
      status: 422,
      code: "INVALID_SESSION_WINDOW",
      fields: { endsAt: "Choose an end time after the start time." },
    });
  }
  const nextMode = updates.mode ?? session.mode;
  const nextMeetingUrl = updates.meetingUrl ?? session.meeting_url;
  if (nextMode === "ONLINE" && !nextMeetingUrl) {
    throw new AppError("Add a meeting link for an online session.", {
      status: 422,
      code: "MEETING_URL_REQUIRED",
      fields: { meetingUrl: "Paste the call link your group will use." },
    });
  }

  const attendees = await queryRows(
    `SELECT student_id
       FROM session_participants
      WHERE session_id = $1 AND rsvp = 'GOING' AND student_id <> $2`,
    [sessionId, userId],
    "collaboration:sessionAttendees",
  );

  const updated = await queryOne(
    `UPDATE study_sessions
        SET title = COALESCE($3, title),
            starts_at = COALESCE($4::timestamptz, starts_at),
            ends_at = COALESCE($5::timestamptz, ends_at),
            mode = COALESCE($6::session_mode, mode),
            location = COALESCE($7, location),
            meeting_url = COALESCE($8, meeting_url),
            agenda = COALESCE($9, agenda),
            plan_id = COALESCE($10::uuid, plan_id),
            topic_id = COALESCE($11::uuid, topic_id),
            attendance_tracked = COALESCE($12::boolean, attendance_tracked),
            status = COALESCE($13::session_status, status)
      WHERE id = $1 AND group_id = $2
      RETURNING ${sessionColumns}`,
    [
      sessionId,
      groupId,
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
    "collaboration:updateSession",
  );

  await notifyMany(
    attendees.map((row) => row.student_id),
    {
      type: NOTIFICATION_TYPE.SESSION_UPDATED,
      title: cancelling ? `Session cancelled: ${updated.title}` : `Session updated: ${updated.title}`,
      body: cancelling
        ? `This session in ${group.name} was cancelled.`
        : `"${updated.title}" in ${group.name} was updated.`,
      link: `/groups/${group.slug}?session=${sessionId}`,
      metadata: { sessionId, status: updated.status },
    },
  );

  if (cancelling) {
    await query(
      `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'SESSION_CANCELLED', 'session', $3, $4)`,
      [groupId, userId, sessionId, JSON.stringify({ title: updated.title })],
      "collaboration:logSessionCancel",
    );
  }

  return { session: publicRow(updated), notified: attendees.length };
}

export async function rsvp(groupId, userId, sessionId, body) {
  const { group } = await assertGroupAccess(groupId, userId);
  const session = await queryOne(
    `SELECT id, group_id, status, starts_at, ends_at, participants_closed
       FROM study_sessions
      WHERE id = $1 AND group_id = $2`,
    [sessionId, groupId],
    "collaboration:rsvpSession",
  );
  if (!session) throw new NotFoundError("That session");
  if (session.status === "CANCELLED") throw new ConflictError("That session was cancelled.");

  if (session.participants_closed) {
    const participant = await queryOne(
      "SELECT 1 FROM session_participants WHERE session_id = $1 AND student_id = $2",
      [sessionId, userId],
      "collaboration:rsvpParticipant",
    );
    if (!participant) throw new ForbiddenError("You are not an invited participant of this session.");
  }

  const isPast = new Date(session.ends_at) < new Date();
  if (body.attended !== undefined && !isPast) {
    throw new AppError("Attendance can only be recorded once the session has finished.", {
      status: 422,
      code: "SESSION_NOT_FINISHED",
    });
  }

  await query(
    `INSERT INTO session_participants
       (session_id, student_id, rsvp, attended, attendance_minutes, responded_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (session_id, student_id) DO UPDATE
       SET rsvp = EXCLUDED.rsvp,
           attended = COALESCE(EXCLUDED.attended, session_participants.attended),
           attendance_minutes = COALESCE(EXCLUDED.attendance_minutes, session_participants.attendance_minutes),
           responded_at = now()`,
    [sessionId, userId, body.rsvp, body.attended ?? null, body.attendanceMinutes ?? null],
    "collaboration:rsvp",
  );
  await query(
    `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id, metadata)
     VALUES ($1, $2, 'SESSION_RSVP', 'session', $3, $4)`,
    [group.id, userId, sessionId, JSON.stringify({ rsvp: body.rsvp })],
    "collaboration:logRsvp",
  );
  return { sessionId, groupId, rsvp: body.rsvp };
}

// ---------------------------------------------------------------------------
// Group discussion/chat
// ---------------------------------------------------------------------------

export async function listMessages(groupId, userId, { before, limit = 30 } = {}) {
  await assertGroupAccess(groupId, userId);
  const params = [groupId];
  const clauses = ["m.group_id = $1", "m.deleted_at IS NULL"];
  if (before) {
    params.push(before);
    clauses.push(`m.created_at < $${params.length}`);
  }
  params.push(limit);
  const rows = await queryRows(
    `SELECT m.id, m.group_id, m.kind, m.body, m.parent_id, m.resource_id,
            m.metadata, m.ai_model, m.ai_sources, m.created_at, m.edited_at,
            u.id AS author_id, u.first_name, u.last_name, u.avatar_url
       FROM messages m
       LEFT JOIN users u ON u.id = m.author_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${params.length}`,
    params,
    "collaboration:listMessages",
  );
  return { messages: publicRows(rows).reverse() };
}

export async function sendMessage(groupId, userId, input) {
  const { membership } = await assertGroupAccess(groupId, userId);
  if (input.parentId) {
    const parent = await queryOne(
      "SELECT id FROM messages WHERE id = $1 AND group_id = $2",
      [input.parentId, groupId],
      "collaboration:parentCheck",
    );
    if (!parent) throw new NotFoundError("That message");
  }
  if (input.resourceId) {
    const resource = await queryOne(
      `SELECT id FROM resources
        WHERE id = $1 AND group_id = $2 AND NOT is_deleted
          AND (visibility <> 'PRIVATE' OR uploaded_by = $3)`,
      [input.resourceId, groupId, userId],
      "collaboration:messageResourceCheck",
    );
    if (!resource) throw new NotFoundError("That resource");
  }

  const message = await withTransaction(async (tx) => {
    return tx.queryOne(
      `INSERT INTO messages
         (group_id, author_id, parent_id, kind, body, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, group_id, author_id, parent_id, kind, body, resource_id,
                 metadata, ai_model, ai_sources, created_at, edited_at`,
      [
        groupId,
        userId,
        input.parentId ?? null,
        input.kind ?? MESSAGE_KIND.TEXT,
        input.body ?? "",
        input.resourceId ?? null,
        input.clientId ? { clientId: input.clientId } : {},
      ],
    );
  }, "collaboration:sendMessage");

  await query(
    `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
     VALUES ($1, $2, 'MESSAGE_POSTED', 'message', $3)`,
    [groupId, userId, message.id],
    "collaboration:logMessage",
  );
  return {
    message: {
      ...publicRow(message),
      clientId: input.clientId ?? null,
      author: { id: userId, role: membership.role },
    },
  };
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export async function listResources(groupId, userId, filters = {}) {
  await assertGroupAccess(groupId, userId);
  await assertChildScope(groupId, filters);
  const params = [groupId, userId];
  const conditions = [
    "r.group_id = $1",
    "r.is_deleted = FALSE",
    "(r.visibility <> 'PRIVATE' OR r.uploaded_by = $2)",
  ];
  for (const [key, column] of [["kind", "r.kind"], ["topicId", "r.topic_id"], ["planId", "r.plan_id"]]) {
    if (filters[key]) {
      params.push(filters[key]);
      conditions.push(`${column} = $${params.length}`);
    }
  }
  params.push(Math.min(filters.limit ?? 20, 50));
  const resources = await queryRows(
    `SELECT r.id, r.group_id, r.title, r.description, r.kind, r.visibility,
            r.external_url, r.original_filename, r.mime_type, r.size_bytes,
            r.topic_id, r.plan_id, r.created_at, r.uploaded_by,
            CASE WHEN r.kind = 'NOTE' THEN r.extracted_text ELSE NULL END AS content,
            u.first_name AS uploader_first_name, u.last_name AS uploader_last_name
       FROM resources r
       LEFT JOIN users u ON u.id = r.uploaded_by
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length}`,
    params,
    "collaboration:listResources",
  );
  return { resources: publicRows(resources) };
}

export async function createResource(groupId, userId, input) {
  await assertGroupManager(groupId, userId);
  if (input.kind === "FILE" && !input.file?.buffer?.length) {
    throw new AppError("Choose a file to share with your group.", { status: 422, code: "RESOURCE_FILE_REQUIRED" });
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
  await assertChildScope(groupId, input);

  let storageKey = null;
  if (input.kind === "FILE") {
    const extension = extname(input.file.originalname || "")
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, "")
      .slice(0, 12);
    storageKey = `${groupId}/${randomUUID()}${extension}`;
    const filePath = resolve(resolve(env.UPLOAD_DIR), storageKey);
    await mkdir(resolve(filePath, ".."), { recursive: true });
    await writeFile(filePath, input.file.buffer, { flag: "wx" });
  }

  try {
    const resource = await withTransaction(async (tx) => {
      return tx.queryOne(
        `INSERT INTO resources
           (group_id, plan_id, topic_id, uploaded_by, title, description, kind,
            visibility, external_url, extracted_text, extraction_status,
            original_filename, storage_key, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SKIPPED', $11, $12, $13, $14)
         RETURNING id, group_id, plan_id, topic_id, uploaded_by, title, description,
                   kind, visibility, external_url, original_filename, mime_type,
                   size_bytes, created_at,
                   CASE WHEN kind = 'NOTE' THEN extracted_text ELSE NULL END AS content`,
        [
          groupId,
          input.planId ?? null,
          input.topicId ?? null,
          userId,
          input.title,
          input.description ?? "",
          input.kind,
          input.visibility ?? "GROUP",
          input.externalUrl ?? null,
          input.kind === "NOTE" ? input.content.trim() : null,
          input.kind === "FILE" ? input.file.originalname : null,
          storageKey,
          input.kind === "FILE" ? input.file.mimetype : null,
          input.kind === "FILE" ? input.file.size : null,
        ],
      );
    }, "collaboration:createResource");
    return { resource: publicRow(resource) };
  } catch (error) {
    if (storageKey) await unlink(resolve(env.UPLOAD_DIR, storageKey)).catch(() => {});
    throw error;
  }
}

export async function getResourceFile(groupId, resourceId, userId) {
  await assertGroupAccess(groupId, userId);
  const resource = await queryOne(
    `SELECT original_filename, storage_key, mime_type, size_bytes
       FROM resources
      WHERE id = $1 AND group_id = $2 AND kind = 'FILE' AND NOT is_deleted
        AND (visibility <> 'PRIVATE' OR uploaded_by = $3)`,
    [resourceId, groupId, userId],
    "collaboration:resourceFile",
  );
  if (!resource?.storage_key) throw new NotFoundError("That resource file");
  const root = resolve(env.UPLOAD_DIR);
  const filePath = resolve(root, resource.storage_key);
  if (!(filePath === root || filePath.startsWith(`${root}${sep}`))) {
    throw new AppError("That resource file is not available.", { status: 404, code: "RESOURCE_FILE_NOT_FOUND" });
  }
  try {
    await stat(filePath);
  } catch {
    throw new NotFoundError("That resource file");
  }
  return {
    filePath,
    filename: resource.original_filename || "download",
    mimeType: resource.mime_type || "application/octet-stream",
    size: resource.size_bytes,
  };
}

// ---------------------------------------------------------------------------
// Topic progress and feedback
// ---------------------------------------------------------------------------

export async function getTopicProgress(groupId, userId) {
  await assertGroupAccess(groupId, userId);
  const progress = await queryRows(
    `SELECT gtp.group_id, gtp.topic_id, ct.name AS topic_name,
            gtp.status, gtp.confidence, gtp.source, gtp.updated_by, gtp.updated_at
       FROM group_topic_progress gtp
       JOIN course_topics ct ON ct.id = gtp.topic_id
      WHERE gtp.group_id = $1
      ORDER BY gtp.updated_at DESC`,
    [groupId],
    "collaboration:listProgress",
  );
  return { progress: publicRows(progress) };
}

export async function updateTopicProgress(groupId, userId, topicId, status, confidence) {
  await assertGroupManager(groupId, userId);
  await assertChildScope(groupId, { topicId });

  const progress = await withTransaction(async (tx) => {
    const updated = await tx.queryOne(
      `UPDATE group_topic_progress
          SET status = $3, confidence = $4, source = 'MANUAL',
              updated_by = $5, updated_at = now()
        WHERE group_id = $1 AND topic_id = $2
        RETURNING id, group_id, topic_id, status, confidence, source, updated_by, updated_at`,
      [groupId, topicId, status, confidence ?? null, userId],
    );
    if (updated) return updated;

    return tx.queryOne(
      `INSERT INTO group_topic_progress
         (group_id, topic_id, status, confidence, source, updated_by)
        VALUES ($1, $2, $3, $4, 'MANUAL', $5)
        ON CONFLICT (group_id, topic_id) DO UPDATE
          SET status = EXCLUDED.status,
              confidence = EXCLUDED.confidence,
              source = 'MANUAL',
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
        RETURNING id, group_id, topic_id, status, confidence, source, updated_by, updated_at`,
      [groupId, topicId, status, confidence ?? null, userId],
    );
  }, "collaboration:updateProgress");
  return { progress: publicRow(progress) };
}

export async function submitFeedback(groupId, userId, input) {
  const { group } = await assertGroupAccess(groupId, userId);
  const feedback = await withTransaction(async (tx) => {
    const values = [
      groupId,
      userId,
      input.goalsCompatible,
      input.skillsComplementary,
      input.scheduleWorked,
      input.productive,
      input.wouldRepeat ?? null,
      input.overallRating,
      input.comment ?? null,
    ];
    const updated = await tx.queryOne(
      `UPDATE group_feedback
          SET goals_compatible = $3, skills_complementary = $4, schedule_worked = $5,
              productive = $6, would_repeat = $7, overall_rating = $8, comment = $9
        WHERE group_id = $1 AND student_id = $2
        RETURNING id, group_id, student_id, goals_compatible, skills_complementary,
                  schedule_worked, productive, would_repeat, overall_rating, comment,
                  created_at`,
      values,
    );
    if (updated) return updated;

    return tx.queryOne(
      `INSERT INTO group_feedback
         (group_id, student_id, goals_compatible, skills_complementary,
           schedule_worked, productive, would_repeat, overall_rating, comment)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (group_id, student_id) DO UPDATE
          SET goals_compatible = EXCLUDED.goals_compatible,
             skills_complementary = EXCLUDED.skills_complementary,
             schedule_worked = EXCLUDED.schedule_worked,
             productive = EXCLUDED.productive,
             would_repeat = EXCLUDED.would_repeat,
             overall_rating = EXCLUDED.overall_rating,
             comment = EXCLUDED.comment
       RETURNING id, group_id, student_id, goals_compatible, skills_complementary,
                  schedule_worked, productive, would_repeat, overall_rating, comment,
                  created_at`,
       values,
    );
  }, "collaboration:submitFeedback");
  return { feedback: publicRow(feedback), groupId: group.id };
}

export async function getFeedbackSummary(groupId, userId) {
  await assertGroupAccess(groupId, userId);
  const summary = await queryOne(
    `SELECT count(*)::int AS responses,
            round(avg(goals_compatible)::numeric, 2) AS goals,
            round(avg(skills_complementary)::numeric, 2) AS skills,
            round(avg(schedule_worked)::numeric, 2) AS schedule,
            round(avg(productive)::numeric, 2) AS productive,
            round(avg(overall_rating)::numeric, 2) AS overall,
            count(*) FILTER (WHERE would_repeat)::int AS would_repeat
       FROM group_feedback
      WHERE group_id = $1`,
    [groupId],
    "collaboration:feedbackSummary",
  );
  const own = await queryOne(
    `SELECT id, group_id, student_id, goals_compatible, skills_complementary,
            schedule_worked, productive, would_repeat, overall_rating, comment, created_at
       FROM group_feedback
      WHERE group_id = $1 AND student_id = $2`,
    [groupId, userId],
    "collaboration:ownFeedback",
  );
  const isReliable = (summary?.responses ?? 0) >= 5;
  return {
    summary: isReliable
      ? { ...summary, isReliable: true }
      : { responses: summary?.responses ?? 0, isReliable: false, insufficientResponses: true },
    ownFeedback: publicRow(own),
    hasSubmitted: Boolean(own),
  };
}

export default {
  assertGroupAccess,
  getOverview,
  listPlans,
  getPlan,
  getPlanTopics,
  createPlan,
  updatePlan,
  createTask,
  listTasks,
  updateTask,
  addTaskComment,
  createSession,
  listSessions,
  updateSession,
  rsvp,
  listMessages,
  sendMessage,
  listResources,
  createResource,
  getResourceFile,
  getTopicProgress,
  updateTopicProgress,
  submitFeedback,
  getFeedbackSummary,
};
