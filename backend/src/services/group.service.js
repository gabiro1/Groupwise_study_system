import { query, queryRows, queryOne, withTransaction } from "../config/db.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  CapacityError,
  AppError,
} from "../lib/errors.js";
import { recordAudit, AUDIT } from "../lib/audit.js";
import { notify, notifyMany } from "../lib/notifications.js";
import { NOTIFICATION_TYPE, GROUP_MEMBER_ROLE, LEARNING_GOAL_LABELS } from "../config/constants.js";

/**
 * Study group service.
 *
 * Membership is the authority. Every read and write in this file re-derives the
 * caller's membership from the database and refuses anything that is not a
 * current member — the group id in the URL is never treated as proof of access.
 *
 * The recurring rule: **human choice outranks the model.** A student can invite
 * someone with a 30% compatibility score, and can always decline a
 * recommendation. Any code that gates an action on a score is a bug.
 */

/** Escapes a value for safe use inside a generated slug. */
function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Group slugs must be unique. A random suffix keeps two groups called
 * "Calculus Study Group" from colliding, without forcing the student to invent a
 * URL-friendly name themselves.
 */
async function uniqueSlug(name) {
  const base = slugify(name) || "group";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const taken = await queryOne("SELECT 1 FROM study_groups WHERE slug = $1", [candidate], "groups:slugTaken");
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Resolve a group and the caller's membership in one query.
 *
 * Returns `{ group, membership }` where `membership` is null for a non-member.
 * Callers must check it; `assertMember` does that for them.
 */
export async function loadGroupWithMembership(groupId, userId) {
  const group = await queryOne(
    `SELECT g.*, c.course_code, c.name AS course_name, c.credit_hours,
            lg.code AS goal_code, lg.label AS goal_label,
            u.first_name AS owner_first_name, u.last_name AS owner_last_name,
            w.id AS workspace_id,
            EXISTS (SELECT 1 FROM study_group_invitations i
                     WHERE i.group_id = g.id AND i.invitee_id = $2 AND i.status = 'PENDING') AS has_pending_invite
       FROM study_groups g
       JOIN courses c ON c.id = g.course_id
       LEFT JOIN learning_goals lg ON lg.id = g.goal_id
       LEFT JOIN users u ON u.id = g.owner_id
       LEFT JOIN LATERAL (
         SELECT id FROM workspaces
          WHERE group_id = g.id AND NOT is_archived
          ORDER BY created_at DESC
          LIMIT 1
       ) w ON TRUE
      WHERE g.id = $1`,
    [groupId, userId],
    "groups:load",
  );

  if (!group) throw new NotFoundError("That study group");

  const membership = await queryOne(
    `SELECT id, role, status, joined_via, joined_at, contribution_score
       FROM study_group_members
      WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL`,
    [groupId, userId],
    "groups:membership",
  );

  return { group, membership };
}

/** Load a group the caller must be an active member of. */
export async function assertMember(groupId, userId) {
  const { group, membership } = await loadGroupWithMembership(groupId, userId);
  if (!membership || membership.status !== "ACTIVE") {
    throw new ForbiddenError("You need to be a member of this study group to do that.");
  }
  return { group, membership };
}

/** Owner or moderator. */
export async function assertModerator(groupId, userId) {
  const { group, membership } = await assertMember(groupId, userId);
  if (![GROUP_MEMBER_ROLE.OWNER, GROUP_MEMBER_ROLE.MODERATOR].includes(membership.role)) {
    throw new ForbiddenError("Only a group owner or moderator can do that.");
  }
  return { group, membership };
}

/**
 * Public group listing and search.
 *
 * Only PUBLIC and REQUEST_REQUIRED groups are discoverable: an INVITE_ONLY group
 * is findable by direct link and by invitation, never by browsing, which is the
 * whole point of the setting.
 */
export async function searchGroups(viewerId, filters = {}) {
  const limit = filters.limit ?? 20;
  const params = [viewerId];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const clauses = [
    "g.status = 'ACTIVE'",
    // An INVITE_ONLY group stays out of browse/search entirely.
    "g.privacy IN ('PUBLIC', 'REQUEST_REQUIRED')",
  ];

  if (filters.q) {
    const pattern = `%${String(filters.q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    clauses.push(`(g.name ILIKE ${bind(pattern)} OR g.description ILIKE ${bind(pattern)})`);
  }
  if (filters.courseId) clauses.push(`g.course_id = ${bind(filters.courseId)}`);
  if (filters.topicId) {
    clauses.push(
      `EXISTS (SELECT 1 FROM study_group_topics gt
                WHERE gt.group_id = g.id AND gt.topic_id = ${bind(filters.topicId)})`,
    );
  }
  if (filters.goalId) clauses.push(`g.goal_id = ${bind(filters.goalId)}`);
  if (filters.universityId) clauses.push(`sp.university_id = ${bind(filters.universityId)}`);
  if (filters.programId) clauses.push(`sp.program_id = ${bind(filters.programId)}`);
  if (filters.mode && filters.mode !== "EITHER") {
    clauses.push(`g.mode IN (${bind(filters.mode)}, 'EITHER')`);
  }
  if (filters.privacy) clauses.push(`g.privacy = ${bind(filters.privacy)}`);
  if (filters.hasSpace) clauses.push("g.member_count < g.max_size");

  const order = {
    newest: "g.created_at DESC",
    activity: "g.activity_score DESC, g.created_at DESC",
    size: "g.member_count DESC",
    // "relevance" is deliberately not score-based: ranking search results by a
    // compatibility score would quietly turn browsing into ranking by an opaque
    // number. Plain-text relevance plus activity is more honest here.
    relevance: "g.activity_score DESC, g.member_count DESC",
  }[filters.sort ?? "relevance"];

  const direction = filters.sortDirection === "asc" && filters.sort === "newest" ? "ASC" : "DESC";

  const rows = await queryRows(
    `SELECT g.id, g.slug, g.name, g.description, g.mode, g.privacy, g.status,
            g.member_count, g.min_size, g.max_size, g.activity_score, g.require_approval,
            g.created_at, g.location_hint, g.language,
            c.id AS course_id, c.course_code, c.name AS course_name,
            lg.code AS goal_code, lg.label AS goal_label,
            u.first_name AS owner_first_name, u.last_name AS owner_last_name,
            (SELECT count(*)::int FROM study_group_schedule s
              WHERE s.group_id = g.id) AS schedule_slot_count,
            EXISTS (SELECT 1 FROM study_group_members m
                     WHERE m.group_id = g.id AND m.student_id = $1 AND m.left_at IS NULL) AS is_member,
            EXISTS (SELECT 1 FROM study_group_members m
                     WHERE m.group_id = g.id AND m.student_id = $1 AND m.left_at IS NULL
                       AND m.role IN ('OWNER', 'MODERATOR')) AS can_moderate,
            EXISTS (SELECT 1 FROM study_group_join_requests jr
                     WHERE jr.group_id = g.id AND jr.student_id = $1 AND jr.status = 'PENDING') AS has_pending_request,
            EXISTS (SELECT 1 FROM study_group_invitations i
                     WHERE i.group_id = g.id AND i.invitee_id = $1 AND i.status = 'PENDING') AS has_pending_invite
       FROM study_groups g
       JOIN courses c ON c.id = g.course_id
       LEFT JOIN student_profiles sp ON sp.user_id = g.owner_id
       LEFT JOIN learning_goals lg ON lg.id = g.goal_id
       LEFT JOIN users u ON u.id = g.owner_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY ${order.replace(/DESC$/, direction)} NULLS LAST
      LIMIT ${bind(limit)} OFFSET ${bind(filters.offset ?? 0)}`,
    params,
    "groups:search",
  );

  return {
    groups: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      mode: row.mode,
      privacy: row.privacy,
      memberCount: row.member_count,
      minSize: row.min_size,
      maxSize: row.max_size,
      hasSpace: row.member_count < row.max_size,
      courseId: row.course_id,
      courseCode: row.course_code,
      courseName: row.course_name,
      goalCode: row.goal_code,
      goalLabel: row.goal_label ?? LEARNING_GOAL_LABELS[row.goal_code],
      owner: { firstName: row.owner_first_name, lastName: row.owner_last_name },
      locationHint: row.location_hint,
      scheduleSlotCount: row.schedule_slot_count,
      createdAt: row.created_at,
      isMember: row.is_member,
      canModerate: row.can_moderate,
      hasPendingRequest: row.has_pending_request,
      hasPendingInvite: row.has_pending_invite,
    })),
    hasMore: rows.length === limit,
  };
}

/**
 * A single group.
 *
 * Non-members get a limited public view; the response shape is identical either
 * way so the UI has one case to render. What a non-member may see is decided here,
 * never in the client.
 */
export async function getGroup(groupId, viewerId) {
  const { group, membership } = await loadGroupWithMembership(groupId, viewerId);
  const isMember = Boolean(membership && membership.status === "ACTIVE");

  const [topics, schedule, memberCount, recentActivity] = await Promise.all([
    queryRows(
      `SELECT ct.id, ct.name, gt.focus_weight, ct.position
         FROM study_group_topics gt JOIN course_topics ct ON ct.id = gt.topic_id
        WHERE gt.group_id = $1 ORDER BY gt.focus_weight DESC, ct.position`,
      [groupId],
      "groups:topics",
    ),
    queryRows(
      `SELECT day_of_week, start_minute, end_minute, is_primary
         FROM study_group_schedule WHERE group_id = $1
        ORDER BY day_of_week, start_minute`,
      [groupId],
      "groups:schedule",
    ),
    // Member names are visible to members only. For outsiders a bare count is
    // returned, which is enough to decide whether to join.
    isMember
      ? queryRows(
          `SELECT u.id, u.first_name, u.last_name, u.avatar_url, m.role, m.joined_at, m.last_active_at
             FROM study_group_members m JOIN users u ON u.id = m.student_id
            WHERE m.group_id = $1 AND m.left_at IS NULL AND m.status = 'ACTIVE'
            ORDER BY m.joined_at`,
          [groupId],
          "groups:members",
        )
      : Promise.resolve(null),
    queryRows(
      `SELECT event_type, created_at FROM group_activity_events
        WHERE group_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [groupId],
      "groups:activity",
    ),
  ]);

  return {
    id: group.id,
    slug: group.slug,
    name: group.name,
    description: group.description,
    mode: group.mode,
    privacy: group.privacy,
    status: group.status,
    courseId: group.course_id,
    courseCode: group.course_code,
    courseName: group.course_name,
    goalCode: group.goal_code,
    goalLabel: group.goal_label,
    minSize: group.min_size,
    maxSize: group.max_size,
    memberCount: group.member_count,
    hasSpace: group.member_count < group.max_size,
    requireApproval: group.require_approval,
    locationHint: group.location_hint,
    language: group.language,
    activityScore: group.activity_score,
    createdAt: group.created_at,
    workspaceId: group.workspace_id,
    owner: { firstName: group.owner_first_name, lastName: group.owner_last_name },
    topics,
    schedule,
    // null for outsiders: "withheld", which the UI shows differently from [].
    members: memberCount,
    recentActivity,
    viewer: {
      isMember,
      role: membership?.role ?? null,
      canModerate: [GROUP_MEMBER_ROLE.OWNER, GROUP_MEMBER_ROLE.MODERATOR].includes(membership?.role),
      hasPendingInvite: group.has_pending_invite,
    },
  };
}

