import { Router } from "express";
import { asyncHandler, ok, created, accepted } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireStudent, requireAuth } from "../middleware/auth.js";
import { writeLimiter, searchLimiter, uploadLimiter } from "../middleware/rateLimit.js";
import { resourceUpload } from "../middleware/uploads.js";
import * as groups from "../services/group.service.js";
import * as leader from "../services/leader.service.js";
import * as collaboration from "../services/groupCollaboration.service.js";
import {
  createGroupSchema,
  updateGroupSchema,
  groupSearchSchema,
  groupIdParamSchema,
  inviteMemberSchema,
  respondInvitationSchema,
  joinRequestSchema,
  decideJoinRequestSchema,
  manageMemberSchema,
  leaderGroupFilterSchema,
  leaderSessionQuerySchema,
  cancelInvitationParamSchema,
  announcementSchema,
  analyticsQuerySchema,
  recommendMembersQuerySchema,
  createPlanSchema,
  updatePlanSchema,
  createTaskSchema,
  updateTaskSchema,
  taskQuerySchema,
  taskCommentSchema,
  createSessionSchema,
  updateSessionSchema,
  rsvpSchema,
  sessionQuerySchema,
  sendMessageSchema,
  messageQuerySchema,
  createResourceSchema,
  resourceQuerySchema,
  groupFeedbackSchema,
  topicStatusSchema,
  optionalBooleanFromQuery,
  z,
} from "../lib/schemas.js";

const router = Router();

// Every route below is restricted to signed-in students. The role guard in
// `requireStudent` depends on `req.user`, so `requireAuth` must run first.
router.use(requireAuth);

/**
 * Study group routes.
 *
 * Authorisation is resolved from `req.user.id` on every handler. No route reads a
 * student id from the request body, so a caller cannot act as someone else by
 * editing a payload.
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** GET /api/groups — browse and search groups. */
router.get(
  "/",
  requireStudent,
  searchLimiter,
  validate({ query: groupSearchSchema }),
  asyncHandler(async (req, res) => {
    const result = await groups.searchGroups(req.user.id, {
      ...req.query,
      limit: req.query.limit ?? 20,
      offset: 0,
    });
    return ok(res, result);
  }),
);

/**
 * GET /api/groups/mine
 *
 * The caller's own groups, not the public catalogue. Declared before `/:groupId`
 * so the literal segment is matched rather than parsed as a UUID.
 */
router.get(
  "/mine",
  requireStudent,
  validate({
    query: z.object({ includeArchived: optionalBooleanFromQuery.default(false) }),
  }),
  asyncHandler(async (req, res) => {
    const result = await groups.listMyGroups(req.user.id, req.query);
    return ok(res, result);
  }),
);

/** GET /api/groups/invitations — invitations and requests for the caller. */
router.get(
  "/invitations",
  requireStudent,
  asyncHandler(async (req, res) => {
    const result = await groups.listMyInvitations(req.user.id);
    return ok(res, result);
  }),
);

/**
 * GET /api/groups/leader/overview
 *
 * The leadership dashboard: every group the caller owns or moderates, with the
 * moderation and scheduling counts that decide where attention goes first. An
 * empty list is the correct response for a student who leads nothing.
 */
router.get(
  "/leader/overview",
  requireStudent,
  asyncHandler(async (req, res) => {
    const result = await groups.leaderOverview(req.user.id);
    return ok(res, result);
  }),
);

/** GET /api/study-groups/leader/requests — pending join requests across managed groups. */
router.get(
  "/leader/requests",
  requireStudent,
  validate({ query: leaderGroupFilterSchema }),
  asyncHandler(async (req, res) => {
    const result = await leader.listPendingRequests(req.user.id, req.query);
    return ok(res, result);
  }),
);

/** GET /api/study-groups/leader/invitations — pending invitations sent by managed groups. */
router.get(
  "/leader/invitations",
  requireStudent,
  validate({ query: leaderGroupFilterSchema }),
  asyncHandler(async (req, res) => {
    const result = await leader.listPendingInvitations(req.user.id, req.query);
    return ok(res, result);
  }),
);

/** GET /api/study-groups/leader/sessions — sessions across managed groups. */
router.get(
  "/leader/sessions",
  requireStudent,
  validate({ query: leaderSessionQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await leader.listLeaderSessions(req.user.id, req.query);
    return ok(res, result);
  }),
);

