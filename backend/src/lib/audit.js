import { query } from "../config/db.js";
import logger from "../config/logger.js";

/**
 * Audit logging.
 *
 * Records security-relevant and administrative events. Two rules govern what
 * goes in:
 *
 *  1. Never log credentials. Callers pass an explicit metadata object, and this
 *     module refuses to serialise known-sensitive keys even if a caller slips.
 *  2. Ordinary audit writes must never break the request. A failure here is
 *     logged and swallowed. Transaction-scoped and explicitly required writes
 *     are different: their callers have declared the audit trail load-bearing.
 */

const FORBIDDEN_KEY_PARTS = [
  "password",
  "passwordhash",
  "token",
  "apikey",
  "accesskey",
  "secretkey",
  "authorization",
  "cookie",
  "secret",
  "credential",
  "privatekey",
  "csrf",
  "sessionid",
  "jwt",
];

function isForbiddenKey(key) {
  const normalised = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return FORBIDDEN_KEY_PARTS.some((part) => normalised.includes(part));
}

function sanitiseValue(value, seen, depth) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}...`;
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 8) return "[truncated]";
  if (seen.has(value)) return "[circular]";

  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => sanitiseValue(entry, seen, depth + 1));
  } else {
    result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isForbiddenKey(key)) continue;
      result[key] = sanitiseValue(entry, seen, depth + 1);
    }
  }
  seen.delete(value);
  return result;
}

/** Remove sensitive values at every nesting level before JSON serialisation. */
export function sanitiseMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  return sanitiseValue(metadata, new WeakSet(), 0);
}

/**
 * @param {object} event
 * @param {string} event.action        e.g. 'auth.login.success'
 * @param {string} event.entityType    e.g. 'USER'
 * @param {string} [event.entityId]
 * @param {object} [event.metadata]
 * @param {object} [event.actor]       req.user
 * @param {object} [event.req]         used for ip / user-agent only
 * @param {string} [event.outcome]     'SUCCESS' | 'FAILURE' | 'PARTIAL'. Defaults to
 *   'SUCCESS'. An audit row is immutable, so this is written once at insert.
 * @param {boolean} [event.required]   Re-throw an audit failure even without a
 *   transaction. Use for critical administrative changes that cannot be silently
 *   accepted without a trace.
 * @param {object} [event.tx]          transaction-scoped query runner. When given,
 *   the audit row commits or rolls back with the action it describes, which is
 *   what administrative mutations want: an admin action without its audit trail
 *   should not exist.
 * @param {object} [options]           legacy call shape: `recordAudit(event, { tx })`.
 *   Both forms are accepted because older route modules pass the transaction
 *   separately; ignoring it silently would leave audit rows behind on rollback.
 *   `required: true` is also accepted for non-transactional critical events.
 */
export async function recordAudit(
  {
    action,
    entityType,
    entityId,
    metadata,
    actor,
    req,
    outcome = "SUCCESS",
    required = false,
    tx,
  },
  options = {},
) {
  const transaction = tx ?? options?.tx ?? null;
  const mustSucceed = transaction || required || options?.required === true;
  try {
    const run = transaction ?? { query };
    const safeOutcome = ["SUCCESS", "FAILURE", "PARTIAL"].includes(outcome) ? outcome : "SUCCESS";

    await run.query(
      `INSERT INTO audit_logs
         (actor_id, actor_role, action, entity_type, entity_id, metadata, outcome, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        actor?.id ?? null,
        actor?.role ?? null,
        action,
        entityType,
        entityId ?? null,
        JSON.stringify(sanitiseMetadata(metadata)),
        safeOutcome,
        req?.ip ?? null,
        req?.get?.("user-agent")?.slice(0, 300) ?? null,
      ],
      "audit:insert",
    );
  } catch (error) {
    // Deliberately non-fatal for ordinary events, so a logging failure cannot
    // fail a student's request. Transactional and explicitly required events
    // propagate: rolling back or surfacing the action failure is the caller's
    // intent.
    logger.error("Failed to write audit log", {
      action,
      entityType,
      entityId,
      message: error.message,
    });

    if (mustSucceed) throw error;
  }
}

