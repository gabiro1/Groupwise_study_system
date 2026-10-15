/**
 * Domain error hierarchy.
 *
 * Every error thrown deliberately inside a service carries a `status`, a stable
 * machine `code`, an optional field map for form binding, and an optional
 * `context` that is logged but never serialised to the client.
 */
export class AppError extends Error {
  /**
   * @param {string} message Human-readable, safe to display.
   * @param {object} [options]
   * @param {number} [options.status=500]
   * @param {string} [options.code='APP_ERROR']
   * @param {Record<string,string>} [options.fields]
   * @param {boolean} [options.expected=false] Expected errors are logged at warn, not error.
   * @param {object} [options.context]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.status = options.status ?? 500;
    this.code = options.code ?? "APP_ERROR";
    this.fields = options.fields;
    this.expected = options.expected ?? this.status < 500;
    this.context = options.context;
    this.expose = true;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(fields, message = "Please check the highlighted fields and try again.") {
    super(message, { status: 422, code: "VALIDATION_FAILED", fields });
    this.fields = fields;
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "You need to sign in to continue.") {
    super(message, { status: 401, code: "UNAUTHENTICATED" });
  }
}

export class InvalidCredentialsError extends AppError {
  constructor(message = "That email and password combination is not correct.") {
    super(message, { status: 401, code: "INVALID_CREDENTIALS" });
  }
}

export class SessionExpiredError extends AppError {
  constructor(message = "Your session has expired. Please sign in again.") {
    super(message, { status: 401, code: "SESSION_EXPIRED" });
  }
}

export class AccountLockedError extends AppError {
  constructor(retryAfterMinutes) {
    super(
      `Too many failed sign-in attempts. Try again in ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? "" : "s"}.`,
      { status: 423, code: "ACCOUNT_LOCKED" },
    );
    this.retryAfterMinutes = retryAfterMinutes;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, retryAfterMinutes: this.retryAfterMinutes } };
  }
}

export class AccountSuspendedError extends AppError {
  constructor(message = "This account has been suspended. Contact your university administrator for help.") {
    super(message, { status: 403, code: "ACCOUNT_SUSPENDED" });
  }
}

export class EmailNotVerifiedError extends AppError {
  constructor(message = "Please verify your email address before continuing.") {
    super(message, { status: 403, code: "EMAIL_NOT_VERIFIED" });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that.") {
    super(message, { status: 403, code: "FORBIDDEN" });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "That item") {
    super(`${resource} could not be found.`, { status: 404, code: "NOT_FOUND" });
    this.resource = resource;
  }
}

export class ConflictError extends AppError {
  constructor(message = "That action conflicts with the current state of this study group.", options = {}) {
    super(message, { status: 409, code: "CONFLICT", ...options });
  }
}

export class CapacityError extends AppError {
  constructor(message = "This study group is already full.") {
    super(message, { status: 409, code: "GROUP_FULL" });
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests. Please wait a moment and try again.", retryAfterSeconds) {
    super(message, { status: 429, code: "RATE_LIMITED" });
    this.retryAfterSeconds = retryAfterSeconds;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, retryAfterSeconds: this.retryAfterSeconds } };
  }
}

export class AiUnavailableError extends AppError {
  constructor(message = "Our AI assistant is unavailable right now. The rest of Lien still works normally.") {
    super(message, { status: 503, code: "AI_UNAVAILABLE" });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "That service is temporarily unavailable. Please try again shortly.") {
    super(message, { status: 503, code: "SERVICE_UNAVAILABLE" });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "That file is too large to upload.") {
    super(message, { status: 413, code: "PAYLOAD_TOO_LARGE" });
  }
}

export class UnsupportedMediaError extends AppError {
  constructor(message = "That file type is not supported.") {
    super(message, { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  }
}