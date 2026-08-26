import { widgetTurnRequestSchema } from "@jormall/contracts/ai-channels";
import { DomainError } from "@jormall/domain/errors";

import { aiChannelCoordinator } from "../../../../../server/ai-channel-runtime";
import { aiChannelRepository } from "../../../../../server/identity";
import {
  enforcePublicRateLimit,
  publicClientAddress,
} from "../../../../../server/public-rate-limit";
import { verifyWidgetSessionToken } from "../../../../../server/widget-capability";
import {
  readBoundedJson,
  widgetCorsHeaders,
  widgetErrorResponse,
} from "../../../../../server/widget-http";

export function OPTIONS(request: Request): Response {
  return new Response(null, {
    headers: widgetCorsHeaders(request.headers.get("origin") ?? "null"),
  });
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  try {
    const parsed = widgetTurnRequestSchema.parse(await readBoundedJson(request));
    const capability = verifyWidgetSessionToken(parsed.sessionToken);
    if (!capability || !origin || capability.origin !== new URL(origin).origin) {
      throw new DomainError({ code: "UNAUTHENTICATED", message: "Widget session is invalid." });
    }
    await Promise.all([
      enforcePublicRateLimit("widget-turn-session", capability.nonce, 30, 60),
      enforcePublicRateLimit("widget-turn-ip", publicClientAddress(request), 120, 60),
    ]);
    const context = await aiChannelRepository.trustedWebsiteContextFromCapability({
      nonce: capability.nonce,
      origin: capability.origin,
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (value: unknown): void => {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };
        emit({ type: "start" });
        try {
          const result = await aiChannelCoordinator.handleTurn(
            context,
            parsed.message,
            capability.locale,
            undefined,
            `website-turn:${parsed.requestId}`,
          );
          if (result.suppressed) {
            emit({ handoff: true, type: "takeover" });
          } else {
            for (const token of result.content.match(/\S+\s*/gu) ?? [result.content]) {
              emit({ text: token, type: "token" });
            }
            emit({
              handoff: result.handoffRequested,
              requiresConfirmation: result.action?.outcome === "requires_confirmation",
              type: "done",
            });
          }
        } catch (error) {
          emit({
            code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
            type: "error",
          });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        ...widgetCorsHeaders(origin),
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return widgetErrorResponse(error, origin || "null");
  }
}