// ---------------------------------------------------------------------------
// Single group
// ---------------------------------------------------------------------------

/**
 * POST /api/groups/invitations/:invitationId/respond
 *
 * Declined and expired invitations never block a re-invite: `respondToInvitation`
 * closes the current row, and the partial unique index on PENDING rows means the
 * next invitation is a new row rather than a resurrection of a stale one.
 *
 * Declining requires no reason. Making someone justify a "no" is how people stop
 * declining things.
 */
router.post(
  "/invitations/:invitationId/respond",
  requireStudent,
  writeLimiter,
  validate({
    params: z.object({ invitationId: z.string().uuid() }),
    body: respondInvitationSchema,
  }),
  asyncHandler(async (req, res) => {
    const result = await groups.respondToInvitation(
      req.user.id,
      req.params.invitationId,
      req.body.response,
    );
    return ok(res, result);
  }),
);

/** GET /api/groups/:groupId — group detail, tailored to the caller's membership. */
router.get(
  "/:groupId",
  requireStudent,
  validate({ params: groupIdParamSchema }),
  asyncHandler(async (req, res) => {
    const group = await groups.getGroup(req.params.groupId, req.user.id);
    return ok(res, { group });
  }),
);

// ---------------------------------------------------------------------------
// Group collaboration
// ---------------------------------------------------------------------------

/** GET /api/study-groups/:groupId/overview */
router.get(
  "/:groupId/overview",
  requireStudent,
  validate({ params: groupIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.getOverview(req.params.groupId, req.user.id);
    return ok(res, result);
  }),
);

/** Plans and their ordered topic coverage. */
router.get(
  "/:groupId/plans",
  requireStudent,
  validate({ params: groupIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.listPlans(req.params.groupId, req.user.id);
    return ok(res, result);
  }),
);

router.post(
  "/:groupId/plans",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: createPlanSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.createPlan(req.params.groupId, req.user.id, req.body);
    return created(res, result);
  }),
);

router.get(
  "/:groupId/plans/:planId",
  requireStudent,
  validate({ params: groupIdParamSchema.extend({ planId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.getPlan(req.params.groupId, req.user.id, req.params.planId);
    return ok(res, result);
  }),
);

router.get(
  "/:groupId/plans/:planId/topics",
  requireStudent,
  validate({ params: groupIdParamSchema.extend({ planId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.getPlanTopics(req.params.groupId, req.user.id, req.params.planId);
    return ok(res, result);
  }),
);

router.patch(
  "/:groupId/plans/:planId",
  requireStudent,
  writeLimiter,
  validate({
    params: groupIdParamSchema.extend({ planId: z.string().uuid() }),
    body: updatePlanSchema,
  }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.updatePlan(
      req.params.groupId,
      req.user.id,
      req.params.planId,
      req.body,
    );
    return ok(res, result);
  }),
);

/** Tasks and task comments. */
router.get(
  "/:groupId/tasks",
  requireStudent,
  validate({ params: groupIdParamSchema, query: taskQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.listTasks(req.params.groupId, req.user.id, req.query);
    return ok(res, result);
  }),
);

router.post(
  "/:groupId/tasks",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: createTaskSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.createTask(req.params.groupId, req.user.id, req.body);
    return created(res, result);
  }),
);

router.patch(
  "/:groupId/tasks/:taskId",
  requireStudent,
  writeLimiter,
  validate({
    params: groupIdParamSchema.extend({ taskId: z.string().uuid() }),
    body: updateTaskSchema,
  }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.updateTask(
      req.params.groupId,
      req.user.id,
      req.params.taskId,
      req.body,
    );
    return ok(res, result);
  }),
);

router.post(
  "/:groupId/tasks/:taskId/comments",
  requireStudent,
  writeLimiter,
  validate({
    params: groupIdParamSchema.extend({ taskId: z.string().uuid() }),
    body: taskCommentSchema,
  }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.addTaskComment(
      req.params.groupId,
      req.user.id,
      req.params.taskId,
      req.body.body,
    );
    return created(res, result);
  }),
);

/** Sessions, schedule updates and RSVP. */
router.get(
  "/:groupId/sessions",
  requireStudent,
  validate({ params: groupIdParamSchema, query: sessionQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.listSessions(req.params.groupId, req.user.id, req.query);
    return ok(res, result);
  }),
);

