import { verifyAccessToken } from "../lib/tokens.js";
import { queryOne } from "../config/db.js";
import {
  AuthenticationError,
  AccountSuspendedError,
  ForbiddenError,
  EmailNotVerifiedError,
  NotFoundError,
} from "../lib/errors.js";
import logger from "../config/logger.js";

/**
 * Authentication and authorisation middleware.
 *
 * The single most important rule in this file: authorisation is *always*
 * re-derived from the database on privileged routes. The JWT carries a role for
 * cheap rejections, but `requireRole` re-reads the user's current role so a
 * demotion takes effect immediately rather than whenever their access token
 * happens to expire.
 *
 * Nothing here trusts `req.body.userId`, a client-supplied role, or a
 * client-supplied group id.
 */

/** Extract the bearer token from the Authorization header, or the access cookie. */
function extractToken(req) {
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  return req.cookies?.lien_access || null;
}

/**
 * Load the authenticated user and attach it to the request.
 * Unverified users may sign in, but suspended or deleted accounts are rejected
 * at the boundary; verification requirements are applied to sensitive actions.
 */
export async function loadUser(userId) {
  return queryOne(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, u.status,
            u.email_verified_at, u.role_id, r.key AS role, u.deleted_at,
            u.locked_until, u.last_login_at, u.created_at,
            sp.student_number, sp.admission_year, sp.current_semester,
            sp.registration_number_verified_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
    "auth:loadUser",
  );
}

/**
 * Access JWTs are intentionally short-lived, but their session id still needs
 * to be checked so an administrator's revocation takes effect immediately.
 * Tokens issued by this service always carry a persisted session id.
 */
export async function loadActiveSession(sessionId, userId) {
  if (!sessionId || !userId) return null;
  return queryOne(
    `SELECT id
       FROM auth_sessions
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [sessionId, userId],
    "auth:activeSession",
  );
}

/**
 * Require a valid access token. Populates `req.user` and `req.sessionId`.
 */
export async function requireAuth(req, _res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw new AuthenticationError();

    // issuer / audience / algorithm pinning are enforced inside verifyAccessToken.
    const payload = verifyAccessToken(token);
    const user = await loadUser(payload.sub);

    if (!user) throw new AuthenticationError("Your account is no longer available.");
    if (user.status === "SUSPENDED" || user.status === "DEACTIVATED") throw new AccountSuspendedError();
    if (!(await loadActiveSession(payload.sid, user.id))) {
      throw new AuthenticationError("Your session is no longer valid. Please sign in again.");
    }

    req.user = user;
    req.sessionId = payload.sid;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Attach the user when a token is present, but never reject. Used by endpoints
 * that personalise output for signed-in users while remaining usable anonymously.
 */
export async function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  if (!token) return next();

  try {
    const payload = verifyAccessToken(token);
    const user = await loadUser(payload.sub);
    if (user && user.status === "ACTIVE" && (await loadActiveSession(payload.sid, user.id))) {
      req.user = user;
      req.sessionId = payload.sid;
    }
  } catch {
    // An invalid token on an optional route is simply treated as anonymous.
  }
  return next();
}

/**
 * Role gate. Always re-reads the role from the database so that a role change
 * takes effect immediately instead of at token expiry.
 *
 * `requireAuth` must run first — this middleware depends on `req.user`.
 *
 * @param {...string} allowedRoles
 */
export function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles.flat());

  return async function roleGuard(req, _res, next) {
    try {
      if (!req.user) throw new AuthenticationError();

      const fresh = await queryOne("SELECT key FROM roles WHERE id = $1", [req.user.role_id], "auth:role");
      const role = fresh?.key;

      if (!role || !allowed.has(role)) {
        logger.warn("Role check denied", {
          userId: req.user.id,
          role,
          attempted: [...allowed],
          path: req.originalUrl,
        });
        throw new ForbiddenError("Your account does not have access to this area.");
      }

      req.user.role = role;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Global account roles are STUDENT and ADMIN; leadership is membership-scoped. */
export const requireStudent = requireRole("STUDENT");
export const requireAdmin = requireRole("ADMIN");

/** Require at least one active OWNER/MODERATOR membership. */
export async function requireGroupLeader(req, _res, next) {
  try {
    if (!req.user) throw new AuthenticationError();

    const leadership = await queryOne(
      `SELECT 1
         FROM study_group_members m
         JOIN study_groups g ON g.id = m.group_id AND g.status = 'ACTIVE'
        WHERE m.student_id = $1 AND m.left_at IS NULL AND m.status = 'ACTIVE'
          AND m.role IN ('OWNER', 'MODERATOR')
        LIMIT 1`,
      [req.user.id],
      "auth:groupLeadership",
    );

    if (!leadership) throw new ForbiddenError("You do not lead an active study group.");
    return next();
  } catch (error) {
    return next(error);
  }
}

/** Staff = administrators. */
export const requireStaff = requireRole("ADMIN");

/**
 * Authorise access to one study group.
 *
 * The group id is always read from the route params (never from a body field the
 * client could point at a group they do not belong to). Access is re-derived
 * from `study_group_members` on every request.
 *
 * @param {{param?:string, requireLeader?:boolean}} [options]
 *   `param` names the route parameter holding the group id (default `groupId`).
 *   `requireLeader` restricts access to the group's OWNER/MODERATOR (admins still
 *   pass, so the same guard can serve admin endpoints).
 */
export function authorizeGroupAccess({ param = "groupId", requireLeader = false } = {}) {
  return async function groupGuard(req, _res, next) {
    try {
      if (!req.user) throw new AuthenticationError();

      // Admins oversee every group; the administrative routes apply their own
      // role guard, so allowing them here keeps the guard reusable.
      if (req.user.role === "ADMIN") return next();

      const groupId = req.params?.[param];
      if (!groupId) throw new NotFoundError("That group");

      const membership = await queryOne(
        `SELECT m.role, g.status
           FROM study_group_members m
           JOIN study_groups g ON g.id = m.group_id
          WHERE m.group_id = $1 AND m.student_id = $2 AND m.left_at IS NULL
            AND m.status = 'ACTIVE' AND g.status = 'ACTIVE'`,
        [groupId, req.user.id],
        "auth:groupMembership",
      );

      // A non-member gets the same answer as a missing group: membership must not
      // be probeable by iterating ids.
      if (!membership) throw new NotFoundError("That group");

      if (requireLeader && !["OWNER", "MODERATOR"].includes(membership.role)) {
        throw new ForbiddenError("Only the group's leaders can do that.");
      }

      req.groupMembership = membership;
      req.groupId = groupId;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Require a verified email address. Used for actions where an unverified
 * account could otherwise be used to spam invitations.
 */
export function requireVerifiedEmail(req, _res, next) {
  if (!req.user?.email_verified_at) {
    return next(new EmailNotVerifiedError());
  }
  return next();
}

export default {
  requireAuth,
  optionalAuth,
  requireRole,
  requireStudent,
  requireGroupLeader,
  requireAdmin,
  requireStaff,
  authorizeGroupAccess,
  requireVerifiedEmail,
  loadUser,
  loadActiveSession,
};
