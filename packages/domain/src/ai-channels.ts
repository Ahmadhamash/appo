import type { AIActionName, AIConfirmationEvidence, AITrustedContext } from "./ai-foundation";
import { DomainError } from "./errors";

export const aiCustomerChannels = ["WEBSITE", "WHATSAPP", "VOICE"] as const;
export type AICustomerChannel = (typeof aiCustomerChannels)[number];

export type AIChannelPendingConfirmation = Readonly<{
  actionName: AIActionName;
  approvalId: string;
  expiresAt: string;
  idempotencyKey: string;
  payload: unknown;
  requestId: string;
  summary: string;
  summaryHash: string;
}>;

export interface AIChannelConfirmationPort {
  approvePendingConfirmation(
    context: AITrustedContext,
    approvalId: string,
    summaryHash: string,
  ): Promise<AIConfirmationEvidence>;
  declinePendingConfirmation(context: AITrustedContext): Promise<boolean>;
  hasHumanTakeover(context: AITrustedContext): Promise<boolean>;
  loadPendingConfirmation(context: AITrustedContext): Promise<AIChannelPendingConfirmation | null>;
}

const affirmativeConfirmationPatterns = [
  /^confirm$/iu,
  /^i\s+confirm$/iu,
  /^yes[,،]?\s+confirm$/iu,
  /^approve\s+(?:it|this)$/iu,
  /^أؤكد$/u,
  /^نعم[,،]?\s*(?:أؤكد|أكد)$/u,
  /^موافق\s+على\s+(?:الحجز|التعديل|الإلغاء)$/u,
];

const declineConfirmationPatterns = [
  /^decline$/iu,
  /^do\s+not\s+(?:proceed|confirm)$/iu,
  /^no[,،]?\s*(?:cancel|stop)$/iu,
  /^لا[,،]?\s*(?:تؤكد|تكمل|تنفذ)$/u,
  /^ارفض$/u,
  /^غير\s+موافق$/u,
];

export function classifyExplicitConfirmation(content: string): "CONFIRM" | "DECLINE" | "NONE" {
  const normalized = content.trim().replace(/\s+/gu, " ");
  if (affirmativeConfirmationPatterns.some((pattern) => pattern.test(normalized))) {
    return "CONFIRM";
  }
  if (declineConfirmationPatterns.some((pattern) => pattern.test(normalized))) {
    return "DECLINE";
  }
  return "NONE";
}

const optOutPatterns = [
  /^stop$/iu,
  /^unsubscribe$/iu,
  /^opt[ -]?out$/iu,
  /^cancel\s+messages$/iu,
  /^وقف$/u,
  /^إيقاف$/u,
  /^الغاء\s+الرسائل$/u,
  /^إلغاء\s+الرسائل$/u,
  /^لا\s+ترسل(?:وا)?\s+لي$/u,
];

export function isCommunicationOptOut(content: string): boolean {
  const normalized = content.trim().replace(/\s+/gu, " ");
  return optOutPatterns.some((pattern) => pattern.test(normalized));
}

export type VoiceConfirmationEvidence = Readonly<{
  confidence: number;
  isFinal: boolean;
}>;

export function voiceConfirmationIsReliable(evidence: VoiceConfirmationEvidence): boolean {
  return evidence.isFinal && evidence.confidence >= 0.85;
}

export const callStatuses = [
  "RINGING",
  "ACTIVE",
  "HUMAN_TRANSFER",
  "COMPLETED",
  "MISSED",
  "FAILED",
] as const;
export type CallStatusValue = (typeof callStatuses)[number];

export const callEventTypes = [
  "CALL_STARTED",
  "CALL_ANSWERED",
  "TRANSCRIPT_PARTIAL",
  "TRANSCRIPT_FINAL",
  "AI_RESPONSE_STARTED",
  "AI_RESPONSE_COMPLETED",
  "BARGE_IN",
  "SILENCE",
  "INTERRUPTED",
  "RECORDING_CONSENT_GRANTED",
  "RECORDING_CONSENT_DECLINED",
  "RECORDING_STARTED",
  "RECORDING_STOPPED",
  "HUMAN_TRANSFER_REQUESTED",
  "HUMAN_TRANSFERRED",
  "MISSED",
  "DISCONNECTED",
  "PROVIDER_FAILURE",
  "CALL_COMPLETED",
] as const;
export type CallEventTypeValue = (typeof callEventTypes)[number];

const allowedCallTransitions: Readonly<Record<CallStatusValue, readonly CallStatusValue[]>> = {
  ACTIVE: ["COMPLETED", "FAILED", "HUMAN_TRANSFER"],
  COMPLETED: [],
  FAILED: [],
  HUMAN_TRANSFER: ["COMPLETED", "FAILED"],
  MISSED: [],
  RINGING: ["ACTIVE", "FAILED", "MISSED"],
};

export function assertCallStatusTransition(from: CallStatusValue, to: CallStatusValue): void {
  if (!allowedCallTransitions[from].includes(to)) {
    throw new DomainError({
      code: "CONFLICT",
      message: `Call cannot transition from ${from} to ${to}.`,
      metadata: { from, to },
    });
  }
}

export type VoiceNoteTranscriptionInput = Readonly<{
  mediaReference: string;
  providerConnectionReference: string;
}>;

export type VoiceNoteTranscriptionResult = Readonly<{
  confidence: number;
  language: "ar" | "en" | "mixed";
  text: string;
}>;

export interface VoiceNoteTranscriptionAdapter {
  readonly key: string;
  transcribe(input: VoiceNoteTranscriptionInput): Promise<VoiceNoteTranscriptionResult>;
}

export type TelephonyCommandInput = Readonly<{
  callReference: string;
  idempotencyKey: string;
}>;

export interface ProviderNeutralTelephonyAdapter {
  readonly key: string;
  interrupt(input: TelephonyCommandInput): Promise<void>;
  speak(
    input: TelephonyCommandInput & Readonly<{ locale: "ar" | "en"; text: string }>,
  ): Promise<void>;
  startRecording(input: TelephonyCommandInput): Promise<Readonly<{ providerRecordingId: string }>>;
  transfer(
    input: TelephonyCommandInput & Readonly<{ destinationReference?: string | undefined }>,
  ): Promise<void>;
}

export class TelephonyAdapterError extends Error {
  constructor(
    readonly code: "PROVIDER_FAILURE" | "PROVIDER_TIMEOUT",
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "TelephonyAdapterError";
  }
}
