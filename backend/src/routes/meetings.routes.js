import { Router } from "express";
import { asyncHandler, ok, created } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, requireStudent } from "../middleware/auth.js";
import { writeLimiter, searchLimiter } from "../middleware/rateLimit.js";
import * as meetings from "../services/meeting.service.js";
import {
  meetingIdParamSchema,
  meetingGroupParamSchema,
  createMeetingSchema,
  updateMeetingSchema,
  meetingListQuerySchema,
} from "../lib/schemas.js";

const router = Router();

/**
 * Video meeting routes (group_meetings).
 *
 * Every handler re-derives authorisation from group membership in the service
 * layer. No route trusts a client-supplied group id without checking the actual
 * meeting-group relationship; the meeting's own group is the authority.
 * All routes sit behind requireAuth + requireStudent.
 */

router.use(requireAuth);
router.use(requireStudent);

/** GET /api/meetings — caller's meetings across all their groups. */
router.get(
  "/",
  searchLimiter,
  validate({ query: meetingListQuerySchema }),
  asyncHandler(async (req, res) => {
    const list = await meetings.listMyMeetings(req.user.id, req.query);
    return ok(res, { meetings: list });
  }),
);

/** GET /api/meetings/history/mine — attendance history. Before /:meetingId. */
router.get(
  "/history/mine",
  validate({ query: meetingListQuerySchema.pick({ limit: true }) }),
  asyncHandler(async (req, res) => {
    const history = await meetings.myAttendance(req.user.id, { limit: req.query.limit ?? 50 });
    return ok(res, { attendance: history });
  }),
);

/** GET /api/meetings/group/:groupId — meetings for one authorised group. */
router.get(
  "/group/:groupId",
  searchLimiter,
  validate({ params: meetingGroupParamSchema, query: meetingListQuerySchema.omit({ groupId: true }) }),
  asyncHandler(async (req, res) => {
    const list = await meetings.listGroupMeetings(req.params.groupId, req.user.id, req.query);
    return ok(res, { meetings: list });
  }),
);

/** GET /api/meetings/:meetingId — details (never flips status). */
router.get(
  "/:meetingId",
  validate({ params: meetingIdParamSchema }),
  asyncHandler(async (req, res) => {
    const detail = await meetings.getMeeting(req.params.meetingId, req.user.id);
    return ok(res, detail);
  }),
);

/** POST /api/meetings — schedule (group leader only, enforced in service). */
router.post(
  "/",
  writeLimiter,
  validate({ body: createMeetingSchema }),
  asyncHandler(async (req, res) => {
    const meeting = await meetings.createMeeting(req.user.id, req.body);
    return created(res, { meeting });
  }),
);

/** PATCH /api/meetings/:meetingId — edit details (leader only). */
router.patch(
  "/:meetingId",
  writeLimiter,
  validate({ params: meetingIdParamSchema, body: updateMeetingSchema }),
  asyncHandler(async (req, res) => {
    const detail = await meetings.updateMeeting(req.params.meetingId, req.user.id, req.body);
    return ok(res, detail);
  }),
);

/** Lifecycle — explicit transitions only, compare-and-set in service. */
router.post(
  "/:meetingId/start",
  writeLimiter,
  validate({ params: meetingIdParamSchema }),
  asyncHandler(async (req, res) => {
    const detail = await meetings.startMeeting(req.params.meetingId, req.user.id);
    return ok(res, detail);
  }),
);

router.post(
  "/:meetingId/complete",
  writeLimiter,
  validate({ params: meetingIdParamSchema }),
  asyncHandler(async (req, res) => {
    const detail = await meetings.completeMeeting(req.params.meetingId, req.user.id);
    return ok(res, detail);
  }),
);

router.post(
  "/:meetingId/cancel",
  writeLimiter,
  validate({ params: meetingIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await meetings.cancelMeeting(req.params.meetingId, req.user.id);
    return ok(res, result);
  }),
);

/**
 * POST /api/meetings/:meetingId/join — authorised join.
 * Returns the non-secret provider config (Jitsi domain + room + display name).
 * Secrets never leave the server. Also the only path that auto-starts a
 * scheduled meeting (leader join within the window) — viewing details never
 * changes status.
 */
router.post(
  "/:meetingId/join",
  writeLimiter,
  validate({ params: meetingIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await meetings.joinMeeting(req.params.meetingId, req.user.id);
    return ok(res, result);
  }),
);

/** Attendance events — idempotent, verifiable only. */
router.post(
  "/:meetingId/attendance/join",
  writeLimiter,
  validate({ params: meetingIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await meetings.recordJoin(req.params.meetingId, req.user.id);
    return ok(res, result);
  }),
);

router.post(
  "/:meetingId/attendance/leave",
  writeLimiter,
  validate({ params: meetingIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await meetings.recordLeave(req.params.meetingId, req.user.id);
    return ok(res, result);
  }),
);

/** GET /api/meetings/:meetingId/attendance — leader only (enforced in service). */
router.get(
  "/:meetingId/attendance",
  validate({ params: meetingIdParamSchema }),
  asyncHandler(async (req, res) => {
    const rows = await meetings.listAttendance(req.params.meetingId, req.user.id);
    return ok(res, { attendance: rows });
  }),
);

export default router;
