import { queryOne, queryRows, withTransaction } from "../../config/db.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { recordAudit, AUDIT } from "../../lib/audit.js";

/**
 * Conversation storage / retrieval.
 *
 * The AI contract in this system is: *the model never decides anything* — it only
 * turns natural language into structured ids it has been given. But conversations
 * (chat history, messages) are still stored so a student can review what the
 * assistant said and so an admin can audit a specific answer.
 *
 * Visibility is enforced in SQL: a conversation is only returned to someone who
 * owns it or is a member of the group it belongs to. Nothing is joined to client
 * input — `studentId` is the only actor.
 */
const CONVERSATION_LIMIT = 50;
const MESSAGE_LIMIT = 100;

export const CONVERSATION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
  DELETED: "DELETED",
});

export const CONVERSATION_KIND = Object.freeze({
  STUDY: "STUDY",
  GROUP: "GROUP",
  SINGLE: "SINGLE",
  QUIZ: "QUIZ",
});

/** Chat message roles. `SYSTEM` is never persisted — it is a per-request prompt. */
export const MESSAGE_ROLE = Object.freeze({
  USER: "USER",
  ASSISTANT: "ASSISTANT",
});

/**
 * Load a conversation the caller may see, or throw `NotFoundError`.
 *
 * Access is owner-or-group-member, resolved entirely in SQL so there is no window
 * in which a leaked id grants read access. A conversation that is soft-deleted is
 * indistinguishable from one that never existed.
 */
async function assertConversationAccess(studentId, conversationId) {
  const conversation = await queryOne(
    `SELECT c.id, c.student_id, c.group_id, c.title, c.kind, c.status,
            c.created_at, c.updated_at
       FROM ai_conversations c
      WHERE c.id = $1
        AND c.status <> 'DELETED'
        AND (
          c.student_id = $2
          OR (c.group_id IS NOT NULL AND EXISTS (
                SELECT 1
                  FROM study_group_members m
                 WHERE m.group_id = c.group_id
                   AND m.student_id = $2
                   AND m.left_at IS NULL
                   AND m.status = 'ACTIVE'
              ))
        )`,
    [conversationId, studentId],
    "ai:assertConversationAccess",
  );

  if (!conversation) throw new NotFoundError("That conversation");
  return conversation;
}

/**
 * Create a conversation. `groupId` is optional for single-student threads.
 *
 * The owner row and the participant row are written in one transaction: a
 * conversation with no participant would be invisible to the very student who
 * created it.
 */
export async function createConversation({
  studentId,
  groupId,
  title,
  kind = CONVERSATION_KIND.STUDY,
} = {}) {
  const conversation = await withTransaction(async (tx) => {
    const row = await tx.queryOne(
      `INSERT INTO ai_conversations (student_id, group_id, title, kind, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       RETURNING *`,
      [studentId, groupId ?? null, title ?? null, kind],
      "ai:createConversation",
    );

    await tx.query(
      `INSERT INTO ai_conversation_participants (conversation_id, student_id, role)
       VALUES ($1, $2, 'OWNER')`,
      [row.id, studentId],
      "ai:createParticipant",
    );

    return row;
  }, "ai:createConversation");

  await recordAudit({
    actor: { id: studentId },
    action: AUDIT.AI_CONVERSATION_CREATED,
    entityType: "ai_conversation",
    entityId: conversation.id,
    metadata: { groupId, title, kind },
  });

  return conversation;
}

/**
 * List conversations for a student, newest first.
 * `groupId` is an optional filter so groups only see their threads.
 */
export async function listConversations(studentId, groupId = null) {
  return queryRows(
    `SELECT c.id, c.group_id, c.title, c.kind, c.status, c.created_at, c.updated_at,
            COALESCE((
              SELECT COUNT(*)::int
                FROM ai_messages msg
               WHERE msg.conversation_id = c.id AND msg.deleted_at IS NULL
            ), 0) AS message_count
       FROM ai_conversations c
      WHERE c.status <> 'DELETED'
        AND (
          c.student_id = $1
          OR (c.group_id IS NOT NULL AND EXISTS (
                SELECT 1
                  FROM study_group_members m
                 WHERE m.group_id = c.group_id
                   AND m.student_id = $1
                   AND m.left_at IS NULL
                   AND m.status = 'ACTIVE'
              ))
        )
        AND ($2::uuid IS NULL OR c.group_id = $2)
      ORDER BY c.updated_at DESC NULLS LAST
      LIMIT $3`,
    [studentId, groupId ?? null, CONVERSATION_LIMIT],
    "ai:listConversations",
  );
}

