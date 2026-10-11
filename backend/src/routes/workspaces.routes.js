import { Router } from "express";
import { asyncHandler, ok, created, noContent } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireStudent, requireAuth } from "../middleware/auth.js";
import { writeLimiter } from "../middleware/rateLimit.js";
import * as workspace from "../services/workspace.service.js";
import {
  workspaceIdParamSchema,
  createWorkspaceSchema,
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
  z,
} from "../lib/schemas.js";

const router = Router();

/**
 * Workspace routes — plans, tasks, sessions, chat and progress for a study group.
 *
 * Every route requires an active group membership, re-derived server-side from
 * the workspace's group. Nothing here accepts a group id from the client: the
 * workspace alone determines which group's data is reachable.
 */

// The role guard below depends on `req.user`, so `requireAuth` must run first.
router.use(requireAuth);
router.use(requireStudent);

/** GET /api/workspaces — the caller's active group workspaces. */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await workspace.listMyWorkspaces(req.user.id);
    return ok(res, result);
  }),
);

/** POST /api/workspaces — create a shared space inside an existing group. */
router.post(
  "/",
  writeLimiter,
  validate({ body: createWorkspaceSchema }),
  asyncHandler(async (req, res) => {
    const result = await workspace.createWorkspace(req.user.id, req.body);
    return created(res, result);
  }),
);

/** GET /api/workspaces/:workspaceId — everything the landing page needs. */
router.get(
  "/:workspaceId",
  validate({ params: workspaceIdParamSchema }),
  asyncHandler(async (req, res) => {
    const overview = await workspace.getOverview(req.params.workspaceId, req.user.id);
    return ok(res, overview);
  }),
);

/** DELETE /api/workspaces/:workspaceId — soft-archive a workspace and preserve its data. */
router.delete(
  "/:workspaceId",
  writeLimiter,
  validate({ params: workspaceIdParamSchema }),
  asyncHandler(async (req, res) => {
    await workspace.archiveWorkspace(req.params.workspaceId, req.user.id);
    return noContent(res);
  }),
);

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

router.post(
  "/:workspaceId/plans",
  writeLimiter,
  validate({ params: workspaceIdParamSchema, body: createPlanSchema }),
  asyncHandler(async (req, res) => {
    const plan = await workspace.createPlan(req.params.workspaceId, req.user.id, req.body);
    return created(res, { plan });
  }),
);

