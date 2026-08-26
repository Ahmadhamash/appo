import { describe, expect, it } from "vitest";

import {
  DeterministicMockTelephonyAdapter,
  DeterministicMockVoiceNoteTranscriptionAdapter,
} from "./channel-adapters";

const command = { callReference: "call-1", idempotencyKey: "event-1:speak" };

describe("deterministic AI channel adapters", () => {
  it("normalizes timeout and permanent telephony failures", async () => {
    await expect(
      new DeterministicMockTelephonyAdapter("TIMEOUT").speak({
        ...command,
        locale: "en",
        text: "Hello",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
    await expect(
      new DeterministicMockTelephonyAdapter("PERMANENT_FAILURE").transfer(command),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILURE", retryable: false });
  });

  it("uses only explicit local voice-note replay fixtures", async () => {
    const adapter = new DeterministicMockVoiceNoteTranscriptionAdapter(
      new Map([["fixture://voice-1", "شو في خدمات؟"]]),
    );
    await expect(
      adapter.transcribe({
        mediaReference: "fixture://voice-1",
        providerConnectionReference: "mock-whatsapp",
      }),
    ).resolves.toMatchObject({ confidence: 0.99, language: "ar", text: "شو في خدمات؟" });
    await expect(
      adapter.transcribe({
        mediaReference: "fixture://missing",
        providerConnectionReference: "mock-whatsapp",
      }),
    ).rejects.toThrow("MOCK_TRANSCRIPTION_NOT_FOUND");
  });
});
