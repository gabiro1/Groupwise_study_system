import { Router } from "express";
import { asyncHandler, ok, created } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireStudent, requireAuth } from "../middleware/auth.js";
import { writeLimiter, messageLimiter } from "../middleware/rateLimit.js";
import * as partners from "../services/partner.service.js";
import {
  partnerInviteSchema,
  partnerRespondSchema,
  partnerMessageSchema,
  partnerMessageQuerySchema,
  partnerRespondParamSchema,
  partnerRevokeParamSchema,
  partnerConversationParamSchema,
} from "../lib/schemas.js";

const router = Router();

/**
 * Study-partner routes.
 *
 * Direct messaging only happens between students who have accepted each other,
 * and every message route resolves participation from the conversation members
 * table. No route here accepts a student id in the body, so a caller cannot
 * message someone who has not accepted them by editing a payload.
 */

// The role guard depends on `req.user`, so `requireAuth` must run first.
router.use(requireAuth);
router.use(requireStudent);

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** GET /api/partners/invitations — incoming and outgoing requests. */
router.get(
  "/invitations",
  asyncHandler(async (req, res) => {
    const result = await partners.listInvitations(req.user.id);
    return ok(res, result);
  }),
);

/** POST /api/partners/invitations — ask another student to be a study partner. */
router.post(
  "/invitations",
  writeLimiter,
  validate({ body: partnerInviteSchema }),
  asyncHandler(async (req, res) => {
    const result = await partners.createInvitation(req.user.id, req.body);
    return created(res, result);
  }),
);

/** POST /api/partners/invitations/:invitationId/respond — accept or decline. */
router.post(
  "/invitations/:invitationId/respond",
  writeLimiter,
  validate({ params: partnerRespondParamSchema, body: partnerRespondSchema }),
  asyncHandler(async (req, res) => {
    const result = await partners.respondToInvitation(
      req.user.id,
      req.params.invitationId,
      req.body.response,
    );
    return ok(res, result);
  }),
);

/** POST /api/partners/invitations/:invitationId/revoke — withdraw an open offer. */
router.post(
  "/invitations/:invitationId/revoke",
  writeLimiter,
  validate({ params: partnerRevokeParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await partners.revokeInvitation(req.user.id, req.params.invitationId);
    return ok(res, result);
  }),
);

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

/** GET /api/partners/conversations — threads with accepted partners. */
router.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const result = await partners.listConversations(req.user.id);
    return ok(res, result);
  }),
);

/** GET /api/partners/conversations/:conversationId/messages */
router.get(
  "/conversations/:conversationId/messages",
  validate({ params: partnerConversationParamSchema, query: partnerMessageQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await partners.listMessages(
      req.user.id,
      req.params.conversationId,
      { before: req.query.before, limit: req.query.limit },
    );
    return ok(res, result);
  }),
);

/** POST /api/partners/conversations/:conversationId/messages */
router.post(
  "/conversations/:conversationId/messages",
  messageLimiter,
  validate({ params: partnerConversationParamSchema, body: partnerMessageSchema }),
  asyncHandler(async (req, res) => {
    const result = await partners.sendMessage(req.user.id, req.params.conversationId, req.body);
    return created(res, result);
  }),
);

/** POST /api/partners/conversations/:conversationId/read — mark read to now. */
router.post(
  "/conversations/:conversationId/read",
  writeLimiter,
  validate({ params: partnerConversationParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await partners.markRead(req.user.id, req.params.conversationId);
    return ok(res, result);
  }),
);

/** GET /api/partners/unread-count — badge for the messages nav item. */
router.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const count = await partners.unreadCount(req.user.id);
    return ok(res, { count });
  }),
);

export default router;