/** Named audit actions, so the log is greppable and consistent. */
export const AUDIT = Object.freeze({
  AUTH_REGISTER: "auth.register",
  AUTH_LOGIN_SUCCESS: "auth.login.success",
  AUTH_LOGIN_FAILED: "auth.login.failed",
  AUTH_LOGIN_LOCKED: "auth.login.locked",
  AUTH_LOGOUT: "auth.logout",
  AUTH_LOGOUT_ALL: "auth.logout.all",
  AUTH_TOKEN_REFRESH: "auth.token.refresh",
  AUTH_PASSWORD_RESET_REQUESTED: "auth.password_reset.requested",
  AUTH_PASSWORD_RESET_COMPLETED: "auth.password_reset.completed",
  AUTH_PASSWORD_CHANGED: "auth.password.changed",
  AUTH_EMAIL_VERIFIED: "auth.email.verified",

  ROLE_CHANGED: "admin.role.changed",
  ACCOUNT_SUSPENDED: "admin.account.suspended",
  ACCOUNT_RESTORED: "admin.account.restored",
  ACCOUNT_DEACTIVATED: "admin.account.deactivated",

  UNIVERSITY_CREATED: "admin.university.created",
  UNIVERSITY_UPDATED: "admin.university.updated",
  FACULTY_CREATED: "admin.faculty.created",
  DEPARTMENT_CREATED: "admin.department.created",
  PROGRAM_CREATED: "admin.program.created",
  COURSE_CREATED: "admin.course.created",
  COURSE_UPDATED: "admin.course.updated",
  COURSE_ARCHIVED: "admin.course.archived",
  COURSE_DELETED: "admin.course.deleted",
  TOPIC_CREATED: "admin.topic.created",
  TOPIC_UPDATED: "admin.topic.updated",
  SKILL_CREATED: "admin.skill.created",

  CATALOGUE_REQUEST_CREATED: "catalogue_request.created",
  CATALOGUE_REQUEST_APPROVED: "admin.catalogue_request.approved",
  CATALOGUE_REQUEST_DECLINED: "admin.catalogue_request.declined",

  REPORT_RESOLVED: "admin.report.resolved",
  REPORT_DISMISSED: "admin.report.dismissed",
  REPORT_ACTIONED: "admin.report.actioned",

  SETTINGS_UPDATED: "admin.settings.updated",
  SETTING_DELETED: "admin.setting.deleted",
  WEIGHTS_UPDATED: "admin.recommendation.weights.updated",
  RECOMMENDATION_TRAINING_REQUESTED: "admin.recommendation.training.requested",
  RECOMMENDATION_MODEL_REGISTERED: "admin.recommendation.model.registered",
  RECOMMENDATION_MODEL_ACTIVATED: "admin.recommendation.model.activated",
  RECOMMENDATION_MODEL_DEACTIVATED: "admin.recommendation.model.deactivated",
  RECOMMENDATION_PERSONALIZATION_UPDATED: "admin.recommendation.personalization.updated",
  RECOMMENDATION_CIRCUIT_RESET: "admin.recommendation.circuit.reset",

  GROUP_CREATED: "group.created",
  GROUP_UPDATED: "group.updated",
  GROUP_ARCHIVED: "group.archived",
  GROUP_MEMBER_REMOVED: "group.member.removed",
  GROUP_MEMBER_LEFT: "group.member.left",
  GROUP_INVITATION_SENT: "group.invitation.sent",
  GROUP_INVITATION_ACCEPTED: "group.invitation.accepted",
  GROUP_JOIN_REQUESTED: "group.join_requested",
  GROUP_JOIN_APPROVED: "group.join.approved",

  GROUP_LEADER_ASSIGNED: "admin.group_leader.assigned",
  GROUP_LEADER_REMOVED: "admin.group_leader.removed",
  GROUP_SUSPENDED: "admin.group.suspended",
  GROUP_RESTORED: "admin.group.restored",
  GROUP_ARCHIVED_BY_ADMIN: "admin.group.archived",
  GROUP_MEMBER_REMOVED_BY_ADMIN: "admin.group.member.removed",
  GROUP_JOIN_REQUEST_DECIDED_BY_ADMIN: "admin.group.join_request.decided",
  ACCOUNT_DELETED: "admin.account.deleted",
  SESSION_CANCELLED: "admin.session.cancelled",

  ANNOUNCEMENT_CREATED: "admin.announcement.created",
  ANNOUNCEMENT_UPDATED: "admin.announcement.updated",
  ANNOUNCEMENT_PUBLISHED: "admin.announcement.published",
  ANNOUNCEMENT_ARCHIVED: "admin.announcement.archived",
  ANNOUNCEMENT_DELETED: "admin.announcement.deleted",
  ANNOUNCEMENT_SENT: "admin.announcement.sent",

  AI_CONFIG_UPDATED: "admin.ai.config.updated",
  AI_PROVIDER_RESET: "admin.ai.provider.reset",
  AI_PROVIDER_TESTED: "admin.ai.provider.tested",
  AI_PROVIDER_CREATED: "admin.ai.provider.created",
  AI_PROVIDER_UPDATED: "admin.ai.provider.updated",
  AI_PROVIDER_REMOVED: "admin.ai.provider.removed",
  AI_PROVIDER_DISCOVERY: "admin.ai.provider.discovery",

  ADMIN_BOOTSTRAP: "admin.bootstrap.created",
  USER_UPDATED_BY_ADMIN: "admin.user.updated",

  MAINTENANCE_ENABLED: "admin.maintenance.enabled",
  MAINTENANCE_DISABLED: "admin.maintenance.disabled",

  RESOURCE_DELETED: "resource.deleted",
  MODERATION_MESSAGE_REMOVED: "moderation.message.removed",

  AI_CONVERSATION_CREATED: "ai.conversation.created",
  AI_MESSAGE_ADDED: "ai.message.added",
});

export default { recordAudit, AUDIT, sanitiseMetadata };
