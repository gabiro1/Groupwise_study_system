/**
 * Server-side configuration for the Lien API.
 *
 * The browser only ever talks to this Next.js app (`/api/*`). The route
 * handlers below proxy those calls to the backend, so the backend URL stays
 * server-side and never needs a `NEXT_PUBLIC_` prefix.
 *
 * `BACKEND_API_URL` must be the backend origin, optionally with a path prefix.
 * A trailing `/api` is tolerated (older deployments set it that way) and is
 * removed so the proxy cannot accidentally request `/api/api/...`.
 */

const LOCAL_BACKEND_URL = "http://localhost:4000";

export class BackendConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackendConfigurationError";
    this.code = "BACKEND_NOT_CONFIGURED";
  }
}

/** Normalise one configured backend URL, rejecting anything unusable. */
export function normalizeBackendUrl(value) {
  const trimmed = String(value ?? "").trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BackendConfigurationError("BACKEND_API_URL must be an absolute http(s) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BackendConfigurationError("BACKEND_API_URL must use http or https.");
  }
  if (!url.hostname) {
    throw new BackendConfigurationError("BACKEND_API_URL must include a hostname.");
  }

  url.hash = "";
  url.search = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (/\/api$/i.test(pathname)) pathname = pathname.slice(0, -4);
  url.pathname = pathname;

  return url.toString().replace(/\/+$/, "");
}

/**
 * Resolve the backend base URL.
 *
 * Outside production a missing value falls back to the local server, which is
 * convenient for `next dev`. In production a missing value is a configuration
 * error: silently proxying to localhost produces confusing 503s and hides the
 * actual deployment mistake.
 */
export function getBackendBaseUrl() {
  const configured = process.env.BACKEND_API_URL;
  if (configured && configured.trim()) return normalizeBackendUrl(configured);

  if (process.env.NODE_ENV === "production") {
    throw new BackendConfigurationError(
      "BACKEND_API_URL is not set. Configure it in the deployment environment.",
    );
  }

  return LOCAL_BACKEND_URL;
}

/** Build a URL under the backend's `/api` namespace. */
export function backendApiUrl(pathname, search = "") {
  return backendUrl(pathname, search, true);
}

/** Build a URL outside `/api` (for example the backend's `/health`). */
export function backendServiceUrl(pathname, search = "") {
  return backendUrl(pathname, search, false);
}

function backendUrl(pathname, search, api) {
  const base = getBackendBaseUrl();
  let path = String(pathname ?? "").replace(/^\/+/, "");
  if (api) path = path.replace(/^api\//i, "");
  const query = search ? (search.startsWith("?") ? search : `?${search}`) : "";
  return `${base}${api ? "/api" : ""}/${path}${query}`;
}

/** Convert a configuration failure into a safe client-facing payload. */
export function backendConfigurationResponse(error) {
  return {
    error: {
      code: error instanceof BackendConfigurationError ? error.code : "BACKEND_NOT_CONFIGURED",
      message: "The Lien service is not configured correctly. Please contact support.",
    },
  };
}
