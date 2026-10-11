import { Router } from "express";
import { asyncHandler, ok } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { writeLimiter } from "../middleware/rateLimit.js";
import { queryOne } from "../config/db.js";
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from "../lib/notifications.js";
import { NotFoundError } from "../lib/errors.js";
import { z, idParamSchema, optionalBooleanFromQuery } from "../lib/schemas.js";

const router = Router();

/**
 * Notification routes.
 *
 * Every query is scoped by `user_id = $1` taken from the session, never from a
 * parameter. A notification is private by construction, so there is no endpoint
 * from which one user can address another.
 */

router.use(requireAuth);

/** GET /api/notifications — newest first, cursor paginated. */
router.get(
  "/",
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(200).optional(), unreadOnly: optionalBooleanFromQuery }) }),
  asyncHandler(async (req, res) => {
    const page = await listNotifications(req.user.id, req.query);
    return ok(res, page);
  }),
);

/**
 * GET /api/notifications/unread-count
 *
 * Separate from the list because the header badge polls this on an interval and
 * must not pull message bodies with it.
 */
router.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const count = await unreadCount(req.user.id);
    return ok(res, { unreadCount: count });
  }),
);

/** POST /api/notifications/:id/read */
router.post(
  "/:id/read",
  writeLimiter,
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const notification = await markRead(req.user.id, req.params.id);
    if (!notification) throw new NotFoundError("That notification");
    return ok(res, { notification });
  }),
);

/** POST /api/notifications/read-all */
router.post(
  "/read-all",
  writeLimiter,
  asyncHandler(async (req, res) => {
    const result = await markAllRead(req.user.id);
    return ok(res, result);
  }),
);

/** GET /api/notifications/preferences — channel and quiet-hour settings. */
router.get(
  "/preferences",
  asyncHandler(async (req, res) => {
    const preferences = await queryOne(
      `SELECT in_app_enabled, email_enabled, quiet_hours_start, quiet_hours_end, overrides
         FROM notification_preferences WHERE user_id = $1`,
      [req.user.id],
      "notifications:preferences",
    );

    return ok(res, {
      preferences: preferences ?? {
        in_app_enabled: true,
        email_enabled: true,
        quiet_hours_start: null,
        quiet_hours_end: null,
        overrides: {},
      },
    });
  }),
);

/**
 * PUT /api/notifications/preferences
 *
 * Written with an explicit upsert so a user who has never received a notification
 * still has preferences rather than a missing row the UI has to special-case.
 */
router.put(
  "/preferences",
  writeLimiter,
  validate({
    body: z.object({
      inAppEnabled: z.boolean().optional(),
      emailEnabled: z.boolean().optional(),
      quietHoursStart: z.coerce.number().int().min(0).max(1439).nullable().optional(),
      quietHoursEnd: z.coerce.number().int().min(0).max(1439).nullable().optional(),
      overrides: z.record(z.string(), z.enum(["ALL", "IN_APP", "EMAIL", "NONE"])).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { inAppEnabled, emailEnabled, quietHoursStart, quietHoursEnd, overrides } = req.body;

    const preferences = await queryOne(
      `INSERT INTO notification_preferences
         (user_id, in_app_enabled, email_enabled, quiet_hours_start, quiet_hours_end, overrides)
       VALUES ($1,
               COALESCE($2, TRUE),
               COALESCE($3, TRUE),
               $4, $5, COALESCE($6, '{}'::jsonb))
       ON CONFLICT (user_id) DO UPDATE SET
         in_app_enabled    = COALESCE($2, notification_preferences.in_app_enabled),
         email_enabled     = COALESCE($3, notification_preferences.email_enabled),
         quiet_hours_start = COALESCE($4, notification_preferences.quiet_hours_start),
         quiet_hours_end   = COALESCE($5, notification_preferences.quiet_hours_end),
         overrides         = COALESCE($6, notification_preferences.overrides),
         updated_at        = now()
       RETURNING in_app_enabled, email_enabled, quiet_hours_start, quiet_hours_end, overrides`,
      [
        req.user.id,
        inAppEnabled ?? null,
        emailEnabled ?? null,
        quietHoursStart ?? null,
        quietHoursEnd ?? null,
        overrides ? JSON.stringify(overrides) : null,
      ],
      "notifications:updatePreferences",
    );

    return ok(res, { preferences });
  }),
);

export default router;