router.post(
  "/:groupId/sessions",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: createSessionSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.createSession(req.params.groupId, req.user.id, req.body);
    return created(res, result);
  }),
);

router.patch(
  "/:groupId/sessions/:sessionId",
  requireStudent,
  writeLimiter,
  validate({
    params: groupIdParamSchema.extend({ sessionId: z.string().uuid() }),
    body: updateSessionSchema,
  }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.updateSession(
      req.params.groupId,
      req.user.id,
      req.params.sessionId,
      req.body,
    );
    return ok(res, result);
  }),
);

router.post(
  "/:groupId/sessions/rsvp",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: rsvpSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.rsvp(
      req.params.groupId,
      req.user.id,
      req.body.sessionId,
      req.body,
    );
    return ok(res, result);
  }),
);

/** Group discussion uses the canonical group chat rows in messages. */
router.get(
  "/:groupId/messages",
  requireStudent,
  validate({ params: groupIdParamSchema, query: messageQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.listMessages(req.params.groupId, req.user.id, req.query);
    return ok(res, result);
  }),
);

router.post(
  "/:groupId/messages",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: sendMessageSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.sendMessage(req.params.groupId, req.user.id, req.body);
    return created(res, result);
  }),
);

/** Resources and authorised file downloads. */
router.get(
  "/:groupId/resources",
  requireStudent,
  validate({ params: groupIdParamSchema, query: resourceQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.listResources(req.params.groupId, req.user.id, req.query);
    return ok(res, result);
  }),
);

router.get(
  "/:groupId/resources/:resourceId/download",
  requireStudent,
  validate({ params: groupIdParamSchema.extend({ resourceId: z.string().uuid() }) }),
  asyncHandler(async (req, res, next) => {
    try {
      const file = await collaboration.getResourceFile(
        req.params.groupId,
        req.params.resourceId,
        req.user.id,
      );
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Length", String(file.size ?? 0));
      return res.download(file.filePath, file.filename, (error) => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
      return next(error);
    }
  }),
);

router.post(
  "/:groupId/resources",
  requireStudent,
  uploadLimiter,
  resourceUpload.single("file"),
  validate({ params: groupIdParamSchema, body: createResourceSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.createResource(
      req.params.groupId,
      req.user.id,
      { ...req.body, file: req.file },
    );
    return created(res, result);
  }),
);

/** Shared topic progress and end-of-group feedback. */
router.get(
  "/:groupId/progress",
  requireStudent,
  validate({ params: groupIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.getTopicProgress(req.params.groupId, req.user.id);
    return ok(res, result);
  }),
);

router.put(
  "/:groupId/progress",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: topicStatusSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.updateTopicProgress(
      req.params.groupId,
      req.user.id,
      req.body.topicId,
      req.body.status,
      req.body.confidence,
    );
    return ok(res, result);
  }),
);

router.get(
  "/:groupId/feedback",
  requireStudent,
  validate({ params: groupIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.getFeedbackSummary(req.params.groupId, req.user.id);
    return ok(res, result);
  }),
);

router.post(
  "/:groupId/feedback",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: groupFeedbackSchema }),
  asyncHandler(async (req, res) => {
    const result = await collaboration.submitFeedback(req.params.groupId, req.user.id, req.body);
    return created(res, result);
  }),
);

/** POST /api/groups */
router.post(
  "/",
  requireStudent,
  writeLimiter,
  validate({ body: createGroupSchema }),
  asyncHandler(async (req, res) => {
    const group = await groups.createGroup(req.user.id, req.body);
    return created(res, { group });
  }),
);

/** PATCH /api/groups/:groupId — moderator or owner, field-dependent. */
router.patch(
  "/:groupId",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: updateGroupSchema }),
  asyncHandler(async (req, res) => {
    const group = await groups.updateGroup(req.params.groupId, req.user.id, req.body);
    return ok(res, { group });
  }),
);

/** POST /api/groups/:groupId/join — join directly or request to join. */
router.post(
  "/:groupId/join",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: joinRequestSchema.partial() }),
  asyncHandler(async (req, res) => {
    const result = await groups.joinGroup(req.params.groupId, req.user.id, req.body);
    return accepted(res, result);
  }),
);

