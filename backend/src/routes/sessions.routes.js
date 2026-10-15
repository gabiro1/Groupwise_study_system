import { Router } from "express";
import { asyncHandler, ok, created } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, requireStudent } from "../middleware/auth.js";
import { messageLimiter } from "../middleware/rateLimit.js";
import * as sessions from "../services/studySession.service.js";
import {
  sessionIdParamSchema,
  sessionListQuerySchema,
  createStudySessionSchema,
  updateStudySessionSchema,
  participantOpSchema,
  rsvpUpdateSchema,
  roleRotationSchema,
  roleAssignmentSchema,
  setAgendaSchema,
  extendActivitySchema,
  sessionMessageSchema,
  sessionMessageQuerySchema,
  sessionQuestionSchema,
  sessionQuestionResponseSchema,
  sessionQuestionStatusSchema,
  sessionNoteSchema,
  sessionNoteUpdateSchema,
  sessionPrepSchema,
  sessionReflectionSchema,
} from "../lib/schemas.js";

const router = Router();

/**
 * Study-session routes — the structured collaboration layer.
 *
 * Authorisation is re-derived on every request from the session's group
 * membership (see services/studySession.service.js). Admin has no implicit
 * access: sessions live inside a group, exactly like workspaces.
 *
 * All routes sit behind `requireAuth` + `requireStudent`, so these endpoints
 * are student-facing only.
 */

router.use(requireAuth);
router.use(requireStudent);

// ---------------------------------------------------------------------------
// Overview + detail
// ---------------------------------------------------------------------------

/** GET /api/sessions — every study session visible through group membership. */
router.get(
  "/",
  validate({ query: sessionListQuerySchema }),
  asyncHandler(async (req, res) => {
    const list = await sessions.listMySessions(req.user.id, req.query);
    return ok(res, { sessions: list });
  }),
);

/** GET /api/sessions/:sessionId — full collaboration payload for one session. */
router.get(
  "/:sessionId",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.getSession(req.params.sessionId, req.user.id);
    return ok(res, { session });
  }),
);

/** POST /api/sessions — schedule a structured study session (group leader only). */
router.post(
  "/",
  validate({ body: createStudySessionSchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.createStudySession(req.user.id, req.body);
    return created(res, { session });
  }),
);

router.patch(
  "/:sessionId",
  validate({ params: sessionIdParamSchema, body: updateStudySessionSchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.updateSessionDetails(req.params.sessionId, req.user.id, req.body);
    return ok(res, { session });
  }),
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const transitionRoutes = {
  start: sessions.startSession,
  pause: sessions.pauseSession,
  resume: sessions.resumeSession,
  complete: sessions.completeSession,
  cancel: sessions.cancelSession,
};

for (const [name, fn] of Object.entries(transitionRoutes)) {
  router.post(
    `/:sessionId/${name}`,
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => {
      const result = await fn(req.params.sessionId, req.user.id);
      return ok(res, result?.session ? { session: result.session } : { session: result });
    }),
  );
}

// ---------------------------------------------------------------------------
// Participants + RSVP
// ---------------------------------------------------------------------------

router.post(
  "/:sessionId/participants",
  validate({ params: sessionIdParamSchema, body: participantOpSchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.addParticipant(req.params.sessionId, req.user.id, req.body.studentId);
    return created(res, { session });
  }),
);

router.delete(
  "/:sessionId/participants/:studentId",
  validate({ params: sessionIdParamSchema.partial().extend({ studentId: participantOpSchema.shape.studentId }) }),
  asyncHandler(async (req, res) => {
    const session = await sessions.removeParticipant(req.params.sessionId, req.user.id, req.params.studentId);
    return ok(res, { session });
  }),
);

router.patch(
  "/:sessionId/rsvp",
  validate({ params: sessionIdParamSchema, body: rsvpUpdateSchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.setRsvp(req.params.sessionId, req.user.id, req.body.rsvp);
    return ok(res, { session });
  }),
);

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

router.post(
  "/:sessionId/roles/rotate",
  validate({ params: sessionIdParamSchema, body: roleRotationSchema }),
  asyncHandler(async (req, res) => {
    const result = await sessions.rotateRoles(req.params.sessionId, req.user.id, req.body);
    return created(res, result);
  }),
);

router.post(
  "/:sessionId/roles/assign",
  validate({ params: sessionIdParamSchema, body: roleAssignmentSchema }),
  asyncHandler(async (req, res) => {
    const role = await sessions.assignRole(req.params.sessionId, req.user.id, req.body);
    return created(res, { role });
  }),
);

// ---------------------------------------------------------------------------
// Agenda + timer
// ---------------------------------------------------------------------------

router.put(
  "/:sessionId/agenda",
  validate({ params: sessionIdParamSchema, body: setAgendaSchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.setAgenda(req.params.sessionId, req.user.id, req.body);
    return ok(res, { session });
  }),
);

router.post(
  "/:sessionId/timer/advance",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.advanceActivity(req.params.sessionId, req.user.id);
    return ok(res, { session });
  }),
);

router.post(
  "/:sessionId/timer/pause",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.pauseTimer(req.params.sessionId, req.user.id);
    return ok(res, { session });
  }),
);

router.post(
  "/:sessionId/timer/resume",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.resumeTimer(req.params.sessionId, req.user.id);
    return ok(res, { session });
  }),
);

