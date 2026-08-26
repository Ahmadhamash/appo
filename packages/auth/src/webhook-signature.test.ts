import { describe, expect, it } from "vitest";

import { createWebhookSignature, verifyWebhookSignature } from "./webhook-signature";

describe("webhook signatures", () => {
  it("verifies raw body signatures inside the replay window", () => {
    const now = new Date("2026-08-23T12:00:00Z");
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const rawBody = '{"eventId":"event-1"}';
    const secret = "local-test-secret-at-least-32-characters";
    expect(
      verifyWebhookSignature({
        now,
        rawBody,
        secret,
        signature: createWebhookSignature(secret, timestamp, rawBody),
        timestamp,
      }),
    ).toBe(true);
  });

  it("rejects tampering, invalid signatures, and stale timestamps", () => {
    const secret = "local-test-secret-at-least-32-characters";
    expect(
      verifyWebhookSignature({
        now: new Date("2026-08-23T12:10:00Z"),
        rawBody: "tampered",
        secret,
        signature: createWebhookSignature(secret, "1787486400", "original"),
        timestamp: "1787486400",
      }),
    ).toBe(false);
  });
});
