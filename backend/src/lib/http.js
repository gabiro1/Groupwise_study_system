/**
 * Uniform API response envelope.
 *
 * Every endpoint — success or failure — returns the same shape so the frontend
 * BFF never has to guess:
 *
 *   success: { "data": <payload>, "meta"?: {...} }
 *   failure: { "error": { "code", "message", "fields"?, ... } }
 */

export function ok(res, data, meta) {
  return res.status(200).json(meta ? { data, meta } : { data });
}

export function created(res, data, meta) {
  return res.status(201).json(meta ? { data, meta } : { data });
}

export function accepted(res, data, meta) {
  return res.status(202).json(meta ? { data, meta } : { data });
}

export function noContent(res) {
  return res.status(204).end();
}

/**
 * Wrap an async route handler so rejected promises reach the Express error
 * pipeline instead of becoming unhandled rejections.
 */
export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}