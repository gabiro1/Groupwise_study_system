import { query, queryOne, withTransaction } from "../config/db.js";
import env from "../config/env.js";
import { ROLES, USER_STATUS } from "../config/constants.js";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
  evaluateLockout,
  shouldResetFailureCount,
} from "../lib/crypto.js";
import {
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
  refreshTokenExpiry,
} from "../lib/tokens.js";
import {
  AppError,
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  InvalidCredentialsError,
  AccountLockedError,
  NotFoundError,
} from "../lib/errors.js";
import { recordAudit, AUDIT } from "../lib/audit.js";
import logger from "../config/logger.js";
import { sendMail } from "./mailer.js";

/**
 * Authentication service.
 *
 * Security properties this module is responsible for:
 *
 *  - Uniform failure behaviour. Login returns the same message whether the email
 *    is unknown or the password is wrong, and performs the same bcrypt work in
 *    both cases (see the dummy-hash comparison in crypto.js), so the endpoint
 *    cannot be used to enumerate accounts.
 *  - Password reset never reveals whether an address exists. The response is
 *    identical either way and the token is only emailed when the account is real.
 *  - Progressive lockout, per account, plus IP-level rate limiting in front.
 *  - Refresh tokens rotate on every use and are stored hashed, so a stolen
 *    refresh token has a bounded lifetime and reuse is detectable.
 */

const LOCKOUT_WINDOW_MIN = 30;