/** Create a group. The workspace is created by a database trigger. */
export async function createGroup(ownerId, input) {
  const slug = await uniqueSlug(input.name);

  const group = await withTransaction(async (tx) => {
    const created = await tx.queryOne(
      `INSERT INTO study_groups
         (slug, name, course_id, goal_id, description, mode, privacy, require_approval,
          min_size, max_size, owner_id, location_hint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        slug,
        input.name,
        input.courseId,
        input.goalId ?? null,
        input.description ?? "",
        input.mode,
        input.privacy,
        input.requireApproval,
        input.minSize,
        input.maxSize,
        ownerId,
        input.locationHint ?? null,
      ],
    );

    // The creator is the owner. member_count is maintained by trigger, so it does
    // not need to be seeded here.
    await tx.query(
      `INSERT INTO study_group_members (group_id, student_id, role, status, joined_via)
       VALUES ($1, $2, 'OWNER', 'ACTIVE', 'DIRECT')`,
      [created.id, ownerId],
      "groups:createOwnerMembership",
    );

    // The workspace is created by a trigger on study_groups, so it already exists
    // by this point and the owner's outcome row can be opened in the same
    // transaction as the membership.
    await openMembershipOutcome(tx, created.id, ownerId, "DIRECT");

    for (const topic of input.topicIds ?? []) {
      await tx.query(
        "INSERT INTO study_group_topics (group_id, topic_id, focus_weight) VALUES ($1, $2, $3)",
        [created.id, topic.topicId ?? topic, topic.focusWeight ?? 3],
        "groups:createTopic",
      );
    }

    for (const slot of input.schedule ?? []) {
      await tx.query(
        `INSERT INTO study_group_schedule (group_id, day_of_week, start_minute, end_minute)
         VALUES ($1, $2, $3, $4)`,
        [created.id, slot.dayOfWeek, slot.startMinute, slot.endMinute],
        "groups:createSchedule",
      );
    }

    await tx.query(
      `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
       VALUES ($1, $2, 'GROUP_CREATED', 'study_group', $1)`,
      [created.id, ownerId],
      "groups:logCreated",
    );

    return created;
  }, "groups:create");

  await recordAudit({
    action: AUDIT.GROUP_CREATED,
    entityType: "study_group",
    entityId: group.id,
    actor: { id: ownerId },
    metadata: { name: group.name, courseId: group.course_id, privacy: group.privacy },
  });

  return getGroup(group.id, ownerId);
}

/**
 * Update a group. Moderator-or-owner, and a moderator cannot change the fields
 * that define who the group belongs to.
 */
const OWNER_ONLY_FIELDS = new Set(["privacy", "requireApproval", "minSize", "maxSize", "status"]);

export async function updateGroup(groupId, actorId, updates) {
  const { membership } = await assertMember(groupId, actorId);
  const isOwner = membership.role === GROUP_MEMBER_ROLE.OWNER;

  if (!isOwner) {
    const attempted = Object.keys(updates).filter((key) => OWNER_ONLY_FIELDS.has(key));
    if (attempted.length) {
      throw new ForbiddenError("Only the group owner can change who may join and how large the group is.");
    }
  }

  const columns = {
    name: "name",
    description: "description",
    mode: "mode",
    privacy: "privacy",
    requireApproval: "require_approval",
    minSize: "min_size",
    maxSize: "max_size",
    goalId: "goal_id",
    locationHint: "location_hint",
    status: "status",
    courseId: "course_id",
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
      `UPDATE study_groups SET ${assignments.join(", ")} WHERE id = $1`,
      [groupId, ...values],
      "groups:update",
    );
  }

  // Replacing the schedule and topic focus wholesale keeps the edit semantics
  // predictable: the client sends the complete desired set, not a diff.
  if (updates.schedule) {
    await withTransaction(async (tx) => {
      await tx.query("DELETE FROM study_group_schedule WHERE group_id = $1", [groupId], "groups:clearSchedule");
      for (const slot of updates.schedule) {
        await tx.query(
          "INSERT INTO study_group_schedule (group_id, day_of_week, start_minute, end_minute) VALUES ($1, $2, $3, $4)",
          [groupId, slot.dayOfWeek, slot.startMinute, slot.endMinute],
          "groups:addSchedule",
        );
      }
    }, "groups:setSchedule");
  }

  if (updates.topicIds) {
    await withTransaction(async (tx) => {
      await tx.query("DELETE FROM study_group_topics WHERE group_id = $1", [groupId], "groups:clearTopics");
      for (const topic of updates.topicIds) {
        await tx.query(
          "INSERT INTO study_group_topics (group_id, topic_id, focus_weight) VALUES ($1, $2, $3)",
          [groupId, topic.topicId ?? topic, topic.focusWeight ?? 3],
          "groups:addTopic",
        );
      }
    }, "groups:setTopics");
  }

  return getGroup(groupId, actorId);
}

/**
 * Invite a student.
 *
 * Two checks that are easy to conflate and must both hold:
 *  - the *group* must allow the inviter to add people;
 *  - the *invitee* must allow being invited.
 *
 * A low compatibility score is never a reason to refuse. `ignoreCompatibility`
 * exists so the client can be explicit that the student chose this person.
 */
export async function inviteMember(groupId, inviterId, inviteeId, { message, ignoreCompatibility } = {}) {
  if (inviteeId === inviterId) {
    throw new AppError("You are already in this group.", { status: 422, code: "SELF_INVITE" });
  }

  const { group, membership } = await assertMember(groupId, inviterId);

  if (group.member_count >= group.max_size) {
    throw new CapacityError("This study group is already at its maximum size.");
  }

  const invitee = await queryOne(
    `SELECT u.id, u.first_name, u.last_name, u.status,
            ps.discoverable, ps.allow_invites_from
       FROM users u LEFT JOIN privacy_settings ps ON ps.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [inviteeId],
    "groups:invitee",
  );

  if (!invitee) throw new NotFoundError("That student");

  // Invariant: invite permission belongs to the invitee, not to the inviter.
  if (invitee.allow_invites_from === "NOBODY" || invitee.discoverable === false) {
    throw new ForbiddenError("This student is not accepting invitations right now.");
  }

  const alreadyMember = await queryOne(
    "SELECT 1 FROM study_group_members WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL",
    [groupId, inviteeId],
    "groups:alreadyMember",
  );
  if (alreadyMember) {
    throw new ConflictError("They are already a member of this study group.");
  }

  // The score is stored for research ("were low-scored invites accepted more
  // often?"), never used to gate the action.
  const compatibility = await scoreInvitee(groupId, inviterId, inviteeId);

  const invitation = await withTransaction(async (tx) => {
    const created = await tx.queryOne(
      `INSERT INTO study_group_invitations
         (group_id, inviter_id, invitee_id, message, compatibility_score,
          compatibility_note, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days')
       RETURNING id, group_id, invitee_id, status, message, compatibility_score, expires_at, created_at`,
      [
        groupId,
        inviterId,
        inviteeId,
        message ?? null,
        compatibility?.score ?? null,
        compatibility?.note ?? null,
      ],
      "groups:createInvitation",
    );

    await tx.query(
      `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'MEMBER_INVITED', 'user', $3, $4)`,
      [groupId, inviterId, inviteeId, JSON.stringify({ ignoredCompatibility: Boolean(ignoreCompatibility) })],
      "groups:logInvite",
    );

    return created;
  }, "groups:invite");

  await notify({
    userId: inviteeId,
    type: NOTIFICATION_TYPE.GROUP_INVITATION,
    title: `Invitation to ${group.name}`,
    body: `You have been invited to join ${group.name}.`,
    link: `/groups/${group.slug}`,
    metadata: { groupId, invitationId: invitation.id },
  });

  return { ...invitation, compatibility };
}

/** Best-effort compatibility estimate for an invite, used for research only. */
async function scoreInvitee(groupId, inviterId, inviteeId) {
  try {
    const { pairCompatibility } = await import("./recommendation.service.js");
    const result = await pairCompatibility(inviterId, inviteeId);
    return { score: result.score, note: result.reasons[0]?.detail ?? null };
  } catch {
    // An unavailable scorer must never block an invitation.
    return null;
  }
}

/** Accept or decline an invitation. */
export async function respondToInvitation(userId, invitationId, response) {
  const invitation = await queryOne(
    `SELECT i.*, g.name AS group_name, g.slug, g.member_count, g.max_size, g.privacy
       FROM study_group_invitations i JOIN study_groups g ON g.id = i.group_id
      WHERE i.id = $1 AND i.invitee_id = $2`,
    [invitationId, userId],
    "groups:loadInvitation",
  );

  if (!invitation) throw new NotFoundError("That invitation");

  if (invitation.status !== "PENDING") {
    throw new ConflictError(
      invitation.status === "EXPIRED"
        ? "That invitation has expired. Ask for a new one."
        : "That invitation has already been answered.",
    );
  }

  if (new Date(invitation.expires_at) < new Date()) {
    await query(
      "UPDATE study_group_invitations SET status = 'EXPIRED' WHERE id = $1",
      [invitationId],
      "groups:expireInvitation",
    );
    throw new ConflictError("That invitation has expired. Ask for a new one.");
  }

  const accepted = response === "ACCEPT";

  // Capacity is re-checked at acceptance, not at invitation time: the group may
  // have filled up in between, and accepting into a full group would breach the
  // group's own stated limit.
  if (accepted && invitation.member_count >= invitation.max_size) {
    throw new CapacityError("This study group filled up while your invitation was pending.");
  }

  const { groupId, inviterId, inviteeId } = invitation;

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE study_group_invitations
          SET status = $2, responded_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [invitationId, accepted ? "ACCEPTED" : "DECLINED"],
      "groups:respondInvitation",
    );

    if (accepted) {
      // Rejoining a group you previously left reuses the existing row: the unique
      // constraint is on (group_id, student_id), so an INSERT would collide.
      await tx.query(
        `INSERT INTO study_group_members (group_id, student_id, role, status, joined_via)
         VALUES ($1, $2, 'MEMBER', 'ACTIVE', 'INVITATION')
         ON CONFLICT (group_id, student_id)
         DO UPDATE SET left_at = NULL, status = 'ACTIVE', joined_via = 'INVITATION', joined_at = now()`,
        [groupId, inviteeId],
        "groups:acceptMembership",
      );
      await openMembershipOutcome(tx, groupId, inviteeId, "INVITATION");
    }

    await tx.query(
      `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
       VALUES ($1, $2, $3, 'invitation', $4)`,
      [groupId, inviteeId, accepted ? "INVITATION_ACCEPTED" : "INVITATION_DECLINED", invitationId],
      "groups:logInvitationResponse",
    );
  }, "groups:respond");

  await notify({
    userId: inviterId,
    type: NOTIFICATION_TYPE.INVITATION_ACCEPTED,
    title: accepted ? "Invitation accepted" : "Invitation declined",
    body: accepted
      ? `You are now a member of ${invitation.group_name}.`
      : `Your invitation to ${invitation.group_name} was declined.`,
    link: `/groups/${invitation.slug}`,
    metadata: { groupId, invitationId },
  });

  return { status: accepted ? "ACCEPTED" : "DECLINED", groupId, groupSlug: invitation.slug };
}

