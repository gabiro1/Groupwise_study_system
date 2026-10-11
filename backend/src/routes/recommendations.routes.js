import { Router } from "express";
import { asyncHandler, ok, created } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireStudent, requireAuth, requireAdmin } from "../middleware/auth.js";
import { searchLimiter, aiLimiter, writeLimiter } from "../middleware/rateLimit.js";
import * as recommendations from "../services/recommendation.service.js";
import { parseNaturalLanguage, aiStatus } from "../services/ai.service.js";
import {
  recommendationRequestSchema,
  recommendationFeedbackSchema,
  aiIntentSchema,
  z,
  idParamSchema,
} from "../lib/schemas.js";
import env from "../config/env.js";

const router = Router();

// Every route in this file requires a signed-in account (student or admin),
// and the role guards depend on `req.user`, so `requireAuth` runs first.
router.use(requireAuth);

/**
 * Recommendation routes.
 *
 * The engine is deterministic — these endpoints only translate HTTP into the
 * service layer. Nothing here interprets a score, and the client cannot supply
 * weights.
 */

/** POST /api/recommendations — structured or natural-language search. */
router.post(
  "/",
  requireStudent,
  searchLimiter,
  validate({ body: recommendationRequestSchema }),
  asyncHandler(async (req, res) => {
    const result = await recommendations.generate(req.user.id, req.body);
    return ok(res, result);
  }),
);

/**
 * GET /api/recommendations — same ranking, no request body.
 *
 * Defaults to the student's saved profile and availability, which is the common
 * case: "show me who I should meet" should need no input at all.
 */
router.get(
  "/",
  requireStudent,
  searchLimiter,
  validate({ query: recommendationRequestSchema.partial() }),
  asyncHandler(async (req, res) => {
    const result = await recommendations.generate(req.user.id, {
      ...req.query,
      kind: req.query.kind ?? "GROUP",
      topicIds: req.query.topicIds ?? [],
      availability: req.query.availability ?? [],
      limit: req.query.limit ?? 20,
      track: false,
      source: req.query.source ?? "DASHBOARD",
    });
    return ok(res, result);
  }),
);

/**
 * GET /api/recommendations/recent — recently shown cards.
 *
 * Registered before `/:recommendationId` so the literal path is not captured as
 * an id and rejected by the UUID schema.
 */
router.get(
  "/recent",
  requireStudent,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 10, 50);
    const recent = await recommendations.listRecent(req.user.id, limit);
    return ok(res, { recommendations: recent });
  }),
);

/** GET /api/recommendations/weights — the active model's published weights. */
router.get(
  "/weights",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const model = await recommendations.currentModel();
    return ok(res, { model });
  }),
);

/** PATCH /api/recommendations/weights — admin-only model calibration. */
router.patch(
  "/weights",
  requireAdmin,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const model = await recommendations.updateWeights(req.user.id, req.body);
    return ok(res, { model });
  }),
);

/**
 * POST /api/recommendations/feedback
 *
 * The qualitative opinion on a card, stored in `recommendation_feedback`.
 * The behavioural events live on a different route (`PATCH /:recommendationId/outcome`)
 * because "swiped past" and "this was a bad match" are different facts, and the
 * calibration study needs them separable.
 */
router.post(
  "/feedback",
  requireStudent,
  writeLimiter,
  validate({ body: recommendationFeedbackSchema }),
  asyncHandler(async (req, res) => {
    const result = await recommendations.recordFeedback(req.user.id, req.body.recommendationId, req.body);
    return created(res, result);
  }),
);

/**
 * PATCH /api/recommendations/:recommendationId/outcome
 *
 * The behavioural funnel: shown, clicked, accepted, rejected. Declared after the
 * literal `/feedback` and `/explain/...` routes so those are not shadowed.
 */
router.patch(
  "/:recommendationId/outcome",
  requireStudent,
  writeLimiter,
  validate({
    params: idParamSchema,
    body: z.object({
      action: z.enum(["SHOWN", "CLICKED", "ACCEPTED", "REJECTED"]),
      reason: z
        .enum([
          "NOT_RELEVANT_COURSE",
          "SCHEDULE_MISMATCH",
          "GROUP_FULL",
          "GOAL_MISMATCH",
          "ALREADY_IN_GROUP",
          "NOT_INTERESTED",
          "OTHER",
        ])
        .optional()
        .nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await recommendations.recordOutcome(
      req.user.id,
      req.params.recommendationId,
      req.body.action,
      { reason: req.body.reason },
    );
    return ok(res, result);
  }),
);

/**
 * POST /api/recommendations/explain/:recommendationId
 *
 * Rebuilds the deterministic explanation for one recommendation. Useful when a
 * student disputes a score: the breakdown is reproducible from stored inputs.
 */
router.post(
  "/explain/:recommendationId",
  requireStudent,
  writeLimiter,
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const result = await recommendations.recommendationDetail(req.user.id, req.params.recommendationId);
    return ok(res, result);
  }),
);

