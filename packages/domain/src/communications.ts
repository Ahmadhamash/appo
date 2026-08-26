import { DomainError } from "./errors";

export const communicationTemplateKeys = [
  "APPOINTMENT_CONFIRMATION",
  "APPOINTMENT_REMINDER",
  "APPOINTMENT_CANCELLATION",
  "SLOT_OFFER",
  "MISSED_CALL_RECOVERY",
] as const;

export type CommunicationTemplateKey = (typeof communicationTemplateKeys)[number];
export type CommunicationChannelValue = "SMS" | "WHATSAPP" | "EMAIL" | "INTERNAL";
export type MockProviderBehaviorValue =
  "SUCCESS" | "TRANSIENT_ONCE" | "TIMEOUT" | "PERMANENT_FAILURE";

export type ProviderSendInput = Readonly<{
  channel: CommunicationChannelValue;
  idempotencyKey: string;
  messageBody: string;
  recipient: string;
  attemptNumber: number;
  mockBehavior: MockProviderBehaviorValue;
}>;

export type ProviderSendResult = Readonly<{
  providerMessageId: string;
  acceptedAt: Date;
}>;

export type NormalizedProviderError = Readonly<{
  category:
    "AUTHENTICATION" | "CONFIGURATION" | "PERMANENT" | "RATE_LIMIT" | "TIMEOUT" | "TRANSIENT";
  code: string;
  retryable: boolean;
  safeMessage: string;
}>;

export interface MessageProviderAdapter {
  readonly key: string;
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

export class ProviderAdapterError extends Error {
  readonly normalized: NormalizedProviderError;

  constructor(normalized: NormalizedProviderError) {
    super(normalized.safeMessage);
    this.name = "ProviderAdapterError";
    this.normalized = normalized;
  }
}

export class LocalMockProviderAdapter implements MessageProviderAdapter {
  readonly key: string;

  constructor(key: "MOCK_SMS" | "MOCK_WHATSAPP") {
    this.key = key;
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (input.mockBehavior === "PERMANENT_FAILURE") {
      throw new ProviderAdapterError({
        category: "PERMANENT",
        code: "MOCK_RECIPIENT_REJECTED",
        retryable: false,
        safeMessage: "The mock provider rejected the recipient.",
      });
    }
    if (input.mockBehavior === "TIMEOUT") {
      throw new ProviderAdapterError({
        category: "TIMEOUT",
        code: "PROVIDER_TIMEOUT",
        retryable: true,
        safeMessage: "The mock provider timed out.",
      });
    }
    if (input.mockBehavior === "TRANSIENT_ONCE" && input.attemptNumber === 1) {
      throw new ProviderAdapterError({
        category: "TRANSIENT",
        code: "MOCK_TEMPORARILY_UNAVAILABLE",
        retryable: true,
        safeMessage: "The mock provider is temporarily unavailable.",
      });
    }
    return {
      acceptedAt: new Date(),
      providerMessageId: `mock-${this.key.toLowerCase()}-${input.idempotencyKey}`,
    };
  }
}

export function boundedExponentialBackoff(
  attemptNumber: number,
  baseDelayMs = 1_000,
  maximumDelayMs = 30_000,
): number {
  const safeAttempt = Math.max(1, Math.floor(attemptNumber));
  return Math.min(maximumDelayMs, baseDelayMs * 2 ** (safeAttempt - 1));
}

export function renderCommunicationTemplate(
  body: string,
  variables: Readonly<Record<"customerName" | "serviceName" | "startsAt", string>>,
): string {
  const unknownToken = body.match(/{{\s*([^}\s]+)\s*}}/g)?.find((token) => {
    const key = token.replace(/[{}\s]/g, "");
    return !(key in variables);
  });
  if (unknownToken) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "The message template contains an unsupported variable.",
    });
  }
  return body.replace(
    /{{\s*(customerName|serviceName|startsAt)\s*}}/g,
    (_, key: keyof typeof variables) => variables[key],
  );
}

export function safeCommunicationLog(
  input: Readonly<{
    event: string;
    messageId?: string;
    organizationId?: string;
    outboxEventId?: string;
    errorCode?: string;
  }>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
