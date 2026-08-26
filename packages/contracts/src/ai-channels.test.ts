import { describe, expect, it } from "vitest";

import {
  voiceWebhookPayloadSchema,
  widgetSessionRequestSchema,
  widgetSessionTokenPayloadSchema,
} from "./ai-channels";

describe("AI channel boundary contracts", () => {
  it("rejects unknown widget fields and malformed capabilities", () => {
    expect(
      widgetSessionRequestSchema.safeParse({
        configurationToken: "x".repeat(40),
        locale: "en",
        organizationId: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
    const opaqueSession = {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedAt: new Date().toISOString(),
      kind: "widget_session",
      locale: "en",
      nonce: "0".repeat(64),
      origin: "https://example.com",
    } as const;
    expect(widgetSessionTokenPayloadSchema.safeParse(opaqueSession).success).toBe(true);
    expect(
      widgetSessionTokenPayloadSchema.safeParse({
        ...opaqueSession,
        organizationId: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("requires final transcript evidence", () => {
    const base = {
      confidence: 0.9,
      eventId: "voice-event-1",
      occurredAt: new Date().toISOString(),
      providerCallId: "call-1",
      text: "نعم أؤكد",
      to: "+96265550000",
      type: "transcript.final",
    };
    expect(voiceWebhookPayloadSchema.safeParse(base).success).toBe(false);
    expect(voiceWebhookPayloadSchema.safeParse({ ...base, isFinal: true }).success).toBe(true);
  });
});