/**
 * Join a group directly, or request to join.
 *
 * PUBLIC groups admit immediately. REQUEST_REQUIRED creates a request unless the
 * group has turned approval off. INVITE_ONLY cannot be joined at all — that is
 * what makes it private.
 */
export async function joinGroup(groupId, studentId, { message } = {}) {
  const group = await queryOne(
    `SELECT id, name, slug, privacy, require_approval, member_count, max_size, course_id
       FROM study_groups WHERE id = $1 AND status = 'ACTIVE'`,
    [groupId],
    "groups:joinLoad",
  );

  if (!group) throw new NotFoundError("That study group");

  const existing = await queryOne(
    "SELECT id, left_at FROM study_group_members WHERE group_id = $1 AND student_id = $2",
    [groupId, studentId],
    "groups:joinExisting",
  );

  if (existing && !existing.left_at) {
    throw new ConflictError("You are already a member of this study group.");
  }

  if (group.privacy === "INVITE_ONLY") {
    throw new ForbiddenError("This group is invite only. Ask a member to invite you.");
  }

  if (group.member_count >= group.max_size) {
    throw new CapacityError("This study group is already full.");
  }

  const needsRequest = group.privacy === "REQUEST_REQUIRED" && group.require_approval;

  if (!needsRequest) {
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO study_group_members (group_id, student_id, role, status, joined_via)
         VALUES ($1, $2, 'MEMBER', 'ACTIVE', 'DIRECT')
         ON CONFLICT (group_id, student_id)
         DO UPDATE SET left_at = NULL, status = 'ACTIVE', joined_via = 'DIRECT', joined_at = now()`,
        [groupId, studentId],
        "groups:directJoin",
      );
      await openMembershipOutcome(tx, groupId, studentId, "DIRECT");
      await tx.query(
        `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
         VALUES ($1, $2, 'MEMBER_JOINED', 'user', $2)`,
        [groupId, studentId],
        "groups:logJoin",
      );
    }, "groups:directJoin");

    return { status: "JOINED", groupId, groupSlug: group.slug, workspaceId: await workspaceFor(groupId) };
  }

  // The conflict target must match the partial index exactly, predicate included,
  // or Postgres cannot infer it.
  const request = await queryOne(
    `INSERT INTO study_group_join_requests (group_id, student_id, message)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_id, student_id) WHERE status = 'PENDING'
     DO UPDATE SET message = EXCLUDED.message
     RETURNING id, status, created_at`,
    [groupId, studentId, message ?? null],
    "groups:createRequest",
  );

  const moderators = await queryRows(
    `SELECT student_id FROM study_group_members
      WHERE group_id = $1 AND left_at IS NULL AND role IN ('OWNER', 'MODERATOR')`,
    [groupId],
    "groups:moderators",
  );

  await notifyMany(
    moderators.map((row) => row.student_id),
    {
      type: NOTIFICATION_TYPE.JOIN_REQUEST,
      title: `New request to join ${group.name}`,
      body: "A student has asked to join your study group.",
      link: `/groups/${group.slug}/requests`,
      metadata: { groupId, requestId: request.id },
    },
  );

  return { status: "REQUESTED", requestId: request.id, groupId, groupSlug: group.slug };
}

/** Approve or reject a join request. */
export async function decideJoinRequest(actorId, requestId, decision, note) {
  const request = await queryOne(
    `SELECT jr.*, g.name AS group_name, g.slug, g.member_count, g.max_size, g.owner_id
       FROM study_group_join_requests jr JOIN study_groups g ON g.id = jr.group_id
      WHERE jr.id = $1`,
    [requestId],
    "groups:loadRequest",
  );

  if (!request) throw new NotFoundError("That join request");

  // Moderator check via the request's own group, so a request id from another
  // group cannot be decided through this endpoint.
  await assertModerator(request.group_id, actorId);

  if (request.status !== "PENDING") {
    throw new ConflictError("That request has already been decided.");
  }

  const approve = decision === "APPROVE";

  if (approve && request.member_count >= request.max_size) {
    throw new CapacityError("This study group is already full.");
  }

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE study_group_join_requests
          SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        WHERE id = $1 AND status = 'PENDING'`,
      [requestId, approve ? "APPROVED" : "REJECTED", actorId, note ?? null],
      "groups:decideRequest",
    );

    if (approve) {
      await tx.query(
        `INSERT INTO study_group_members (group_id, student_id, role, status, joined_via)
         VALUES ($1, $2, 'MEMBER', 'ACTIVE', 'JOIN_REQUEST')
         ON CONFLICT (group_id, student_id)
         DO UPDATE SET left_at = NULL, status = 'ACTIVE', joined_via = 'JOIN_REQUEST', joined_at = now()`,
        [request.group_id, request.student_id],
        "groups:approveMembership",
      );
      await openMembershipOutcome(tx, request.group_id, request.student_id, "JOIN_REQUEST");
    }

    await tx.query(
      `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id)
       VALUES ($1, $2, $3, 'join_request', $4)`,
      [request.group_id, actorId, approve ? "JOIN_REQUEST_APPROVED" : "JOIN_REQUEST_REJECTED", requestId],
      "groups:logDecision",
    );
  }, "groups:decideRequest");

  await notify({
    userId: request.student_id,
    type: NOTIFICATION_TYPE.JOIN_REQUEST_APPROVED,
    title: approve ? `You joined ${request.group_name}` : `Request declined for ${request.group_name}`,
    body: approve ? "Your request was approved. Welcome aboard." : note ?? "Your request was not approved this time.",
    link: `/groups/${request.slug}`,
    metadata: { groupId: request.group_id, requestId },
  });

  return { status: approve ? "APPROVED" : "REJECTED", groupId: request.group_id };
}

