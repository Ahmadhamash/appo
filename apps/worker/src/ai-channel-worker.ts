import {
  DeterministicMockTelephonyAdapter,
  DeterministicMockVoiceNoteTranscriptionAdapter,
} from "@jormall/ai/channel-adapters";
import { SharedAIChannelCoordinator } from "@jormall/ai/channels";
import { SafeActionGateway } from "@jormall/ai/gateway";
import { DeterministicMockModelAdapter } from "@jormall/ai/model";
import { SafeAIOrchestrator } from "@jormall/ai/orchestrator";
import { voiceWebhookPayloadSchema } from "@jormall/contracts/ai-channels";
import { whatsAppWebhookPayloadSchema } from "@jormall/contracts/communications";
import { AIChannelRepository } from "@jormall/db/ai-channel-repository";
import { AIFoundationRepository } from "@jormall/db/ai-foundation-repository";
import { prisma } from "@jormall/db/client";
import { DomainError } from "@jormall/domain/errors";

const aiFoundation = new AIFoundationRepository(prisma);
const channelRepository = new AIChannelRepository(prisma);
const model = new DeterministicMockModelAdapter();
const gateway = new SafeActionGateway(aiFoundation);
const orchestrator = new SafeAIOrchestrator(model, gateway, aiFoundation, aiFoundation);
const coordinator = new SharedAIChannelCoordinator(orchestrator, aiFoundation);

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringValue(value: unknown, key: string): string | undefined {
  const entry = record(value)?.[key];
  return typeof entry === "string" ? entry : undefined;
}

export async function processAIChannelEvent(
  organizationId: string,
  outboxEventId: string,
  eventType: string,
): Promise<void> {
  if (eventType === "AI_WHATSAPP_TURN_REQUESTED") {
    await processWhatsAppEvent(organizationId, outboxEventId);
    return;
  }
  if (eventType === "AI_VOICE_EVENT_REQUESTED") {
    await processVoiceEvent(organizationId, outboxEventId);
    return;
  }
  throw new DomainError({ code: "VALIDATION_FAILED", message: "Unknown AI channel event." });
}

async function processWhatsAppEvent(organizationId: string, outboxEventId: string): Promise<void> {
  const work = await channelRepository.loadWhatsAppTurn(organizationId, outboxEventId);
  const event = whatsAppWebhookPayloadSchema.parse(work.inbox.payload);
  let content = event.body;
  if (!content && event.voiceNote) {
    const fixtures = new Map<string, string>();
    if (event.voiceNote.mockTranscript) {
      fixtures.set(event.voiceNote.mediaReference, event.voiceNote.mockTranscript);
    }
    const transcription = await new DeterministicMockVoiceNoteTranscriptionAdapter(
      fixtures,
    ).transcribe({
      mediaReference: event.voiceNote.mediaReference,
      providerConnectionReference: work.inbox.providerConnectionId,
    });
    content = transcription.text;
  }
  if (!content || !event.from) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Inbound AI message is invalid." });
  }
  if (channelRepository.isOptOut(content)) {
    await channelRepository.applyWhatsAppOptOut(
      organizationId,
      outboxEventId,
      work.message.customerId,
    );
    return;
  }
  const context = await channelRepository.resolveWhatsAppContext({
    organizationId,
    providerConnectionId: work.inbox.providerConnectionId,
    sender: event.from,
  });
  const result = await coordinator.handleTurn(
    context,
    content,
    work.message.locale,
    undefined,
    `whatsapp-event:${work.inbox.id}`,
  );
  if (result.suppressed) {
    await channelRepository.markSuppressedChannelTurn(organizationId, outboxEventId);
    return;
  }
  await channelRepository.queueWhatsAppAssistantResponse({
    body: result.content,
    inboundMessageId: work.message.id,
    organizationId,
    outboxEventId,
  });
}

