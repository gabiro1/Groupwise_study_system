import { createHash } from "node:crypto";
import { backendApiUrl } from "../../../lib/backend-api";

const refreshOperations = new Map();
const completedRefreshCacheMs = 5_000;

function cookieValue(cookieHeader, name) {
  const value = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value ? decodeURIComponent(value) : undefined;
}

export function applySetCookies(cookieHeader, setCookies) {
  let nextCookie = cookieHeader;
  for (const setCookie of setCookies) {
    const [pair, ...attributes] = setCookie.split(";");
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute.trim()));
    const parts = nextCookie.split(";").map((part) => part.trim()).filter(Boolean);
    const withoutPrevious = parts.filter((part) => !part.startsWith(`${name}=`));
    if (!expired) withoutPrevious.push(`${name}=${value}`);
    nextCookie = withoutPrevious.join("; ");
  }
  return nextCookie;
}

function apiError(status, code, message, setCookies = []) {
  return {
    ok: false,
    status,
    payload: { error: { code, message } },
    setCookies,
  };
}

async function performRefresh(cookieHeader) {
  let csrfUrl;
  let refreshUrl;
  try {
    csrfUrl = backendApiUrl("auth/csrf");
    refreshUrl = backendApiUrl("auth/refresh");
  } catch {
    return apiError(503, "BACKEND_NOT_CONFIGURED", "The Lien service is not configured correctly. Please contact support.");
  }

  const csrfResponse = await fetch(csrfUrl, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });
  const csrfSetCookies = csrfResponse.headers.getSetCookie();
  if (!csrfResponse.ok) {
    return apiError(503, "API_UNAVAILABLE", "The Lien service is unavailable. Please try again shortly.", csrfSetCookies);
  }

  const csrfResult = await csrfResponse.json();
  const csrfToken = csrfResult.data?.csrfToken;
  if (!csrfToken) {
    return apiError(502, "INVALID_CSRF_RESPONSE", "The Lien service could not verify this session.", csrfSetCookies);
  }

  const cookieWithCsrf = applySetCookies(cookieHeader, csrfSetCookies);
  const refreshResponse = await fetch(refreshUrl, {
    method: "POST",
    headers: {
      cookie: cookieWithCsrf,
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: "{}",
    cache: "no-store",
  });
  const refreshSetCookies = refreshResponse.headers.getSetCookie();
  let payload;
  try {
    payload = await refreshResponse.json();
  } catch {
    return apiError(502, "INVALID_API_RESPONSE", "The Lien service returned an invalid response.", [
      ...csrfSetCookies,
      ...refreshSetCookies,
    ]);
  }

  return {
    ok: refreshResponse.ok,
    status: refreshResponse.status,
    payload,
    setCookies: [...csrfSetCookies, ...refreshSetCookies],
  };
}

export function refreshSession(cookieHeader) {
  const refreshToken = cookieValue(cookieHeader, "lien_refresh");
  if (!refreshToken) {
    return Promise.resolve(apiError(401, "NO_SESSION", "No refresh session is available."));
  }

  const key = createHash("sha256").update(refreshToken).digest("hex");
  const existing = refreshOperations.get(key);
  if (existing && (existing.expiresAt === null || existing.expiresAt > Date.now())) {
    return existing.promise;
  }
  if (existing) refreshOperations.delete(key);

  const entry = { expiresAt: null, promise: null };
  entry.promise = Promise.resolve()
    .then(() => performRefresh(cookieHeader))
    .then((result) => {
      if (!result.ok && result.status !== 401) {
        refreshOperations.delete(key);
        return result;
      }

      entry.expiresAt = Date.now() + completedRefreshCacheMs;
      const cleanup = setTimeout(() => {
        if (refreshOperations.get(key) === entry) refreshOperations.delete(key);
      }, completedRefreshCacheMs);
      cleanup.unref?.();
      return result;
    }, (error) => {
      refreshOperations.delete(key);
      throw error;
    });
  refreshOperations.set(key, entry);
  return entry.promise;
}
