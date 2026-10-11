import { ValidationError } from "../lib/errors.js";

/**
 * Zod-backed request validation.
 *
 * `validate` replaces `req.body`, `req.query` and `req.params` with the parsed,
 * coerced and stripped result. Because parsing happens here, services always
 * receive data of exactly the declared shape and type — no manual `parseInt`
 * scattered through business logic.
 */
export function validate(schemas) {
  return function validateMiddleware(req, _res, next) {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body ?? {});
      }
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query ?? {});
        // Express 5 exposes `req.query` as a getter-only property, so it must be
        // defined rather than assigned.
        Object.defineProperty(req, "query", { value: parsed, writable: true, configurable: true });
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params ?? {});
      }
      next();
    } catch (error) {
      next(toValidationError(error));
    }
  };
}

export function toValidationError(error) {
  if (error?.name !== "ZodError" || !Array.isArray(error.issues)) {
    return error;
  }

  /** @type {Record<string,string>} */
  const fields = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_root";
    // Keep the first (most specific) message per field for form display.
    if (!fields[path]) fields[path] = issue.message;
  }
  return new ValidationError(fields);
}