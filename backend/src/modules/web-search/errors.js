import { AppError } from "../../lib/errors.js";

/** Safe, structured errors for an outbound search provider. */
export class WebSearchError extends AppError {
  constructor(message, { code = "WEB_SEARCH_ERROR", status = 503, context } = {}) {
    super(message, { code, status, expected: true, context });
  }
}
