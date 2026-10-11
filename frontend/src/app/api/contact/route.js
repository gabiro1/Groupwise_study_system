import { NextResponse } from "next/server";

const backendUrl = (process.env.BACKEND_API_URL || "http://localhost:4000").replace(/\/+$/, "");

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
    upstream = await fetch(`${backendUrl}/api/contact`, {
      method,
      headers,
      body: method === "POST" ? await request.text() : undefined,
      cache: "no-store",
    });
  } catch {
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