/**
 * Load one conversation with its live message count. Throws `NotFoundError`
 * when the caller has no access.
 */
export async function getConversation(studentId, conversationId) {
  const conversation = await assertConversationAccess(studentId, conversationId);
  const stats = await queryOne(
    `SELECT COUNT(*)::int AS message_count
       FROM ai_messages
      WHERE conversation_id = $1 AND deleted_at IS NULL`,
    [conversationId],
    "ai:conversationStats",
  );
  return { ...conversation, message_count: stats?.message_count ?? 0 };
}

/**
 * Append a message to a conversation.
 *
 * Access is verified first so a message can only be written to a thread the
 * caller belongs to. The conversation's `updated_at` is bumped in the same
 * transaction so list ordering stays correct without a second round trip.
 */
export async function addMessage(studentId, conversationId, { role, content, meta = null } = {}) {
  const messageRole = role === MESSAGE_ROLE.USER || role === MESSAGE_ROLE.ASSISTANT
    ? role
    : null;
  if (!messageRole) {
    throw new AppError("That message role is not valid.", {
      status: 400,
      code: "INVALID_ROLE",
    });
  }
  if (typeof content !== "string" || !content.trim()) {
    throw new AppError("A message needs some content.", {
      status: 400,
      code: "INVALID_CONTENT",
    });
  }

  await assertConversationAccess(studentId, conversationId);

  const message = await withTransaction(async (tx) => {
    const row = await tx.queryOne(
      `INSERT INTO ai_messages (conversation_id, role, content, meta)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, conversation_id, role, content, meta, created_at`,
      [conversationId, messageRole, content.trim(), meta ? JSON.stringify(meta) : null],
      "ai:addMessage",
    );

    await tx.query(
      `UPDATE ai_conversations SET updated_at = now() WHERE id = $1`,
      [conversationId],
      "ai:touchConversation",
    );

    return row;
  }, "ai:addMessage");

  await recordAudit({
    actor: { id: studentId },
    action: AUDIT.AI_MESSAGE_ADDED,
    entityType: "ai_message",
    entityId: message.id,
    metadata: { conversationId, role: messageRole },
  });

  return message;
}

/**
 * Messages in a conversation the caller belongs to, oldest page first.
 *
 * Keyset pagination on `created_at` (via the `before` cursor) keeps deep
 * history cheap: OFFSET would rescan every row above the page. The page is
 * returned oldest-to-newest so the client renders it directly.
 */
export async function listMessages(studentId, conversationId, { before, limit = MESSAGE_LIMIT } = {}) {
  await assertConversationAccess(studentId, conversationId);

  const params = [conversationId];
  const clauses = ["m.conversation_id = $1", "m.deleted_at IS NULL"];
  if (before) {
    params.push(before);
    clauses.push(`m.created_at < $${params.length}`);
  }
  params.push(limit);

  const rows = await queryRows(
    `SELECT m.id, m.role, m.content, m.meta, m.created_at
       FROM ai_messages m
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${params.length}`,
    params,
    "ai:listMessages",
  );

  return rows.reverse();
}

/**
 * Archive a conversation (soft state change, not a delete).
 */
export async function archiveConversation(studentId, conversationId) {
  await assertConversationAccess(studentId, conversationId);
  return queryOne(
    `UPDATE ai_conversations SET status = 'ARCHIVED', updated_at = now()
      WHERE id = $1
      RETURNING id, status, updated_at`,
    [conversationId],
    "ai:archiveConversation",
  );
}

/**
 * Soft-delete a conversation. The row is kept for audit but hidden from every
 * read path, which filters on `status <> 'DELETED'`.
 */
export async function deleteConversation(studentId, conversationId) {
  await assertConversationAccess(studentId, conversationId);
  return queryOne(
    `UPDATE ai_conversations SET status = 'DELETED', updated_at = now()
      WHERE id = $1
      RETURNING id, status`,
    [conversationId],
    "ai:deleteConversation",
  );
}

export default {
  CONVERSATION_STATUS,
  CONVERSATION_KIND,
  MESSAGE_ROLE,
  createConversation,
  listConversations,
  getConversation,
  addMessage,
  listMessages,
  archiveConversation,
  deleteConversation,
};

