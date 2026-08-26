import { z } from "zod";

export const widgetSessionRequestSchema = z
  .object({
    configurationToken: z.string().min(40).max(8_192),
    locale: z.enum(["ar", "en"]),
  })
  .strict();

export const widgetTurnRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(5_000),
    requestId: z.uuid(),
    sessionToken: z.string().min(40).max(8_192),
  })
  .strict();

export const widgetIdentityVerificationSchema = z
  .object({
    phone: z.string().trim().min(7).max(40),
    sessionToken: z.string().min(40).max(8_192),
    verificationCode: z.string().trim().min(4).max(32),
  })
  .strict();

export const widgetConfigurationTokenPayloadSchema = z
  .object({
    expiresAt: z.iso.datetime(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("widget_configuration"),
    publicKey: z.uuid(),
    version: z.number().int().positive(),
  })
  .strict();

export const widgetSessionTokenPayloadSchema = z
  .object({
    expiresAt: z.iso.datetime(),
    issuedAt: z.iso.datetime(),
    kind: z.literal("widget_session"),
    locale: z.enum(["ar", "en"]),
    nonce: z.string().regex(/^[0-9a-f]{64}$/),
    origin: z.url().max(500),
  })
  .strict();

const voiceEventTypeSchema = z.enum([
  "call.started",
  "call.answered",
  "transcript.partial",
  "transcript.final",
  "barge_in",
  "silence",
  "interrupted",
  "recording.consent_granted",
  "recording.consent_declined",
  "recording.start",
  "recording.stop",
  "human_transfer.requested",
  "call.missed",
  "call.disconnected",
  "call.completed",
  "provider.failure",
]);

export const voiceWebhookPayloadSchema = z
  .object({
    confidence: z.number().min(0).max(1).optional(),
    eventId: z.string().trim().min(1).max(200),
    from: z.string().trim().min(3).max(80).optional(),
    isFinal: z.boolean().optional(),
    locale: z.enum(["ar", "en"]).default("ar"),
    occurredAt: z.iso.datetime({ offset: true }),
    providerCallId: z.string().trim().min(1).max(200),
    sequence: z.number().int().nonnegative().optional(),
    text: z.string().max(10_000).optional(),
    to: z.string().trim().min(3).max(80),
    type: voiceEventTypeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.type === "transcript.partial" || value.type === "transcript.final") &&
      (!value.text || value.confidence === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Transcript events require text and confidence.",
      });
    }
    if (value.type === "transcript.final" && value.isFinal !== true) {
      context.addIssue({ code: "custom", message: "Final transcripts must be marked final." });
    }
  });

export const aiChannelReplayFixtureSchema = z
  .object({
    channel: z.enum(["WEBSITE", "WHATSAPP", "VOICE"]),
    events: z
      .array(
        z
          .object({
            expectedOutcome: z.string().trim().min(1).max(100),
            input: z.string().max(10_000),
            kind: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    locale: z.enum(["ar", "en"]),
    name: z.string().trim().min(2).max(180),
    version: z.literal(1),
  })
  .strict();

export type VoiceWebhookPayload = z.infer<typeof voiceWebhookPayloadSchema>;
export type WidgetConfigurationTokenPayload = z.infer<typeof widgetConfigurationTokenPayloadSchema>;
export type WidgetSessionTokenPayload = z.infer<typeof widgetSessionTokenPayloadSchema>;