/**
 * POST /api/recommendations/pair/:studentId
 *
 * Symmetric compatibility between the caller and one other student. Scoped so a
 * student can only ever request their own pair — not an arbitrary third party's.
 */
router.get(
  "/pair/:studentId",
  requireStudent,
  searchLimiter,
  validate({ params: z.object({ studentId: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const result = await recommendations.pairCompatibility(req.user.id, req.params.studentId);
    return ok(res, result);
  }),
);

// ---------------------------------------------------------------------------
// Natural language
// ---------------------------------------------------------------------------

/**
 * POST /api/recommendations/parse-intent
 *
 * Parses a sentence into structured filters and returns them. Does **not** rank
 * anything: the client then submits them to `POST /api/recommendations`, or the
 * student edits them in the form. Returning a parse the user can see and correct
 * is the point — an invisible parse would hide what the system assumed.
 */
router.post(
  "/parse-intent",
  requireStudent,
  aiLimiter,
  validate({ body: aiIntentSchema }),
  asyncHandler(async (req, res) => {
    const eligible = await buildEligibleSet(req.user.id, req.body);

    // No provider configured is a normal state, not an error: the client is told
    // to fall back to the structured form.
    if (!env.aiEnabled) {
      return ok(res, {
        available: false,
        reason: "AI_INTENT_DISABLED",
        message: "Type a few filters instead — or enable an AI provider.",
        eligible,
      });
    }

    const intent = await parseNaturalLanguage(req.body.text, eligible, req.user.id);
    return ok(res, { available: true, intent, eligible });
  }),
);

/** GET /api/recommendations/ai-status — whether AI features are usable. */
router.get(
  "/ai-status",
  requireStudent,
  asyncHandler(async (_req, res) => ok(res, { ai: aiStatus() })),
);

/**
 * Build the id lists the student is allowed to have the model choose from.
 *
 * Restricted to their own enrolments. A model given ids outside that set could
 * steer a student toward a course they are not taking, so the eligible list is
 * derived from the database rather than from the request body alone.
 */
async function buildEligibleSet(studentId, body) {
  const { queryRows } = await import("../config/db.js");

  const courses = await queryRows(
    `SELECT c.id, c.course_code, c.name
       FROM student_courses sc JOIN courses c ON c.id = sc.course_id
      WHERE sc.student_id = $1 AND c.is_active
        AND ($2::uuid[] IS NULL OR c.id = ANY($2::uuid[]))
      ORDER BY c.course_code
      LIMIT 60`,
    [studentId, body.eligibleCourseIds.length ? body.eligibleCourseIds : null],
    "ai:eligibleCourses",
  );

  const topics = await queryRows(
    `SELECT ct.id, c.course_code, ct.name
       FROM course_topics ct
       JOIN courses c ON c.id = ct.course_id
       JOIN student_courses sc ON sc.course_id = ct.course_id AND sc.student_id = $3 AND sc.is_active
      WHERE ($1::uuid[] IS NULL OR ct.id = ANY($1::uuid[]))
        AND ($2::uuid[] IS NULL OR ct.course_id = ANY($2::uuid[]))
      ORDER BY c.course_code, ct.name
      LIMIT 120`,
    [
      body.eligibleTopicIds.length ? body.eligibleTopicIds : null,
      body.eligibleCourseIds.length ? body.eligibleCourseIds : null,
      studentId,
    ],
    "ai:eligibleTopics",
  );

  const goals = await queryRows(
    `SELECT id, code, label FROM learning_goals
      WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
      ORDER BY code`,
    [body.goalIds.length ? body.goalIds : null],
    "ai:eligibleGoals",
  );

  return {
    courses: courses.map((c) => ({ id: c.id, courseCode: c.course_code, name: c.name })),
    topics: topics.map((t) => ({ id: t.id, courseCode: t.course_code, name: t.name })),
    goals: goals.map((g) => ({ id: g.id, code: g.code, label: g.label })),
  };
}

export default router;