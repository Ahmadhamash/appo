export const aiActionNames = [
  "get_business_information",
  "list_branches",
  "list_services",
  "list_providers",
  "check_availability",
  "find_customer_safely",
  "create_booking",
  "reschedule_booking",
  "cancel_booking",
  "join_waitlist",
  "check_booking_status",
  "request_human_handoff",
] as const;

export type AIActionName = (typeof aiActionNames)[number];

export type AIActionChannel =
  "dashboard" | "evaluation" | "internal" | "voice" | "website_chat" | "whatsapp";

export type AITrustedContext = Readonly<{
  actorId: string;
  actorType: "authenticated_user" | "ai_receptionist" | "system";
  channel: AIActionChannel;
  conversationId: string;
  modelIdentifier: string;
  organizationId: string;
  verifiedCustomerId?: string | undefined;
}>;

export type LocalizedLookupInput = Readonly<{ locale?: "ar" | "en" | undefined }>;

export type AIActionCommand =
  | Readonly<{ input: LocalizedLookupInput; name: "get_business_information" }>
  | Readonly<{ input: LocalizedLookupInput; name: "list_branches" }>
  | Readonly<{
      input: LocalizedLookupInput & Readonly<{ branchReference?: string | undefined }>;
      name: "list_services";
    }>
  | Readonly<{
      input: LocalizedLookupInput &
        Readonly<{
          branchReference?: string | undefined;
          serviceReference?: string | undefined;
        }>;
      name: "list_providers";
    }>
  | Readonly<{
      input: Readonly<{
        branchReference: string;
        endsOn: string;
        providerReference?: string | undefined;
        serviceReference: string;
        startsOn: string;
      }>;
      name: "check_availability";
    }>
  | Readonly<{
      input: Readonly<{ displayName?: string | undefined; phoneOrEmail: string }>;
      name: "find_customer_safely";
    }>
  | Readonly<{
      input: Readonly<{
        branchReference: string;
        customerReference?: string | undefined;
        providerReference: string;
        serviceReference: string;
        startsAtLocal: string;
      }>;
      name: "create_booking";
    }>
  | Readonly<{
      input: Readonly<{
        bookingReference: string;
        expectedVersion: number;
        startsAtLocal: string;
      }>;
      name: "reschedule_booking";
    }>
  | Readonly<{
      input: Readonly<{ bookingReference: string; expectedVersion: number; reason: string }>;
      name: "cancel_booking";
    }>
  | Readonly<{
      input: Readonly<{
        branchReferences: readonly string[];
        customerReference?: string | undefined;
        preferredEndDate: string;
        preferredEndMinute: number;
        preferredStartDate: string;
        preferredStartMinute: number;
        providerReferences?: readonly string[] | undefined;
        serviceReference: string;
      }>;
      name: "join_waitlist";
    }>
  | Readonly<{
      input: Readonly<{ bookingReference: string }>;
      name: "check_booking_status";
    }>
  | Readonly<{
      input: Readonly<{
        reasonCode:
          | "AMBIGUOUS_REQUEST"
          | "CUSTOMER_REQUEST"
          | "LOW_CONFIDENCE"
          | "PROMPT_INJECTION"
          | "UNSUPPORTED_REQUEST";
        summary?: string | undefined;
      }>;
      name: "request_human_handoff";
    }>;

export type AIConfirmationEvidence = Readonly<{
  confirmedAt: string;
  confirmationId: string;
  summaryHash: string;
}>;

export type AIActionRuntimeRequest = Readonly<{
  command: AIActionCommand;
  confirmation?: AIConfirmationEvidence | undefined;
  idempotencyKey: string;
  inputFingerprint: string;
  occurredAt: string;
  rawInputRedacted: unknown;
  requestId: string;
  requiredPermission: string;
  trustedContext: AITrustedContext;
  validatedInputRedacted: unknown;
}>;

export type AIActionRuntimeResult = Readonly<{
  actionId: string;
  auditEventId: string;
  outcome: "completed" | "rejected" | "requires_confirmation";
  payload: unknown;
}>;

export interface AIActionRuntimePort {
  executeAction(request: AIActionRuntimeRequest): Promise<AIActionRuntimeResult>;
  rejectAction(
    request: Readonly<{
      actionName: AIActionName;
      errorCode: string;
      idempotencyKey: string;
      inputFingerprint: string;
      occurredAt: string;
      rawInputRedacted: unknown;
      requestId: string;
      requiredPermission: string;
      trustedContext: AITrustedContext;
    }>,
  ): Promise<AIActionRuntimeResult>;
}

export type AIKnowledgeChunkProjection = Readonly<{
  checksum: string;
  content: string;
  documentTitle: string;
  id: string;
  language: "ar" | "en" | "mixed";
  position: number;
  versionNumber: number;
}>;

export interface AIKnowledgeRetrievalPort {
  searchPublishedKnowledge(
    context: AITrustedContext,
    query: string,
    limit: number,
  ): Promise<readonly AIKnowledgeChunkProjection[]>;
}

export interface AIConversationRuntimePort {
  assertUsageWithinLimits(context: AITrustedContext): Promise<void>;
  appendAssistantMessage(
    context: AITrustedContext,
    input: Readonly<{
      content: string;
      latencyMs: number;
      safetyStatus: "SAFE" | "AMBIGUOUS" | "HANDOFF_REQUIRED" | "INJECTION_DETECTED";
    }>,
  ): Promise<string>;
  appendCustomerMessage(
    context: AITrustedContext,
    input: Readonly<{
      content: string;
      safetyStatus: "SAFE" | "AMBIGUOUS" | "HANDOFF_REQUIRED" | "INJECTION_DETECTED";
    }>,
  ): Promise<string>;
  loadActivePolicy(context: AITrustedContext): Promise<
    Readonly<{
      allowedActionNames: readonly AIActionName[];
      minimumConfidence: number;
      systemPrompt: string;
    }>
  >;
  recordUsage(
    context: AITrustedContext,
    input: Readonly<{
      estimatedCostMicros: number;
      inputTokens: number;
      latencyMs: number;
      outcome: "SUCCEEDED" | "REJECTED" | "FAILED";
      outputTokens: number;
    }>,
  ): Promise<void>;
}
