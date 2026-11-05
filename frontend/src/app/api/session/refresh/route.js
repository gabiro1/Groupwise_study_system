import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { forwardSetCookies } from "../../cookies";
import { applySetCookies, refreshSession } from "../refresh-session";
import { backendApiUrl, backendConfigurationResponse } from "../../../../lib/backend-api";

export async function GET(request) {
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();
  const next = request.nextUrl.searchParams.get("next") || "/dashboard";
  const safeNext = next === "/dashboard" || next.startsWith("/dashboard/") ? next : "/dashboard";
  const loginUrl = new URL(`/login?next=${encodeURIComponent(safeNext)}`, request.url);

  if (!cookieStore.get("lien_refresh")) return NextResponse.redirect(loginUrl);

  let refreshResult;
  try {
    refreshResult = await refreshSession(cookie);
  } catch {
    return NextResponse.json(
      { error: { code: "API_UNAVAILABLE", message: "The Lien service is unavailable. Please try again shortly." } },
      { status: 503 },
    );
  }

  if (!refreshResult.ok && refreshResult.status !== 401) {
    const response = NextResponse.json(refreshResult.payload, { status: refreshResult.status });
    forwardSetCookies(response, refreshResult.setCookies);
    return response;
  }

  if (!refreshResult.ok) {
    const response = NextResponse.redirect(loginUrl);
    response.cookies.set("lien_access", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    response.cookies.set("lien_refresh", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    forwardSetCookies(response, refreshResult.setCookies);
    return response;
  }

  const refreshedCookie = applySetCookies(cookie, refreshResult.setCookies);
  let sessionUrl;
  try {
    sessionUrl = backendApiUrl("auth/me");
  } catch (error) {
    const response = NextResponse.json(backendConfigurationResponse(error), { status: 503 });
    forwardSetCookies(response, refreshResult.setCookies);
    return response;
  }

  let sessionResponse;
  try {
    sessionResponse = await fetch(sessionUrl, {
      headers: { cookie: refreshedCookie },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: { code: "API_UNAVAILABLE", message: "The Lien service is unavailable. Please try again shortly." } },
      { status: 503 },
    );
  }

  if (!sessionResponse.ok) {
    if (sessionResponse.status !== 401 && sessionResponse.status !== 403) {
      const response = NextResponse.json(
        { error: { code: "API_UNAVAILABLE", message: "The Lien service is unavailable. Please try again shortly." } },
        { status: 503 },
      );
      forwardSetCookies(response, refreshResult.setCookies);
      return response;
    }
    const response = NextResponse.redirect(loginUrl);
    response.cookies.set("lien_access", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    response.cookies.set("lien_refresh", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    forwardSetCookies(response, refreshResult.setCookies);
    return response;
  }

  const response = NextResponse.redirect(new URL(safeNext, request.url));
  forwardSetCookies(response, refreshResult.setCookies);
  return response;
}
