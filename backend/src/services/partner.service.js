import { query, queryRows, queryOne, withTransaction } from "../config/db.js";
import { AppError, ConflictError, NotFoundError } from "../lib/errors.js";
import { PARTNER_CONNECTION_STATUS, NOTIFICATION_TYPE } from "../config/constants.js";
import { notify } from "../lib/notifications.js";

/**
 * Study-partner connections and direct messaging.
 *
 * Two rules are load-bearing here.
 *
 * 1. **A connection must be accepted before any message can be sent.** The
 *    accept step creates a two-member conversation, and every message route
 *    re-derives participation from `direct_conversation_members` — never from
 *    ids in the request body. A student cannot message someone who has not
 *    accepted them, and a guessed conversation id 404s for a non-participant
 *    rather than leaking its existence.
 * 2. **Connection history accumulates.** Declined and revoked offers stay as
 *    rows, so the UI can distinguish "never asked" from "declined, leave them
 *    alone". The partial unique index on PENDING rows is what keeps at most one
 *    open offer per ordered pair.
 */

/** Only one direction of an offer may be open at a time. */
export const PARTNER_ACTIONS = Object.freeze({
  ACCEPT: "ACCEPT",
  DECLINE: "DECLINE",
  REVOKE: "REVOKE",
});

/** How many unanswered outbound offers one student may keep open. */
export const MAX_PENDING_OUTBOUND = 20;

/**
 * Pure state machine for a connection row.
 *
 * Only a PENDING row can move. This is exported so the transition rules are
 * testable without a database, and so the route layer can reject an invalid
 * action descriptively rather than letting the UPDATE silently affect nothing.
 */
export function nextConnectionStatus(status, action) {
  if (status !== PARTNER_CONNECTION_STATUS.PENDING) return null;
  if (action === PARTNER_ACTIONS.ACCEPT) return PARTNER_CONNECTION_STATUS.ACCEPTED;
  if (action === PARTNER_ACTIONS.DECLINE) return PARTNER_CONNECTION_STATUS.DECLINED;
  if (action === PARTNER_ACTIONS.REVOKE) return PARTNER_CONNECTION_STATUS.REVOKED;
  return null;
}

/**
 * A student is reachable only if their profile would be visible to the
 * requester. Reusing the discovery layer keeps the invitation path and the
 * browsing path from drifting apart: a profile hidden from you 404s here exactly
 * as it does on the profile endpoint.
 */
async function assertRecipientReachable(requesterId, recipientId) {
  const { getStudentProfile } = await import("./discovery.service.js");
  try {
    await getStudentProfile(requesterId, recipientId);
  } catch {
    throw new NotFoundError("That student");
  }
}

/** Send a study-partner invitation. */
export async function createInvitation(requesterId, { recipientId, message }) {
  if (recipientId === requesterId) {
    throw new AppError("You cannot invite yourself to be a study partner.", {
      status: 422,
      code: "SELF_INVITE",
    });
  }

  await assertRecipientReachable(requesterId, recipientId);

  const existing = await queryOne(
    `SELECT pc.id, pc.status, pc.requester_id, pc.recipient_id
       FROM partner_connections pc
      WHERE pc.status = 'PENDING'
        AND ((pc.requester_id = $1 AND pc.recipient_id = $2)
          OR (pc.requester_id = $2 AND pc.recipient_id = $1))
      LIMIT 1`,
    [requesterId, recipientId],
    "partners:existingPending",
  );

  if (existing) {
    if (existing.requester_id === requesterId) {
      throw new ConflictError("You have already invited this student to be a study partner.");
    }
    throw new ConflictError("This student has already invited you. Accept their request instead.");
  }

  const connected = await queryOne(
    `SELECT 1 FROM partner_connections
      WHERE status = 'ACCEPTED'
        AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))`,
    [requesterId, recipientId],
    "partners:existingAccepted",
  );
  if (connected) {
    throw new ConflictError("You are already study partners with this student.");
  }

  const open = await queryOne(
    `SELECT count(*)::int AS count FROM partner_connections
      WHERE requester_id = $1 AND status = 'PENDING'`,
    [requesterId],
    "partners:pendingCount",
  );
  if ((open?.count ?? 0) >= MAX_PENDING_OUTBOUND) {
    throw new ConflictError("You have too many unanswered partner requests. Wait for a reply before sending more.");
  }

  const invitation = await queryOne(
    `INSERT INTO partner_connections (requester_id, recipient_id, status, message)
     VALUES ($1, $2, 'PENDING', $3)
     RETURNING id, requester_id, recipient_id, status, message, requested_at`,
    [requesterId, recipientId, message?.trim() || null],
    "partners:create",
  );

  const name = await requesterName(requesterId);

  await notify({
    userId: recipientId,
    type: NOTIFICATION_TYPE.PARTNER_INVITATION,
    title: `${name} wants to study with you`,
    body: message ? `“${message}”` : undefined,
    link: "/dashboard/partners",
    metadata: { connectionId: invitation.id },
  });

  return { invitation };
}