async function processVoiceEvent(organizationId: string, outboxEventId: string): Promise<void> {
  const work = await channelRepository.loadVoiceEvent(organizationId, outboxEventId);
  const event = voiceWebhookPayloadSchema.parse(work.callEvent.payload);
  const call = work.callEvent.call;
  const telephony = new DeterministicMockTelephonyAdapter(call.providerConnection.mockBehavior);
  if (event.type === "transcript.final" && event.text) {
    const context = await channelRepository.trustedVoiceContext(
      organizationId,
      call.channelSessionId,
    );
    const result = await coordinator.handleTurn(
      context,
      event.text,
      event.locale,
      {
        confidence: event.confidence ?? 0,
        isFinal: event.isFinal === true,
      },
      `voice-event:${work.callEvent.id}`,
    );
    if (result.suppressed) {
      await channelRepository.processVoiceLifecycleEvent({
        callEventId: work.callEvent.id,
        organizationId,
        outboxEventId,
        type: "suppressed",
      });
      return;
    }
    await telephony.speak({
      callReference: call.providerCallId,
      idempotencyKey: `${work.callEvent.id}:speak`,
      locale: event.locale,
      text: result.content,
    });
    await channelRepository.recordVoiceAssistantResponse({
      callEventId: work.callEvent.id,
      callId: call.id,
      content: result.content,
      locale: event.locale,
      organizationId,
      outboxEventId,
    });
    const appointmentId = stringValue(result.action?.payload, "bookingReference");
    if (appointmentId || result.handoffRequested) {
      await channelRepository.recordCallSummary({
        ...(appointmentId ? { appointmentId } : {}),
        callId: call.id,
        ...(result.handoffRequested ? { handoffReason: "AI requested human handoff" } : {}),
        intent: result.action ? result.action.outcome : "conversation",
        organizationId,
        outcome: result.content,
        unresolvedItems: result.handoffRequested ? ["Human follow-up required"] : [],
      });
    }
    if (result.handoffRequested) {
      await telephony.transfer({
        callReference: call.providerCallId,
        idempotencyKey: `${work.callEvent.id}:transfer`,
      });
    }
    return;
  }
  if (event.type === "barge_in" || event.type === "interrupted") {
    await telephony.interrupt({
      callReference: call.providerCallId,
      idempotencyKey: `${work.callEvent.id}:interrupt`,
    });
  }
  if (event.type === "call.missed") {
    await channelRepository.queueMissedCallRecovery({
      callId: call.id,
      organizationId,
      outboxEventId,
    });
    return;
  }
  if (event.type === "silence") {
    const clarification =
      event.locale === "ar"
        ? "لم أسمع طلبك بوضوح. هل يمكنك المحاولة مرة أخرى؟"
        : "I could not hear your request clearly. Could you try again?";
    await telephony.speak({
      callReference: call.providerCallId,
      idempotencyKey: `${work.callEvent.id}:silence`,
      locale: event.locale,
      text: clarification,
    });
    await channelRepository.recordVoiceAssistantResponse({
      callEventId: work.callEvent.id,
      callId: call.id,
      content: clarification,
      locale: event.locale,
      organizationId,
      outboxEventId,
    });
    return;
  }
  if (event.type === "recording.start") {
    await channelRepository.assertRecordingConsent(organizationId, work.callEvent.id);
    const recording = await telephony.startRecording({
      callReference: call.providerCallId,
      idempotencyKey: `${work.callEvent.id}:recording`,
    });
    await channelRepository.startRecording({
      callEventId: work.callEvent.id,
      organizationId,
      providerRecordingId: recording.providerRecordingId,
    });
  }
  if (event.type === "human_transfer.requested") {
    const context = await channelRepository.trustedVoiceContext(
      organizationId,
      call.channelSessionId,
    );
    const result = await coordinator.handleTurn(
      context,
      event.locale === "ar" ? "بدي أحكي مع موظف" : "I need to speak to a person",
      event.locale,
    );
    if (!result.suppressed) {
      await telephony.speak({
        callReference: call.providerCallId,
        idempotencyKey: `${work.callEvent.id}:handoff-speak`,
        locale: event.locale,
        text: result.content,
      });
    }
    await telephony.transfer({
      callReference: call.providerCallId,
      idempotencyKey: `${work.callEvent.id}:transfer`,
    });
  }
  await channelRepository.processVoiceLifecycleEvent({
    callEventId: work.callEvent.id,
    organizationId,
    outboxEventId,
    type: event.type,
  });
}
