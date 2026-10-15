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
 *  2. Audit writes must never break the request. A failure here is logged as an
 *     error and swallowed — losing an audit row is bad, but returning a 500 to a
 *     student who just completed an action is worse.
 */

const FORBIDDEN_KEYS = new Set([
  "password",
  "newPassword",
  "currentPassword",
  "passwordHash",
  "token",
  "refreshToken",
  "accessToken",
  "authorization",
  "cookie",
  "secret",
  "apiKey",
]);

function sanitiseMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (typeof value === "string" && value.length > 500) {
      out[key] = `${value.slice(0, 500)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {object} event
 * @param {string} event.action        e.g. 'auth.login.success'
 * @param {string} event.entityType    e.g. 'USER'
 * @param {string} [event.entityId]
 * @param {object} [event.metadata]
 * @param {object} [event.actor]       req.user
 * @param {object} [event.req]         used for ip / user-agent only
 * @param {object} [event.tx]          transaction-scoped query runner. When given,
 *   the audit row commits or rolls back with the action it describes, which is
 *   what administrative mutations want: an admin action without its audit trail
 *   should not exist.
 */
export async function recordAudit({ action, entityType, entityId, metadata, actor, req, tx }) {
  try {
    const run = tx ?? { query };

    await run.query(
      `INSERT INTO audit_logs
         (actor_id, actor_role, action, entity_type, entity_id, metadata, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        actor?.id ?? null,
        actor?.role ?? null,
        action,
        entityType,
        entityId ?? null,
        JSON.stringify(sanitiseMetadata(metadata)),
        req?.ip ?? null,
        req?.get?.("user-agent")?.slice(0, 300) ?? null,
      ],
      "audit:insert",
    );
  } catch (error) {
    // Deliberately non-fatal when there is no surrounding transaction, so a
    // logging failure cannot fail a student's request. Inside a transaction the
    // error still propagates: rolling back is the caller's intent.
    logger.error("Failed to write audit log", {
      action,
      entityType,
      entityId,
      message: error.message,
    });

    if (tx) throw error;
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
  WEIGHTS_UPDATED: "admin.recommendation.weights.updated",

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
  ANNOUNCEMENT_SENT: "admin.announcement.sent",
  AI_PROVIDER_RESET: "admin.ai.provider.reset",

  RESOURCE_DELETED: "resource.deleted",
  MODERATION_MESSAGE_REMOVED: "moderation.message.removed",

  AI_CONVERSATION_CREATED: "ai.conversation.created",
  AI_MESSAGE_ADDED: "ai.message.added",
});

export default { recordAudit, AUDIT };