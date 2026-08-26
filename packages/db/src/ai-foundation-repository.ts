import { createHash, randomUUID } from "node:crypto";

import type {
  AIChannelConfirmationPort,
  AIChannelPendingConfirmation,
} from "@jormall/domain/ai-channels";
import {
  aiActionNames,
  type AIActionCommand,
  type AIActionName,
  type AIActionRuntimePort,
  type AIActionRuntimeRequest,
  type AIActionRuntimeResult,
  type AIConfirmationEvidence,
  type AIConversationRuntimePort,
  type AIKnowledgeChunkProjection,
  type AIKnowledgeRetrievalPort,
  type AITrustedContext,
} from "@jormall/domain/ai-foundation";
import {
  detectAIContentLanguage,
  detectAIInstructionInjection,
  redactAISensitiveFields,
  splitKnowledgeIntoChunks,
} from "@jormall/domain/ai-safety";
import { DomainError } from "@jormall/domain/errors";
import type {
  PermissionCode,
  PermissionScope,
  TenantAccessSnapshot,
} from "@jormall/domain/identity";
import { normalizeJordanianPhone } from "@jormall/domain/jordan-phone";

import { createAIFoundationDefaults, safeDefaultSystemPrompt } from "./ai-defaults";
import { CrmAppointmentRepository } from "./crm-appointment-repository";
import {
  AIActionApprovalStatus,
  AIActionOutcome,
  AIChannelPendingActionStatus,
  AIConversationStatus,
  AIMessageRole,
  AppointmentSource,
  HumanHandoffStatus,
  KnowledgeIngestionStatus,
  KnowledgeVersionStatus,
  OrganizationStatus,
  type AIMessageSafetyStatus,
  type AIUsageOutcome,
  type AIEvaluationOutcome,
  type Prisma,
  type PrismaClient,
} from "./generated/prisma/client";
import { SchedulingRepository } from "./scheduling-repository";
import { runInTenant, type TenantTransaction } from "./tenant-context";

const aiServiceActorId = "00000000-0000-4000-8000-000000000005";
const confirmationActionNames: ReadonlySet<AIActionName> = new Set([
  "cancel_booking",
  "create_booking",
  "reschedule_booking",
]);
const permissionRank: Readonly<Record<PermissionScope, number>> = {
  ASSIGNED_BRANCHES: 2,
  ORGANIZATION: 3,
  SELF: 1,
};
const gatewayPermissions: Readonly<Record<AIActionName, PermissionCode>> = {
  cancel_booking: "appointments.cancel",
  check_availability: "appointments.availability.read",
  check_booking_status: "appointments.read",
  create_booking: "appointments.create",
  find_customer_safely: "customers.read",
  get_business_information: "organization.read",
  join_waitlist: "waitlist.manage",
  list_branches: "branches.read",
  list_providers: "staff.read",
  list_services: "services.read",
  request_human_handoff: "conversations.handoff",
  reschedule_booking: "appointments.reschedule",
};

export type KnowledgeIngestionInput = Readonly<{
  content: string;
  name: string;
  originalFilename?: string | undefined;
  sourceId?: string | undefined;
  title: string;
}>;

export type PromptConfigurationInput = Readonly<{
  allowedActionNames: readonly AIActionName[];
  businessGuidance?: string | undefined;
  expectedVersion: number;
  minimumConfidence: number;
  monthlyActionLimit: number;
  monthlyCostLimitMicros: number;
  monthlyTokenLimit: number;
}>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uuidFromHash(value: string): string {
  const digest = hash(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toJson(item));
  if (typeof value === "object" && value !== null) {
    const object: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      object[key] = toJson(entry);
    }
    return object;
  }
  return String(value);
}

function fromJson(value: Prisma.JsonValue | null): unknown {
  return value ?? {};
}

function requirePermission(access: TenantAccessSnapshot, permission: PermissionCode): void {
  const scope = access.grants
    .filter((grant) => grant.code === permission)
    .toSorted((left, right) => permissionRank[right.scope] - permissionRank[left.scope])[0]?.scope;
  if (!scope) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "The active tenant context does not grant this permission.",
      metadata: { permission },
    });
  }
}

function assertActiveOrganization(status: OrganizationStatus): void {
  if (status === OrganizationStatus.SUSPENDED) {
    throw new DomainError({
      code: "ORGANIZATION_SUSPENDED",
      message: "Organization is suspended.",
    });
  }
  if (status !== OrganizationStatus.ACTIVE) {
    throw new DomainError({ code: "FORBIDDEN", message: "Organization is not active." });
  }
}

function isAIActionName(value: string): value is AIActionName {
  return (aiActionNames as readonly string[]).includes(value);
}

function gatewayAccess(
  context: AITrustedContext,
  permission: PermissionCode,
  gatewayActionId: string,
): TenantAccessSnapshot {
  return {
    actorUserId: aiServiceActorId,
    assignedBranchIds: [],
    grants: [{ code: permission, scope: "ORGANIZATION" }],
    gatewayActionId,
    organizationId: context.organizationId,
  };
}

function safeErrorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

