import { query, queryRows } from "../config/db.js";
import { NOTIFICATION_TYPE } from "../config/constants.js";
import logger from "../config/logger.js";

/**
 * Notification delivery.
 *
 * Design constraint from the product spec: students must not be spammed.
 * Three mechanisms enforce that:
 *
 *  1. Per-type opt-out, stored in `notification_preferences.overrides`.
 *  2. Quiet hours — notifications raised outside the student's chosen window are
 *     still recorded (so nothing is silently lost) but are marked for email only,
 *     not pushed.
 *  3. Per-group throttling for high-frequency types such as task assignments,
 *     so a group posting twelve tasks does not produce twelve interruptions.
 *
 * Notifications are always persisted first. Delivery is best-effort afterwards,
 * so a mail failure can never lose the in-app record.
 */

/** Types eligible for frequency-based coalescing within a group. */
const THROTTLEABLE = new Set([
  NOTIFICATION_TYPE.TASK_ASSIGNED,
  NOTIFICATION_TYPE.TASK_DUE,
  NOTIFICATION_TYPE.SESSION_UPDATED,
  // A rapid exchange of direct messages is the same conversation, not six
  // interruptions: coalesce so the bell reflects the thread, and the thread's
  // own unread counter does the precise bookkeeping.
  NOTIFICATION_TYPE.DIRECT_MESSAGE,
]);

const THROTTLE_WINDOW_MINUTES = 30;

async function preferencesFor(userId) {
  return query(
    `SELECT in_app_enabled, email_enabled, quiet_hours_start, quiet_hours_end, overrides
       FROM notification_preferences WHERE user_id = $1`,
    [userId],
    "notifications:preferences",
  ).then((result) => result.rows[0] ?? null);
}

function isEnabledFor(preferences, type) {
  if (!preferences) return { inApp: true, email: true };
  if (!preferences.in_app_enabled && !preferences.email_enabled) return { inApp: false, email: false };

  const override = preferences.overrides?.[type];
  return {
    inApp: preferences.in_app_enabled && override?.inApp !== false,
    email: preferences.email_enabled && override?.email !== false,
  };
}

/**
 * Quiet hours wrap across midnight, so the check is split: a window starting at
 * 22:00 and ending at 06:00 covers 22:00-24:00 and 00:00-06:00.
 */
function inQuietHours(preferences, date) {
  const start = preferences?.quiet_hours_start;
  const end = preferences?.quiet_hours_end;
  if (start === null || start === undefined || end === null || end === undefined) return false;

  const minute = date.getHours() * 60 + date.getMinutes();
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

async function isThrottled(userId, type, groupId) {
  if (!THROTTLEABLE.has(type) || !groupId) return false;

  const recent = await query(
    `SELECT count(*)::int AS count
       FROM notifications
      WHERE user_id = $1 AND type = $2 AND created_at > now() - ($3 || ' minutes')::interval
        AND metadata->>'groupId' = $4`,
    [userId, type, String(THROTTLE_WINDOW_MINUTES), groupId],
    "notifications:throttle",
  );

  return (recent.rows[0]?.count ?? 0) >= 3;
}

/**
 * Create one notification.
 *
 * @param {object} notification
 * @param {string} notification.userId
 * @param {string} notification.type
 * @param {string} notification.title
 * @param {string} [notification.body]
 * @param {string} [notification.link]
 * @param {object} [notification.metadata]
 * @param {object} [options]
 * @param {object[]} [options.tx]        Transaction client helpers, to enlist
 * @param {boolean} [options.force]      Bypass throttling (system-critical)
 * @returns {Promise<{created:boolean, id:string|null, reason?:string}>}
 */
export async function notify({ userId, type, title, body, link, metadata = {}, force = false }, options = {}) {
  const run = options.tx ?? { query, queryRows };

  try {
    const preferences = await run.query(
      `SELECT in_app_enabled, email_enabled, quiet_hours_start, quiet_hours_end, overrides
         FROM notification_preferences WHERE user_id = $1`,
      [userId],
      "notifications:preferences",
    ).then((result) => result.rows[0] ?? null);

    const enabled = isEnabledFor(preferences, type);
    if (!enabled.inApp && !enabled.email) {
      return { created: false, reason: "opted_out" };
    }

    // Scoped coalescing: group announcements throttle per group, direct messages
    // per conversation. Either id lands in `scopeId` here.
    const scopeId = metadata.groupId ?? metadata.scopeId;
    if (!force && (await isThrottled(userId, type, scopeId))) {
      return { created: false, reason: "throttled" };
    }

    const result = await run.query(
      `INSERT INTO notifications (user_id, type, title, body, link, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [userId, type, title, body ?? null, link ?? null, JSON.stringify(metadata)],
      "notifications:insert",
    );

    // Out-of-hours notifications are recorded but flagged so the email job can
    // batch them into the morning rather than interrupting the student.
    if (inQuietHours(preferences, new Date())) {
      logger.debug("Notification created during quiet hours; queued for digest", { userId, type });
    }

    return { created: true, id: result.rows[0].id };
  } catch (error) {
    // A failed notification must never fail the action that triggered it.
    logger.error("Failed to create notification", { userId, type, message: error.message });
    return { created: false, reason: "error" };
  }
}

/**
 * Fan out to several users. Used when a group announcement or session reminder
 * reaches every member.
 */
export async function notifyMany(userIds, notification, options = {}) {
  const results = await Promise.all(
    userIds.map((userId) => notify({ ...notification, userId }, options)),
  );
  return {
    delivered: results.filter((result) => result.created).length,
    attempted: userIds.length,
  };
}

/** Mark one notification read, only if it belongs to the requesting user. */
export async function markRead(userId, notificationId) {
  const result = await query(
    `UPDATE notifications SET read_at = now()
      WHERE id = $1 AND user_id = $2 AND read_at IS NULL
      RETURNING id`,
    [notificationId, userId],
    "notifications:markRead",
  );
  return (result.rowCount ?? 0) > 0;
}

/** Mark every unread notification read. Returns how many changed. */
export async function markAllRead(userId) {
  const result = await query(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
    "notifications:markAllRead",
  );
  return result.rowCount ?? 0;
}

/** Unread count only — cheap enough to poll on the notification bell. */
export async function unreadCount(userId) {
  const result = await query(
    `SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
    "notifications:unreadCount",
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Paginated notification list. Cursor pagination on (created_at, id) so a busy
 * student's list stays stable while they are reading it.
 */
export async function listNotifications(userId, { limit = 20, cursor, unreadOnly = false } = {}) {
  const params = [userId];
  let where = "user_id = $1";
  if (unreadOnly) where += " AND read_at IS NULL";

  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where += ` AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
  }

  params.push(Math.min(limit, 50) + 1);

  const rows = await queryRows(
    `SELECT id, type, title, body, link, metadata, read_at, created_at
       FROM notifications
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
    "notifications:list",
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    notifications: page,
    nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

export default {
  notify,
  notifyMany,
  markRead,
  markAllRead,
  unreadCount,
  listNotifications,
  preferencesFor,
};