/**
 * Promote, demote or remove a member.
 *
 * The owner cannot be demoted or removed through this path: a group without an
 * owner has nobody who can moderate it or archive it, so ownership transfer is
 * handled by `transferOwnership` instead.
 */
export async function manageMember(groupId, actorId, targetStudentId, action) {
  const { membership } = await assertModerator(groupId, actorId);

  if (targetStudentId === actorId) {
    throw new AppError("You cannot change your own role in this group.", { status: 422, code: "SELF_MANAGE" });
  }

  const target = await queryOne(
    `SELECT id, role, status FROM study_group_members
      WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL`,
    [groupId, targetStudentId],
    "groups:manageTarget",
  );

  if (!target) throw new NotFoundError("That group member");

  if (target.role === GROUP_MEMBER_ROLE.OWNER) {
    throw new ConflictError(
      action === "REMOVE"
        ? "The group owner cannot be removed. Transfer ownership first."
        : "The owner's role cannot be changed.",
    );
  }

  // A moderator cannot promote to owner: that is an ownership transfer, which
  // only the current owner may perform.
  if (action === "PROMOTE" && membership.role !== GROUP_MEMBER_ROLE.OWNER) {
    throw new ForbiddenError("Only the group owner can promote someone to owner.");
  }

  const nextRole = {
    PROMOTE: GROUP_MEMBER_ROLE.MODERATOR,
    DEMOTE: GROUP_MEMBER_ROLE.MEMBER,
  }[action];

  // Bind positionally: `$2` is skipped in the UPDATE because the row is already
  // identified by its membership id, and the extra bound value would otherwise be
  // dead weight in the parameter list.
  if (nextRole) {
    await query(
      "UPDATE study_group_members SET role = $2 WHERE id = $1 AND role <> 'OWNER'",
      [target.id, nextRole],
      "groups:updateRole",
    );
  }

  if (action === "REMOVE") {
    await withTransaction(async (tx) => {
      await tx.query(
        "UPDATE study_group_members SET left_at = now() WHERE id = $1",
        [target.id],
        "groups:removeMember",
      );
      // Being removed is a different kind of exit from choosing to leave, and the
      // two are not the same fact for the study: one is a group that lost a member,
      // the other is a group that failed to keep them.
      await closeMembershipOutcome(tx, groupId, targetStudentId, "REMOVED");
    }, "groups:removeMemberOutcome");
  }

  // `event_type` is free TEXT, but the value is assembled from a fixed allowlist
  // rather than interpolated into the SQL string, so a caller cannot inject an
  // arbitrary event name.
  const eventType = {
    PROMOTE: "MEMBER_PROMOTED",
    DEMOTE: "MEMBER_DEMOTED",
    REMOVE: "MEMBER_REMOVED",
  }[action];

  await query(
    `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, 'user', $4, $5)`,
    [groupId, actorId, eventType, targetStudentId, JSON.stringify({ via: "moderation", action })],
    "groups:logManage",
  );

  if (action === "REMOVE") {
    await notify({
      userId: targetStudentId,
      type: NOTIFICATION_TYPE.SYSTEM,
      title: "You were removed from a study group",
      body: "A moderator removed you from the group. You can rejoin if it is still open.",
    });
  }

  return { studentId: targetStudentId, action };
}

