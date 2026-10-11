import { NextResponse } from "next/server";
import { forwardSetCookies } from "../cookies";
import { applySetCookies, refreshSession } from "../session/refresh-session";

const backendUrl = (process.env.BACKEND_API_URL || "http://localhost:4000").replace(/\/+$/, "");
const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function cookieValue(cookieHeader, name) {
  const value = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value ? decodeURIComponent(value) : undefined;
}

async function backendRequest(url, method, body, cookie, csrfToken) {
  const headers = new Headers({ accept: "application/json" });
  if (cookie) headers.set("cookie", cookie);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers.set("x-csrf-token", csrfToken || "");
  }
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, {
    method,
    headers,
    body,
    cache: "no-store",
  });
  return { response, setCookies: response.headers.getSetCookie() };
}

async function forward(request, context) {
  const { path = [] } = await context.params;
  if (!path.length || path.some((part) => !/^[\w-]+$/.test(part))) {
    return NextResponse.json({ error: { message: "That API route does not exist." } }, { status: 404 });
  }

  const method = request.method;
  if (!allowedMethods.has(method)) {
    return NextResponse.json({ error: { message: "That request method is not supported." } }, { status: 405 });
  }

  const cookie = request.headers.get("cookie") || "";
  const csrfToken = cookieValue(cookie, "lien_csrf");
  const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await request.text() : undefined;
  const apiUrl = `${backendUrl}/api/${path.join("/")}${request.nextUrl.search}`;
  let result;

  try {
    result = await backendRequest(apiUrl, method, body, cookie, csrfToken);

    if (
      result.response.status === 401
      && path.join("/") !== "auth/refresh"
      && path.join("/") !== "auth/login"
      && cookieValue(cookie, "lien_refresh")
    ) {
      const refreshResult = await refreshSession(cookie);
      if (refreshResult.ok) {
        const rotatedCookie = applySetCookies(cookie, refreshResult.setCookies);
        const retry = await backendRequest(
          apiUrl,
          method,
          body,
          rotatedCookie,
          cookieValue(rotatedCookie, "lien_csrf"),
        );
        result = {
          ...retry,
          setCookies: [...refreshResult.setCookies, ...retry.setCookies],
        };
      } else {
        result = {
          status: refreshResult.status,
          payload: refreshResult.payload,
          setCookies: refreshResult.setCookies,
        };
      }
    }
  } catch {
    return NextResponse.json(
      { error: { code: "API_UNAVAILABLE", message: "The Lien service is unavailable. Please try again shortly." } },
      { status: 503 },
    );
  }

  const status = result.response?.status ?? result.status;
  let payload = result.payload;
  if (result.response) {
    try {
      payload = status === 204 ? null : await result.response.json();
    } catch {
      return NextResponse.json(
        { error: { code: "INVALID_API_RESPONSE", message: "The Lien service returned an invalid response." } },
        { status: 502 },
      );
    }
  }

  const response = status === 204
    ? new NextResponse(null, { status: 204 })
    : NextResponse.json(payload, { status });
  forwardSetCookies(response, result.setCookies);
  return response;
}

export async function GET(request, context) {
  return forward(request, context);
}

export async function POST(request, context) {
  return forward(request, context);
}

export async function PUT(request, context) {
  return forward(request, context);
}

export async function PATCH(request, context) {
  return forward(request, context);
}

export async function DELETE(request, context) {
  return forward(request, context);
}