export class AIFoundationRepository
  implements
    AIActionRuntimePort,
    AIChannelConfirmationPort,
    AIKnowledgeRetrievalPort,
    AIConversationRuntimePort
{
  private readonly appointments: CrmAppointmentRepository;
  private readonly scheduling: SchedulingRepository;

  constructor(private readonly client: PrismaClient) {
    this.appointments = new CrmAppointmentRepository(client);
    this.scheduling = new SchedulingRepository(client);
  }

  async ensureDefaults(access: TenantAccessSnapshot): Promise<void> {
    requirePermission(access, "ai.configure");
    await runInTenant(this.client, access, async (transaction) => {
      await createAIFoundationDefaults(transaction, access.organizationId);
    });
  }

  async listKnowledgeSources(access: TenantAccessSnapshot) {
    requirePermission(access, "knowledge.read");
    return runInTenant(this.client, access, async (transaction) => {
      await this.assertOrganization(transaction, access.organizationId);
      return transaction.knowledgeSource.findMany({
        include: {
          activeVersion: { select: { id: true, versionNumber: true } },
          versions: {
            include: {
              _count: { select: { chunks: true, documents: true } },
            },
            orderBy: { versionNumber: "desc" },
          },
        },
        orderBy: { updatedAt: "desc" },
        where: { organizationId: access.organizationId },
      });
    });
  }

  async ingestKnowledge(access: TenantAccessSnapshot, input: KnowledgeIngestionInput) {
    requirePermission(access, "knowledge.manage");
    const content = input.content.replace(/\r\n?/g, "\n").trim();
    const name = input.name.trim();
    const title = input.title.trim();
    if (
      !name ||
      name.length > 180 ||
      !title ||
      title.length > 220 ||
      content.length < 1 ||
      content.length > 200_000 ||
      (input.originalFilename?.length ?? 0) > 255
    ) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Knowledge input is invalid or exceeds the Phase 5A text limit.",
      });
    }
    const chunks = splitKnowledgeIntoChunks(content);
    if (chunks.length < 1 || chunks.length > 500) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Knowledge content produced an unsupported number of chunks.",
      });
    }
    return runInTenant(this.client, access, async (transaction) => {
      await this.assertOrganization(transaction, access.organizationId);
      const source = input.sourceId
        ? await transaction.knowledgeSource.findFirst({
            where: { id: input.sourceId, organizationId: access.organizationId },
          })
        : await transaction.knowledgeSource.create({
            data: {
              ingestionStatus: KnowledgeIngestionStatus.DRAFT,
              name,
              organizationId: access.organizationId,
              originalFilename: input.originalFilename ?? null,
              sourceType: input.originalFilename ? "TEXT_UPLOAD" : "MANUAL_TEXT",
            },
          });
      if (!source) {
        throw new DomainError({ code: "NOT_FOUND", message: "Knowledge source not found." });
      }
      const latest = await transaction.knowledgeVersion.aggregate({
        _max: { versionNumber: true },
        where: { organizationId: access.organizationId, sourceId: source.id },
      });
      const version = await transaction.knowledgeVersion.create({
        data: {
          checksum: hash(content),
          createdByUserId: access.actorUserId,
          organizationId: access.organizationId,
          sourceId: source.id,
          versionNumber: (latest._max.versionNumber ?? 0) + 1,
        },
      });
      const document = await transaction.knowledgeDocument.create({
        data: {
          checksum: hash(content),
          content,
          language: detectAIContentLanguage(content),
          organizationId: access.organizationId,
          sourceId: source.id,
          title,
          versionId: version.id,
        },
      });
      await transaction.knowledgeChunk.createMany({
        data: chunks.map((chunk, position) => {
          const injection = detectAIInstructionInjection(chunk);
          return {
            checksum: hash(chunk),
            content: chunk,
            documentId: document.id,
            isQuarantined: injection.detected,
            language: detectAIContentLanguage(chunk),
            organizationId: access.organizationId,
            position,
            safetyReason: injection.detected ? injection.reason : null,
            sourceId: source.id,
            versionId: version.id,
          };
        }),
      });
      await transaction.knowledgeSource.update({
        data: {
          ingestionStatus: KnowledgeIngestionStatus.READY,
          name,
          originalFilename: input.originalFilename ?? source.originalFilename,
        },
        where: { id: source.id },
      });
      await transaction.auditEvent.create({
        data: {
          action: "KNOWLEDGE_VERSION_INGESTED",
          actorUserId: access.actorUserId,
          metadata: { chunkCount: chunks.length, versionNumber: version.versionNumber },
          organizationId: access.organizationId,
          targetId: version.id,
          targetType: "KnowledgeVersion",
        },
      });
      return { sourceId: source.id, versionId: version.id, versionNumber: version.versionNumber };
    });
  }

  async activateKnowledgeVersion(
    access: TenantAccessSnapshot,
    sourceId: string,
    versionId: string,
  ) {
    requirePermission(access, "knowledge.manage");
    return runInTenant(this.client, access, async (transaction) => {
      await this.assertOrganization(transaction, access.organizationId);
      const [source, selected] = await Promise.all([
        transaction.knowledgeSource.findFirst({
          where: { id: sourceId, organizationId: access.organizationId },
        }),
        transaction.knowledgeVersion.findFirst({
          where: { id: versionId, organizationId: access.organizationId, sourceId },
        }),
      ]);
      if (!source || !selected) {
        throw new DomainError({ code: "NOT_FOUND", message: "Knowledge version not found." });
      }
      if (source.activeVersionId === selected.id) return selected;
      await transaction.knowledgeVersion.updateMany({
        data: { rolledBackAt: new Date(), status: KnowledgeVersionStatus.ROLLED_BACK },
        where: {
          organizationId: access.organizationId,
          sourceId,
          status: KnowledgeVersionStatus.ACTIVE,
        },
      });
      const active = await transaction.knowledgeVersion.update({
        data: {
          activatedAt: new Date(),
          rolledBackAt: null,
          status: KnowledgeVersionStatus.ACTIVE,
        },
        where: { id: selected.id },
      });
      await transaction.knowledgeSource.update({
        data: { activeVersionId: active.id },
        where: { id: source.id },
      });
      await transaction.auditEvent.create({
        data: {
          action:
            selected.status === KnowledgeVersionStatus.DRAFT
              ? "KNOWLEDGE_VERSION_ACTIVATED"
              : "KNOWLEDGE_VERSION_ROLLED_BACK",
          actorUserId: access.actorUserId,
          metadata: {
            previousVersionId: source.activeVersionId,
            versionNumber: selected.versionNumber,
          },
          organizationId: access.organizationId,
          targetId: active.id,
          targetType: "KnowledgeVersion",
        },
      });
      return active;
    });
  }

  async getPromptConfiguration(access: TenantAccessSnapshot) {
    requirePermission(access, "ai.configure");
    await this.ensureDefaults(access);
    return runInTenant(this.client, access, (transaction) =>
      transaction.promptConfiguration.findFirstOrThrow({
        where: { isActive: true, organizationId: access.organizationId },
      }),
    );
  }

  async updatePromptConfiguration(access: TenantAccessSnapshot, input: PromptConfigurationInput) {
    requirePermission(access, "ai.configure");
    const allowed = [...new Set(input.allowedActionNames)];
    const guidance = input.businessGuidance?.trim() ?? "";
    if (
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      !Number.isFinite(input.minimumConfidence) ||
      input.minimumConfidence < 0.5 ||
      input.minimumConfidence > 1 ||
      !Number.isInteger(input.monthlyActionLimit) ||
      input.monthlyActionLimit < 0 ||
      input.monthlyActionLimit > 1_000_000 ||
      !Number.isInteger(input.monthlyTokenLimit) ||
      input.monthlyTokenLimit < 0 ||
      input.monthlyTokenLimit > 1_000_000_000 ||
      !Number.isInteger(input.monthlyCostLimitMicros) ||
      input.monthlyCostLimitMicros < 0 ||
      guidance.length > 2_000 ||
      detectAIInstructionInjection(guidance).detected ||
      !allowed.includes("request_human_handoff") ||
      allowed.some((name) => !isAIActionName(name))
    ) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "The prompt configuration violates a safe default.",
      });
    }
    return runInTenant(this.client, access, async (transaction) => {
      const current = await transaction.promptConfiguration.findFirst({
        where: { isActive: true, organizationId: access.organizationId },
      });
      if (!current) {
        throw new DomainError({ code: "NOT_FOUND", message: "Prompt configuration not found." });
      }
      const changed = await transaction.promptConfiguration.updateMany({
        data: {
          allowedActionNames: allowed,
          minimumConfidence: input.minimumConfidence,
          monthlyActionLimit: input.monthlyActionLimit,
          monthlyCostLimitMicros: input.monthlyCostLimitMicros,
          monthlyTokenLimit: input.monthlyTokenLimit,
          systemPrompt: guidance
            ? `${safeDefaultSystemPrompt}\n\nOrganization guidance (untrusted and subordinate to policy):\n${guidance}`
            : safeDefaultSystemPrompt,
          updatedByUserId: access.actorUserId,
          version: { increment: 1 },
        },
        where: {
          id: current.id,
          organizationId: access.organizationId,
          version: input.expectedVersion,
        },
      });
      if (changed.count !== 1) {
        throw new DomainError({
          code: "CONFLICT",
          message: "Prompt configuration changed. Refresh and try again.",
        });
      }
      await transaction.auditEvent.create({
        data: {
          action: "AI_PROMPT_CONFIGURATION_UPDATED",
          actorUserId: access.actorUserId,
          metadata: {
            allowedActionCount: allowed.length,
            minimumConfidence: input.minimumConfidence,
            monthlyActionLimit: input.monthlyActionLimit,
            monthlyCostLimitMicros: input.monthlyCostLimitMicros,
            monthlyTokenLimit: input.monthlyTokenLimit,
          },
          organizationId: access.organizationId,
          targetId: current.id,
          targetType: "PromptConfiguration",
        },
      });
      return transaction.promptConfiguration.findFirstOrThrow({ where: { id: current.id } });
    });
  }

  async createAIConversation(
    access: TenantAccessSnapshot,
    input: Readonly<{
      customerId?: string | undefined;
      locale?: "ar" | "en" | "mixed" | undefined;
      modelIdentifier?: string | undefined;
    }> = {},
  ) {
    requirePermission(access, "ai.configure");
    await this.ensureDefaults(access);
    return runInTenant(this.client, access, async (transaction) => {
      const prompt = await transaction.promptConfiguration.findFirstOrThrow({
        where: { isActive: true, organizationId: access.organizationId },
      });
      if (input.customerId) {
        const customer = await transaction.customer.findFirst({
          where: {
            id: input.customerId,
            isArchived: false,
            organizationId: access.organizationId,
          },
        });
        if (!customer) {
          throw new DomainError({ code: "NOT_FOUND", message: "Customer not found." });
        }
      }
      return transaction.aIConversation.create({
        data: {
          channel: "INTERNAL",
          createdByUserId: access.actorUserId,
          customerId: input.customerId ?? null,
          locale: input.locale ?? "mixed",
          modelIdentifier: input.modelIdentifier ?? "jormall-deterministic-mock-v1",
          organizationId: access.organizationId,
          promptConfigurationId: prompt.id,
        },
      });
    });
  }

  async trustedContextForConversation(
    access: TenantAccessSnapshot,
    conversationId: string,
    channel: AITrustedContext["channel"] = "internal",
  ): Promise<AITrustedContext> {
    requirePermission(access, "ai.configure");
    const conversation = await runInTenant(this.client, access, async (transaction) => {
      await this.assertOrganization(transaction, access.organizationId);
      return transaction.aIConversation.findFirst({
        where: { id: conversationId, organizationId: access.organizationId },
      });
    });
    if (!conversation) {
      throw new DomainError({ code: "NOT_FOUND", message: "AI conversation not found." });
    }
    return {
      actorId: aiServiceActorId,
      actorType: "ai_receptionist",
      channel,
      conversationId,
      modelIdentifier: conversation.modelIdentifier,
      organizationId: access.organizationId,
      ...(conversation.customerId ? { verifiedCustomerId: conversation.customerId } : {}),
    };
  }

  async listAIConversations(access: TenantAccessSnapshot) {
    requirePermission(access, "conversations.read");
    return runInTenant(this.client, access, (transaction) =>
      transaction.aIConversation.findMany({
        include: {
          _count: { select: { actions: true, handoffs: true, messages: true } },
          customer: { select: { displayName: true, id: true } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async getAIConversation(access: TenantAccessSnapshot, conversationId: string) {
    requirePermission(access, "conversations.read");
    const conversation = await runInTenant(this.client, access, (transaction) =>
      transaction.aIConversation.findFirst({
        include: {
          actions: { include: { approval: true }, orderBy: { createdAt: "desc" } },
          customer: { select: { displayName: true, id: true } },
          handoffs: { orderBy: { createdAt: "desc" } },
          messages: { orderBy: { createdAt: "asc" } },
        },
        where: { id: conversationId, organizationId: access.organizationId },
      }),
    );
    if (!conversation) {
      throw new DomainError({ code: "NOT_FOUND", message: "AI conversation not found." });
    }
    return conversation;
  }

  async listAIActionAudit(access: TenantAccessSnapshot) {
    requirePermission(access, "audit.read");
    return runInTenant(this.client, access, (transaction) =>
      transaction.aIAction.findMany({
        include: { approval: true },
        orderBy: { createdAt: "desc" },
        take: 200,
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async listHumanHandoffs(access: TenantAccessSnapshot) {
    requirePermission(access, "conversations.handoff");
    return runInTenant(this.client, access, (transaction) =>
      transaction.humanHandoff.findMany({
        include: {
          assignedMembership: { include: { user: { select: { email: true, name: true } } } },
          conversation: { select: { id: true, locale: true } },
          customer: { select: { displayName: true, id: true } },
        },
        orderBy: [{ status: "asc" }, { createdAt: "asc" }],
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async updateHumanHandoff(
    access: TenantAccessSnapshot,
    handoffId: string,
    status: "ASSIGNED" | "CLOSED" | "RESOLVED",
    assignedMembershipId?: string,
  ) {
    requirePermission(access, "conversations.handoff");
    return runInTenant(this.client, access, async (transaction) => {
      if (assignedMembershipId) {
        const membership = await transaction.organizationMembership.findFirst({
          where: {
            id: assignedMembershipId,
            organizationId: access.organizationId,
            status: "ACTIVE",
          },
        });
        if (!membership) {
          throw new DomainError({ code: "NOT_FOUND", message: "Assignee not found." });
        }
      }
      const changed = await transaction.humanHandoff.updateMany({
        data: {
          ...(assignedMembershipId ? { assignedMembershipId } : {}),
          resolvedAt: status === "RESOLVED" || status === "CLOSED" ? new Date() : null,
          status,
        },
        where: {
          id: handoffId,
          organizationId: access.organizationId,
          status: { in: [HumanHandoffStatus.OPEN, HumanHandoffStatus.ASSIGNED] },
        },
      });
      if (changed.count !== 1) {
        throw new DomainError({ code: "CONFLICT", message: "Handoff is no longer actionable." });
      }
      await transaction.auditEvent.create({
        data: {
          action: "AI_HANDOFF_UPDATED",
          actorUserId: access.actorUserId,
          metadata: { status },
          organizationId: access.organizationId,
          targetId: handoffId,
          targetType: "HumanHandoff",
        },
      });
      return transaction.humanHandoff.findFirstOrThrow({ where: { id: handoffId } });
    });
  }

  async usageDashboard(access: TenantAccessSnapshot) {
    requirePermission(access, "reports.read");
    return runInTenant(this.client, access, async (transaction) => {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [configuration, usage, actionCount, outcomeCounts, channelUsage] = await Promise.all([
        transaction.promptConfiguration.findFirst({
          where: { isActive: true, organizationId: access.organizationId },
        }),
        transaction.aIUsage.aggregate({
          _sum: { estimatedCostMicros: true, inputTokens: true, outputTokens: true },
          where: { occurredAt: { gte: monthStart }, organizationId: access.organizationId },
        }),
        transaction.aIAction.count({
          where: { createdAt: { gte: monthStart }, organizationId: access.organizationId },
        }),
        transaction.aIAction.groupBy({
          _count: { _all: true },
          by: ["outcome"],
          where: { createdAt: { gte: monthStart }, organizationId: access.organizationId },
        }),
        transaction.aIUsage.groupBy({
          _avg: { latencyMs: true },
          _count: { _all: true },
          _sum: { estimatedCostMicros: true, inputTokens: true, outputTokens: true },
          by: ["channel"],
          where: { occurredAt: { gte: monthStart }, organizationId: access.organizationId },
        }),
      ]);
      return { actionCount, channelUsage, configuration, outcomeCounts, usage: usage._sum };
    });
  }

  async listEvaluationCases(access: TenantAccessSnapshot) {
    requirePermission(access, "ai.configure");
    await this.ensureDefaults(access);
    return runInTenant(this.client, access, (transaction) =>
      transaction.aIEvaluationCase.findMany({
        include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { name: "asc" },
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async recordEvaluationRun(
    access: TenantAccessSnapshot,
    input: Readonly<{
      actualAction?: AIActionName | undefined;
      evaluationCaseId: string;
      latencyMs: number;
      modelIdentifier: string;
      outcome: "PASS" | "FAIL" | "ERROR";
      responseExcerpt?: string | undefined;
      safeTrace?: unknown;
    }>,
  ) {
    requirePermission(access, "ai.configure");
    if (
      !Number.isInteger(input.latencyMs) ||
      input.latencyMs < 0 ||
      input.modelIdentifier.trim().length < 2 ||
      input.modelIdentifier.length > 160 ||
      (input.responseExcerpt?.length ?? 0) > 500
    ) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "AI evaluation is invalid." });
    }
    return runInTenant(this.client, access, async (transaction) => {
      const [evaluationCase, configuration] = await Promise.all([
        transaction.aIEvaluationCase.findFirst({
          where: {
            id: input.evaluationCaseId,
            isActive: true,
            organizationId: access.organizationId,
          },
        }),
        transaction.promptConfiguration.findFirst({
          where: { isActive: true, organizationId: access.organizationId },
        }),
      ]);
      if (!evaluationCase) {
        throw new DomainError({ code: "NOT_FOUND", message: "Evaluation case not found." });
      }
      const run = await transaction.aIEvaluationRun.create({
        data: {
          actualAction: input.actualAction ?? null,
          evaluationCaseId: evaluationCase.id,
          latencyMs: input.latencyMs,
          modelIdentifier: input.modelIdentifier.trim(),
          organizationId: access.organizationId,
          outcome: input.outcome as AIEvaluationOutcome,
          promptConfigurationId: configuration?.id ?? null,
          responseExcerpt: input.responseExcerpt?.trim() || null,
          ...(input.safeTrace === undefined
            ? {}
            : { safeTrace: toJson(redactAISensitiveFields(input.safeTrace)) }),
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: "AI_EVALUATION_RUN_RECORDED",
          actorUserId: access.actorUserId,
          metadata: {
            evaluationCaseId: evaluationCase.id,
            modelIdentifier: run.modelIdentifier,
            outcome: run.outcome,
          },
          organizationId: access.organizationId,
          targetId: run.id,
          targetType: "AIEvaluationRun",
        },
      });
      return run;
    });
  }

  async searchPublishedKnowledge(
    context: AITrustedContext,
    query: string,
    limit: number,
  ): Promise<readonly AIKnowledgeChunkProjection[]> {
    const normalizedLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
    const terms = query
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 3)
      .slice(0, 8);
    if (terms.length === 0) return [];
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        await this.assertTrustedConversation(transaction, context);
        const chunks = await transaction.knowledgeChunk.findMany({
          include: {
            document: { select: { title: true } },
            version: { select: { versionNumber: true } },
          },
          orderBy: [{ versionId: "asc" }, { position: "asc" }],
          take: normalizedLimit,
          where: {
            isQuarantined: false,
            organizationId: context.organizationId,
            version: { status: KnowledgeVersionStatus.ACTIVE },
            OR: terms.map((term) => ({ content: { contains: term, mode: "insensitive" } })),
          },
        });
        return chunks.map((chunk) => ({
          checksum: chunk.checksum,
          content: chunk.content,
          documentTitle: chunk.document.title,
          id: chunk.id,
          language: chunk.language,
          position: chunk.position,
          versionNumber: chunk.version.versionNumber,
        }));
      },
    );
  }

  async assertUsageWithinLimits(context: AITrustedContext): Promise<void> {
    await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        await this.assertTrustedConversation(transaction, context);
        const budget = await this.currentBudget(transaction, context.organizationId);
        if (budget.exhausted) {
          throw new DomainError({ code: "RATE_LIMITED", message: "AI usage limit reached." });
        }
      },
    );
  }

  async loadActivePolicy(context: AITrustedContext) {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        const conversation = await this.assertTrustedConversation(transaction, context);
        const configuration = conversation.promptConfiguration;
        if (!configuration?.isActive) {
          throw new DomainError({ code: "FORBIDDEN", message: "AI is not configured." });
        }
        return {
          allowedActionNames: configuration.allowedActionNames.filter(isAIActionName),
          minimumConfidence: configuration.minimumConfidence,
          systemPrompt: configuration.systemPrompt,
        };
      },
    );
  }

  async appendCustomerMessage(
    context: AITrustedContext,
    input: Readonly<{
      content: string;
      safetyStatus: "SAFE" | "AMBIGUOUS" | "HANDOFF_REQUIRED" | "INJECTION_DETECTED";
    }>,
  ): Promise<string> {
    return this.appendMessage(context, AIMessageRole.CUSTOMER, input.content, input.safetyStatus);
  }

  async appendAssistantMessage(
    context: AITrustedContext,
    input: Readonly<{
      content: string;
      latencyMs: number;
      safetyStatus: "SAFE" | "AMBIGUOUS" | "HANDOFF_REQUIRED" | "INJECTION_DETECTED";
    }>,
  ): Promise<string> {
    return this.appendMessage(context, AIMessageRole.ASSISTANT, input.content, input.safetyStatus);
  }

  async recordUsage(
    context: AITrustedContext,
    input: Readonly<{
      estimatedCostMicros: number;
      inputTokens: number;
      latencyMs: number;
      outcome: "SUCCEEDED" | "REJECTED" | "FAILED";
      outputTokens: number;
    }>,
  ): Promise<void> {
    if (
      [input.estimatedCostMicros, input.inputTokens, input.latencyMs, input.outputTokens].some(
        (value) => !Number.isInteger(value) || value < 0,
      )
    ) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "AI usage is invalid." });
    }
    await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        const conversation = await this.assertTrustedConversation(transaction, context);
        await transaction.aIUsage.create({
          data: {
            channel: context.channel,
            conversationId: conversation.id,
            estimatedCostMicros: input.estimatedCostMicros,
            inputTokens: input.inputTokens,
            latencyMs: input.latencyMs,
            modelIdentifier: context.modelIdentifier,
            organizationId: context.organizationId,
            outcome: input.outcome as AIUsageOutcome,
            outputTokens: input.outputTokens,
            promptConfigurationId: conversation.promptConfigurationId,
          },
        });
      },
    );
  }

  async executeAction(request: AIActionRuntimeRequest): Promise<AIActionRuntimeResult> {
    const startedAt = Date.now();
    const prepared = await this.prepareAction(request);
    if (prepared.result) return prepared.result;
    const action = prepared.action;
    if (!action) {
      throw new DomainError({ code: "INTERNAL_ERROR", message: "AI action was not prepared." });
    }
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: request.trustedContext.organizationId },
      async (transaction) => {
        await this.lockAction(transaction, request);
        const current = await transaction.aIAction.findFirstOrThrow({
          where: { id: action.id, organizationId: request.trustedContext.organizationId },
        });
        if (current.outcome === AIActionOutcome.COMPLETED && current.auditEventId) {
          return {
            actionId: current.id,
            auditEventId: current.auditEventId,
            outcome: "completed" as const,
            payload: fromJson(current.result),
          };
        }
        if (current.outcome === AIActionOutcome.REJECTED && current.auditEventId) {
          return {
            actionId: current.id,
            auditEventId: current.auditEventId,
            outcome: "rejected" as const,
            payload: fromJson(current.result),
          };
        }
        if (confirmationActionNames.has(request.command.name)) {
          const approval = await this.requireConfirmationInTransaction(
            transaction,
            request,
            action.id,
          );
          if (approval.result) return approval.result;
        }
        try {
          const payload = redactAISensitiveFields(
            await this.executeCommand(
              request.trustedContext,
              request.command,
              request.idempotencyKey,
              action.id,
            ),
          );
          const audit = await transaction.auditEvent.create({
            data: {
              action: "AI_ACTION_COMPLETED",
              metadata: {
                actionName: request.command.name,
                authorizationDecisionId: action.authorizationDecisionId,
                latencyMs: Date.now() - startedAt,
              },
              organizationId: request.trustedContext.organizationId,
              targetId: action.id,
              targetType: "AIAction",
            },
          });
          await transaction.aIAction.update({
            data: {
              auditEventId: audit.id,
              completedAt: new Date(),
              errorCode: null,
              latencyMs: Date.now() - startedAt,
              outcome: AIActionOutcome.COMPLETED,
              result: toJson(payload),
            },
            where: { id: action.id },
          });
          await transaction.aIActionApproval.updateMany({
            data: { consumedAt: new Date(), status: AIActionApprovalStatus.CONSUMED },
            where: {
              actionId: action.id,
              organizationId: request.trustedContext.organizationId,
              status: AIActionApprovalStatus.APPROVED,
            },
          });
          await transaction.aIChannelPendingAction.updateMany({
            data: {
              consumedAt: new Date(),
              status: AIChannelPendingActionStatus.CONSUMED,
            },
            where: {
              actionId: action.id,
              organizationId: request.trustedContext.organizationId,
              status: AIChannelPendingActionStatus.PENDING,
            },
          });
          return {
            actionId: action.id,
            auditEventId: audit.id,
            outcome: "completed" as const,
            payload,
          };
        } catch (error) {
          return this.finishRejectedInTransaction(
            transaction,
            request.trustedContext,
            action.id,
            request.command.name,
            safeErrorCode(error),
            Date.now() - startedAt,
          );
        }
      },
    );
  }

  async rejectAction(
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
  ): Promise<AIActionRuntimeResult> {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: request.trustedContext.organizationId },
      async (transaction) => {
        const conversation = await this.assertTrustedConversation(
          transaction,
          request.trustedContext,
        );
        await this.lockAction(transaction, request);
        const existing = await transaction.aIAction.findFirst({
          where: {
            actionName: request.actionName,
            idempotencyKey: request.idempotencyKey,
            organizationId: request.trustedContext.organizationId,
          },
        });
        if (
          existing &&
          existing.inputFingerprint === request.inputFingerprint &&
          existing.auditEventId
        ) {
          return {
            actionId: existing.id,
            auditEventId: existing.auditEventId,
            outcome: "rejected" as const,
            payload: { errorCode: existing.errorCode ?? request.errorCode },
          };
        }
        const action =
          existing ??
          (await transaction.aIAction.create({
            data: {
              actionName: request.actionName,
              actorId: request.trustedContext.actorId,
              actorType: request.trustedContext.actorType,
              authorizationDecisionId: randomUUID(),
              channel: request.trustedContext.channel,
              conversationId: conversation.id,
              idempotencyKey: request.idempotencyKey,
              inputFingerprint: request.inputFingerprint,
              latencyMs: 0,
              modelIdentifier: request.trustedContext.modelIdentifier,
              organizationId: request.trustedContext.organizationId,
              rawInput: toJson(request.rawInputRedacted),
              requestId: request.requestId,
              requiredPermission: request.requiredPermission,
              validatedInput: {},
            },
          }));
        const code = existing ? "IDEMPOTENCY_KEY_REUSED" : request.errorCode;
        const audit = await transaction.auditEvent.create({
          data: {
            action: "AI_ACTION_REJECTED",
            metadata: { actionName: request.actionName, errorCode: code },
            organizationId: request.trustedContext.organizationId,
            targetId: action.id,
            targetType: "AIAction",
          },
        });
        if (!existing) {
          await transaction.aIAction.update({
            data: {
              auditEventId: audit.id,
              completedAt: new Date(),
              errorCode: code,
              latencyMs: 0,
              outcome: AIActionOutcome.REJECTED,
              result: { errorCode: code },
            },
            where: { id: action.id },
          });
        }
        return {
          actionId: action.id,
          auditEventId: audit.id,
          outcome: "rejected" as const,
          payload: { errorCode: code },
        };
      },
    );
  }

  async recordVerifiedCustomerApproval(
    context: AITrustedContext,
    approvalId: string,
    summaryHash: string,
  ): Promise<Readonly<{ confirmedAt: string; confirmationId: string; summaryHash: string }>> {
    if (!context.verifiedCustomerId) {
      throw new DomainError({
        code: "FORBIDDEN",
        message: "Verified customer identity is required.",
      });
    }
    const customerId = context.verifiedCustomerId;
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        await this.assertTrustedConversation(transaction, context);
        const now = new Date();
        const changed = await transaction.aIActionApproval.updateMany({
          data: { confirmedAt: now, status: AIActionApprovalStatus.APPROVED },
          where: {
            conversationId: context.conversationId,
            customerId,
            expiresAt: { gt: now },
            id: approvalId,
            organizationId: context.organizationId,
            status: AIActionApprovalStatus.PENDING,
            summaryHash,
          },
        });
        if (changed.count !== 1) {
          throw new DomainError({
            code: "CONFLICT",
            message: "Confirmation is invalid, expired, or already used.",
          });
        }
        return { confirmedAt: now.toISOString(), confirmationId: approvalId, summaryHash };
      },
    );
  }

  async approvePendingConfirmation(
    context: AITrustedContext,
    approvalId: string,
    summaryHash: string,
  ): Promise<AIConfirmationEvidence> {
    return this.recordVerifiedCustomerApproval(context, approvalId, summaryHash);
  }

  async loadPendingConfirmation(
    context: AITrustedContext,
  ): Promise<AIChannelPendingConfirmation | null> {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        await this.assertTrustedConversation(transaction, context);
        const now = new Date();
        await transaction.aIChannelPendingAction.updateMany({
          data: { status: AIChannelPendingActionStatus.EXPIRED },
          where: {
            expiresAt: { lte: now },
            organizationId: context.organizationId,
            session: { conversationId: context.conversationId },
            status: AIChannelPendingActionStatus.PENDING,
          },
        });
        const pending = await transaction.aIChannelPendingAction.findFirst({
          include: { action: true, approval: true },
          orderBy: { createdAt: "desc" },
          where: {
            expiresAt: { gt: now },
            organizationId: context.organizationId,
            session: { conversationId: context.conversationId },
            status: AIChannelPendingActionStatus.PENDING,
          },
        });
        if (!pending || !isAIActionName(pending.action.actionName)) return null;
        return {
          actionName: pending.action.actionName,
          approvalId: pending.approvalId,
          expiresAt: pending.expiresAt.toISOString(),
          idempotencyKey: pending.action.idempotencyKey,
          payload: fromJson(pending.payload),
          requestId: pending.action.requestId,
          summary: pending.approval.summary,
          summaryHash: pending.approval.summaryHash,
        };
      },
    );
  }

  async declinePendingConfirmation(context: AITrustedContext): Promise<boolean> {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        await this.assertTrustedConversation(transaction, context);
        const pending = await transaction.aIChannelPendingAction.findFirst({
          where: {
            expiresAt: { gt: new Date() },
            organizationId: context.organizationId,
            session: { conversationId: context.conversationId },
            status: AIChannelPendingActionStatus.PENDING,
          },
        });
        if (!pending) return false;
        await transaction.aIChannelPendingAction.update({
          data: { consumedAt: new Date(), status: AIChannelPendingActionStatus.DECLINED },
          where: { id: pending.id },
        });
        await transaction.aIActionApproval.updateMany({
          data: { status: AIActionApprovalStatus.REVOKED },
          where: {
            id: pending.approvalId,
            organizationId: context.organizationId,
            status: AIActionApprovalStatus.PENDING,
          },
        });
        await transaction.auditEvent.create({
          data: {
            action: "AI_ACTION_CONFIRMATION_DECLINED",
            organizationId: context.organizationId,
            targetId: pending.actionId,
            targetType: "AIAction",
          },
        });
        return true;
      },
    );
  }

  async hasHumanTakeover(context: AITrustedContext): Promise<boolean> {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        const conversation = await this.assertTrustedConversation(transaction, context);
        return conversation.status === AIConversationStatus.WAITING_HUMAN;
      },
    );
  }

  private async appendMessage(
    context: AITrustedContext,
    role: AIMessageRole,
    content: string,
    safetyStatus: "SAFE" | "AMBIGUOUS" | "HANDOFF_REQUIRED" | "INJECTION_DETECTED",
  ): Promise<string> {
    if (!content.trim() || content.length > 20_000) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "AI message is invalid." });
    }
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        const conversation = await this.assertTrustedConversation(transaction, context);
        const message = await transaction.aIMessage.create({
          data: {
            content,
            conversationId: conversation.id,
            modelIdentifier: role === AIMessageRole.ASSISTANT ? context.modelIdentifier : null,
            organizationId: context.organizationId,
            role,
            safetyStatus: safetyStatus as AIMessageSafetyStatus,
          },
        });
        await transaction.aIConversation.update({
          data: { lastMessageAt: message.createdAt, version: { increment: 1 } },
          where: { id: conversation.id },
        });
        return message.id;
      },
    );
  }

  private async prepareAction(request: AIActionRuntimeRequest): Promise<
    Readonly<{
      action?: Awaited<ReturnType<TenantTransaction["aIAction"]["create"]>>;
      result?: AIActionRuntimeResult;
    }>
  > {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: request.trustedContext.organizationId },
      async (transaction) => {
        const conversation = await this.assertTrustedConversation(
          transaction,
          request.trustedContext,
        );
        const expectedPermission = gatewayPermissions[request.command.name];
        await this.lockAction(transaction, request);
        const existing = await transaction.aIAction.findFirst({
          where: {
            actionName: request.command.name,
            idempotencyKey: request.idempotencyKey,
            organizationId: request.trustedContext.organizationId,
          },
        });
        if (request.requiredPermission !== expectedPermission) {
          if (existing) {
            const audit = await transaction.auditEvent.create({
              data: {
                action: "AI_ACTION_REJECTED",
                metadata: {
                  actionName: request.command.name,
                  errorCode: "AUTHORIZATION_DENIED",
                },
                organizationId: request.trustedContext.organizationId,
                targetId: existing.id,
                targetType: "AIAction",
              },
            });
            return {
              result: {
                actionId: existing.id,
                auditEventId: audit.id,
                outcome: "rejected",
                payload: { errorCode: "AUTHORIZATION_DENIED" },
              },
            };
          }
          return {
            result: await this.rejectPrepared(transaction, request, "AUTHORIZATION_DENIED"),
          };
        }
        if (existing) {
          if (existing.inputFingerprint !== request.inputFingerprint) {
            const audit = await transaction.auditEvent.create({
              data: {
                action: "AI_ACTION_IDEMPOTENCY_REJECTED",
                metadata: { actionName: request.command.name },
                organizationId: request.trustedContext.organizationId,
                targetId: existing.id,
                targetType: "AIAction",
              },
            });
            return {
              result: {
                actionId: existing.id,
                auditEventId: audit.id,
                outcome: "rejected",
                payload: { errorCode: "IDEMPOTENCY_KEY_REUSED" },
              },
            };
          }
          if (existing.outcome === AIActionOutcome.COMPLETED && existing.auditEventId) {
            return {
              result: {
                actionId: existing.id,
                auditEventId: existing.auditEventId,
                outcome: "completed",
                payload: fromJson(existing.result),
              },
            };
          }
          if (existing.outcome === AIActionOutcome.REJECTED && existing.auditEventId) {
            return {
              result: {
                actionId: existing.id,
                auditEventId: existing.auditEventId,
                outcome: "rejected",
                payload: fromJson(existing.result),
              },
            };
          }
          return { action: existing };
        }
        if (!conversation.promptConfiguration?.allowedActionNames.includes(request.command.name)) {
          return { result: await this.rejectPrepared(transaction, request, "ACTION_DISABLED") };
        }
        const budget = await this.currentBudget(transaction, request.trustedContext.organizationId);
        if (budget.exhausted) {
          return {
            result: await this.rejectPrepared(transaction, request, "AI_USAGE_LIMIT_REACHED"),
          };
        }
        const action = await transaction.aIAction.create({
          data: {
            actionName: request.command.name,
            actorId: request.trustedContext.actorId,
            actorType: request.trustedContext.actorType,
            authorizationDecisionId: randomUUID(),
            channel: request.trustedContext.channel,
            conversationId: conversation.id,
            idempotencyKey: request.idempotencyKey,
            inputFingerprint: request.inputFingerprint,
            modelIdentifier: request.trustedContext.modelIdentifier,
            organizationId: request.trustedContext.organizationId,
            rawInput: toJson(request.rawInputRedacted),
            requestId: request.requestId,
            requiredPermission: expectedPermission,
            validatedInput: toJson(request.validatedInputRedacted),
          },
        });
        return { action };
      },
    );
  }

  private async rejectPrepared(
    transaction: TenantTransaction,
    request: AIActionRuntimeRequest,
    errorCode: string,
  ): Promise<AIActionRuntimeResult> {
    const action = await transaction.aIAction.create({
      data: {
        actionName: request.command.name,
        actorId: request.trustedContext.actorId,
        actorType: request.trustedContext.actorType,
        authorizationDecisionId: randomUUID(),
        channel: request.trustedContext.channel,
        conversationId: request.trustedContext.conversationId,
        errorCode,
        idempotencyKey: request.idempotencyKey,
        inputFingerprint: request.inputFingerprint,
        latencyMs: 0,
        modelIdentifier: request.trustedContext.modelIdentifier,
        organizationId: request.trustedContext.organizationId,
        outcome: AIActionOutcome.REJECTED,
        rawInput: toJson(request.rawInputRedacted),
        requestId: request.requestId,
        requiredPermission: request.requiredPermission,
        result: { errorCode },
        validatedInput: toJson(request.validatedInputRedacted),
      },
    });
    const audit = await transaction.auditEvent.create({
      data: {
        action: "AI_ACTION_REJECTED",
        metadata: { actionName: request.command.name, errorCode },
        organizationId: request.trustedContext.organizationId,
        targetId: action.id,
        targetType: "AIAction",
      },
    });
    await transaction.aIAction.update({
      data: { auditEventId: audit.id, completedAt: new Date() },
      where: { id: action.id },
    });
    return {
      actionId: action.id,
      auditEventId: audit.id,
      outcome: "rejected",
      payload: { errorCode },
    };
  }

  private async requireConfirmationInTransaction(
    transaction: TenantTransaction,
    request: AIActionRuntimeRequest,
    actionId: string,
  ): Promise<Readonly<{ result?: AIActionRuntimeResult }>> {
    const customerId = request.trustedContext.verifiedCustomerId;
    if (!customerId) {
      return {
        result: await this.finishRejectedInTransaction(
          transaction,
          request.trustedContext,
          actionId,
          request.command.name,
          "VERIFIED_CUSTOMER_REQUIRED",
        ),
      };
    }
    const existing = await transaction.aIActionApproval.findFirst({
      where: { actionId, organizationId: request.trustedContext.organizationId },
    });
    if (!request.confirmation) {
      const summary = await this.actionSummary(transaction, request);
      const approval =
        existing ??
        (await transaction.aIActionApproval.create({
          data: {
            actionId,
            actionName: request.command.name,
            conversationId: request.trustedContext.conversationId,
            customerId,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            organizationId: request.trustedContext.organizationId,
            payloadHash: request.inputFingerprint,
            summary,
            summaryHash: hash(summary),
          },
        }));
      const session = await transaction.aIChannelSession.findFirst({
        select: { id: true },
        where: {
          conversationId: request.trustedContext.conversationId,
          organizationId: request.trustedContext.organizationId,
          status: "OPEN",
        },
      });
      if (session) {
        await transaction.aIChannelPendingAction.upsert({
          create: {
            actionId,
            approvalId: approval.id,
            expiresAt: approval.expiresAt,
            organizationId: request.trustedContext.organizationId,
            payload: toJson(request.command.input),
            sessionId: session.id,
          },
          update: {
            expiresAt: approval.expiresAt,
            payload: toJson(request.command.input),
            status: AIChannelPendingActionStatus.PENDING,
          },
          where: { actionId },
        });
      }
      const audit = await transaction.auditEvent.create({
        data: {
          action: "AI_ACTION_CONFIRMATION_REQUIRED",
          metadata: {
            actionName: request.command.name,
            expiresAt: approval.expiresAt.toISOString(),
          },
          organizationId: request.trustedContext.organizationId,
          targetId: actionId,
          targetType: "AIAction",
        },
      });
      const responsePayload = {
        confirmationId: approval.id,
        expiresAt: approval.expiresAt.toISOString(),
        summary: approval.summary,
        summaryHash: approval.summaryHash,
      };
      await transaction.aIAction.update({
        data: {
          auditEventId: audit.id,
          latencyMs: 0,
          outcome: AIActionOutcome.REQUIRES_CONFIRMATION,
          result: toJson(redactAISensitiveFields(responsePayload)),
        },
        where: { id: actionId },
      });
      return {
        result: {
          actionId,
          auditEventId: audit.id,
          outcome: "requires_confirmation",
          payload: responsePayload,
        },
      };
    }
    if (!this.validApproval(existing, request.confirmation, request, customerId)) {
      return {
        result: await this.finishRejectedInTransaction(
          transaction,
          request.trustedContext,
          actionId,
          request.command.name,
          "CONFIRMATION_INVALID",
        ),
      };
    }
    return {};
  }

  private validApproval(
    approval: Awaited<ReturnType<TenantTransaction["aIActionApproval"]["findFirst"]>>,
    evidence: AIConfirmationEvidence,
    request: AIActionRuntimeRequest,
    customerId: string,
  ): boolean {
    if (!approval?.confirmedAt) return false;
    const confirmedAt = new Date(evidence.confirmedAt);
    return (
      approval.id === evidence.confirmationId &&
      approval.summaryHash === evidence.summaryHash &&
      approval.payloadHash === request.inputFingerprint &&
      approval.customerId === customerId &&
      approval.conversationId === request.trustedContext.conversationId &&
      approval.status === AIActionApprovalStatus.APPROVED &&
      approval.expiresAt > new Date() &&
      Math.abs(approval.confirmedAt.getTime() - confirmedAt.getTime()) < 1_000
    );
  }

  private async executeCommand(
    context: AITrustedContext,
    command: AIActionCommand,
    idempotencyKey: string,
    gatewayActionId: string,
  ): Promise<unknown> {
    const access = gatewayAccess(context, gatewayPermissions[command.name], gatewayActionId);
    switch (command.name) {
      case "get_business_information":
        return runInTenant(this.client, access, async (transaction) => {
          const organization = await transaction.organization.findFirst({
            include: {
              branches: {
                include: {
                  hoursRules: { orderBy: [{ weekday: "asc" }, { startMinuteLocal: "asc" }] },
                },
                orderBy: { nameEn: "asc" },
                where: { isActive: true },
              },
              settings: true,
            },
            where: { id: context.organizationId },
          });
          if (!organization)
            throw new DomainError({ code: "NOT_FOUND", message: "Business not found." });
          return {
            branches: organization.branches.map((branch) => ({
              hours: branch.hoursRules.map((rule) => ({
                endMinuteLocal: rule.endMinuteLocal,
                startMinuteLocal: rule.startMinuteLocal,
                weekday: rule.weekday,
              })),
              nameAr: branch.nameAr,
              nameEn: branch.nameEn,
              timezone: branch.timezone,
            })),
            currency: organization.settings?.currency ?? "JOD",
            nameAr: organization.nameAr,
            nameEn: organization.nameEn,
            timezone: organization.settings?.timezone ?? "Asia/Amman",
          };
        });
      case "list_branches":
        return runInTenant(this.client, access, (transaction) =>
          transaction.branch.findMany({
            orderBy: { nameEn: "asc" },
            select: { id: true, nameAr: true, nameEn: true, timezone: true },
            where: { isActive: true, organizationId: context.organizationId },
          }),
        );
      case "list_services":
        return runInTenant(this.client, access, async (transaction) => {
          if (command.input.branchReference) {
            const branch = await transaction.branch.findFirst({
              select: { id: true },
              where: {
                id: command.input.branchReference,
                isActive: true,
                organizationId: context.organizationId,
              },
            });
            if (!branch) {
              throw new DomainError({ code: "NOT_FOUND", message: "Branch not found." });
            }
          }
          return transaction.service.findMany({
            orderBy: { nameEn: "asc" },
            select: {
              currency: true,
              defaultDurationMins: true,
              defaultPriceMinor: true,
              id: true,
              nameAr: true,
              nameEn: true,
            },
            where: {
              ...(command.input.branchReference
                ? {
                    branches: {
                      some: { branchId: command.input.branchReference, isEnabled: true },
                    },
                  }
                : {}),
              isActive: true,
              organizationId: context.organizationId,
            },
          });
        });
      case "list_providers":
        return runInTenant(this.client, access, async (transaction) => {
          if (command.input.branchReference) {
            const branch = await transaction.branch.findFirst({
              select: { id: true },
              where: {
                id: command.input.branchReference,
                isActive: true,
                organizationId: context.organizationId,
              },
            });
            if (!branch) {
              throw new DomainError({ code: "NOT_FOUND", message: "Branch not found." });
            }
          }
          if (command.input.serviceReference) {
            const service = await transaction.service.findFirst({
              select: { id: true },
              where: {
                id: command.input.serviceReference,
                isActive: true,
                organizationId: context.organizationId,
              },
            });
            if (!service) {
              throw new DomainError({ code: "NOT_FOUND", message: "Service not found." });
            }
          }
          return transaction.staffProfile.findMany({
            orderBy: { displayNameEn: "asc" },
            select: { displayNameAr: true, displayNameEn: true, id: true },
            where: {
              ...(command.input.branchReference
                ? { branchAssignments: { some: { branchId: command.input.branchReference } } }
                : {}),
              ...(command.input.serviceReference
                ? {
                    services: {
                      some: { isEnabled: true, serviceId: command.input.serviceReference },
                    },
                  }
                : {}),
              isBookable: true,
              organizationId: context.organizationId,
            },
          });
        });
      case "check_availability": {
        const slots = await this.scheduling.findAvailableSlots(access, {
          branchId: command.input.branchReference,
          endsOn: command.input.endsOn,
          limit: 50,
          ...(command.input.providerReference
            ? { providerId: command.input.providerReference }
            : {}),
          serviceId: command.input.serviceReference,
          startsOn: command.input.startsOn,
        });
        return slots.map((slot) => ({
          endsAt: slot.endsAt.toISOString(),
          providerReference: slot.providerId,
          startsAt: slot.startsAt.toISOString(),
          startsAtLocal: slot.startsAtLocal,
          timezone: slot.timezone,
        }));
      }
      case "find_customer_safely":
        return this.findCustomerSafely(context, command.input.phoneOrEmail);
      case "create_booking": {
        const customerId = await this.resolveBoundCustomer(
          context,
          command.input.customerReference,
        );
        const appointment = await this.appointments.createAppointment(access, {
          branchId: command.input.branchReference,
          customerId,
          idempotencyKey: uuidFromHash(idempotencyKey),
          providerId: command.input.providerReference,
          serviceId: command.input.serviceReference,
          source:
            context.channel === "whatsapp"
              ? AppointmentSource.WHATSAPP_AI
              : context.channel === "voice"
                ? AppointmentSource.VOICE_AI
                : AppointmentSource.WEBSITE_AI,
          startsAtLocal: command.input.startsAtLocal,
          status: "CONFIRMED",
        });
        return {
          bookingReference: appointment.id,
          endsAt: appointment.endsAt.toISOString(),
          startsAt: appointment.startsAt.toISOString(),
          status: appointment.status,
          version: appointment.version,
        };
      }
      case "reschedule_booking": {
        await this.assertOwnBooking(context, command.input.bookingReference);
        const appointment = await this.appointments.rescheduleAppointment(access, {
          appointmentId: command.input.bookingReference,
          expectedVersion: command.input.expectedVersion,
          idempotencyKey: uuidFromHash(idempotencyKey),
          startsAtLocal: command.input.startsAtLocal,
        });
        return {
          bookingReference: appointment.id,
          endsAt: appointment.endsAt.toISOString(),
          startsAt: appointment.startsAt.toISOString(),
          status: appointment.status,
          version: appointment.version,
        };
      }
      case "cancel_booking": {
        await this.assertOwnBooking(context, command.input.bookingReference);
        const appointment = await this.appointments.transitionAppointment(access, {
          appointmentId: command.input.bookingReference,
          expectedVersion: command.input.expectedVersion,
          idempotencyKey: uuidFromHash(idempotencyKey),
          reason: command.input.reason,
          toStatus: "CANCELLED",
        });
        return {
          bookingReference: appointment.id,
          status: appointment.status,
          version: appointment.version,
        };
      }
      case "join_waitlist": {
        const customerId = await this.resolveBoundCustomer(
          context,
          command.input.customerReference,
        );
        const entry = await this.scheduling.createWaitlistEntry(access, {
          branchIds: command.input.branchReferences,
          customerId,
          preferredEndDate: command.input.preferredEndDate,
          preferredEndMinute: command.input.preferredEndMinute,
          preferredStartDate: command.input.preferredStartDate,
          preferredStartMinute: command.input.preferredStartMinute,
          priority: 0,
          providerIds: command.input.providerReferences ?? [],
          serviceId: command.input.serviceReference,
        });
        return { status: entry.status, waitlistReference: entry.id };
      }
      case "check_booking_status": {
        await this.assertOwnBooking(context, command.input.bookingReference);
        const appointment = await this.appointments.getPublicAppointmentProjection(
          access,
          command.input.bookingReference,
        );
        return {
          bookingReference: appointment.id,
          endsAt: appointment.endsAt.toISOString(),
          startsAt: appointment.startsAt.toISOString(),
          status: appointment.status,
          timezone: appointment.branch.timezone,
        };
      }
      case "request_human_handoff":
        return runInTenant(this.client, access, async (transaction) => {
          const handoff = await transaction.humanHandoff.create({
            data: {
              conversationId: context.conversationId,
              customerId: context.verifiedCustomerId ?? null,
              organizationId: context.organizationId,
              reasonCode: command.input.reasonCode,
              summary: command.input.summary?.trim() || "AI requested a safe human handoff.",
            },
          });
          await transaction.aIConversation.update({
            data: { status: AIConversationStatus.WAITING_HUMAN },
            where: { id: context.conversationId },
          });
          return { handoffReference: handoff.id, status: handoff.status };
        });
    }
  }

  private async findCustomerSafely(context: AITrustedContext, phoneOrEmail: string) {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      async (transaction) => {
        const normalizedPhone = normalizeJordanianPhone(phoneOrEmail);
        const normalizedEmail = phoneOrEmail.trim().toLocaleLowerCase("en");
        const contacts = await transaction.customerContact.findMany({
          select: { customerId: true },
          take: 2,
          where: {
            organizationId: context.organizationId,
            OR: [
              ...(normalizedPhone ? [{ normalizedPhoneE164: normalizedPhone }] : []),
              { originalValue: { equals: normalizedEmail, mode: "insensitive" } },
            ],
          },
        });
        const unique = [...new Set(contacts.map((contact) => contact.customerId))];
        const boundMatch = context.verifiedCustomerId
          ? unique.includes(context.verifiedCustomerId)
          : false;
        return {
          ambiguous: unique.length > 1,
          ...(boundMatch ? { customerReference: context.verifiedCustomerId } : {}),
          match: boundMatch,
          requiresIdentityVerification: !boundMatch,
        };
      },
    );
  }

  private async resolveBoundCustomer(
    context: AITrustedContext,
    proposedCustomerReference?: string,
  ): Promise<string> {
    const customerId = context.verifiedCustomerId;
    if (!customerId || (proposedCustomerReference && proposedCustomerReference !== customerId)) {
      throw new DomainError({ code: "NOT_FOUND", message: "Customer not found." });
    }
    const found = await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      (transaction) =>
        transaction.customer.findFirst({
          select: { id: true },
          where: { id: customerId, isArchived: false, organizationId: context.organizationId },
        }),
    );
    if (!found) throw new DomainError({ code: "NOT_FOUND", message: "Customer not found." });
    return found.id;
  }

  private async assertOwnBooking(
    context: AITrustedContext,
    bookingReference: string,
  ): Promise<void> {
    if (!context.verifiedCustomerId) {
      throw new DomainError({ code: "NOT_FOUND", message: "Booking not found." });
    }
    const appointment = await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: context.organizationId },
      (transaction) =>
        transaction.appointment.findFirst({
          select: { customerId: true },
          where: { id: bookingReference, organizationId: context.organizationId },
        }),
    );
    if (!appointment || appointment.customerId !== context.verifiedCustomerId) {
      throw new DomainError({ code: "NOT_FOUND", message: "Booking not found." });
    }
  }

  private async lockAction(
    transaction: TenantTransaction,
    request: Readonly<{
      actionName?: AIActionName | undefined;
      command?: Readonly<{ name: AIActionName }> | undefined;
      idempotencyKey: string;
      trustedContext: AITrustedContext;
    }>,
  ): Promise<void> {
    const actionName = request.command?.name ?? request.actionName;
    if (!actionName) {
      throw new DomainError({ code: "INTERNAL_ERROR", message: "AI action name is missing." });
    }
    const lockKey = `${request.trustedContext.organizationId}:${actionName}:${request.idempotencyKey}`;
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
  }

  private async finishRejectedInTransaction(
    transaction: TenantTransaction,
    context: AITrustedContext,
    actionId: string,
    actionName: AIActionName,
    errorCode: string,
    latencyMs = 0,
  ): Promise<AIActionRuntimeResult> {
    const audit = await transaction.auditEvent.create({
      data: {
        action: "AI_ACTION_REJECTED",
        metadata: { actionName, errorCode, latencyMs },
        organizationId: context.organizationId,
        targetId: actionId,
        targetType: "AIAction",
      },
    });
    await transaction.aIAction.update({
      data: {
        auditEventId: audit.id,
        completedAt: new Date(),
        errorCode,
        latencyMs,
        outcome: AIActionOutcome.REJECTED,
        result: { errorCode },
      },
      where: { id: actionId },
    });
    return { actionId, auditEventId: audit.id, outcome: "rejected", payload: { errorCode } };
  }

  private async actionSummary(
    transaction: TenantTransaction,
    request: AIActionRuntimeRequest,
  ): Promise<string> {
    const conversation = await transaction.aIConversation.findFirstOrThrow({
      select: { locale: true },
      where: {
        id: request.trustedContext.conversationId,
        organizationId: request.trustedContext.organizationId,
      },
    });
    const isArabic = conversation.locale === "ar";
    if (request.command.name === "create_booking") {
      const [branch, service, provider] = await Promise.all([
        transaction.branch.findFirst({
          where: {
            id: request.command.input.branchReference,
            organizationId: request.trustedContext.organizationId,
          },
        }),
        transaction.service.findFirst({
          where: {
            id: request.command.input.serviceReference,
            organizationId: request.trustedContext.organizationId,
          },
        }),
        transaction.staffProfile.findFirst({
          where: {
            id: request.command.input.providerReference,
            organizationId: request.trustedContext.organizationId,
          },
        }),
      ]);
      if (!branch || !service || !provider) {
        throw new DomainError({ code: "NOT_FOUND", message: "Booking details were not found." });
      }
      return isArabic
        ? `تأكيد حجز ${service.nameAr} في ${branch.nameAr} مع ${provider.displayNameAr} بتاريخ ${request.command.input.startsAtLocal}.`
        : `Confirm ${service.nameEn} at ${branch.nameEn} with ${provider.displayNameEn} on ${request.command.input.startsAtLocal}.`;
    }
    if (
      request.command.name === "reschedule_booking" ||
      request.command.name === "cancel_booking"
    ) {
      const verifiedCustomerId = request.trustedContext.verifiedCustomerId;
      if (!verifiedCustomerId) {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "Verified customer identity is required.",
        });
      }
      const appointment = await transaction.appointment.findFirst({
        include: { branch: true, service: true },
        where: {
          customerId: verifiedCustomerId,
          id: request.command.input.bookingReference,
          organizationId: request.trustedContext.organizationId,
        },
      });
      if (!appointment) {
        throw new DomainError({ code: "NOT_FOUND", message: "Booking was not found." });
      }
      if (request.command.name === "reschedule_booking") {
        return isArabic
          ? `تأكيد نقل موعد ${appointment.service.nameAr} في ${appointment.branch.nameAr} إلى ${request.command.input.startsAtLocal}.`
          : `Confirm moving the ${appointment.service.nameEn} appointment at ${appointment.branch.nameEn} to ${request.command.input.startsAtLocal}.`;
      }
      return isArabic
        ? `تأكيد إلغاء موعد ${appointment.service.nameAr} في ${appointment.branch.nameAr}.`
        : `Confirm cancelling the ${appointment.service.nameEn} appointment at ${appointment.branch.nameEn}.`;
    }
    return `Confirm ${request.command.name}.`;
  }

  private async currentBudget(transaction: TenantTransaction, organizationId: string) {
    const configuration = await transaction.promptConfiguration.findFirst({
      where: { isActive: true, organizationId },
    });
    if (!configuration) return { exhausted: true };
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [actions, usage] = await Promise.all([
      transaction.aIAction.count({
        where: { createdAt: { gte: monthStart }, organizationId },
      }),
      transaction.aIUsage.aggregate({
        _sum: { estimatedCostMicros: true, inputTokens: true, outputTokens: true },
        where: { occurredAt: { gte: monthStart }, organizationId },
      }),
    ]);
    const tokens = (usage._sum.inputTokens ?? 0) + (usage._sum.outputTokens ?? 0);
    return {
      exhausted:
        actions >= configuration.monthlyActionLimit ||
        tokens >= configuration.monthlyTokenLimit ||
        (usage._sum.estimatedCostMicros ?? 0) >= configuration.monthlyCostLimitMicros,
    };
  }

  private async assertTrustedConversation(
    transaction: TenantTransaction,
    context: AITrustedContext,
  ) {
    const organization = await transaction.organization.findFirst({
      select: { status: true },
      where: { id: context.organizationId },
    });
    if (!organization) {
      throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
    }
    assertActiveOrganization(organization.status);
    const conversation = await transaction.aIConversation.findFirst({
      include: { promptConfiguration: true },
      where: { id: context.conversationId, organizationId: context.organizationId },
    });
    if (
      !conversation ||
      conversation.status === AIConversationStatus.CLOSED ||
      conversation.modelIdentifier !== context.modelIdentifier ||
      conversation.customerId !== (context.verifiedCustomerId ?? null)
    ) {
      throw new DomainError({ code: "NOT_FOUND", message: "AI conversation not found." });
    }
    return conversation;
  }

  private async assertOrganization(
    transaction: TenantTransaction,
    organizationId: string,
  ): Promise<void> {
    const organization = await transaction.organization.findFirst({
      select: { status: true },
      where: { id: organizationId },
    });
    if (!organization) {
      throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
    }
    assertActiveOrganization(organization.status);
  }
}