/** Fetch requester display name without joining tables in the caller's path. */
async function requesterName(userId) {
  const row = await queryOne(
    "SELECT first_name, last_name FROM users WHERE id = $1 AND deleted_at IS NULL",
    [userId],
    "partners:requesterName",
  );
  return [row?.first_name, row?.last_name].filter(Boolean).join(" ") || "Someone";
}

/** Incoming and outgoing invitations, newest first. */
export async function listInvitations(userId) {
  const [incoming, outgoing] = await Promise.all([
    queryRows(
      `SELECT pc.id, pc.status, pc.message, pc.requested_at, pc.responded_at,
              u.id AS requester_id, u.first_name AS requester_first_name,
              u.last_name AS requester_last_name, u.avatar_url AS requester_avatar_url
         FROM partner_connections pc
         JOIN users u ON u.id = pc.requester_id
         WHERE pc.recipient_id = $1 AND pc.status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED')
         ORDER BY pc.responded_at DESC NULLS FIRST, pc.requested_at DESC
         LIMIT 50`,
      [userId],
      "partners:incoming",
    ),
    queryRows(
      `SELECT pc.id, pc.status, pc.message, pc.requested_at, pc.responded_at,
              u.id AS recipient_id, u.first_name AS recipient_first_name,
              u.last_name AS recipient_last_name, u.avatar_url AS recipient_avatar_url
         FROM partner_connections pc
         JOIN users u ON u.id = pc.recipient_id
        WHERE pc.requester_id = $1
        ORDER BY pc.responded_at DESC NULLS FIRST, pc.requested_at DESC
        LIMIT 50`,
      [userId],
      "partners:outgoing",
    ),
  ]);

  return { incoming, outgoing };
}

/**
 * Accept or decline an invitation.
 *
 * Accepting creates the direct conversation inside the same transaction as the
 * status change, so there is no window where a connection is ACCEPTED but has no
 * thread to message into.
 */
export async function respondToInvitation(userId, invitationId, response) {
  const invitation = await queryOne(
    `SELECT pc.id, pc.status, pc.requester_id, pc.recipient_id
       FROM partner_connections pc
      WHERE pc.id = $1 AND pc.recipient_id = $2`,
    [invitationId, userId],
    "partners:loadForRespond",
  );
  if (!invitation) throw new NotFoundError("That partner request");

  const next = nextConnectionStatus(invitation.status, response);
  if (!next) {
    throw new ConflictError("That partner request has already been answered.");
  }

  if (response === PARTNER_ACTIONS.ACCEPT) {
    const accepted = await withTransaction(async (tx) => {
      const updated = await tx.queryOne(
        `UPDATE partner_connections
            SET status = 'ACCEPTED', responded_at = now()
          WHERE id = $1 AND status = 'PENDING'
          RETURNING id, requester_id, recipient_id, status`,
        [invitationId],
        "partners:accept",
      );
      if (!updated) return null;

      // Exactly two members, mirroring the two people in this connection.
      const conversation = await tx.queryOne(
        `INSERT INTO direct_conversations (created_by) VALUES ($1) RETURNING id`,
        [userId],
        "partners:createConversation",
      );
      await tx.query(
        `INSERT INTO direct_conversation_members (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)`,
        [conversation.id, updated.requester_id, updated.recipient_id],
        "partners:addMembers",
      );
      return { ...updated, conversationId: conversation.id };
    }, "partners:acceptTransaction");

    if (!accepted) throw new ConflictError("That partner request has already been answered.");

    await notify({
      userId: invitation.requester_id,
      type: NOTIFICATION_TYPE.PARTNER_ACCEPTED,
      title: "Your study partner request was accepted",
      body: "You can now message each other from Messages.",
      link: "/dashboard/messages",
      metadata: { connectionId: invitationId },
    });

    return { connection: accepted, conversationId: accepted.conversationId };
  }

  const declined = await queryOne(
    `UPDATE partner_connections SET status = 'DECLINED', responded_at = now()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, status, requester_id, recipient_id`,
    [invitationId],
    "partners:decline",
  );
  if (!declined) throw new ConflictError("That partner request has already been answered.");

  return { connection: declined, conversationId: null };
}