/** Public shape of a user, safe to return to the client. */
function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`.trim(),
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    emailVerified: Boolean(row.email_verified_at),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

/**
 * Create the default privacy and notification rows for a new user, so later
 * reads never have to handle a missing row.
 */
async function seedUserDefaults(tx, userId) {
  await tx.query("INSERT INTO privacy_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
  await tx.query(
    "INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
}

/**
 * Register a new student.
 *
 * Only STUDENT is accepted; the route-level schema enforces this so an
 * attacker cannot register themselves as an admin.
 */
export async function register({ email, password, firstName, lastName, universityId, programId, yearOfStudy }, { req, actor } = {}) {
  const normalisedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const { token: refreshToken, hash: refreshTokenHash } = createRefreshToken();
  const expiresAt = refreshTokenExpiry();

  const result = await withTransaction(async (tx) => {
    const role = await tx.queryOne("SELECT id, key FROM roles WHERE key = $1", [ROLES.STUDENT], "auth:role");
    if (!role) {
      // Seed data is missing, which is an operator error, not a user error.
      throw new AppError("Registration is not available right now. Please contact support.", { status: 503 });
    }

    const existing = await tx.queryOne(
      "SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL",
      [normalisedEmail],
      "auth:existing",
    );
    if (existing) {
      throw new ConflictError("An account already exists with that email address. Try signing in instead.");
    }

    if (universityId) {
      const university = await tx.queryOne("SELECT id FROM universities WHERE id = $1", [universityId], "auth:university");
      if (!university) throw new AppError("Select a university from the list.", { status: 422, code: "INVALID_UNIVERSITY" });
    }

    const user = await tx.queryOne(
      `INSERT INTO users (email, password_hash, role_id, status, first_name, last_name, password_changed_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       RETURNING id, email, first_name, last_name, avatar_url, status, email_verified_at,
                 created_at, role_id`,
      [normalisedEmail, passwordHash, role.id, USER_STATUS.ACTIVE, firstName.trim(), lastName.trim()],
      "auth:insert",
    );

    if (programId) {
      await tx.query(
        `INSERT INTO student_profiles (user_id, university_id, program_id, year_of_study)
         VALUES ($1, $2, $3, $4)`,
        [user.id, universityId, programId, yearOfStudy ?? 1],
        "auth:profile",
      );
    } else if (universityId) {
      await tx.query(
        "INSERT INTO student_profiles (user_id, university_id, year_of_study) VALUES ($1, $2, $3)",
        [user.id, universityId, yearOfStudy ?? 1],
        "auth:profile",
      );
    } else {
      await tx.query(
        "INSERT INTO student_profiles (user_id) VALUES ($1)",
        [user.id],
        "auth:profile",
      );
    }

    await tx.query(
      `INSERT INTO study_preferences (student_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [user.id],
    );

    await seedUserDefaults(tx, user.id);

    const session = await tx.queryOne(
      `INSERT INTO auth_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at, device_label)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        user.id,
        refreshTokenHash,
        req?.get?.("user-agent")?.slice(0, 300) ?? null,
        req?.ip ?? null,
        expiresAt,
        describeDevice(req),
      ],
      "auth:registerSession",
    );

    const authenticatedUser = { ...user, role: role.key };
    const accessToken = signAccessToken({
      userId: user.id,
      role: role.key,
      roleId: role.id,
      sessionId: session.id,
      email: user.email,
      name: `${user.first_name} ${user.last_name}`.trim(),
    });

    return { user: authenticatedUser, accessToken, refreshToken, expiresAt };
  }, "auth:register");

  await recordAudit(
    { action: AUDIT.AUTH_REGISTER, entityType: "USER", entityId: result.user.id, req, actor: actor ?? null },
  );

  return {
    user: publicUser(result.user),
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
  };
}

async function sendVerificationEmail(to, name, token) {
  const link = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const delivery = await sendMail({
    to,
    subject: "Confirm your Lien account",
    text: `Hi ${name},\n\nConfirm your email address to activate your Lien account:\n${link}\n\nThis link expires in 24 hours. If you did not create an account, you can ignore this email.`,
  });
  return {
    ...delivery,
    ...(!delivery.delivered && env.NODE_ENV === "development" ? { developmentUrl: link } : {}),
  };
}

async function sendPasswordResetEmail(to, name, token) {
  const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const delivery = await sendMail({
    to,
    subject: "Reset your Lien password",
    text: `Hi ${name},\n\nReset your password here:\n${link}\n\nThis link expires in 1 hour. If you did not request a reset, no action is needed and your password has not changed.`,
  });
  return {
    ...delivery,
    ...(!delivery.delivered && env.NODE_ENV === "development" ? { developmentUrl: link } : {}),
  };
}

/**
 * Verify an email address from a single-use token.
 * The token is consumed even on a second attempt, so a leaked link is
 * useless once used.
 */
export async function verifyEmail(token) {
  const tokenHash = hashToken(token);

  return withTransaction(async (tx) => {
    const row = await tx.queryOne(
      `SELECT id, user_id, expires_at, consumed_at FROM auth_tokens
        WHERE token_hash = $1 AND purpose = 'EMAIL_VERIFY'`,
      [tokenHash],
      "auth:verifyToken",
    );

    if (!row) throw new NotFoundError("That confirmation link is not valid.");
    if (row.consumed_at) throw new AppError("That link has already been used.", { status: 400, code: "TOKEN_USED" });
    if (new Date(row.expires_at) < new Date()) throw new AppError("That link has expired. Request a new one.", { status: 400, code: "TOKEN_EXPIRED" });

    await tx.query("UPDATE auth_tokens SET consumed_at = now() WHERE id = $1", [row.id]);
    await tx.query(
      `UPDATE users
          SET email_verified_at = COALESCE(email_verified_at, now()),
              status = CASE WHEN status = 'PENDING_VERIFICATION' THEN 'ACTIVE'::user_status ELSE status END
        WHERE id = $1`,
      [row.user_id],
      "auth:verifyUser",
    );

    return { verified: true };
  }, "auth:verifyEmail").then(async (result) => {
    await recordAudit({
      action: AUDIT.AUTH_EMAIL_VERIFIED,
      entityType: "USER",
      entityId: result.userId ?? null,
    });
    return result;
  });
}

/** Resend a verification email without disclosing whether the address exists. */
export async function resendVerification(email) {
  const user = await queryOne(
    "SELECT id, email, first_name, email_verified_at FROM users WHERE email = $1 AND deleted_at IS NULL",
    [email.trim().toLowerCase()],
    "auth:resendUser",
  );
  if (!user || user.email_verified_at) {
    return { message: "If an unverified account exists for that address, a new link has been sent." };
  }

  const token = generateToken(32);
  const tokenRow = await queryOne(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, 'EMAIL_VERIFY', $2, now() + interval '24 hours')
     RETURNING id`,
    [user.id, hashToken(token)],
    "auth:resendToken",
  );

  const delivery = await sendVerificationEmail(user.email, user.first_name, token);
  if (delivery.delivered || delivery.developmentUrl) {
    await query(
      `UPDATE auth_tokens SET consumed_at = now()
        WHERE user_id = $1 AND purpose = 'EMAIL_VERIFY'
          AND consumed_at IS NULL AND id <> $2`,
      [user.id, tokenRow.id],
      "auth:invalidateOldVerificationTokens",
    );
  }

  return {
    message: "If an unverified account exists for that address, a new link has been sent.",
    ...(delivery.developmentUrl ? { developmentVerificationUrl: delivery.developmentUrl } : {}),
  };
}

