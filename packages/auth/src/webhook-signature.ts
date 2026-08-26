import { createHmac, timingSafeEqual } from "node:crypto";

const replayWindowSeconds = 300;

export function createWebhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifyWebhookSignature(
  input: Readonly<{
    now?: Date;
    rawBody: string;
    secret: string;
    signature: string;
    timestamp: string;
  }>,
): boolean {
  const timestampSeconds = Number(input.timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (
    !Number.isInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > replayWindowSeconds ||
    input.secret.length < 16
  ) {
    return false;
  }
  const expected = Buffer.from(
    createWebhookSignature(input.secret, input.timestamp, input.rawBody),
  );
  const received = Buffer.from(input.signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
