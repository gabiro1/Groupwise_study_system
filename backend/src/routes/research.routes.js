import { Router } from "express";
import { asyncHandler, ok } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireStaff, requireAuth } from "../middleware/auth.js";
import { searchLimiter } from "../middleware/rateLimit.js";
import { researchQuerySchema } from "../lib/schemas.js";
import {
  outcomesByCourse,
  recommendationsVsOrganic,
  scoreCalibration,
  intentParserEffectiveness,
  dataCoverage,
  assertAdminScope,
  resolveWindow,
  resolveCourseScope,
} from "../services/research.service.js";

const router = Router();

/**
 * Research routes.
 *
 * Lecturer and admin only, and every response is an aggregate. There is no
 * endpoint here that can return an individual student's record: not because the
 * SQL would be difficult, but because a dataset that can be sliced to one person
 * stops being research data and becomes a surveillance tool.
 *
 * These analytics are an administrator surface: every route below requires the
 * ADMIN role, so there is no per-learner scope to widen.
 */

// The role guard below depends on `req.user`, so `requireAuth` must run first.
router.use(requireAuth);
router.use(requireStaff);

/**
 * GET /api/research/coverage
 *
 * Data sufficiency first. An analytics surface that renders "—" for everything
 * while quietly hiding a sample-size problem teaches the reader nothing.
 */
router.get(
  "/coverage",
  searchLimiter,
  validate({ query: researchQuerySchema }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveWindow(req.query);
    const courseIds = await resolveCourseScope(req.user, req.query.courseId);

    const coverage = await dataCoverage({ from, to, courseIds });

    // Stated as guidance rather than a hard gate: a course with three groups
    // should still show those three groups.
    return ok(res, {
      coverage,
      adequacy: {
        // Below these counts a comparison is not interpretable, and saying so is
        // more useful than a ratio computed from six rows.
        minimumForComparison: { recommendedMemberships: 20, organicMemberships: 20 },
        isComparable: (coverage.recommended_memberships ?? 0) >= 20 && (coverage.organic_memberships ?? 0) >= 20,
        note:
          "Comparisons below are only meaningful once both cohorts reach 20 memberships. Small numbers are shown for transparency, not for inference.",
      },
      window: { from, to },
    });
  }),
);

/** GET /api/research/outcomes — group participation outcomes over time. */
router.get(
  "/outcomes",
  searchLimiter,
  validate({ query: researchQuerySchema }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveWindow(req.query);
    const courseIds = await resolveCourseScope(req.user, req.query.courseId);

    const rows = await outcomesByCourse({ ...req.query, from, to, courseIds });

    return ok(res, {
      window: { from, to, granularity: req.query.granularity },
      outcomes: rows,
      measure: {
        stillActive: "Members who had not left the group at the time of measurement.",
        attritionPct: "Share of memberships that ended. Lower is better; a high value may mean the group formed badly or simply that exams passed.",
        avgSessionsAttended: "Mean study sessions attended per member.",
        avgTasksCompleted: "Mean tasks completed per member.",
        avgMessagesSent: "Mean messages sent per member. Treated as a weak signal on its own.",
      },
    });
  }),
);

/**
 * GET /api/research/recommendation-effect
 *
 * The headline comparison: groups joined via a recommendation against groups joined
 * directly.
 */
router.get(
  "/recommendation-effect",
  searchLimiter,
  validate({ query: researchQuerySchema }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveWindow(req.query);
    const courseIds = await resolveCourseScope(req.user, req.query.courseId);

    const comparisons = await recommendationsVsOrganic({ from, to, courseIds });

    return ok(res, {
      window: { from, to },
      comparisons,
      method: {
        cohorts: {
          recommended: "Memberships with joined_via = 'AI_ASSISTED', i.e. the student arrived from a recommendation card.",
          organic: "All other memberships: direct create, invitation, or join request.",
        },
        caveats: [
          "Cohorts are not randomised. Students who accept recommendations may differ systematically from those who browse, so a difference here is an association, not a causal effect.",
          "joined_via is recorded at join time and does not encode the compatibility score, which keeps this comparison from being circular.",
          "Retention is measured as 'still a member', which is also a function of exam calendars.",
        ],
      },
    });
  }),
);

/**
 * GET /api/research/calibration — does a higher score produce more joining?
 *
 * The check that would falsify the whole ranking: if acceptance is flat across
 * score bands, the score is decoration.
 */
router.get(
  "/calibration",
  searchLimiter,
  validate({ query: researchQuerySchema }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveWindow(req.query);
    const courseIds = await resolveCourseScope(req.user, req.query.courseId);

    const calibration = await scoreCalibration({ from, to, courseIds });

    return ok(res, {
      window: { from, to },
      ...calibration,
      interpretation: {
        rule: "Acceptance should rise with the score band. A flat or decreasing curve indicates the ranking is not informative.",
        precisionAtK: "Of the top K recommendations shown, the share that were accepted. This is the metric to quote.",
        minimumShown: 30,
      },
    });
  }),
);

/**
 * GET /api/research/intent-parser
 *
 * Whether natural-language search produced usable filters, and how often the
 * parser had to be bypassed because no AI provider was available.
 */
router.get(
  "/intent-parser",
  searchLimiter,
  validate({ query: researchQuerySchema }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveWindow(req.query);
    const courseIds = await resolveCourseScope(req.user, req.query.courseId);

    const effectiveness = await intentParserEffectiveness({ from, to, courseIds });

    return ok(res, {
      window: { from, to },
      sources: effectiveness,
      notes: [
        "AI output is recorded with parser_model so its contribution can be excluded from any human-participation measure.",
        "`degraded` counts requests served through the structured fallback because no provider was configured; these are working searches, not failures.",
        "`empty_parses` counts natural-language requests that produced zero candidates, which indicates a failed extraction rather than a failed search.",
      ],
    });
  }),
);

/**
 * GET /api/research/export — CSV of the course-level outcome table.
 *
 * Admin only. A bulk export is the one place aggregates could be de-anonymised by
 * repeated small queries, so it is fenced off entirely.
 */
router.get(
  "/export",
  searchLimiter,
  validate({ query: researchQuerySchema }),
  asyncHandler(async (req, res) => {
    assertAdminScope(req.user.role);

    const { from, to } = resolveWindow(req.query);
    // Admin scope is unrestricted, but an explicit `courseId` still narrows the
    // export rather than being silently dropped by the scope resolver.
    const courseIds = req.query.courseId ? [req.query.courseId] : null;
    const rows = await outcomesByCourse({ ...req.query, from, to, courseIds });

    const header = [
      "period",
      "course_code",
      "course_name",
      "memberships",
      "still_active",
      "left_group",
      "attrition_pct",
      "avg_sessions_attended",
      "avg_tasks_completed",
      "avg_messages_sent",
    ];

    // Every field is quoted: a course name containing a comma would otherwise
    // corrupt the file for whoever opens it next.
    const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

    const csv = [
      header.join(","),
      ...rows.map((row) => header.map((key) => escape(row[key])).join(",")),
    ].join("\n");

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="lien-outcomes-${from}_${to}.csv"`);
    return res.send(csv);
  }),
);

export default router;