router.post(
  "/:sessionId/timer/extend",
  validate({ params: sessionIdParamSchema, body: extendActivitySchema }),
  asyncHandler(async (req, res) => {
    const session = await sessions.extendActivity(req.params.sessionId, req.user.id, req.body);
    return ok(res, { session });
  }),
);

// ---------------------------------------------------------------------------
// Session chat
// ---------------------------------------------------------------------------

router.get(
  "/:sessionId/messages",
  validate({ params: sessionIdParamSchema, query: sessionMessageQuerySchema }),
  asyncHandler(async (req, res) => {
    const result = await sessions.listSessionMessages(req.params.sessionId, req.user.id, req.query);
    return ok(res, result);
  }),
);

router.post(
  "/:sessionId/messages",
  messageLimiter,
  validate({ params: sessionIdParamSchema, body: sessionMessageSchema }),
  asyncHandler(async (req, res) => {
    const result = await sessions.sendSessionMessage(req.params.sessionId, req.user.id, req.body);
    return created(res, result);
  }),
);

// ---------------------------------------------------------------------------
// Question queue
// ---------------------------------------------------------------------------

router.get(
  "/:sessionId/questions",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const questions = await sessions.listQuestions(req.params.sessionId, req.user.id);
    return ok(res, { questions });
  }),
);

router.post(
  "/:sessionId/questions",
  validate({ params: sessionIdParamSchema, body: sessionQuestionSchema }),
  asyncHandler(async (req, res) => {
    const question = await sessions.createQuestion(req.params.sessionId, req.user.id, req.body);
    return created(res, { question });
  }),
);

router.post(
  "/:sessionId/questions/:questionId/answers",
  validate({ params: sessionIdParamSchema.partial().extend({ questionId: sessionIdParamSchema.shape.sessionId }), body: sessionQuestionResponseSchema }),
  asyncHandler(async (req, res) => {
    const response = await sessions.answerQuestion(req.params.sessionId, req.user.id, req.params.questionId, req.body);
    return created(res, { response });
  }),
);

router.patch(
  "/:sessionId/questions/:questionId/status",
  validate({ params: sessionIdParamSchema.partial().extend({ questionId: sessionIdParamSchema.shape.sessionId }), body: sessionQuestionStatusSchema }),
  asyncHandler(async (req, res) => {
    const question = await sessions.updateQuestionStatus(req.params.sessionId, req.user.id, req.params.questionId, req.body.status);
    return ok(res, { question });
  }),
);

// ---------------------------------------------------------------------------
// Shared notes
// ---------------------------------------------------------------------------

router.get(
  "/:sessionId/notes",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const notes = await sessions.listNotes(req.params.sessionId, req.user.id);
    return ok(res, { notes });
  }),
);

router.post(
  "/:sessionId/notes",
  validate({ params: sessionIdParamSchema, body: sessionNoteSchema }),
  asyncHandler(async (req, res) => {
    const note = await sessions.createNote(req.params.sessionId, req.user.id, req.body);
    return created(res, { note });
  }),
);

router.put(
  "/:sessionId/notes/:noteId",
  validate({ params: sessionIdParamSchema.partial().extend({ noteId: sessionIdParamSchema.shape.sessionId }), body: sessionNoteUpdateSchema }),
  asyncHandler(async (req, res) => {
    const note = await sessions.updateNote(req.params.sessionId, req.user.id, req.params.noteId, req.body);
    return ok(res, { note });
  }),
);

router.delete(
  "/:sessionId/notes/:noteId",
  validate({ params: sessionIdParamSchema.partial().extend({ noteId: sessionIdParamSchema.shape.sessionId }) }),
  asyncHandler(async (req, res) => {
    const result = await sessions.deleteNote(req.params.sessionId, req.user.id, req.params.noteId);
    return ok(res, result);
  }),
);

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

router.get(
  "/:sessionId/prep/mine",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const prep = await sessions.myPrep(req.params.sessionId, req.user.id);
    return ok(res, prep);
  }),
);

router.put(
  "/:sessionId/prep/mine",
  validate({ params: sessionIdParamSchema, body: sessionPrepSchema }),
  asyncHandler(async (req, res) => {
    const prep = await sessions.setMyPrep(req.params.sessionId, req.user.id, req.body.status);
    return ok(res, prep);
  }),
);

router.get(
  "/:sessionId/prep/board",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const board = await sessions.prepOverview(req.params.sessionId, req.user.id);
    return ok(res, board);
  }),
);

// ---------------------------------------------------------------------------
// Reflections + summary
// ---------------------------------------------------------------------------

router.get(
  "/:sessionId/reflections",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await sessions.listReflections(req.params.sessionId, req.user.id);
    return ok(res, result);
  }),
);

router.put(
  "/:sessionId/reflections/mine",
  validate({ params: sessionIdParamSchema, body: sessionReflectionSchema }),
  asyncHandler(async (req, res) => {
    const reflection = await sessions.submitReflection(req.params.sessionId, req.user.id, req.body);
    return ok(res, { reflection });
  }),
);

router.get(
  "/:sessionId/summary",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const summary = await sessions.getSummary(req.params.sessionId, req.user.id);
    return ok(res, { summary });
  }),
);

// ---------------------------------------------------------------------------
// Virtual meeting (LiveKit, server-issued token)
// ---------------------------------------------------------------------------

router.post(
  "/:sessionId/meeting/token",
  validate({ params: sessionIdParamSchema }),
  asyncHandler(async (req, res) => {
    const token = await sessions.meetingToken(req.params.sessionId, req.user.id);
    return ok(res, { ...token });
  }),
);

export default router;