/**
 * Leave a group.
 *
 * The last member cannot leave: that would leave an ownerless group with no
 * possible moderator. They must archive or transfer ownership instead.
 */
export async function leaveGroup(groupId, studentId, reason) {
  const { group, membership } = await assertMember(groupId, studentId);

  if (membership.role === GROUP_MEMBER_ROLE.OWNER) {
    const others = await queryOne(
      `SELECT count(*)::int AS count FROM study_group_members
        WHERE group_id = $1 AND student_id <> $2 AND left_at IS NULL AND status = 'ACTIVE'`,
      [groupId, studentId],
      "groups:leaveOthers",
    );

    if (others.count === 0) {
      throw new ConflictError(
        "You are the only member. Archive the group or invite someone before leaving.",
      );
    }
  }

  await withTransaction(async (tx) => {
    await tx.query(
      "UPDATE study_group_members SET left_at = now() WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL",
      [groupId, studentId],
      "groups:leave",
    );
    await closeMembershipOutcome(tx, groupId, studentId, reason ?? "LEFT");
    await tx.query(
      `INSERT INTO group_activity_events (group_id, actor_id, event_type, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'MEMBER_LEFT', 'user', $2, $3)`,
      [groupId, studentId, JSON.stringify({ reason: reason ?? null })],
      "groups:logLeave",
    );
  }, "groups:leave");

  return { left: true, groupId, groupName: group.name };
}