/**
 * Authenticate with email and password.
 *
 * @throws {InvalidCredentialsError} for every credential failure mode.
 * @throws {AccountLockedError} when the account is locked out.
 */
export async function login({ email: rawEmail, password: plaintext, rememberDevice = true }, { req } = {}) {
  const normalisedEmail = rawEmail.trim().toLowerCase();

  const user = await queryOne(
    `SELECT u.id, u.email, u.password_hash, u.first_name, u.last_name, u.avatar_url,
            u.status, u.email_verified_at, u.failed_login_count, u.locked_until,
            u.last_login_at, u.created_at, u.role_id, r.key AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.email = $1 AND u.deleted_at IS NULL`,
    [normalisedEmail],
    "auth:loginLookup",
  );

  // Unknown account: still perform a bcrypt comparison against a dummy hash so
  // the response time does not reveal whether the address is registered.
  if (!user) {
    await verifyPassword(plaintext, null);
    await recordAudit({ action: AUDIT.AUTH_LOGIN_FAILED, entityType: "USER", metadata: { reason: "unknown_email" }, req });
    throw new InvalidCredentialsError();
  }

  // Progressive lockout, evaluated before the password check.
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutes = Math.max(1, Math.ceil((new Date(user.locked_until) - Date.now()) / 60000));
    await recordAudit({ action: AUDIT.AUTH_LOGIN_LOCKED, entityType: "USER", entityId: user.id, req });
    throw new AccountLockedError(minutes);
  }

  const passwordOk = await verifyPassword(plaintext, user.password_hash);

  if (!passwordOk) {
    // Reset the counter if the last failure was long enough ago.
    const base = shouldResetFailureCount(user.last_login_at) ? 0 : user.failed_login_count;
    const failedCount = base + 1;
    const lock = evaluateLockout(failedCount);

    await query(
      `UPDATE users
          SET failed_login_count = $2,
              locked_until = COALESCE($3, locked_until)
        WHERE id = $1`,
      [user.id, failedCount, lock.locked ? lock.until : null],
      "auth:failedLogin",
    );

    await recordAudit({
      action: AUDIT.AUTH_LOGIN_FAILED,
      entityType: "USER",
      entityId: user.id,
      metadata: { failedCount, locked: lock.locked },
      req,
    });

    if (lock.locked) throw new AccountLockedError(lock.minutes);
    throw new InvalidCredentialsError();
  }

  // Password is correct from here on.
  if (user.status === USER_STATUS.SUSPENDED || user.status === USER_STATUS.DEACTIVATED) {
    await recordAudit({ action: AUDIT.AUTH_LOGIN_FAILED, entityType: "USER", entityId: user.id, metadata: { reason: user.status }, req });
    throw new ForbiddenError("This account has been suspended. Contact your university administrator for help.");
  }

  await query(
    "UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
    [user.id],
    "auth:loginSuccess",
  );

  const tokens = await issueSession(user, { req, rememberDevice });
  await recordAudit({
    action: AUDIT.AUTH_LOGIN_SUCCESS,
    entityType: "USER",
    entityId: user.id,
    metadata: { role: user.role },
    actor: { id: user.id, role: user.role },
    req,
  });

  return { user: publicUser({ ...user, last_login_at: new Date() }), ...tokens };
}

/**
 * Create a session: a hashed refresh token in the database plus a signed access
 * token for immediate use.
 */
