import "server-only";

import { verifyWebhookSignature } from "@jormall/auth/webhook-signature";
import { whatsAppWebhookPayloadSchema } from "@jormall/contracts/communications";
import { parseMockWebhookSecret } from "@jormall/config/environment";
import { CommunicationChannel, ProviderConnectionStatus } from "@jormall/db/generated/enums";
import { DomainError } from "@jormall/domain/errors";

import { communicationRepository } from "./identity";

const allowedSecretReferences = new Set(["env:MOCK_WHATSAPP_WEBHOOK_SECRET"]);

export async function receiveWhatsAppWebhook(
  input: Readonly<{
    connectionId: string;
    rawBody: string;
    signature: string;
    timestamp: string;
  }>,
): Promise<{ duplicate: boolean }> {
  const connection = await communicationRepository.resolveWebhookConnection(input.connectionId);
  if (
    !connection ||
    connection.channel !== CommunicationChannel.WHATSAPP ||
    connection.status !== ProviderConnectionStatus.ACTIVE ||
    connection.adapterKey !== "MOCK_WHATSAPP" ||
    !connection.webhookSecretReference ||
    !allowedSecretReferences.has(connection.webhookSecretReference)
  ) {
    throw new DomainError({ code: "NOT_FOUND", message: "Webhook connection was not found." });
  }
  let secret: string;
  try {
    secret = parseMockWebhookSecret(process.env.MOCK_WHATSAPP_WEBHOOK_SECRET);
  } catch {
    throw new DomainError({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Mock webhook verification is not configured.",
    });
  }
  if (!verifyWebhookSignature({ ...input, secret })) {
    throw new DomainError({ code: "UNAUTHENTICATED", message: "Webhook signature is invalid." });
  }
  const parsed = whatsAppWebhookPayloadSchema.safeParse(JSON.parse(input.rawBody));
  if (!parsed.success) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Webhook payload is invalid." });
  }
  return communicationRepository.storeVerifiedWebhook(connection, parsed.data, input.rawBody);
}
