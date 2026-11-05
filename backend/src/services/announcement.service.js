import { queryOne, queryRows, withTransaction } from "../config/db.js";
import logger from "../config/logger.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { recordAudit, AUDIT } from "../lib/audit.js";
import { notifyMany } from "../lib/notifications.js";
import { NOTIFICATION_TYPE } from "../config/constants.js";

/**
 * Platform announcements.
 *
 * `admin_announcements` is only the draft/schedule record. Delivery deliberately
 * reuses the existing notification pipeline (`notifyMany`), so there is no second
 * notification system, no second preference model, and quiet hours/opt-outs keep
 * working exactly as they do for every other notification.
 *
 * The audience is resolved server-side from roles. It is never a client-supplied
 * list of ids.
 */

const AUDIENCE_ROLE = Object.freeze({
  STUDENTS: "STUDENT",
  GROUP_LEADERS: "GROUP_LEADER",
  ADMINS: "ADMIN",
});

const COLUMNS = `id, title, body, category, audience, status, scheduled_for, published_at,
                 archived_at, created_by, updated_by, metadata, created_at, updated_at`;

const A_COLUMNS = `a.id, a.title, a.body, a.category, a.audience, a.status, a.scheduled_for,
                   a.published_at, a.archived_at, a.created_by, a.updated_by, a.metadata,
                   a.created_at, a.updated_at`;

/** Resolve the recipient ids for an audience. Only live, active accounts. */
async function resolveAudience(audience) {
  const params = [];
  let where = "u.deleted_at IS NULL AND u.status = 'ACTIVE'";
  if (audience !== "ALL") {
    params.push(AUDIENCE_ROLE[audience]);
    where += ` AND r.key = $${params.length}`;
  }

  const rows = await queryRows(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where}`,
    params,
    "announcements:audience",
  );
  return rows.map((row) => row.id);
}

export async function listAnnouncements({ status, category, q, limit = 25, cursor = 0 } = {}) {
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const clauses = [];
  if (status) clauses.push(`a.status = ${bind(status)}`);
  if (category) clauses.push(`a.category = ${bind(category)}`);
  if (q) clauses.push(`(a.title ILIKE '%' || ${bind(q)} || '%' OR a.body ILIKE '%' || ${bind(q)} || '%')`);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const announcements = await queryRows(
    `SELECT ${A_COLUMNS},
            creator.first_name AS created_by_first_name,
            creator.last_name  AS created_by_last_name,
            (SELECT count(*)::int FROM notifications n
              WHERE n.metadata->>'announcementId' = a.id::text) AS delivered_count
       FROM admin_announcements a
       LEFT JOIN users creator ON creator.id = a.created_by
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ${bind(limit + 1)} OFFSET ${bind(cursor)}`,
    params,
    "announcements:list",
  );

  const hasMore = announcements.length > limit;
  const page = hasMore ? announcements.slice(0, limit) : announcements;

  return {
    announcements: page,
    cursor: hasMore ? cursor + limit : null,
  };
}

export async function getAnnouncement(announcementId) {
  const announcement = await queryOne(
    `SELECT ${A_COLUMNS},
            creator.first_name AS created_by_first_name,
            creator.last_name  AS created_by_last_name,
            updater.first_name AS updated_by_first_name,
            updater.last_name  AS updated_by_last_name,
            (SELECT count(*)::int FROM notifications n
              WHERE n.metadata->>'announcementId' = a.id::text) AS delivered_count
       FROM admin_announcements a
       LEFT JOIN users creator ON creator.id = a.created_by
       LEFT JOIN users updater ON updater.id = a.updated_by
      WHERE a.id = $1`,
    [announcementId],
    "announcements:get",
  );

  if (!announcement) throw new NotFoundError("That announcement");
  return announcement;
}

export async function createAnnouncement(actorId, payload, { req } = {}) {
  const announcement = await queryOne(
    `INSERT INTO admin_announcements
       (title, body, category, audience, status, scheduled_for, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     RETURNING ${COLUMNS}`,
    [
      payload.title,
      payload.body,
      payload.category,
      payload.audience,
      payload.status,
      payload.status === "SCHEDULED" ? payload.scheduledFor : null,
      actorId,
    ],
    "announcements:create",
  );

  await recordAudit({
    actor: req?.user ?? { id: actorId },
    req,
    action: AUDIT.ANNOUNCEMENT_CREATED,
    entityType: "announcement",
    entityId: announcement.id,
    metadata: { title: announcement.title, audience: announcement.audience, status: announcement.status },
    required: true,
  });

  return announcement;
}

export async function updateAnnouncement(announcementId, actorId, payload, { req } = {}) {
  const existing = await getAnnouncement(announcementId);
  if (existing.status === "PUBLISHED") {
    throw new ConflictError("A published announcement cannot be edited. Archive it and publish a new one.");
  }

  const fields = {
    title: "title",
    body: "body",
    category: "category",
    audience: "audience",
    status: "status",
    scheduledFor: "scheduled_for",
  };

  const values = [];
  const assignments = [];
  for (const [key, column] of Object.entries(fields)) {
    if (key === "scheduledFor") {
      // A schedule is meaningful only for a scheduled announcement; reverting to
      // DRAFT clears it so a later publish prompt cannot reuse a stale time.
      if (payload.status === "DRAFT" && payload.scheduledFor === undefined) {
        assignments.push("scheduled_for = NULL");
        continue;
      }
      if (payload.scheduledFor === undefined) continue;
    } else if (payload[key] === undefined) {
      continue;
    }
    values.push(payload[key]);
    assignments.push(`${column} = $${values.length + 1}`);
  }

  if (assignments.length === 0) throw new ConflictError("Provide at least one field to update.");

  const announcement = await queryOne(
    `UPDATE admin_announcements
        SET ${assignments.join(", ")}, updated_by = $${values.length + 2}, updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [announcementId, ...values, actorId],
    "announcements:update",
  );

  await recordAudit({
    actor: req?.user ?? { id: actorId },
    req,
    action: AUDIT.ANNOUNCEMENT_UPDATED,
    entityType: "announcement",
    entityId: announcementId,
    metadata: { changes: Object.keys(payload) },
    required: true,
  });

  return announcement;
}

