import { describe, expect, it } from "vitest";

import {
  boundedExponentialBackoff,
  LocalMockProviderAdapter,
  ProviderAdapterError,
  renderCommunicationTemplate,
  safeCommunicationLog,
} from "./communications";

describe("communications domain", () => {
  it("bounds exponential retry delay", () => {
    expect([1, 2, 3, 9].map((attempt) => boundedExponentialBackoff(attempt))).toEqual([
      1_000, 2_000, 4_000, 30_000,
    ]);
  });

  it("renders only allowlisted template variables", () => {
    expect(
      renderCommunicationTemplate("Hi {{customerName}} at {{startsAt}}", {
        customerName: "Amina",
        serviceName: "Consultation",
        startsAt: "10:00",
      }),
    ).toBe("Hi Amina at 10:00");
    expect(() =>
      renderCommunicationTemplate("{{secret}}", {
        customerName: "Amina",
        serviceName: "Consultation",
        startsAt: "10:00",
      }),
    ).toThrow();
  });

  it("normalizes mock transient, timeout, and permanent failures", async () => {
    const adapter = new LocalMockProviderAdapter("MOCK_SMS");
    const base = {
      attemptNumber: 1,
      channel: "SMS" as const,
      idempotencyKey: "event-1",
      messageBody: "sensitive body",
      recipient: "+962790000000",
    };
    await expect(adapter.send({ ...base, mockBehavior: "TRANSIENT_ONCE" })).rejects.toBeInstanceOf(
      ProviderAdapterError,
    );
    await expect(adapter.send({ ...base, mockBehavior: "TIMEOUT" })).rejects.toMatchObject({
      normalized: { code: "PROVIDER_TIMEOUT", retryable: true },
    });
    await expect(
      adapter.send({ ...base, mockBehavior: "PERMANENT_FAILURE" }),
    ).rejects.toMatchObject({
      normalized: { retryable: false },
    });
  });

  it("uses an allowlist so logs cannot contain provider secrets or bodies", () => {
    const record = safeCommunicationLog({ event: "message.sent", messageId: "message-1" });
    expect(record).toEqual({ event: "message.sent", messageId: "message-1" });
    expect(JSON.stringify(record)).not.toContain("body");
  });
});
