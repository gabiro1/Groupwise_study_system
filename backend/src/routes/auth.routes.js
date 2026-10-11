import { Router } from "express";
import { z } from "zod";
import env from "../config/env.js";
import { asyncHandler, ok, created, noContent } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { refreshCsrfCookie, clearCsrfCookie } from "../middleware/csrf.js";
import {
  REFRESH_COOKIE_NAME,
  ACCESS_COOKIE_NAME,
  cookieOptions,
} from "../lib/tokens.js";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  changePasswordSchema,
  verifyEmailSchema,
  listSessionsSchema,
  revokeSessionSchema,
} from "../lib/schemas.js";
import * as authService from "../services/auth.service.js";

const router = Router();

/**
 * Cookies.
 *
 * Both tokens are httpOnly, so client-side JavaScript cannot read them. This is
 * the single most important XSS mitigation in the auth flow: an injected script
 * cannot exfiltrate a session.
 *
 * The CSRF cookie is the deliberate exception, and must stay readable so the
 * browser can echo it in a header.
 */
function setAuthCookies(res, { accessToken, refreshToken, expiresAt }) {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    ...cookieOptions({ maxAgeMs: env.ACCESS_TOKEN_TTL_MIN * 60_000 }),
  });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...cookieOptions({ maxAgeMs: expiresAt.getTime() - Date.now() }),
  });
}

function clearAuthCookies(res) {
  const options = { ...cookieOptions(), maxAge: undefined };
  res.clearCookie(ACCESS_COOKIE_NAME, options);
  res.clearCookie(REFRESH_COOKIE_NAME, options);
  clearCsrfCookie(res);
}

router.get("/csrf", asyncHandler(async (req, res) => ok(res, { csrfToken: req.csrfToken })));

/**
 * POST /api/auth/register
 * Creates a student account and starts an authenticated session immediately.
 */
router.post(
  "/register",
  authLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.register(req.body, { req });
    setAuthCookies(res, result);
    refreshCsrfCookie(res);
    return created(res, { user: result.user, expiresAt: result.expiresAt });
  }),
);

/**
 * POST /api/auth/login
 * Sets httpOnly session cookies and returns the user for immediate use.
 */
router.post(
  "/login",
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body, { req });
    setAuthCookies(res, result);
    refreshCsrfCookie(res);
    return ok(res, { user: result.user, expiresAt: result.expiresAt });
  }),
);

/**
 * POST /api/auth/refresh
 * Rotates the session. Called automatically by the BFF on a 401, never by hand.
 */
router.post(
  "/refresh",
  validate({ body: z.object({ refreshToken: z.string().min(10).optional() }) }),
  asyncHandler(async (req, res) => {
    const refreshToken = req.body?.refreshToken ?? req.cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      return ok(res, { user: null, reason: "no_session" });
    }

    let result;
    try {
      result = await authService.refresh({ refreshToken }, { req });
    } catch (error) {
      if (error.status === 401) clearAuthCookies(res);
      throw error;
    }
    setAuthCookies(res, result);
    refreshCsrfCookie(res);
    return ok(res, { user: result.user, expiresAt: result.expiresAt });
  }),
);

/**
 * POST /api/auth/logout
 * Revokes the session server-side, then clears the cookies. Clearing cookies
 * alone would leave a valid refresh token in the database.
 */
router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (refreshToken) {
      await authService.logout({ refreshToken }, { actor: req.user, req });
    }
    clearAuthCookies(res);
    return ok(res, { success: true });
  }),
);

/** POST /api/auth/logout-all — sign out on every device. */
router.post(
  "/logout-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.logoutAll(
      { userId: req.user.id, keepSessionId: req.sessionId },
      { actor: req.user, req },
    );
    // Revoking the current session too is the point of "everywhere".
    clearAuthCookies(res);
    return ok(res, result);
  }),
);

/** GET /api/auth/sessions — active devices for the security settings page. */
router.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.listSessions({
      userId: req.user.id,
      currentSessionId: req.sessionId,
    });
    return ok(res, result);
  }),
);

/** DELETE /api/auth/sessions — revoke one session, or all others. */
router.delete(
  "/sessions",
  requireAuth,
  validate({ body: revokeSessionSchema }),
  asyncHandler(async (req, res) => {
    if (req.body.all) {
      const result = await authService.logoutAll(
        { userId: req.user.id, keepSessionId: req.sessionId },
        { actor: req.user, req },
      );
      return ok(res, result);
    }

    if (!req.body.sessionId) {
      return noContent(res);
    }

    await authService.logout(
      { sessionId: req.body.sessionId },
      { actor: req.user, req },
    );
    return noContent(res);
  }),
);

/** POST /api/auth/verify-email */
router.post(
  "/verify-email",
  validate({ body: verifyEmailSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.verifyEmail(req.body.token);
    return ok(res, result);
  }),
);

/** POST /api/auth/resend-verification */
router.post(
  "/resend-verification",
  authLimiter,
  validate({ body: resendVerificationSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.resendVerification(req.body.email);
    return ok(res, result);
  }),
);

/**
 * POST /api/auth/forgot-password
 *
 * Always returns the same message. The response must not reveal whether an
 * account exists, so both branches are identical.
 */
router.post(
  "/forgot-password",
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.requestPasswordReset(req.body, { req });
    return ok(res, {
      message: "If an account exists for that email, a reset link is on its way.",
      ...(result.developmentResetUrl ? { developmentResetUrl: result.developmentResetUrl } : {}),
    });
  }),
);

/** POST /api/auth/reset-password */
router.post(
  "/reset-password",
  authLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.resetPassword(req.body, { req });
    return ok(res, { ...result, message: "Your password has been changed. Please sign in." });
  }),
);

/** POST /api/auth/change-password */
router.post(
  "/change-password",
  requireAuth,
  authLimiter,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const result = await authService.changePassword(
      { userId: req.user.id, ...req.body },
      { req, actor: req.user },
    );
    return ok(res, result);
  }),
);

/**
 * GET /api/auth/me
 * Used by the BFF to hydrate the session on first paint, and by clients to
 * confirm the current identity.
 */
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    return ok(res, { user: authService.publicUser(req.user) });
  }),
);

export default router;