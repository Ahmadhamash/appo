import { widgetIdentityVerificationSchema } from "@jormall/contracts/ai-channels";
import { DomainError } from "@jormall/domain/errors";

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
    const parsed = widgetIdentityVerificationSchema.parse(await readBoundedJson(request));
    const capability = verifyWidgetSessionToken(parsed.sessionToken);
    if (
      process.env.NODE_ENV === "production" ||
      parsed.verificationCode !== "000000" ||
      !capability ||
      !origin ||
      capability.origin !== new URL(origin).origin
    ) {
      throw new DomainError({ code: "UNAUTHENTICATED", message: "Verification failed." });
    }
    await enforcePublicRateLimit(
      "widget-verify",
      `${capability.nonce}:${publicClientAddress(request)}`,
      5,
      600,
    );
    await aiChannelRepository.bindDevelopmentWebsiteCustomerFromCapability({
      nonce: capability.nonce,
      origin: capability.origin,
      phone: parsed.phone,
    });
    return Response.json({ verified: true }, { headers: widgetCorsHeaders(origin) });
  } catch (error) {
    return widgetErrorResponse(error, origin || "null");
  }
}