export async function issueSession(user, { req, rememberDevice = true } = {}) {
  const { token: refreshToken, hash } = createRefreshToken();
  const baseExpiry = refreshTokenExpiry();
  const expiresAt = rememberDevice ? baseExpiry : new Date(Date.now() + 12 * 60 * 60 * 1000);

  const session = await queryOne(
    `INSERT INTO auth_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at, device_label)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      user.id,
      hash,
      req?.get?.("user-agent")?.slice(0, 300) ?? null,
      req?.ip ?? null,
      expiresAt,
      describeDevice(req),
    ],
    "auth:createSession",
  );

  const accessToken = signAccessToken({
    userId: user.id,
    role: user.role,
    roleId: user.role_id,
    sessionId: session.id,
    email: user.email,
    name: `${user.first_name} ${user.last_name}`.trim(),
  });

  return { accessToken, refreshToken, expiresAt, sessionId: session.id, user: publicUser(user) };
}

/** Best-effort friendly device name from the user agent. */
function describeDevice(req) {
  const agent = req?.get?.("user-agent");
  if (!agent) return "Unknown device";
  if (/iPhone|iPad/i.test(agent)) return "iOS device";
  if (/Android/i.test(agent)) return "Android device";
  if (/Macintosh/i.test(agent)) return "Mac";
  if (/Windows/i.test(agent)) return "Windows PC";
  if (/Linux/i.test(agent)) return "Linux computer";
  return "Web browser";
}

/**
 * Exchange a refresh token for a new pair, rotating the refresh token.
 *
 * Rotation means a leaked token is single-use: if an attacker replays a token
 * after the legitimate client has already refreshed, the lookup fails because
 * the hash no longer exists in the table.
 */
export async function refresh({ refreshToken }, { req } = {}) {
  const hash = hashRefreshToken(refreshToken);

  const session = await queryOne(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at,
            u.email, u.first_name, u.last_name, u.avatar_url, u.status,
            u.email_verified_at, u.role_id, u.last_login_at, u.created_at, r.key AS role
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
       JOIN roles r ON r.id = u.role_id
      WHERE s.refresh_token_hash = $1`,
    [hash],
    "auth:refreshLookup",
  );

  if (!session || session.revoked_at) {
    throw new AuthenticationError("Your session is no longer valid. Please sign in again.");
  }
  if (new Date(session.expires_at) < new Date()) {
    throw new AuthenticationError("Your session has expired. Please sign in again.");
  }
  if (session.status === USER_STATUS.SUSPENDED) {
    throw new ForbiddenError("This account has been suspended.");
  }

  // Rotate: revoke the presented token and issue a fresh one.
  await query(
    "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'rotated', last_used_at = now() WHERE id = $1",
    [session.id],
    "auth:rotate",
  );

  const next = await issueSession(
    { ...session, id: session.user_id },
    { req, rememberDevice: true },
  );

  await recordAudit({
    action: AUDIT.AUTH_TOKEN_REFRESH,
    entityType: "SESSION",
    entityId: session.id,
    actor: { id: session.user_id, role: session.role },
  });

  return next;
}

/** Revoke a single session (sign out on one device). */
export async function logout({ refreshToken, sessionId }, { actor, req } = {}) {
  if (refreshToken) {
    await query(
      "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'user_logout' WHERE refresh_token_hash = $1 AND revoked_at IS NULL",
      [hashRefreshToken(refreshToken)],
      "auth:logout",
    );
  } else if (sessionId) {
    await query(
      "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'user_logout' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [sessionId, actor.id],
      "auth:logoutById",
    );
  }

  await recordAudit({
    action: AUDIT.AUTH_LOGOUT,
    entityType: "SESSION",
    entityId: sessionId ?? null,
    actor,
    req,
  });

  return { success: true };
}

/** Revoke every other session for the user ("sign out everywhere"). */
export async function logoutAll({ userId, keepSessionId }, { actor, req } = {}) {
  const result = await query(
    `UPDATE auth_sessions
        SET revoked_at = now(), revoked_reason = 'logout_all'
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, keepSessionId ?? null],
    "auth:logoutAll",
  );

  await recordAudit({
    action: AUDIT.AUTH_LOGOUT_ALL,
    entityType: "USER",
    entityId: userId,
    metadata: { revokedCount: result.rowCount, keptSession: keepSessionId ?? null },
    actor,
    req,
  });

  return { revoked: result.rowCount ?? 0 };
}

/** Active sessions for the "your devices" screen. */
export async function listSessions({ userId, currentSessionId }) {
  const rows = await query(
    `SELECT id, device_label, user_agent, ip_address, last_used_at, created_at, expires_at
       FROM auth_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_used_at DESC`,
    [userId],
    "auth:listSessions",
  );

  return {
    sessions: rows.rows.map((row) => ({
      id: row.id,
      deviceLabel: row.device_label,
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      current: row.id === currentSessionId,
    })),
  };
}

/**
 * Begin a password reset.
 *
 * Returns `{ sent: true }` regardless of whether the address exists, so this
 * endpoint cannot be used to discover registered email addresses.
 */
export async function requestPasswordReset({ email: rawEmail }, { req } = {}) {
  const normalisedEmail = rawEmail.trim().toLowerCase();

  const user = await queryOne(
    "SELECT id, email, first_name, status FROM users WHERE email = $1 AND deleted_at IS NULL",
    [normalisedEmail],
    "auth:resetLookup",
  );

  if (!user) {
    // Log the attempt without the address, then return the same response.
    await recordAudit({ action: AUDIT.AUTH_PASSWORD_RESET_REQUESTED, entityType: "USER", metadata: { found: false }, req });
    return { sent: true };
  }

  const token = generateToken(32);
  await query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, 'PASSWORD_RESET', $2, now() + interval '1 hour')`,
    [user.id, hashToken(token)],
    "auth:resetToken",
  );

  const delivery = await sendPasswordResetEmail(user.email, user.first_name, token);

  await recordAudit({
    action: AUDIT.AUTH_PASSWORD_RESET_REQUESTED,
    entityType: "USER",
    entityId: user.id,
    metadata: { found: true },
    req,
  });

  return {
    sent: true,
    ...(delivery.developmentUrl ? { developmentResetUrl: delivery.developmentUrl } : {}),
  };
}

