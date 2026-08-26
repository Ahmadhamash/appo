import { createHash } from "node:crypto";

import type {
  ProviderNeutralTelephonyAdapter,
  TelephonyCommandInput,
  VoiceNoteTranscriptionAdapter,
  VoiceNoteTranscriptionInput,
  VoiceNoteTranscriptionResult,
} from "@jormall/domain/ai-channels";
import { TelephonyAdapterError } from "@jormall/domain/ai-channels";
import { detectAIContentLanguage } from "@jormall/domain/ai-safety";

export class DeterministicMockVoiceNoteTranscriptionAdapter implements VoiceNoteTranscriptionAdapter {
  readonly key = "MOCK_WHATSAPP_VOICE_NOTE";

  constructor(private readonly fixtures: ReadonlyMap<string, string>) {}

  async transcribe(input: VoiceNoteTranscriptionInput): Promise<VoiceNoteTranscriptionResult> {
    const text = this.fixtures.get(input.mediaReference);
    if (!text) throw new Error("MOCK_TRANSCRIPTION_NOT_FOUND");
    return { confidence: 0.99, language: detectAIContentLanguage(text), text };
  }
}

export class DeterministicMockTelephonyAdapter implements ProviderNeutralTelephonyAdapter {
  readonly key = "MOCK_VOICE";
  readonly commands: Array<Readonly<{ callReference: string; kind: string }>> = [];

  constructor(
    private readonly behavior:
      "PERMANENT_FAILURE" | "SUCCESS" | "TIMEOUT" | "TRANSIENT_ONCE" = "SUCCESS",
  ) {}

  private assertAvailable(): void {
    if (this.behavior === "TIMEOUT") {
      throw new TelephonyAdapterError("PROVIDER_TIMEOUT", true);
    }
    if (this.behavior === "PERMANENT_FAILURE") {
      throw new TelephonyAdapterError("PROVIDER_FAILURE", false);
    }
  }

  async interrupt(input: TelephonyCommandInput): Promise<void> {
    this.assertAvailable();
    this.commands.push({ callReference: input.callReference, kind: "interrupt" });
  }

  async speak(
    input: TelephonyCommandInput & Readonly<{ locale: "ar" | "en"; text: string }>,
  ): Promise<void> {
    this.assertAvailable();
    this.commands.push({ callReference: input.callReference, kind: "speak" });
  }

  async startRecording(
    input: TelephonyCommandInput,
  ): Promise<Readonly<{ providerRecordingId: string }>> {
    this.assertAvailable();
    this.commands.push({ callReference: input.callReference, kind: "start_recording" });
    return {
      providerRecordingId: `mock-recording-${createHash("sha256")
        .update(input.idempotencyKey)
        .digest("hex")
        .slice(0, 20)}`,
    };
  }

  async transfer(
    input: TelephonyCommandInput & Readonly<{ destinationReference?: string | undefined }>,
  ): Promise<void> {
    this.assertAvailable();
    this.commands.push({ callReference: input.callReference, kind: "transfer" });
  }
}
