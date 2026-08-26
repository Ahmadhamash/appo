import { z } from "zod";

export const communicationQueuePayloadSchema = z
  .object({
    organizationId: z.uuid(),
    outboxEventId: z.uuid(),
    version: z.literal(1),
  })
  .strict();

export type CommunicationQueuePayload = z.infer<typeof communicationQueuePayloadSchema>;

export const whatsAppWebhookPayloadSchema = z
  .object({
    body: z.string().max(10_000).optional(),
    eventId: z.string().trim().min(1).max(200),
    from: z.string().trim().min(3).max(40).optional(),
    occurredAt: z.iso.datetime({ offset: true }),
    voiceNote: z
      .object({
        mediaReference: z.string().trim().min(1).max(500),
        mockTranscript: z.string().trim().min(1).max(10_000).optional(),
      })
      .strict()
      .optional(),
    providerMessageId: z.string().trim().min(1).max(200).optional(),
    type: z.enum([
      "message.received",
      "message.sent",
      "message.delivered",
      "message.read",
      "message.failed",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "message.received" && ((!value.body && !value.voiceNote) || !value.from)) {
      context.addIssue({
        code: "custom",
        message: "Inbound messages require text or a voice note and sender.",
      });
    }
    if (value.body && value.voiceNote) {
      context.addIssue({ code: "custom", message: "Use either text or a voice note." });
    }
    if (value.type !== "message.received" && !value.providerMessageId) {
      context.addIssue({
        code: "custom",
        message: "Delivery events require a provider message ID.",
      });
    }
  });

export type WhatsAppWebhookPayload = z.infer<typeof whatsAppWebhookPayloadSchema>;
