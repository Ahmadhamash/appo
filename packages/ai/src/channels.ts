import type {
  AIChannelConfirmationPort,
  VoiceConfirmationEvidence,
} from "@jormall/domain/ai-channels";
import {
  classifyExplicitConfirmation,
  voiceConfirmationIsReliable,
} from "@jormall/domain/ai-channels";
import type { AITrustedContext } from "@jormall/domain/ai-foundation";

import type { OrchestratorTurnResult, SafeAIOrchestrator } from "./orchestrator";

export type AIChannelTurnResult = OrchestratorTurnResult &
  Readonly<{
    confirmationState?: "CONFIRMED" | "DECLINED" | "NEEDS_CLARIFICATION" | undefined;
    suppressed: boolean;
  }>;

export class SharedAIChannelCoordinator {
  constructor(
    private readonly orchestrator: SafeAIOrchestrator,
    private readonly confirmations: AIChannelConfirmationPort,
  ) {}

  async handleTurn(
    context: AITrustedContext,
    message: string,
    locale: "ar" | "en" | "mixed",
    voiceEvidence?: VoiceConfirmationEvidence,
    turnIdempotencyKey?: string,
  ): Promise<AIChannelTurnResult> {
    if (await this.confirmations.hasHumanTakeover(context)) {
      return {
        content: "",
        handoffRequested: true,
        informationAbsent: false,
        safetyStatus: "HANDOFF_REQUIRED",
        suppressed: true,
      };
    }
    const pending = await this.confirmations.loadPendingConfirmation(context);
    const decision = pending ? classifyExplicitConfirmation(message) : "NONE";
    if (pending && decision === "CONFIRM") {
      if (
        context.channel === "voice" &&
        (!voiceEvidence || !voiceConfirmationIsReliable(voiceEvidence))
      ) {
        const clarification =
          locale === "ar"
            ? "لم ألتقط تأكيدًا واضحًا. قل: نعم، أؤكد."
            : "I did not capture a clear confirmation. Please say: I confirm.";
        return {
          ...(await this.orchestrator.recordDeterministicTurn(
            context,
            message,
            clarification,
            "AMBIGUOUS",
          )),
          confirmationState: "NEEDS_CLARIFICATION",
          suppressed: false,
        };
      }
      const evidence = await this.confirmations.approvePendingConfirmation(
        context,
        pending.approvalId,
        pending.summaryHash,
      );
      return {
        ...(await this.orchestrator.confirmPendingAction(
          context,
          pending,
          evidence,
          locale,
          message,
        )),
        confirmationState: "CONFIRMED",
        suppressed: false,
      };
    }
    if (pending && decision === "DECLINE") {
      await this.confirmations.declinePendingConfirmation(context);
      const declined =
        locale === "ar"
          ? "تم رفض الإجراء ولم يتم تغيير الموعد."
          : "The action was declined and no appointment change was made.";
      return {
        ...(await this.orchestrator.recordDeterministicTurn(context, message, declined)),
        confirmationState: "DECLINED",
        suppressed: false,
      };
    }
    return {
      ...(await this.orchestrator.runTurn(context, message, locale, turnIdempotencyKey)),
      suppressed: false,
    };
  }
}
