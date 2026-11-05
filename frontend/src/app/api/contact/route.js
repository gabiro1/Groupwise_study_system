import { NextResponse } from "next/server";
import {
  BackendConfigurationError,
  backendApiUrl,
  backendConfigurationResponse,
} from "../../../lib/backend-api";

async function forward(request, method) {
  const cookie = request.headers.get("cookie") || "";
  const csrfToken = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("lien_csrf="))
    ?.slice("lien_csrf=".length);
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (method === "POST") {
    headers.set("content-type", "application/json");
    if (csrfToken) headers.set("x-csrf-token", decodeURIComponent(csrfToken));
  }

  let upstream;
  try {
    upstream = await fetch(backendApiUrl("contact"), {
      method,
      headers,
      body: method === "POST" ? await request.text() : undefined,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof BackendConfigurationError) {
      return NextResponse.json(backendConfigurationResponse(error), { status: 503 });
    }
    return NextResponse.json(
      { error: { message: "We couldn’t reach the message service. Please try again later." } },
      { status: 503 },
    );
  }

  const response = NextResponse.json(await upstream.json(), { status: upstream.status });
  for (const cookieHeader of upstream.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookieHeader);
  }
  return response;
}

export function GET(request) {
  return forward(request, "GET");
}

export function POST(request) {
  return forward(request, "POST");
}