/**
 * Publish one announcement and fan it out.
 *
 * The status transition is claimed with a conditional UPDATE first, so a manual
 * publish racing the scheduler can never deliver the same announcement twice.
 */
export async function publishAnnouncement(announcementId, actorId, { req, automatic = false } = {}) {
  const claimed = await queryOne(
    `UPDATE admin_announcements
        SET status = 'PUBLISHED', published_at = now(), updated_by = $2, updated_at = now()
      WHERE id = $1 AND status IN ('DRAFT', 'SCHEDULED')
      RETURNING ${COLUMNS}`,
    [announcementId, actorId ?? null],
    "announcements:claimPublish",
  );

  if (!claimed) {
    const existing = await queryOne("SELECT status FROM admin_announcements WHERE id = $1", [announcementId], "announcements:status");
    if (!existing) throw new NotFoundError("That announcement");
    throw new ConflictError(`That announcement is already ${existing.status.toLowerCase()}.`);
  }

  const recipients = await resolveAudience(claimed.audience);

  const delivery = await notifyMany(recipients, {
    type: NOTIFICATION_TYPE.SYSTEM,
    title: claimed.title,
    body: claimed.body,
    metadata: {
      announcementId: claimed.id,
      category: claimed.category,
      audience: claimed.audience,
      source: "admin_announcement",
    },
  });

  // Delivery stats are stored with the announcement so the console can show what
  // actually reached people, not merely that a button was pressed.
  const updated = await queryOne(
    `UPDATE admin_announcements
        SET metadata = metadata || $2::jsonb, updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [announcementId, JSON.stringify({ delivery: { ...delivery, deliveredAt: new Date().toISOString() } })],
    "announcements:deliveryStats",
  );

  await recordAudit({
    actor: req?.user ?? (actorId ? { id: actorId } : null),
    req,
    action: AUDIT.ANNOUNCEMENT_PUBLISHED,
    entityType: "announcement",
    entityId: announcementId,
    metadata: {
      automatic,
      audience: claimed.audience,
      attempted: delivery.attempted,
      delivered: delivery.delivered,
    },
    required: true,
  });

  return { announcement: updated, delivery };
}

export async function archiveAnnouncement(announcementId, actorId, { req } = {}) {
  return withTransaction(async (tx) => {
    const archived = await tx.queryOne(
      `UPDATE admin_announcements
          SET status = 'ARCHIVED', archived_at = now(), updated_by = $2, updated_at = now()
        WHERE id = $1 AND status <> 'ARCHIVED'
        RETURNING ${COLUMNS}`,
      [announcementId, actorId],
    );

    if (!archived) {
      const existing = await tx.queryOne("SELECT status FROM admin_announcements WHERE id = $1", [announcementId]);
      if (!existing) throw new NotFoundError("That announcement");
      throw new ConflictError("That announcement is already archived.");
    }

    await recordAudit(
      {
        actor: req?.user ?? { id: actorId },
        req,
        action: AUDIT.ANNOUNCEMENT_ARCHIVED,
        entityType: "announcement",
        entityId: announcementId,
        metadata: { previousStatus: archived.status },
      },
      { tx },
    );

    return archived;
  }, "announcements:archive");
}

/** Only an unsent draft or an archived record may be deleted. */
export async function deleteAnnouncement(announcementId, { req } = {}) {
  return withTransaction(async (tx) => {
    const deleted = await tx.queryOne(
      `DELETE FROM admin_announcements
        WHERE id = $1 AND status IN ('DRAFT', 'ARCHIVED')
        RETURNING id, title, status`,
      [announcementId],
    );

    if (!deleted) {
      const existing = await tx.queryOne("SELECT status FROM admin_announcements WHERE id = $1", [announcementId]);
      if (!existing) throw new NotFoundError("That announcement");
      throw new ConflictError("Published or scheduled announcements cannot be deleted. Archive it instead.");
    }

    await recordAudit(
      {
        actor: req?.user,
        req,
        action: AUDIT.ANNOUNCEMENT_DELETED,
        entityType: "announcement",
        entityId: announcementId,
        metadata: { title: deleted.title },
      },
      { tx },
    );

    return deleted;
  }, "announcements:delete");
}

/**
 * Scheduler tick. Called on an interval by the server. Returns the number of
 * announcements delivered so the caller can log something meaningful.
 */
export async function publishDueAnnouncements() {
  const due = await queryRows(
    `SELECT id FROM admin_announcements
      WHERE status = 'SCHEDULED' AND scheduled_for IS NOT NULL AND scheduled_for <= now()
      ORDER BY scheduled_for
      LIMIT 20`,
    [],
    "announcements:due",
  );

  let published = 0;
  for (const row of due) {
    try {
      await publishAnnouncement(row.id, null, { automatic: true });
      published += 1;
    } catch (error) {
      // A conflict here means another tick claimed it; anything else is logged so
      // one bad announcement cannot stop the rest of the batch.
      if (error.code !== "CONFLICT") {
        logger.error("Scheduled announcement failed to publish", { id: row.id, message: error.message });
      }
    }
  }
  return published;
}

/** Small summary for the dashboard/announcements header. */
export async function announcementSummary() {
  return queryOne(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = 'DRAFT')::int AS drafts,
       count(*) FILTER (WHERE status = 'SCHEDULED')::int AS scheduled,
       count(*) FILTER (WHERE status = 'PUBLISHED')::int AS published,
       count(*) FILTER (WHERE status = 'ARCHIVED')::int AS archived
     FROM admin_announcements`,
    [],
    "announcements:summary",
  );
}

export default {
  listAnnouncements,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  publishAnnouncement,
  archiveAnnouncement,
  deleteAnnouncement,
  publishDueAnnouncements,
  announcementSummary,
  resolveAudience,
};
