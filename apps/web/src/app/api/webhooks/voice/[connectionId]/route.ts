import { DomainError } from "@jormall/domain/errors";

import { receiveVoiceWebhook } from "../../../../../server/voice-webhook";

const maximumWebhookBytes = 256 * 1024;

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentType !== "application/json" || contentLength > maximumWebhookBytes) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > maximumWebhookBytes) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const { connectionId } = await context.params;
    const result = await receiveVoiceWebhook({
      connectionId,
      rawBody,
      signature: request.headers.get("x-jormall-signature") ?? "",
      timestamp: request.headers.get("x-jormall-timestamp") ?? "",
    });
    return Response.json({ accepted: true, duplicate: result.duplicate }, { status: 202 });
  } catch (error) {
    if (error instanceof DomainError) {
      const status =
        error.code === "UNAUTHENTICATED"
          ? 401
          : error.code === "DEPENDENCY_UNAVAILABLE"
            ? 503
            : error.code === "VALIDATION_FAILED"
              ? 400
              : 404;
      return Response.json({ code: error.code }, { status });
    }
    return Response.json({ code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