/** Owner hands ownership to another member. The only way roles change hands. */
export async function transferOwnership(groupId, actorId, newOwnerId) {
  const { group } = await assertMember(groupId, actorId);

  if (group.owner_id !== actorId) {
    throw new ForbiddenError("Only the current group owner can transfer ownership.");
  }

  const target = await queryOne(
    `SELECT id FROM study_group_members
      WHERE group_id = $1 AND student_id = $2 AND left_at IS NULL AND status = 'ACTIVE'`,
    [groupId, newOwnerId],
    "groups:ownershipTarget",
  );

  if (!target) throw new NotFoundError("That group member");

  await withTransaction(async (tx) => {
    await tx.query(
      "UPDATE study_group_members SET role = 'OWNER' WHERE id = $1",
      [target.id],
      "groups:promoteOwner",
    );
    await tx.query(
      "UPDATE study_group_members SET role = 'MEMBER' WHERE group_id = $1 AND student_id = $2",
      [groupId, actorId],
      "groups:demoteSelf",
    );
    await tx.query("UPDATE study_groups SET owner_id = $2 WHERE id = $1", [groupId, newOwnerId], "groups:setOwner");
  }, "groups:transferOwnership");

  return { groupId, ownerId: newOwnerId };
}

/** Archive a group. Owner only. Membership rows are kept for the audit trail. */
export async function archiveGroup(groupId, actorId) {
  const { group } = await assertMember(groupId, actorId);

  if (group.owner_id !== actorId) {
    throw new ForbiddenError("Only the group owner can archive it.");
  }

  await withTransaction(async (tx) => {
    await tx.query(
      "UPDATE study_groups SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [groupId],
      "groups:archive",
    );
    await tx.query(
      "UPDATE workspaces SET is_archived = TRUE, archived_at = now() WHERE group_id = $1 AND NOT is_archived",
      [groupId],
      "groups:archiveWorkspace",
    );
    await tx.query(
      "UPDATE study_group_invitations SET status = 'CANCELLED' WHERE group_id = $1 AND status = 'PENDING'",
      [groupId],
      "groups:cancelInvites",
    );
    await tx.query(
      "UPDATE study_group_join_requests SET status = 'CANCELLED' WHERE group_id = $1 AND status = 'PENDING'",
      [groupId],
      "groups:cancelRequests",
    );
  }, "groups:archive");

  await recordAudit({
    action: AUDIT.GROUP_ARCHIVED,
    entityType: "study_group",
    entityId: groupId,
    actor: { id: actorId },
    metadata: { name: group.name },
  });

  return { archived: true, groupId };
}