/**
 * Complete a password reset.
 *
 * Revokes every existing session on success — if the reason someone reset their
 * password is that it may have been compromised, leaving old sessions alive
 * would defeat the purpose.
 */
export async function resetPassword({ token, password }, { req } = {}) {
  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(password);

  const userId = await withTransaction(async (tx) => {
    const row = await tx.queryOne(
      `SELECT id, user_id, expires_at, consumed_at FROM auth_tokens
        WHERE token_hash = $1 AND purpose = 'PASSWORD_RESET'`,
      [tokenHash],
      "auth:resetLookupToken",
    );

    if (!row) throw new NotFoundError("That reset link is not valid.");
    if (row.consumed_at) throw new AppError("That link has already been used.", { status: 400, code: "TOKEN_USED" });
    if (new Date(row.expires_at) < new Date()) {
      throw new AppError("That reset link has expired. Request a new one.", { status: 400, code: "TOKEN_EXPIRED" });
    }

    await tx.query("UPDATE auth_tokens SET consumed_at = now() WHERE id = $1", [row.id]);
    await tx.query(
      `UPDATE users
          SET password_hash = $2,
              password_changed_at = now(),
              failed_login_count = 0,
              locked_until = NULL,
              must_change_password = FALSE,
              status = CASE WHEN status = 'PENDING_VERIFICATION' THEN 'ACTIVE'::user_status ELSE status END
        WHERE id = $1`,
      [row.user_id, passwordHash],
      "auth:resetApply",
    );

    // Kill all sessions: the old password must no longer grant access.
    await tx.query(
      "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL",
      [row.user_id],
      "auth:resetRevokeSessions",
    );

    return row.user_id;
  }, "auth:resetPassword");

  await recordAudit({
    action: AUDIT.AUTH_PASSWORD_RESET_COMPLETED,
    entityType: "USER",
    entityId: userId,
    req,
  });

  return { success: true };
}

/** Change password for a signed-in user. */
export async function changePassword({ userId, currentPassword, newPassword, logoutOtherSessions = true }, { req, actor } = {}) {
  const user = await queryOne(
    "SELECT id, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL",
    [userId],
    "auth:changeLookup",
  );
  if (!user) throw new NotFoundError("That account");

  const ok = await verifyPassword(currentPassword, user.password_hash);
  if (!ok) {
    throw new InvalidCredentialsError("That is not your current password.");
  }

  const passwordHash = await hashPassword(newPassword);

  await query(
    `UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`,
    [userId, passwordHash],
    "auth:changeApply",
  );

  if (logoutOtherSessions) {
    // Keep the current session so the user is not signed out of the tab they are using.
    await query(
      `UPDATE auth_sessions
          SET revoked_at = now(), revoked_reason = 'password_changed'
        WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
      [userId, req?.sessionId ?? null],
      "auth:changeRevoke",
    );
  }

  await recordAudit({
    action: AUDIT.AUTH_PASSWORD_CHANGED,
    entityType: "USER",
    entityId: userId,
    actor,
    req,
  });

  return { success: true };
}

export { publicUser, LOCKOUT_WINDOW_MIN };

export default {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  listSessions,
  verifyEmail,
  resendVerification,
  requestPasswordReset,
  resetPassword,
  changePassword,
};