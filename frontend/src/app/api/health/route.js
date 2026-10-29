import { NextResponse } from "next/server";
import {
  BackendConfigurationError,
  backendServiceUrl,
} from "../../../lib/backend-api";

export const dynamic = "force-dynamic";
// Match the proxy budget so a cold Render instance is not reported as down
// before it has had a chance to wake.
export const maxDuration = 60;

/**
 * BFF diagnostics: proves the Next.js server can reach the backend.
 *
 * The browser should call this route instead of the Render host directly, so
 * CORS never enters the picture. It intentionally exposes only liveness, not
 * the backend URL, credentials, or driver details.
 */
export async function GET() {
  let url;
  try {
    url = backendServiceUrl("health");
  } catch (error) {
    return NextResponse.json(
      {
        status: "degraded",
        backend: {
          reachable: false,
          configured: false,
          error: error instanceof BackendConfigurationError
            ? "BACKEND_API_URL is missing or invalid on this deployment."
            : "The backend configuration is invalid.",
        },
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(50_000),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    return NextResponse.json(
      {
        status: response.ok ? "ok" : "degraded",
        backend: {
          reachable: true,
          status: response.status,
          database: payload?.database?.ok === true ? "ok" : "unknown",
        },
        timestamp: new Date().toISOString(),
      },
      {
        status: response.ok ? 200 : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        backend: { reachable: false, configured: true },
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