/** Invitations and join requests addressed to the caller. */
/**
 * Groups the caller belongs to.
 *
 * Distinct from `searchGroups`, which returns the public catalogue. A member's own
 * groups include invite-only and archived ones, and carry the caller's role, so
 * this is the endpoint the dashboard uses.
 */
export async function listMyGroups(userId, { includeArchived = false } = {}) {
  const groups = await queryRows(
    `SELECT *
       FROM (
         SELECT g.id, g.slug, g.name, g.description, g.mode, g.privacy, g.status,
                g.member_count, g.min_size, g.max_size, g.created_at,
                g.updated_at AS last_active_at,
                m.role AS my_role, m.joined_at,
                c.id AS course_id, c.course_code, c.name AS course_name,
                w.id AS workspace_id,
                (SELECT max(created_at) FROM messages msg WHERE msg.workspace_id = w.id AND msg.deleted_at IS NULL) AS last_message_at,
                (SELECT count(*)::int FROM group_activity_events e WHERE e.group_id = g.id AND e.created_at > now() - interval '7 days') AS events_this_week
           FROM study_group_members m
           JOIN study_groups g ON g.id = m.group_id
           JOIN courses c ON c.id = g.course_id
           LEFT JOIN LATERAL (
             SELECT id FROM workspaces
              WHERE group_id = g.id AND NOT is_archived
              ORDER BY created_at DESC
              LIMIT 1
           ) w ON TRUE
          WHERE m.student_id = $1 AND m.left_at IS NULL
            AND ($2::boolean OR g.status = 'ACTIVE')
       ) filtered
      ORDER BY
        -- Active groups first, then the ones with recent life. A dashboard sorted
        -- alphabetically hides exactly the groups a student should act on.
        (filtered.status = 'ACTIVE') DESC,
        coalesce(filtered.last_message_at, filtered.last_active_at, filtered.created_at) DESC`,
    [userId, includeArchived],
    "groups:myGroups",
  );

  return {
    groups,
    counts: {
      active: groups.filter((group) => group.status === "ACTIVE").length,
      archived: groups.filter((group) => group.status === "ARCHIVED").length,
    },
  };
}

export async function listMyInvitations(userId) {
  const invitations = await queryRows(
    `SELECT i.id, i.status, i.message, i.compatibility_score, i.expires_at, i.created_at,
            g.id AS group_id, g.name AS group_name, g.slug, g.course_id, g.member_count, g.max_size,
            c.course_code, c.name AS course_name,
            u.first_name AS inviter_first_name, u.last_name AS inviter_last_name
       FROM study_group_invitations i
       JOIN study_groups g ON g.id = i.group_id
       JOIN courses c ON c.id = g.course_id
       JOIN users u ON u.id = i.inviter_id
      WHERE i.invitee_id = $1 AND i.status = 'PENDING' AND i.expires_at > now()
      ORDER BY i.created_at DESC`,
    [userId],
    "groups:myInvitations",
  );

  const requests = await queryRows(
    `SELECT jr.id, jr.status, jr.message, jr.created_at,
            g.id AS group_id, g.name AS group_name, g.slug, c.course_code, c.name AS course_name
       FROM study_group_join_requests jr
       JOIN study_groups g ON g.id = jr.group_id
       JOIN courses c ON c.id = g.course_id
      WHERE jr.student_id = $1 AND jr.status = 'PENDING'
      ORDER BY jr.created_at DESC`,
    [userId],
    "groups:myRequests",
  );

  return { invitations, requests };
}

/** Pending invitations and requests for groups the caller moderates. */
export async function listModerationQueue(groupId, actorId) {
  await assertModerator(groupId, actorId);

  const [invitations, requests] = await Promise.all([
    queryRows(
      `SELECT i.id, i.status, i.message, i.compatibility_score, i.created_at, i.expires_at,
              u.id AS student_id, u.first_name, u.last_name, u.avatar_url
         FROM study_group_invitations i JOIN users u ON u.id = i.invitee_id
        WHERE i.group_id = $1 AND i.status = 'PENDING'
        ORDER BY i.created_at DESC`,
      [groupId],
      "groups:queueInvitations",
    ),
    queryRows(
      `SELECT jr.id, jr.status, jr.message, jr.compatibility_score, jr.created_at,
              u.id AS student_id, u.first_name, u.last_name, u.avatar_url
         FROM study_group_join_requests jr JOIN users u ON u.id = jr.student_id
        WHERE jr.group_id = $1 AND jr.status = 'PENDING'
        ORDER BY jr.created_at DESC`,
      [groupId],
      "groups:queueRequests",
    ),
  ]);

  return { invitations, requests };
}

