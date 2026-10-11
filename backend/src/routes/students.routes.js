import { Router } from "express";
import { asyncHandler, ok } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireStudent, requireAuth } from "../middleware/auth.js";
import { writeLimiter, searchLimiter } from "../middleware/rateLimit.js";
import { z } from "zod";
import * as students from "../services/student.service.js";
import * as discovery from "../services/discovery.service.js";
import {
  profileUpdateSchema,
  studentCoursesSchema,
  studentSkillsSchema,
  studentTopicsSchema,
  learningGoalsSchema,
  availabilitySchema,
  studyPreferencesSchema,
  onboardingStepSchema,
  privacySettingsSchema,
  studentSearchSchema,
} from "../lib/schemas.js";

const router = Router();

/** All routes here require a session; role gates then narrow it to STUDENT. */
router.use(requireAuth);

/**
 * Student profile and discovery endpoints.
 *
 * All routes require a STUDENT role: a lecturer has no student profile, and
 * `requireStudent` keeps that distinction explicit rather than implicit.
 */

const studentIdParamSchema = z.object({ studentId: z.string().uuid() });

/**
 * GET /api/students/me
 * The complete profile bundle the UI needs: identity, academic standing,
 * courses, skills, topic self-assessment, goals, availability and preferences,
 * plus a computed completeness figure.
 *
 * Deliberately one endpoint. The profile page and the onboarding flow both need
 * all of it, and six round trips on first paint is a measurable cost.
 */
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const profile = await students.getProfileBundle(req.user.id);
    return ok(res, { profile });
  }),
);

/** PATCH /api/students/me — basic information. */
router.patch(
  "/me",
  requireStudent,
  writeLimiter,
  validate({
    body: profileUpdateSchema,
  }),
  asyncHandler(async (req, res) => {
    const profile = await students.updateProfile(req.user.id, req.body);
    return ok(res, { profile });
  }),
);

/** PUT /api/students/me/courses — replace the enrolment set. */
router.put(
  "/me/courses",
  requireStudent,
  writeLimiter,
  validate({ body: studentCoursesSchema }),
  asyncHandler(async (req, res) => {
    const result = await students.setCourses(req.user.id, req.body.courseIds);
    return ok(res, result);
  }),
);

/** PUT /api/students/me/skills — replace self-declared skill levels. */
router.put(
  "/me/skills",
  requireStudent,
  writeLimiter,
  validate({ body: studentSkillsSchema }),
  asyncHandler(async (req, res) => {
    const result = await students.setSkills(req.user.id, req.body.skills);
    return ok(res, result);
  }),
);

/** PUT /api/students/me/topics — replace topic strengths/weaknesses. */
router.put(
  "/me/topics",
  requireStudent,
  writeLimiter,
  validate({ body: studentTopicsSchema }),
  asyncHandler(async (req, res) => {
    const result = await students.setTopics(req.user.id, req.body.topics);
    return ok(res, result);
  }),
);

/** PUT /api/students/me/goals */
router.put(
  "/me/goals",
  requireStudent,
  writeLimiter,
  validate({ body: learningGoalsSchema }),
  asyncHandler(async (req, res) => {
    const result = await students.setGoals(req.user.id, req.body.goals);
    return ok(res, result);
  }),
);

/** PUT /api/students/me/availability */
router.put(
  "/me/availability",
  requireStudent,
  writeLimiter,
  validate({ body: availabilitySchema }),
  asyncHandler(async (req, res) => {
    const result = await students.setAvailability(req.user.id, req.body.slots);
    return ok(res, result);
  }),
);

/** PUT /api/students/me/preferences */
router.put(
  "/me/preferences",
  requireStudent,
  writeLimiter,
  validate({ body: studyPreferencesSchema }),
  asyncHandler(async (req, res) => {
    const result = await students.setPreferences(req.user.id, req.body);
    return ok(res, result);
  }),
);

/** POST /api/students/me/onboarding-step — tracks onboarding progress. */
router.post(
  "/me/onboarding-step",
  requireStudent,
  writeLimiter,
  validate({ body: onboardingStepSchema }),
  asyncHandler(async (req, res) => {
    const result = await students.recordOnboardingStep(req.user.id, req.body.step, req.body.completed);
    return ok(res, result);
  }),
);

/** GET /api/students/me/completeness — drives the "85% complete" indicator. */
router.get(
  "/me/completeness",
  requireStudent,
  asyncHandler(async (req, res) => {
    const completeness = await students.getCompleteness(req.user.id);
    return ok(res, { completeness });
  }),
);

/** PUT /api/students/me/privacy */
router.put(
  "/me/privacy",
  requireStudent,
  writeLimiter,
  validate({ body: privacySettingsSchema }),
  asyncHandler(async (req, res) => {
    const settings = await students.updatePrivacy(req.user.id, req.body);
    return ok(res, { settings });
  }),
);

/** GET /api/students/me/privacy */
router.get(
  "/me/privacy",
  requireStudent,
  asyncHandler(async (req, res) => {
    const settings = await students.getPrivacy(req.user.id);
    return ok(res, { settings });
  }),
);

/**
 * GET /api/students/me/summary
 * The overview counters for the dashboard: groups, pending invitations and
 * requests, upcoming sessions, partnership notifications and unread messages.
 */
router.get(
  "/me/summary",
  requireStudent,
  asyncHandler(async (req, res) => {
    const summary = await students.summaryForStudent(req.user.id);
    return ok(res, { summary });
  }),
);

/**
 * GET /api/students/search — find students to invite.
 *
 * Respects every other student's privacy settings: undiscoverable students are
 * never returned, and a non-discoverable requester searching by email finds
 * nobody. This is enforced in the service against the `privacy_settings` table
 * rather than filtered in the UI.
 */
router.get(
  "/search",
  requireStudent,
  searchLimiter,
  validate({ query: studentSearchSchema }),
  asyncHandler(async (req, res) => {
    const result = await discovery.searchStudents(req.user.id, req.query);
    return ok(res, result);
  }),
);

/**
 * GET /api/students/:studentId
 * The public view of another student, filtered by their privacy settings.
 *
 * Always returns a 404 rather than a 403 for a private profile, so the endpoint
 * cannot be used to probe which student ids exist.
 */
router.get(
  "/:studentId",
  requireStudent,
  validate({ params: studentIdParamSchema }),
  asyncHandler(async (req, res) => {
    const profile = await discovery.getStudentProfile(req.user.id, req.params.studentId);
    return ok(res, { profile });
  }),
);

/** GET /api/students/:studentId/availability — only if they allow it. */
router.get(
  "/:studentId/availability",
  requireStudent,
  validate({ params: studentIdParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await discovery.getStudentAvailability(req.user.id, req.params.studentId);
    return ok(res, result);
  }),
);

/** GET /api/students/:studentId/shared-groups */
router.get(
  "/:studentId/shared-groups",
  requireStudent,
  validate({ params: studentIdParamSchema }),
  asyncHandler(async (req, res) => {
    const groups = await discovery.getSharedGroups(req.user.id, req.params.studentId);
    return ok(res, { groups });
  }),
);

export default router;