/** POST /api/groups/:groupId/leave */
router.post(
  "/:groupId/leave",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: z.object({ reason: z.string().trim().max(300).optional().nullable() }) }),
  asyncHandler(async (req, res) => {
    const result = await groups.leaveGroup(req.params.groupId, req.user.id, req.body.reason);
    return ok(res, result);
  }),
);

/** POST /api/groups/:groupId/archive — owner only. */
router.post(
  "/:groupId/archive",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await groups.archiveGroup(req.params.groupId, req.user.id);
    return ok(res, result);
  }),
);

/** POST /api/groups/:groupId/transfer-ownership — owner only. */
router.post(
  "/:groupId/transfer-ownership",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: z.object({ newOwnerId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const result = await groups.transferOwnership(req.params.groupId, req.user.id, req.body.newOwnerId);
    return ok(res, result);
  }),
);

// ---------------------------------------------------------------------------
// Membership management
// ---------------------------------------------------------------------------

/** POST /api/groups/:groupId/invite — invite a student, regardless of score. */
router.post(
  "/:groupId/invite",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: inviteMemberSchema }),
  asyncHandler(async (req, res) => {
    const invitation = await groups.inviteMember(req.params.groupId, req.user.id, req.body.inviteeId, {
      message: req.body.message,
      ignoreCompatibility: req.body.ignoreCompatibility,
    });
    return created(res, { invitation });
  }),
);

/** POST /api/groups/:groupId/members/:studentId — promote, demote or remove. */
router.post(
  "/:groupId/members/:studentId",
  requireStudent,
  writeLimiter,
  validate({
    params: groupIdParamSchema.extend({ studentId: z.string().uuid() }),
    body: manageMemberSchema.pick({ action: true }),
  }),
  asyncHandler(async (req, res) => {
    const result = await groups.manageMember(
      req.params.groupId,
      req.user.id,
      req.params.studentId,
      req.body.action,
    );
    return ok(res, result);
  }),
);

/** GET /api/groups/:groupId/moderation — pending invitations and requests. */
router.get(
  "/:groupId/moderation",
  requireStudent,
  validate({ params: groupIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await groups.listModerationQueue(req.params.groupId, req.user.id);
    return ok(res, result);
  }),
);

/** POST /api/groups/:groupId/requests/:requestId/decide */
router.post(
  "/:groupId/requests/:requestId/decide",
  requireStudent,
  writeLimiter,
  validate({
    params: groupIdParamSchema.extend({ requestId: z.string().uuid() }),
    body: decideJoinRequestSchema.pick({ decision: true, note: true }),
  }),
  asyncHandler(async (req, res) => {
    const result = await groups.decideJoinRequest(
      req.user.id,
      req.params.requestId,
      req.body.decision,
      req.body.note,
      { expectedGroupId: req.params.groupId },
    );
    return ok(res, result);
  }),
);

// ---------------------------------------------------------------------------
// Leader tools
// ---------------------------------------------------------------------------

/** POST /api/study-groups/:groupId/invitations/:invitationId/cancel */
router.post(
  "/:groupId/invitations/:invitationId/cancel",
  requireStudent,
  writeLimiter,
  validate({ params: cancelInvitationParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await leader.cancelInvitation(
      req.params.groupId,
      req.user.id,
      req.params.invitationId,
    );
    return ok(res, result);
  }),
);

/** GET /api/study-groups/:groupId/analytics */
router.get(
  "/:groupId/analytics",
  requireStudent,
  validate({ params: groupIdParamSchema, query: analyticsQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await leader.groupAnalytics(req.params.groupId, req.user.id, req.query);
    return ok(res, result);
  }),
);

/** GET /api/study-groups/:groupId/recommended-members */
router.get(
  "/:groupId/recommended-members",
  requireStudent,
  searchLimiter,
  validate({ params: groupIdParamSchema, query: recommendMembersQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await leader.recommendMembers(req.params.groupId, req.user.id, req.query);
    return ok(res, result);
  }),
);

/** POST /api/study-groups/:groupId/announcement */
router.post(
  "/:groupId/announcement",
  requireStudent,
  writeLimiter,
  validate({ params: groupIdParamSchema, body: announcementSchema }),
  asyncHandler(async (req, res) => {
    const result = await leader.postAnnouncement(req.params.groupId, req.user.id, req.body);
    return created(res, result);
  }),
);

export default router;