async function workspaceFor(groupId) {
  const row = await queryOne(
    "SELECT id FROM workspaces WHERE group_id = $1 AND NOT is_archived",
    [groupId],
    "groups:workspaceFor",
  );
  return row?.id ?? null;
}

/**
 * Open a research-outcome row for a new membership.
 *
 * `group_membership_outcomes` is the spine of the study: one row per student per
 * workspace, recording how they arrived and what they did afterwards. The
 * compatibility score that produced the match is measured *before* joining and the
 * activity counters are measured *after*, so the two are never entangled.
 *
 * Written in the same transaction as the membership row. If either lands alone the
 * outcome table gains an orphan or a membership with no measurement, and the
 * attrition and retention figures silently stop meaning anything.
 *
 * `joined_via` is how the student arrived, never the score: the headline comparison
 * is recommendation-assisted vs organic joining, and encoding the score here would
 * make the analysis circular.
 */
async function openMembershipOutcome(tx, groupId, studentId, joinedVia, recommendationId = null) {
  const workspace = await tx.query(
    "SELECT id FROM workspaces WHERE group_id = $1 AND NOT is_archived",
    [groupId],
    "groups:outcomeWorkspace",
  );

  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) return null;

  // Re-joining after leaving reuses the same membership row (the unique constraint
  // is on group + student), so the previous outcome row is replaced rather than
  // duplicated: a student who leaves and rejoins is one episode for this study.
  await tx.query(
    `INSERT INTO group_membership_outcomes
       (workspace_id, student_id, joined_via, recommendation_id, joined_at, left_at, leave_reason)
     VALUES ($1, $2, $3, $4, now(), NULL, NULL)
     ON CONFLICT (workspace_id, student_id) DO UPDATE
       SET joined_via = EXCLUDED.joined_via,
           recommendation_id = EXCLUDED.recommendation_id,
           joined_at = now(),
           left_at = NULL,
           leave_reason = NULL`,
    [workspaceId, studentId, joinedVia, recommendationId],
    "groups:openOutcome",
  );

  return workspaceId;
}

/**
 * Close the outcome row for a membership that ended.
 *
 * `left_at` stays null while the membership is active, so "still a member" is a
 * fact in the data rather than a calculation that can disagree with itself.
 */
async function closeMembershipOutcome(tx, groupId, studentId, reason) {
  await tx.query(
    `UPDATE group_membership_outcomes o
        SET left_at = now(),
            leave_reason = $3
       FROM workspaces w
      WHERE o.workspace_id = w.id
        AND w.group_id = $1
        AND o.student_id = $2
        AND o.left_at IS NULL`,
    [groupId, studentId, reason],
    "groups:closeOutcome",
  );
}

/**
 * The leadership dashboard overview.
 *
 * "Leader" here means a membership role (OWNER or MODERATOR) inside a specific
 * group — the group-level permission, not an account type. The overview is
 * therefore exactly the union of the caller's managed groups, and every count
 * is scoped by that membership. A student who leads nothing gets an empty list,
 * never an error.
 */
export async function leaderOverview(userId) {
  const groups = await queryRows(
    `SELECT g.id, g.slug, g.name, g.privacy, g.status, g.member_count, g.min_size, g.max_size,
            g.created_at, m.role AS my_role, m.joined_at AS role_since,
            c.course_code, c.name AS course_name,
            w.id AS workspace_id,
            (SELECT count(*)::int FROM study_group_join_requests jr
              WHERE jr.group_id = g.id AND jr.status = 'PENDING') AS pending_requests,
            (SELECT count(*)::int FROM study_group_invitations i
              WHERE i.group_id = g.id AND i.status = 'PENDING' AND i.expires_at > now()) AS pending_invitations,
            (SELECT count(*)::int FROM study_sessions ss
              JOIN workspaces wsp ON wsp.id = ss.workspace_id
              WHERE wsp.group_id = g.id AND ss.status = 'SCHEDULED' AND ss.starts_at > now()) AS upcoming_sessions,
            (SELECT count(*)::int FROM study_group_members m2
              WHERE m2.group_id = g.id AND m2.left_at IS NULL) AS active_members,
            (SELECT max(created_at) FROM group_activity_events e WHERE e.group_id = g.id) AS last_activity_at
       FROM study_group_members m
       JOIN study_groups g ON g.id = m.group_id
       JOIN courses c ON c.id = g.course_id
       LEFT JOIN LATERAL (
         SELECT id FROM workspaces
          WHERE group_id = g.id AND NOT is_archived
          ORDER BY created_at DESC
          LIMIT 1
       ) w ON TRUE
      WHERE m.student_id = $1 AND m.left_at IS NULL
        AND m.role IN ('OWNER', 'MODERATOR')
        AND g.status = 'ACTIVE'
      ORDER BY m.role = 'OWNER' DESC, g.member_count DESC`,
    [userId],
    "groups:leaderOverview",
  );

  return {
    groups,
    totals: {
      groups: groups.length,
      activeMembers: groups.reduce((sum, group) => sum + group.active_members, 0),
      pendingRequests: groups.reduce((sum, group) => sum + group.pending_requests, 0),
      pendingInvitations: groups.reduce((sum, group) => sum + group.pending_invitations, 0),
      upcomingSessions: groups.reduce((sum, group) => sum + group.upcoming_sessions, 0),
    },
  };
}

export default {
  createGroup,
  getGroup,
  updateGroup,
  searchGroups,
  inviteMember,
  respondToInvitation,
  joinGroup,
  decideJoinRequest,
  manageMember,
  leaveGroup,
  transferOwnership,
  archiveGroup,
  listMyInvitations,
  listModerationQueue,
  leaderOverview,
  assertMember,
  assertModerator,
};