router.patch(
  "/:workspaceId/plans/:planId",
  writeLimiter,
  validate({
    params: workspaceIdParamSchema.extend({ planId: z.string().uuid() }),
    body: updatePlanSchema,
  }),
  asyncHandler(async (req, res) => {
    const plan = await workspace.updatePlan(req.params.workspaceId, req.user.id, req.params.planId, req.body);
    return ok(res, { plan });
  }),
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

router.get(
  "/:workspaceId/tasks",
  validate({ params: workspaceIdParamSchema, query: taskQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await workspace.listTasks(req.params.workspaceId, req.user.id, req.query);
    return ok(res, result);
  }),
);

router.post(
  "/:workspaceId/tasks",
  writeLimiter,
  validate({ params: workspaceIdParamSchema, body: createTaskSchema }),
  asyncHandler(async (req, res) => {
    const task = await workspace.createTask(req.params.workspaceId, req.user.id, req.body);
    return created(res, { task });
  }),
);

router.patch(
  "/:workspaceId/tasks/:taskId",
  writeLimiter,
  validate({
    params: workspaceIdParamSchema.extend({ taskId: z.string().uuid() }),
    body: updateTaskSchema,
  }),
  asyncHandler(async (req, res) => {
    const task = await workspace.updateTask(req.params.workspaceId, req.user.id, req.params.taskId, req.body);
    return ok(res, { task });
  }),
);

router.post(
  "/:workspaceId/tasks/:taskId/comments",
  writeLimiter,
  validate({
    params: workspaceIdParamSchema.extend({ taskId: z.string().uuid() }),
    body: taskCommentSchema,
  }),
  asyncHandler(async (req, res) => {
    const comment = await workspace.addTaskComment(
      req.params.workspaceId,
      req.user.id,
      req.params.taskId,
      req.body.body,
    );
    return created(res, { comment });
  }),
);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

router.get(
  "/:workspaceId/sessions",
  validate({ params: workspaceIdParamSchema, query: sessionQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await workspace.listSessions(req.params.workspaceId, req.user.id, req.query);
    return ok(res, result);
  }),
);

router.post(
  "/:workspaceId/sessions",
  writeLimiter,
  validate({ params: workspaceIdParamSchema, body: createSessionSchema }),
  asyncHandler(async (req, res) => {
    const session = await workspace.createSession(req.params.workspaceId, req.user.id, req.body);
    return created(res, { session });
  }),
);

/**
 * PATCH /api/workspaces/:workspaceId/sessions/:sessionId
 *
 * Declared before the RSVP route so `sessions/:sessionId` is not mistaken for the
 * literal `sessions/rsvp` segment.
 */
router.patch(
  "/:workspaceId/sessions/:sessionId",
  writeLimiter,
  validate({
    params: workspaceIdParamSchema.extend({ sessionId: z.string().uuid() }),
    body: updateSessionSchema,
  }),
  asyncHandler(async (req, res) => {
    const result = await workspace.updateSession(
      req.params.workspaceId,
      req.user.id,
      req.params.sessionId,
      req.body,
    );
    return ok(res, result);
  }),
);

router.post(
  "/:workspaceId/sessions/rsvp",
  writeLimiter,
  validate({ params: workspaceIdParamSchema, body: rsvpSchema }),
  asyncHandler(async (req, res) => {
    const result = await workspace.rsvp(req.params.workspaceId, req.user.id, req.body.sessionId, req.body);
    return ok(res, result);
  }),
);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

router.get(
  "/:workspaceId/messages",
  validate({ params: workspaceIdParamSchema, query: messageQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await workspace.listMessages(req.params.workspaceId, req.user.id, req.query);
    return ok(res, result);
  }),
);

router.post(
  "/:workspaceId/messages",
  writeLimiter,
  validate({ params: workspaceIdParamSchema, body: sendMessageSchema }),
  asyncHandler(async (req, res) => {
    const message = await workspace.sendMessage(req.params.workspaceId, req.user.id, req.body);
    return created(res, { message });
  }),
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

router.get(
  "/:workspaceId/resources",
  validate({ params: workspaceIdParamSchema, query: resourceQuerySchema }),
  asyncHandler(async (req, res) => {
    const resources = await workspace.listResources(req.params.workspaceId, req.user.id, req.query);
    return ok(res, { resources });
  }),
);

router.post(
  "/:workspaceId/resources",
  writeLimiter,
  validate({
    params: workspaceIdParamSchema,
    body: createResourceSchema.refine((resource) => resource.kind !== "FILE", {
      message: "File uploads are not available here yet. Add a link or a text note instead.",
      path: ["kind"],
    }),
  }),
  asyncHandler(async (req, res) => {
    const resource = await workspace.createResource(req.params.workspaceId, req.user.id, req.body);
    return created(res, { resource });
  }),
);

// ---------------------------------------------------------------------------
// Progress and feedback
// ---------------------------------------------------------------------------

router.put(
  "/:workspaceId/progress",
  writeLimiter,
  validate({ params: workspaceIdParamSchema, body: topicStatusSchema }),
  asyncHandler(async (req, res) => {
    const progress = await workspace.updateTopicProgress(
      req.params.workspaceId,
      req.user.id,
      req.body.topicId,
      req.body.status,
      req.body.confidence,
    );
    return ok(res, { progress });
  }),
);

router.get(
  "/:workspaceId/feedback",
  validate({ params: workspaceIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await workspace.getFeedbackSummary(req.params.workspaceId, req.user.id);
    return ok(res, result);
  }),
);

router.post(
  "/:workspaceId/feedback",
  writeLimiter,
  validate({ params: workspaceIdParamSchema, body: groupFeedbackSchema }),
  asyncHandler(async (req, res) => {
    const result = await workspace.submitFeedback(req.params.workspaceId, req.user.id, req.body);
    return created(res, result);
  }),
);

export default router;