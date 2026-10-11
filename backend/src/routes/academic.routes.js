import { Router } from "express";
import { asyncHandler, ok } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { optionalAuth, requireAuth, requireAdmin } from "../middleware/auth.js";
import { searchLimiter } from "../middleware/rateLimit.js";
import { z } from "zod";
import * as academic from "../services/academic.service.js";

const router = Router();

/**
 * Academic catalogue endpoints.
 *
 * Mostly public so that the registration form can populate cascading selects
 * before anyone has an account. `optionalAuth` is used where the response can be
 * personalised (e.g. which topics a signed-in student has already assessed).
 */

const courseQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

const idParamSchema = z.object({ id: z.string().uuid() });

/** GET /api/academic/universities */
router.get(
  "/universities",
  asyncHandler(async (_req, res) => ok(res, { universities: await academic.listUniversities() })),
);

/** GET /api/academic/universities/:id/faculties */
router.get(
  "/universities/:id/faculties",
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => ok(res, { faculties: await academic.listFaculties(req.params.id) })),
);

/** GET /api/academic/faculties/:id/departments */
router.get(
  "/faculties/:id/departments",
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => ok(res, { departments: await academic.listDepartments(req.params.id) })),
);

/** GET /api/academic/departments/:id/programs */
router.get(
  "/departments/:id/programs",
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => ok(res, { programs: await academic.listPrograms(req.params.id) })),
);

/**
 * GET /api/academic/tree
 * The whole hierarchy in one request, for cascading selects.
 */
router.get(
  "/tree",
  asyncHandler(async (_req, res) => ok(res, await academic.getAcademicTree())),
);

/** GET /api/academic/courses — search, with debouncing expected client-side. */
router.get(
  "/courses",
  searchLimiter,
  validate({ query: courseQuerySchema }),
  asyncHandler(async (req, res) => {
    const courses = await academic.searchCourses(req.query);
    return ok(res, { courses });
  }),
);

/** GET /api/academic/courses/:id */
router.get(
  "/courses/:id",
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const [course, topics] = await Promise.all([
      academic.getCourse(req.params.id),
      academic.getCourseTopics(req.params.id),
    ]);
    return ok(res, { course, topics });
  }),
);

/** GET /api/academic/courses/:id/topics */
router.get(
  "/courses/:id/topics",
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => ok(res, { topics: await academic.getCourseTopics(req.params.id) })),
);

/** GET /api/academic/topics/:id */
router.get(
  "/topics/:id",
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => ok(res, { topic: await academic.getTopic(req.params.id) })),
);

/** GET /api/academic/skills */
router.get(
  "/skills",
  searchLimiter,
  validate({
    query: z.object({
      q: z.string().trim().max(80).optional(),
      courseId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(50).default(30),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, { skills: await academic.searchSkills(req.query) })),
);

/** GET /api/academic/learning-goals */
router.get(
  "/learning-goals",
  asyncHandler(async (_req, res) => ok(res, { goals: await academic.listLearningGoals() })),
);

/**
 * GET /api/academic/enums
 * Every enum the UI needs to render labels, colours and validation messages.
 *
 * Shipping this from one endpoint means the frontend never hard-codes an enum
 * value, and adding a value server-side cannot leave the UI out of step.
 */
router.get(
  "/enums",
  optionalAuth,
  asyncHandler(async (_req, res) => {
    const { ROLES, PROFICIENCY, TOPIC_STATUS, LEARNING_GOALS, STUDY_MODES, STUDY_STYLES, GROUP_PRIVACY, TASK_STATUS, TASK_PRIORITY, SESSION_MODE, RSVP_STATUS, DAYS_OF_WEEK, LEARNING_GOAL_LABELS, STUDY_STYLE_LABELS, GROUP_SIZE } = await import("../config/constants.js");

    return ok(res, {
      roles: ROLES,
      proficiency: PROFICIENCY,
      topicStatus: TOPIC_STATUS,
      learningGoals: LEARNING_GOALS,
      learningGoalLabels: LEARNING_GOAL_LABELS,
      studyModes: STUDY_MODES,
      studyStyles: STUDY_STYLES,
      studyStyleLabels: STUDY_STYLE_LABELS,
      groupPrivacy: GROUP_PRIVACY,
      groupSize: GROUP_SIZE,
      taskStatus: TASK_STATUS,
      taskPriority: TASK_PRIORITY,
      sessionMode: SESSION_MODE,
      rsvpStatus: RSVP_STATUS,
      daysOfWeek: DAYS_OF_WEEK,
    });
  }),
);

export default router;