import { widgetSessionRequestSchema } from "@jormall/contracts/ai-channels";
import { AIChannelRepository } from "@jormall/db/ai-channel-repository";
import { DomainError } from "@jormall/domain/errors";

import { aiChannelRepository } from "../../../../../server/identity";
import {
  enforcePublicRateLimit,
  publicClientAddress,
} from "../../../../../server/public-rate-limit";
import {
  issueWidgetSessionToken,
  verifyWidgetConfigurationToken,
} from "../../../../../server/widget-capability";
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
    if (!origin) {
      throw new DomainError({ code: "UNAUTHENTICATED", message: "Widget origin is required." });
    }
    const parsed = widgetSessionRequestSchema.parse(await readBoundedJson(request));
    const capability = verifyWidgetConfigurationToken(parsed.configurationToken);
    if (!capability) {
      throw new DomainError({ code: "UNAUTHENTICATED", message: "Widget is invalid." });
    }
    await enforcePublicRateLimit(
      "widget-session",
      `${capability.publicKey}:${origin}:${publicClientAddress(request)}`,
      20,
      60,
    );
    const widget = await aiChannelRepository.resolveWidgetConfiguration(capability.publicKey);
    if (!widget || widget.version !== capability.version) {
      throw new DomainError({ code: "NOT_FOUND", message: "Widget is not active." });
    }
    const nonce = AIChannelRepository.createSessionNonce();
    await aiChannelRepository.openWebsiteSession({
      configurationId: widget.id,
      configurationVersion: capability.version,
      locale: parsed.locale,
      nonce,
      organizationId: widget.organizationId,
      origin,
    });
    const sessionToken = issueWidgetSessionToken({
      locale: parsed.locale,
      nonce,
      origin: new URL(origin).origin,
    });
    const isArabic = parsed.locale === "ar";
    return Response.json(
      {
        branding: {
          accentColor: widget.accentColor,
          displayName: isArabic ? widget.displayNameAr : widget.displayNameEn,
          primaryColor: widget.primaryColor,
        },
        direction: isArabic ? "rtl" : "ltr",
        labels: isArabic
          ? {
              close: "إغلاق المحادثة",
              error: "تعذّر إكمال الطلب. حاول مرة أخرى أو اطلب موظفاً.",
              launcher: "محادثة جورمول",
              message: "اكتب رسالتك",
              send: "إرسال",
              verify: "تحقق تجريبي من رقم الهاتف",
              verificationCode: "رمز التحقق التجريبي",
              verificationPhone: "رقم الهاتف",
              verified: "تم التحقق التجريبي",
            }
          : {
              close: "Close chat",
              error: "The request could not be completed. Try again or ask for a person.",
              launcher: "Chat with JorMall",
              message: "Type your message",
              send: "Send",
              verify: "Mock phone verification",
              verificationCode: "Mock verification code",
              verificationPhone: "Phone number",
              verified: "Mock identity verified",
            },
        mockIdentityVerificationAvailable: process.env.NODE_ENV !== "production",
        sessionToken,
      },
      { headers: widgetCorsHeaders(origin) },
    );
  } catch (error) {
    return widgetErrorResponse(error, origin || "null");
  }
}
