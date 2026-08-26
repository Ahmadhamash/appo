import "server-only";

import { DomainError } from "@jormall/domain/errors";

export function widgetCorsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Cache-Control": "no-store",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  };
}

export function widgetErrorResponse(error: unknown, origin: string): Response {
  const code = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
  const status =
    code === "RATE_LIMITED"
      ? 429
      : code === "DEPENDENCY_UNAVAILABLE"
        ? 503
        : code === "VALIDATION_FAILED"
          ? 400
          : code === "NOT_FOUND" || code === "UNAUTHENTICATED"
            ? 401
            : 500;
  return Response.json({ code }, { headers: widgetCorsHeaders(origin), status });
}

export async function readBoundedJson(request: Request, maximumBytes = 16_384): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentType !== "application/json" || contentLength > maximumBytes) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Request is invalid." });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > maximumBytes) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Request is too large." });
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Request JSON is invalid." });
  }
}
