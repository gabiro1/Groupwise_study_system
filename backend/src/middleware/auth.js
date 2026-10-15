import { verifyAccessToken } from "../lib/tokens.js";
import { queryOne } from "../config/db.js";
import {
  AuthenticationError,
  AccountSuspendedError,
  ForbiddenError,
  EmailNotVerifiedError,
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
            u.locked_until, u.last_login_at, u.created_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
    "auth:loadUser",
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
    if (user && user.status === "ACTIVE") {
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

/**
 * A "student" in the product sense: a plain student or a group leader. Leading a
 * group is an additional responsibility layered on a student account, so a group
 * leader keeps every student capability.
 */
export const requireStudent = requireRole("STUDENT", "GROUP_LEADER");
export const requireAdmin = requireRole("ADMIN");

/** Staff = administrators. Group leaders are students with extra group duties. */
export const requireStaff = requireRole("ADMIN");

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
  requireAdmin,
  requireStaff,
  requireVerifiedEmail,
  loadUser,
};