/** Revoke an outbound invitation that is still pending. */
export async function revokeInvitation(userId, invitationId) {
  const invitation = await queryOne(
    "SELECT status FROM partner_connections WHERE id = $1 AND requester_id = $2",
    [invitationId, userId],
    "partners:loadForRevoke",
  );
  if (!invitation) throw new NotFoundError("That partner request");
  if (nextConnectionStatus(invitation.status, PARTNER_ACTIONS.REVOKE) === null) {
    throw new ConflictError("Only a pending request can be revoked.");
  }

  const revoked = await queryOne(
    `UPDATE partner_connections SET status = 'REVOKED'
      WHERE id = $1 AND requester_id = $2 AND status = 'PENDING'
      RETURNING id, status`,
    [invitationId, userId],
    "partners:revoke",
  );
  if (!revoked) throw new ConflictError("That partner request has already been answered.");

  return { connection: revoked };
}

/** The caller must be one of the two members of this conversation. */
export async function assertConversationParticipant(userId, conversationId) {
  const member = await queryOne(
    `SELECT user_id, last_read_at FROM direct_conversation_members
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
    "partners:participant",
  );
  if (!member) throw new NotFoundError("That conversation");
  return member;
}

/** The caller's conversations, newest activity first, with the peer attached. */
export async function listConversations(userId) {
  const rows = await queryRows(
    `SELECT c.id AS conversation_id, c.created_at, c.last_message_at,
            u.id AS peer_id, u.first_name AS peer_first_name, u.last_name AS peer_last_name,
            u.avatar_url AS peer_avatar_url,
            lm.body AS last_message_body, lm.sender_id AS last_message_sender_id,
            lm.created_at AS last_message_at,
            (SELECT count(*)::int FROM direct_messages dm
              WHERE dm.conversation_id = c.id AND dm.sender_id <> $1 AND dm.deleted_at IS NULL
                AND dm.created_at > COALESCE(me.last_read_at, to_timestamp(0))) AS unread_count
       FROM direct_conversation_members me
       JOIN direct_conversations c ON c.id = me.conversation_id
       JOIN direct_conversation_members peer ON peer.conversation_id = c.id AND peer.user_id <> $1
       JOIN users u ON u.id = peer.user_id
       LEFT JOIN LATERAL (
         SELECT body, sender_id, created_at FROM direct_messages dm
          WHERE dm.conversation_id = c.id AND dm.deleted_at IS NULL
          ORDER BY dm.created_at DESC, dm.id DESC
          LIMIT 1
       ) lm ON TRUE
      WHERE me.user_id = $1
      ORDER BY c.last_message_at DESC`,
    [userId],
    "partners:listConversations",
  );

  return {
    conversations: rows.map((row) => ({
      conversationId: row.conversation_id,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      peer: {
        id: row.peer_id,
        firstName: row.peer_first_name,
        lastName: row.peer_last_name,
        avatarUrl: row.peer_avatar_url,
      },
      lastMessage: row.last_message_body
        ? {
            body: row.last_message_body,
            senderId: row.last_message_sender_id,
            createdAt: row.last_message_at,
          }
        : null,
      unreadCount: row.unread_count,
    })),
  };
}

/** Messages in a conversation the caller participates in, newest page reversed. */
export async function listMessages(userId, conversationId, { before, limit = 30 } = {}) {
  await assertConversationParticipant(userId, conversationId);

  const params = [conversationId, userId];
  const clauses = ["m.conversation_id = $1", "m.deleted_at IS NULL"];
  if (before) {
    params.push(before);
    clauses.push(`m.created_at < $${params.length}`);
  }
  params.push(limit);

  const rows = await queryRows(
    `SELECT m.id, m.body, m.client_id, m.created_at,
            u.id AS sender_id, u.first_name AS sender_first_name,
            u.last_name AS sender_last_name, u.avatar_url AS sender_avatar_url
       FROM direct_messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${params.length}`,
    params,
    "partners:listMessages",
  );

  return { messages: rows.reverse().map((row) => ({
      id: row.id,
      body: row.body,
      clientId: row.client_id,
      createdAt: row.created_at,
      sender: row.sender_id
        ? { id: row.sender_id, firstName: row.sender_first_name, lastName: row.sender_last_name, avatarUrl: row.sender_avatar_url }
        : null,
    })) };
}

/**
 * Send a direct message.
 *
 * A client-generated id makes a retried POST idempotent: on a conflict the
 * original row is returned instead of a duplicate insert.
 */
export async function sendMessage(userId, conversationId, { body, clientId }) {
  await assertConversationParticipant(userId, conversationId);

  const message = await queryOne(
    `INSERT INTO direct_messages (conversation_id, sender_id, body, client_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
     RETURNING id, body, client_id, created_at`,
    [conversationId, userId, body.trim(), clientId ?? null],
    "partners:sendMessage",
  );
  if (!message) {
    // A retried send: return the original message so the client reconciles.
    const original = await queryOne(
      `SELECT id, body, client_id, created_at FROM direct_messages
        WHERE sender_id = $1 AND client_id = $2 AND conversation_id = $3`,
      [userId, clientId, conversationId],
      "partners:resendLookup",
    );
    if (!original) throw new ConflictError("That message could not be sent. Please try again.");
    return { message: original, senderId: userId, idempotentReplay: true };
  }

  await query(
    "UPDATE direct_conversations SET last_message_at = now() WHERE id = $1",
    [conversationId],
    "partners:touchConversation",
  );

  const peerId = await queryOne(
    `SELECT user_id FROM direct_conversation_members
      WHERE conversation_id = $1 AND user_id <> $2`,
    [conversationId, userId],
    "partners:notifyPeer",
  );

  if (peerId?.user_id) {
    const name = await requesterName(userId);
    await notify({
      userId: peerId.user_id,
      type: NOTIFICATION_TYPE.DIRECT_MESSAGE,
      title: `${name} sent you a message`,
      body: body.trim().slice(0, 140),
      link: "/dashboard/messages",
      metadata: { scopeId: conversationId, conversationId },
    });
  }

  return { message, senderId: userId, idempotentReplay: false };
}

/** Everything in this conversation, marked read up to now. */
export async function markRead(userId, conversationId) {
  await assertConversationParticipant(userId, conversationId);
  const row = await queryOne(
    `UPDATE direct_conversation_members SET last_read_at = now()
      WHERE conversation_id = $1 AND user_id = $2
      RETURNING conversation_id, user_id, last_read_at`,
    [conversationId, userId],
    "partners:markRead",
  );
  return { conversationId, readThrough: row?.last_read_at ?? null };
}

/** Total unread direct messages across all the caller's conversations. */
export async function unreadCount(userId) {
  const row = await queryOne(
    `SELECT count(*)::int AS count
       FROM direct_conversation_members me
       JOIN direct_messages dm ON dm.conversation_id = me.conversation_id
      WHERE me.user_id = $1 AND dm.sender_id <> $1 AND dm.deleted_at IS NULL
        AND dm.created_at > COALESCE(me.last_read_at, to_timestamp(0))`,
    [userId],
    "partners:unreadCount",
  );
  return row?.count ?? 0;
}

export default {
  createInvitation,
  listInvitations,
  respondToInvitation,
  revokeInvitation,
  listConversations,
  listMessages,
  sendMessage,
  markRead,
  unreadCount,
  nextConnectionStatus,
  PARTNER_ACTIONS,
  MAX_PENDING_OUTBOUND,
};