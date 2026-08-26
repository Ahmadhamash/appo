import "server-only";

import { verifyWebhookSignature } from "@jormall/auth/webhook-signature";
import { voiceWebhookPayloadSchema } from "@jormall/contracts/ai-channels";
import { parseMockWebhookSecret } from "@jormall/config/environment";
import { CommunicationChannel, ProviderConnectionStatus } from "@jormall/db/generated/enums";
import { DomainError } from "@jormall/domain/errors";

import { aiChannelRepository } from "./identity";

const allowedSecretReferences = new Set(["env:MOCK_VOICE_WEBHOOK_SECRET"]);

export async function receiveVoiceWebhook(
  input: Readonly<{
    connectionId: string;
    rawBody: string;
    signature: string;
    timestamp: string;
  }>,
): Promise<Readonly<{ duplicate: boolean }>> {
  const connection = await aiChannelRepository.resolveVoiceConnection(input.connectionId);
  if (
    !connection ||
    connection.channel !== CommunicationChannel.VOICE ||
    connection.status !== ProviderConnectionStatus.ACTIVE ||
    connection.adapterKey !== "MOCK_VOICE" ||
    !connection.webhookSecretReference ||
    !allowedSecretReferences.has(connection.webhookSecretReference)
  ) {
    throw new DomainError({ code: "NOT_FOUND", message: "Voice connection was not found." });
  }
  let secret: string;
  try {
    secret = parseMockWebhookSecret(process.env.MOCK_VOICE_WEBHOOK_SECRET);
  } catch {
    throw new DomainError({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Mock voice webhook verification is not configured.",
    });
  }
  if (!verifyWebhookSignature({ ...input, secret })) {
    throw new DomainError({ code: "UNAUTHENTICATED", message: "Voice signature is invalid." });
  }
  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Voice payload is invalid." });
  }
  const parsed = voiceWebhookPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Voice payload is invalid." });
  }
  return aiChannelRepository.storeVerifiedVoiceEvent(connection, parsed.data, input.rawBody);
}
