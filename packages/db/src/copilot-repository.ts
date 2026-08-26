import { createHash } from "node:crypto";

import type {
  CopilotEvidence,
  CopilotFeedbackType,
  CopilotGeneratedInsight,
  CopilotInsightRecord,
  CopilotInsightStorePort,
  CopilotInsightType,
  CopilotProjection,
  CopilotProjectionItem,
  CopilotProjectionPort,
  SemanticMetricKey,
  SemanticMetricQuery,
} from "@jormall/domain/copilot";
import { DomainError } from "@jormall/domain/errors";
import type {
  PermissionCode,
  PermissionScope,
  TenantAccessSnapshot,
} from "@jormall/domain/identity";
import {
  localDateForInstant,
  localDateTimePartsForInstant,
  localDateTimeToUtc,
  utcRangeForLocalDate,
} from "@jormall/domain/timezone";

import {
  AppointmentStatus,
  CallStatus,
  HumanHandoffStatus,
  MessageStatus,
  type CopilotDataClassification,
  type CopilotEvidenceSourceType,
  type CopilotFeedbackType as PrismaCopilotFeedbackType,
  type CopilotInsightType as PrismaCopilotInsightType,
  type Prisma,
  type PrismaClient,
} from "./generated/prisma/client";
import { runInTenant, type TenantTransaction } from "./tenant-context";

const scopeRank: Readonly<Record<PermissionScope, number>> = {
  ASSIGNED_BRANCHES: 2,
  ORGANIZATION: 3,
  SELF: 1,
};

function strongestScope(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
): PermissionScope | undefined {
  return access.grants
    .filter((grant) => grant.code === permission)
    .toSorted((left, right) => scopeRank[right.scope] - scopeRank[left.scope])[0]?.scope;
}

function requireScope(access: TenantAccessSnapshot, permission: PermissionCode): PermissionScope {
  const scope = strongestScope(access, permission);
  if (!scope) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "The active tenant context does not grant this Copilot permission.",
      metadata: { permission },
    });
  }
  return scope;
}

function appointmentScopeWhere(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
): Prisma.AppointmentWhereInput {
  const scope = requireScope(access, permission);
  if (scope === "ORGANIZATION") return {};
  if (scope === "ASSIGNED_BRANCHES") return { branchId: { in: [...access.assignedBranchIds] } };
  if (!access.staffProfileId) {
    throw new DomainError({ code: "FORBIDDEN", message: "A provider profile is required." });
  }
  return { providerId: access.staffProfileId };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uuidFromHash(value: string): string {
  const digest = hash(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]),
    ) as Prisma.InputJsonObject;
  }
  return String(value);
}

function evidence(
  locale: "ar" | "en",
  input: Omit<CopilotEvidence, "href" | "id"> & Readonly<{ route: string }>,
): CopilotEvidence {
  return { ...input, href: `/${locale}${input.route}`, id: input.sourceId };
}

function item(
  kind: CopilotProjectionItem["kind"],
  id: string,
  labelEn: string,
  labelAr: string,
  value: string,
  evidenceIds: readonly string[],
): CopilotProjectionItem {
  return { evidenceIds, id, kind, labelAr, labelEn, value };
}

function metricLabels(metric: SemanticMetricKey): Readonly<{ ar: string; en: string }> {
  const labels: Readonly<Record<SemanticMetricKey, Readonly<{ ar: string; en: string }>>> = {
    ACTIVE_WAITLIST_TOTAL: { ar: "فرص قائمة الانتظار", en: "Active waitlist opportunities" },
    APPOINTMENTS_TOTAL: { ar: "إجمالي المواعيد", en: "Appointments" },
    CANCELLATIONS_TOTAL: { ar: "الإلغاءات", en: "Cancellations" },
    FAILED_MESSAGES_TOTAL: { ar: "الاتصالات الفاشلة", en: "Failed communications" },
    MISSED_CALLS_TOTAL: { ar: "المكالمات الفائتة", en: "Missed calls" },
    NO_SHOWS_TOTAL: { ar: "حالات عدم الحضور", en: "No-shows" },
    OPEN_HANDOFFS_TOTAL: { ar: "التحويلات المهمة", en: "Important handoffs" },
    SCHEDULE_GAPS_TOTAL: { ar: "فجوات الجدول", en: "Schedule gaps" },
    SCHEDULED_MINUTES: { ar: "الدقائق المجدولة", en: "Scheduled minutes" },
    UNCONFIRMED_TOTAL: { ar: "الحجوزات غير المؤكدة", en: "Unconfirmed bookings" },
    WAITLIST_MATCHES_TOTAL: { ar: "تطابقات قائمة الانتظار", en: "Waitlist matches" },
  };
  return labels[metric];
}

function metricRoute(metric: SemanticMetricKey): string {
  switch (metric) {
    case "ACTIVE_WAITLIST_TOTAL":
    case "WAITLIST_MATCHES_TOTAL":
      return "/dashboard/waitlist";
    case "FAILED_MESSAGES_TOTAL":
      return "/dashboard/communications";
    case "OPEN_HANDOFFS_TOTAL":
      return "/dashboard/ai-handoffs";
    case "MISSED_CALLS_TOTAL":
      return "/dashboard/copilot";
    default:
      return "/dashboard/calendar";
  }
}

function isGeneratedStatements(value: Prisma.JsonValue): value is Prisma.JsonArray {
  return Array.isArray(value);
}

function isStatementKind(
  value: Prisma.JsonValue | undefined,
): value is CopilotProjectionItem["kind"] {
  return value === "FACT" || value === "COMPUTED_METRIC" || value === "AI_SUGGESTION";
}

export class CopilotRepository implements CopilotProjectionPort, CopilotInsightStorePort {
  constructor(private readonly client: PrismaClient) {}

  async loadProjection(
    access: TenantAccessSnapshot,
    request: Readonly<{
      insightType: CopilotInsightType;
      locale: "ar" | "en";
      metricQuery?: SemanticMetricQuery | undefined;
      subjectId?: string | undefined;
    }>,
  ): Promise<CopilotProjection> {
    requireScope(access, "reports.read");
    return runInTenant(this.client, access, async (transaction) => {
      const trace = await this.loadTrace(transaction, access);
      if (request.insightType === "CUSTOMER_SUMMARY") {
        if (!request.subjectId) {
          throw new DomainError({ code: "VALIDATION_FAILED", message: "Customer is required." });
        }
        return this.customerSummary(transaction, access, request.locale, request.subjectId, trace);
      }
      if (request.insightType === "CALL_QUALITY") {
        if (!request.subjectId) {
          throw new DomainError({ code: "VALIDATION_FAILED", message: "Call is required." });
        }
        return this.callQuality(transaction, access, request.locale, request.subjectId, trace);
      }
      if (request.insightType === "ANALYTICS") {
        if (!request.metricQuery) {
          throw new DomainError({
            code: "VALIDATION_FAILED",
            message: "Metric query is required.",
          });
        }
        return this.analytics(transaction, access, request.locale, request.metricQuery, trace);
      }
      return this.dailyOperations(transaction, access, request.locale, request.insightType, trace);
    });
  }

  async saveInsight(
    access: TenantAccessSnapshot,
    projection: CopilotProjection,
    generated: CopilotGeneratedInsight,
  ): Promise<CopilotInsightRecord> {
    requireScope(access, "reports.read");
    const generationKey = hash(
      JSON.stringify({
        actor: access.actorUserId,
        evidence: projection.evidence.map(({ label, occurredAt, sourceId, sourceType }) => ({
          label,
          ...(sourceType === "METRIC_SNAPSHOT" ? {} : { occurredAt }),
          sourceId,
          sourceType,
        })),
        freshnessBucket: Math.floor(new Date(projection.dataWatermark).getTime() / (15 * 60_000)),
        items: projection.items,
        locale: projection.locale,
        prompt: projection.promptVersion,
        subject: projection.subjectId,
        type: projection.insightType,
      }),
    );
    return runInTenant(this.client, access, async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${access.organizationId}:${generationKey}`}, 0))`;
      const existing = await transaction.copilotInsight.findUnique({
        include: { evidence: true },
        where: {
          organizationId_generationKey: { generationKey, organizationId: access.organizationId },
        },
      });
      if (existing) return this.mapInsight(existing);

      if (projection.metricSnapshots?.length) {
        await transaction.analyticsSnapshot.createMany({
          data: projection.metricSnapshots.map((snapshot) => ({
            actorUserId: access.actorUserId,
            branchId: snapshot.branchId ?? null,
            dataWatermark: new Date(projection.dataWatermark),
            dimensions: { scope: strongestScope(access, "reports.read") ?? "NONE" },
            endsAt: new Date(snapshot.endsAt),
            id: snapshot.id,
            metricKey: snapshot.metric,
            organizationId: access.organizationId,
            startsAt: new Date(snapshot.startsAt),
            value: snapshot.value,
          })),
          skipDuplicates: true,
        });
      }
      const created = await transaction.copilotInsight.create({
        data: {
          actorUserId: access.actorUserId,
          confidence: projection.confidence,
          dataWatermark: new Date(projection.dataWatermark),
          evidence: {
            create: projection.evidence.map((source) => ({
              classification: source.classification,
              href: source.href,
              label: source.label,
              occurredAt: new Date(source.occurredAt),
              sourceId: source.sourceId,
              sourceType: source.sourceType,
            })),
          },
          expiresAt: new Date(projection.expiresAt),
          generationKey,
          insightType: projection.insightType,
          knowledgeVersionIds: [...projection.knowledgeVersionIds],
          locale: projection.locale,
          membershipId: access.membershipId ?? null,
          modelIdentifier: generated.modelIdentifier,
          organizationId: access.organizationId,
          promptConfigurationId: projection.promptConfigurationId ?? null,
          promptVersion: projection.promptVersion,
          statements: jsonValue(generated.statements),
          subjectId: projection.subjectId ?? null,
          subjectType: projection.subjectType ?? null,
          title: projection.locale === "ar" ? projection.titleAr : projection.titleEn,
        },
        include: { evidence: true },
      });
      await transaction.auditEvent.create({
        data: {
          action: "COPILOT_INSIGHT_GENERATED",
          actorUserId: access.actorUserId,
          metadata: {
            dataWatermark: projection.dataWatermark,
            evidenceCount: projection.evidence.length,
            insightType: projection.insightType,
            modelIdentifier: generated.modelIdentifier,
            promptVersion: projection.promptVersion,
          },
          organizationId: access.organizationId,
          supportAccessId: access.supportAccessId ?? null,
          targetId: created.id,
          targetType: "CopilotInsight",
        },
      });
      return this.mapInsight(created);
    });
  }

  async listInsights(access: TenantAccessSnapshot, type?: CopilotInsightType) {
    requireScope(access, "reports.read");
    return runInTenant(this.client, access, async (transaction) => {
      const rows = await transaction.copilotInsight.findMany({
        include: { evidence: true, feedback: { orderBy: { createdAt: "desc" } } },
        orderBy: { createdAt: "desc" },
        take: 50,
        where: {
          actorUserId: access.actorUserId,
          organizationId: access.organizationId,
          ...(type ? { insightType: type } : {}),
        },
      });
      return rows.map((row) => ({ ...this.mapInsight(row), feedback: row.feedback }));
    });
  }

  async recordFeedback(
    access: TenantAccessSnapshot,
    insightId: string,
    feedbackType: CopilotFeedbackType,
    comment?: string,
  ) {
    requireScope(access, "reports.read");
    if ((comment?.length ?? 0) > 500) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Feedback is too long." });
    }
    return runInTenant(this.client, access, async (transaction) => {
      const insight = await transaction.copilotInsight.findFirst({
        where: {
          actorUserId: access.actorUserId,
          id: insightId,
          organizationId: access.organizationId,
        },
      });
      if (!insight) throw new DomainError({ code: "NOT_FOUND", message: "Insight not found." });
      const feedback = await transaction.copilotFeedback.create({
        data: {
          actorUserId: access.actorUserId,
          comment: comment?.trim() || null,
          feedbackType: feedbackType as PrismaCopilotFeedbackType,
          insightId,
          organizationId: access.organizationId,
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: "COPILOT_FEEDBACK_RECORDED",
          actorUserId: access.actorUserId,
          metadata: { feedbackType },
          organizationId: access.organizationId,
          targetId: feedback.id,
          targetType: "CopilotFeedback",
        },
      });
      return feedback;
    });
  }

  async listReviewableCalls(access: TenantAccessSnapshot) {
    requireScope(access, "reports.read");
    const recordingScope = requireScope(access, "recordings.read");
    const scoped = appointmentScopeWhere(access, "recordings.read");
    return runInTenant(this.client, access, (transaction) =>
      transaction.call.findMany({
        include: { customer: { select: { displayName: true } }, summary: true },
        orderBy: { startedAt: "desc" },
        take: 30,
        where: {
          organizationId: access.organizationId,
          ...(recordingScope === "ORGANIZATION"
            ? {}
            : { summary: { is: { appointment: { is: scoped } } } }),
          transcripts: { some: { isFinal: true } },
        },
      }),
    );
  }

  private async loadTrace(transaction: TenantTransaction, access: TenantAccessSnapshot) {
    const organization = await transaction.organization.findFirst({
      include: { settings: true },
      where: { id: access.organizationId, status: "ACTIVE" },
    });
    if (!organization) {
      throw new DomainError({
        code: "ORGANIZATION_SUSPENDED",
        message: "Organization unavailable.",
      });
    }
    const [prompt, knowledge] = await Promise.all([
      transaction.promptConfiguration.findFirst({
        where: { isActive: true, organizationId: access.organizationId },
      }),
      transaction.knowledgeVersion.findMany({
        select: { id: true },
        where: { organizationId: access.organizationId, status: "ACTIVE" },
      }),
    ]);
    return {
      knowledgeVersionIds: knowledge.map(({ id }) => id),
      promptConfigurationId: prompt?.id,
      promptVersion: prompt?.version ?? 1,
      timezone: organization.settings?.timezone ?? "Asia/Amman",
      watermark: new Date(),
    };
  }

  private baseProjection(
    locale: "ar" | "en",
    type: CopilotInsightType,
    trace: Awaited<ReturnType<CopilotRepository["loadTrace"]>>,
  ) {
    return {
      confidence: 1,
      dataWatermark: trace.watermark.toISOString(),
      expiresAt: new Date(trace.watermark.getTime() + 15 * 60_000).toISOString(),
      insightType: type,
      knowledgeVersionIds: trace.knowledgeVersionIds,
      locale,
      ...(trace.promptConfigurationId
        ? { promptConfigurationId: trace.promptConfigurationId }
        : {}),
      promptVersion: trace.promptVersion,
    } as const;
  }

  private metricEvidence(
    locale: "ar" | "en",
    metric: SemanticMetricKey,
    startsAt: Date,
    endsAt: Date,
    watermark: Date,
    suffix: string,
  ): CopilotEvidence {
    const sourceId = uuidFromHash(
      `${metric}:${startsAt.toISOString()}:${endsAt.toISOString()}:${suffix}`,
    );
    const label = metricLabels(metric);
    return evidence(locale, {
      classification: "INTERNAL",
      label: locale === "ar" ? label.ar : label.en,
      occurredAt: watermark.toISOString(),
      route: metricRoute(metric),
      sourceId,
      sourceType: "METRIC_SNAPSHOT",
    });
  }

  private async dailyOperations(
    transaction: TenantTransaction,
    access: TenantAccessSnapshot,
    locale: "ar" | "en",
    type: "DAILY_BRIEFING" | "SCHEDULE_GAPS" | "WAITLIST_MATCHES",
    trace: Awaited<ReturnType<CopilotRepository["loadTrace"]>>,
  ): Promise<CopilotProjection> {
    const date = localDateForInstant(trace.watermark, trace.timezone);
    const range = utcRangeForLocalDate(date, trace.timezone);
    const scoped = appointmentScopeWhere(access, "reports.read");
    const waitlistScope = strongestScope(access, "waitlist.read");
    const appointments = await transaction.appointment.findMany({
      include: {
        branch: true,
        customer: true,
        provider: { include: { services: true } },
        service: true,
      },
      orderBy: { startsAt: "asc" },
      where: {
        ...scoped,
        organizationId: access.organizationId,
        startsAt: { gte: range.startsAt, lt: range.endsAt },
      },
    });
    const waitlist = waitlistScope
      ? await transaction.waitlistEntry.findMany({
          include: { branches: true, customer: true, providers: true, service: true },
          take: 20,
          where: {
            organizationId: access.organizationId,
            status: "ACTIVE",
            ...(waitlistScope === "ASSIGNED_BRANCHES"
              ? { branches: { some: { branchId: { in: [...access.assignedBranchIds] } } } }
              : waitlistScope === "SELF" && access.staffProfileId
                ? { providers: { some: { providerId: access.staffProfileId } } }
                : {}),
          },
        })
      : [];
    const [failedMessages, openHandoffs, missedCalls] = await Promise.all([
      strongestScope(access, "messages.read")
        ? transaction.message.findMany({
            select: { createdAt: true, id: true },
            where: {
              organizationId: access.organizationId,
              ...(strongestScope(access, "messages.read") === "ORGANIZATION"
                ? {}
                : { appointment: { is: scoped } }),
              status: { in: [MessageStatus.FAILED, MessageStatus.DEAD_LETTER] },
              updatedAt: { gte: range.startsAt, lt: range.endsAt },
            },
          })
        : [],
      strongestScope(access, "conversations.handoff")
        ? transaction.humanHandoff.findMany({
            select: { createdAt: true, id: true },
            where: {
              organizationId: access.organizationId,
              status: { in: [HumanHandoffStatus.OPEN, HumanHandoffStatus.ASSIGNED] },
            },
          })
        : [],
      strongestScope(access, "conversations.read")
        ? transaction.call.findMany({
            select: { id: true, startedAt: true },
            where: {
              organizationId: access.organizationId,
              ...(strongestScope(access, "conversations.read") === "ORGANIZATION"
                ? {}
                : { summary: { is: { appointment: { is: scoped } } } }),
              startedAt: { gte: range.startsAt, lt: range.endsAt },
              status: CallStatus.MISSED,
            },
          })
        : [],
    ]);
    const appointmentsBySchedule = new Map<string, typeof appointments>();
    for (const appointment of appointments) {
      const key = `${appointment.branchId}:${appointment.providerId}`;
      appointmentsBySchedule.set(key, [...(appointmentsBySchedule.get(key) ?? []), appointment]);
    }
    const gaps = [...appointmentsBySchedule.values()].flatMap((schedule) =>
      schedule.slice(1).flatMap((next, index) => {
        const previous = schedule[index];
        return previous && next.startsAt.getTime() - previous.endsAt.getTime() >= 60 * 60_000
          ? [{ endsAt: next.startsAt, next, previous, startsAt: previous.endsAt }]
          : [];
      }),
    );
    const waitlistMatches = waitlist.flatMap((entry) => {
      const match = gaps.flatMap((gap) => {
        const localStart = localDateTimePartsForInstant(gap.startsAt, gap.previous.branch.timezone);
        const localEnd = localDateTimePartsForInstant(gap.endsAt, gap.previous.branch.timezone);
        const localDay = localDateForInstant(gap.startsAt, gap.previous.branch.timezone);
        const endDay = localDateForInstant(gap.endsAt, gap.previous.branch.timezone);
        const gapStartMinute = localStart.hour * 60 + localStart.minute;
        const gapEndMinute = localEnd.hour * 60 + localEnd.minute;
        const candidateStartMinute = Math.max(gapStartMinute, entry.preferredStartMinute);
        const candidateEndMinute = candidateStartMinute + entry.service.defaultDurationMins;
        const preferredStart = entry.preferredStartDate.toISOString().slice(0, 10);
        const preferredEnd = entry.preferredEndDate.toISOString().slice(0, 10);
        const eligible =
          localDay === endDay &&
          localDay >= preferredStart &&
          localDay <= preferredEnd &&
          candidateEndMinute <= gapEndMinute &&
          candidateEndMinute <= entry.preferredEndMinute &&
          entry.branches.some(({ branchId }) => branchId === gap.previous.branchId) &&
          (entry.providers.length === 0 ||
            entry.providers.some(({ providerId }) => providerId === gap.previous.providerId)) &&
          gap.previous.provider.services.some(
            ({ isEnabled, serviceId }) => isEnabled && serviceId === entry.serviceId,
          );
        if (!eligible) return [];
        const hour = String(Math.floor(candidateStartMinute / 60)).padStart(2, "0");
        const minute = String(candidateStartMinute % 60).padStart(2, "0");
        return [
          {
            candidateStartsAt: localDateTimeToUtc(
              `${localDay}T${hour}:${minute}`,
              gap.previous.branch.timezone,
            ),
            gap,
          },
        ];
      })[0];
      return match ? [{ candidateStartsAt: match.candidateStartsAt, entry, gap: match.gap }] : [];
    });
    const metricValues: readonly Readonly<{ metric: SemanticMetricKey; value: number }>[] = [
      { metric: "APPOINTMENTS_TOTAL", value: appointments.length },
      {
        metric: "CANCELLATIONS_TOTAL",
        value: appointments.filter(({ status }) => status === AppointmentStatus.CANCELLED).length,
      },
      {
        metric: "UNCONFIRMED_TOTAL",
        value: appointments.filter(({ status }) => status === AppointmentStatus.PENDING).length,
      },
      { metric: "WAITLIST_MATCHES_TOTAL", value: waitlistMatches.length },
      { metric: "FAILED_MESSAGES_TOTAL", value: failedMessages.length },
      { metric: "OPEN_HANDOFFS_TOTAL", value: openHandoffs.length },
      { metric: "MISSED_CALLS_TOTAL", value: missedCalls.length },
      { metric: "SCHEDULE_GAPS_TOTAL", value: gaps.length },
    ];
    const selectedMetrics =
      type === "SCHEDULE_GAPS"
        ? metricValues.filter(({ metric }) => metric === "SCHEDULE_GAPS_TOTAL")
        : type === "WAITLIST_MATCHES"
          ? metricValues.filter(({ metric }) => metric === "WAITLIST_MATCHES_TOTAL")
          : metricValues;
    const metricEvidence = selectedMetrics.map(({ metric }) =>
      this.metricEvidence(
        locale,
        metric,
        range.startsAt,
        range.endsAt,
        trace.watermark,
        access.actorUserId,
      ),
    );
    const relevantGaps = type === "WAITLIST_MATCHES" ? waitlistMatches.map(({ gap }) => gap) : gaps;
    const gapAppointments = [
      ...new Map(
        relevantGaps
          .flatMap(({ next, previous }) => [previous, next])
          .map((appointment) => [appointment.id, appointment]),
      ).values(),
    ];
    const appointmentEvidence =
      type === "DAILY_BRIEFING"
        ? []
        : gapAppointments.map((appointment) =>
            evidence(locale, {
              classification: "CONFIDENTIAL",
              label: `${locale === "ar" ? appointment.provider.displayNameAr : appointment.provider.displayNameEn} · ${appointment.startsAt.toLocaleTimeString(locale === "ar" ? "ar-JO" : "en-JO", { hour: "2-digit", minute: "2-digit", timeZone: appointment.branch.timezone })}`,
              occurredAt: appointment.startsAt.toISOString(),
              route: `/dashboard/appointments/${appointment.id}`,
              sourceId: appointment.id,
              sourceType: "APPOINTMENT",
            }),
          );
    const waitlistEvidence =
      type === "WAITLIST_MATCHES"
        ? waitlistMatches.map(({ entry }) =>
            evidence(locale, {
              classification: "CONFIDENTIAL",
              label: `${entry.customer.displayName} · ${locale === "ar" ? entry.service.nameAr : entry.service.nameEn}`,
              occurredAt: entry.createdAt.toISOString(),
              route: "/dashboard/waitlist",
              sourceId: entry.id,
              sourceType: "WAITLIST_ENTRY",
            }),
          )
        : [];
    const waitlistSuggestionItems =
      type === "WAITLIST_MATCHES"
        ? waitlistMatches.map(({ candidateStartsAt, entry, gap }, index) =>
            item(
              "AI_SUGGESTION",
              `waitlist-${index}`,
              "Review waitlist match",
              "راجع تطابق قائمة الانتظار",
              `${entry.customer.displayName} · ${candidateStartsAt.toLocaleTimeString(locale === "ar" ? "ar-JO" : "en-JO", { hour: "2-digit", minute: "2-digit", timeZone: gap.previous.branch.timezone })}`,
              [entry.id, gap.previous.id, gap.next.id],
            ),
          )
        : [];
    const gapSuggestionItems =
      type === "SCHEDULE_GAPS"
        ? gaps.map((gap, index) =>
            item(
              "AI_SUGGESTION",
              `gap-${index}`,
              "Review schedule gap",
              "راجع فجوة الجدول",
              `${locale === "ar" ? gap.previous.provider.displayNameAr : gap.previous.provider.displayNameEn} · ${gap.startsAt.toLocaleTimeString(locale === "ar" ? "ar-JO" : "en-JO", { hour: "2-digit", minute: "2-digit", timeZone: gap.previous.branch.timezone })}–${gap.endsAt.toLocaleTimeString(locale === "ar" ? "ar-JO" : "en-JO", { hour: "2-digit", minute: "2-digit", timeZone: gap.previous.branch.timezone })}`,
              [gap.previous.id, gap.next.id],
            ),
          )
        : [];
    return {
      ...this.baseProjection(locale, type, trace),
      evidence: [...metricEvidence, ...appointmentEvidence, ...waitlistEvidence],
      items: [
        ...selectedMetrics.map(({ metric, value }, index) => {
          const label = metricLabels(metric);
          return item("COMPUTED_METRIC", `metric-${metric}`, label.en, label.ar, String(value), [
            metricEvidence[index]?.id ?? "",
          ]);
        }),
        ...gapSuggestionItems,
        ...waitlistSuggestionItems,
      ],
      metricSnapshots: selectedMetrics.map(({ metric, value }, index) => ({
        endsAt: range.endsAt.toISOString(),
        id: metricEvidence[index]?.sourceId ?? uuidFromHash(`${metric}:${date}`),
        metric,
        startsAt: range.startsAt.toISOString(),
        value: String(value),
      })),
      titleAr:
        type === "DAILY_BRIEFING"
          ? `الموجز اليومي · ${date}`
          : type === "SCHEDULE_GAPS"
            ? "فجوات الجدول"
            : "تطابقات قائمة الانتظار",
      titleEn:
        type === "DAILY_BRIEFING"
          ? `Daily briefing · ${date}`
          : type === "SCHEDULE_GAPS"
            ? "Schedule gaps"
            : "Waitlist matches",
    };
  }

  private async customerSummary(
    transaction: TenantTransaction,
    access: TenantAccessSnapshot,
    locale: "ar" | "en",
    customerId: string,
    trace: Awaited<ReturnType<CopilotRepository["loadTrace"]>>,
  ): Promise<CopilotProjection> {
    const scoped = appointmentScopeWhere(access, "customers.read");
    const customer = await transaction.customer.findFirst({
      include: {
        appointments: {
          include: { branch: true, service: true },
          orderBy: { startsAt: "desc" },
          take: 20,
          where: scoped,
        },
        communicationPreferences:
          strongestScope(access, "messages.read") === "ORGANIZATION" ? true : false,
        consents: strongestScope(access, "consent.read")
          ? { orderBy: { recordedAt: "desc" }, take: 10 }
          : false,
        humanHandoffs: strongestScope(access, "conversations.handoff")
          ? { orderBy: { createdAt: "desc" }, take: 5 }
          : false,
        messages:
          strongestScope(access, "messages.read") === "ORGANIZATION"
            ? { orderBy: { createdAt: "desc" }, take: 10 }
            : false,
        calls:
          strongestScope(access, "conversations.read") === "ORGANIZATION"
            ? { include: { summary: true }, orderBy: { startedAt: "desc" }, take: 5 }
            : false,
      },
      where: {
        id: customerId,
        organizationId: access.organizationId,
        ...(Object.keys(scoped).length ? { appointments: { some: scoped } } : {}),
      },
    });
    if (!customer) throw new DomainError({ code: "NOT_FOUND", message: "Customer not found." });
    const customerEvidence = evidence(locale, {
      classification: "CONFIDENTIAL",
      label: customer.displayName,
      occurredAt: customer.updatedAt.toISOString(),
      route: `/dashboard/customers/${customer.id}`,
      sourceId: customer.id,
      sourceType: "CUSTOMER",
    });
    const appointmentEvidence = customer.appointments.map((appointment) =>
      evidence(locale, {
        classification: "CONFIDENTIAL",
        label: `${locale === "ar" ? appointment.service.nameAr : appointment.service.nameEn} · ${appointment.status}`,
        occurredAt: appointment.startsAt.toISOString(),
        route: `/dashboard/appointments/${appointment.id}`,
        sourceId: appointment.id,
        sourceType: "APPOINTMENT",
      }),
    );
    const customerConsents = customer.consents ?? [];
    const customerPreferences = customer.communicationPreferences ?? [];
    const customerMessages = customer.messages ?? [];
    const customerCalls = customer.calls ?? [];
    const customerHandoffs = customer.humanHandoffs ?? [];
    const consentEvidence = customerConsents.map((consent) =>
      evidence(locale, {
        classification: "CONFIDENTIAL",
        label: `${consent.purpose} · ${consent.status}`,
        occurredAt: consent.recordedAt.toISOString(),
        route: `/dashboard/customers/${customer.id}`,
        sourceId: consent.id,
        sourceType: "CONSENT",
      }),
    );
    const messageEvidence = customerMessages.map((message) =>
      evidence(locale, {
        classification: "CONFIDENTIAL",
        label: `${message.channel} · ${message.direction} · ${message.status}`,
        occurredAt: message.createdAt.toISOString(),
        route: `/dashboard/customers/${customer.id}`,
        sourceId: message.id,
        sourceType: "MESSAGE",
      }),
    );
    const callEvidence = customerCalls.map((call) =>
      evidence(locale, {
        classification: "RESTRICTED",
        label: call.status,
        occurredAt: call.startedAt.toISOString(),
        route: "/dashboard/copilot",
        sourceId: call.id,
        sourceType: "CALL",
      }),
    );
    const handoffEvidence = customerHandoffs.map((handoff) =>
      evidence(locale, {
        classification: "CONFIDENTIAL",
        label: `${handoff.reasonCode} · ${handoff.status}`,
        occurredAt: handoff.createdAt.toISOString(),
        route: "/dashboard/ai-handoffs",
        sourceId: handoff.id,
        sourceType: "HANDOFF",
      }),
    );
    const now = trace.watermark.getTime();
    const upcoming = customer.appointments.filter(({ startsAt }) => startsAt.getTime() >= now);
    const past = customer.appointments.filter(({ startsAt }) => startsAt.getTime() < now);
    const appointmentsSources = appointmentEvidence.map(({ id }) => id);
    const safeSources = appointmentsSources.length ? appointmentsSources : [customerEvidence.id];
    const items: CopilotProjectionItem[] = [
      item(
        "FACT",
        "upcoming",
        "Upcoming appointments",
        "المواعيد القادمة",
        String(upcoming.length),
        safeSources,
      ),
      item(
        "FACT",
        "past",
        "Past appointments",
        "المواعيد السابقة",
        String(past.length),
        safeSources,
      ),
      item(
        "FACT",
        "cancellations",
        "Cancellations / no-shows",
        "الإلغاءات / عدم الحضور",
        String(
          customer.appointments.filter(
            ({ status }) => status === "CANCELLED" || status === "NO_SHOW",
          ).length,
        ),
        safeSources,
      ),
    ];
    if (consentEvidence.length || customerPreferences.length) {
      const preferenceSummary = customerPreferences
        .map(({ channel, isEnabled }) => `${channel}:${isEnabled ? "ON" : "OFF"}`)
        .join(", ");
      items.push(
        item(
          "FACT",
          "consent",
          "Preferences and consent",
          "التفضيلات والموافقات",
          `${consentEvidence.length}${preferenceSummary ? ` · ${preferenceSummary}` : ""}`,
          consentEvidence.length ? consentEvidence.map(({ id }) => id) : [customerEvidence.id],
        ),
      );
    }
    if (messageEvidence.length) {
      items.push(
        item(
          "FACT",
          "messages",
          "Recent messages",
          "الرسائل الحديثة",
          String(messageEvidence.length),
          messageEvidence.map(({ id }) => id),
        ),
      );
    }
    if (callEvidence.length) {
      items.push(
        item(
          "FACT",
          "calls",
          "Recent calls",
          "المكالمات الحديثة",
          String(callEvidence.length),
          callEvidence.map(({ id }) => id),
        ),
      );
    }
    if (handoffEvidence.length) {
      items.push(
        item(
          "FACT",
          "handoff",
          "Outstanding human handoff",
          "تحويل بشري قائم",
          String(
            handoffEvidence.filter(
              (_, index) =>
                customerHandoffs[index]?.status !== "RESOLVED" &&
                customerHandoffs[index]?.status !== "CLOSED",
            ).length,
          ),
          handoffEvidence.map(({ id }) => id),
        ),
      );
    }
    return {
      ...this.baseProjection(locale, "CUSTOMER_SUMMARY", trace),
      evidence: [
        customerEvidence,
        ...appointmentEvidence,
        ...consentEvidence,
        ...messageEvidence,
        ...callEvidence,
        ...handoffEvidence,
      ],
      items,
      subjectId: customer.id,
      subjectType: "CUSTOMER",
      titleAr: `ملخص العميل · ${customer.displayName}`,
      titleEn: `Customer summary · ${customer.displayName}`,
    };
  }

  private async callQuality(
    transaction: TenantTransaction,
    access: TenantAccessSnapshot,
    locale: "ar" | "en",
    callId: string,
    trace: Awaited<ReturnType<CopilotRepository["loadTrace"]>>,
  ): Promise<CopilotProjection> {
    const recordingScope = requireScope(access, "recordings.read");
    requireScope(access, "conversations.read");
    const scoped = appointmentScopeWhere(access, "recordings.read");
    const call = await transaction.call.findFirst({
      include: {
        channelSession: {
          include: { conversation: { include: { actions: { include: { approval: true } } } } },
        },
        summary: { include: { appointment: true } },
        transcripts: { orderBy: { startedAt: "asc" }, where: { isFinal: true } },
      },
      where: {
        id: callId,
        organizationId: access.organizationId,
        ...(recordingScope === "ORGANIZATION"
          ? {}
          : { summary: { is: { appointment: { is: scoped } } } }),
      },
    });
    if (!call) throw new DomainError({ code: "NOT_FOUND", message: "Call not found." });
    const source = evidence(locale, {
      classification: "RESTRICTED",
      label: locale === "ar" ? "سجل مكالمة مصرح به" : "Authorized call record",
      occurredAt: call.startedAt.toISOString(),
      route: "/dashboard/copilot",
      sourceId: call.id,
      sourceType: "CALL",
    });
    const text = call.transcripts.map(({ content }) => content.toLowerCase()).join(" ");
    const actions = call.channelSession.conversation.actions;
    const mutationActions = actions.filter(({ actionName }) =>
      ["cancel_booking", "create_booking", "reschedule_booking"].includes(actionName),
    );
    const checks = [
      ["greeting", "Greeting", "التحية", /hello|welcome|مرحبا|أهلا/u.test(text)],
      [
        "business",
        "Correct business identification",
        "التعريف الصحيح بالنشاط",
        /jormall|عيادة|clinic|صالون|salon/u.test(text),
      ],
      ["intent", "Intent understanding", "فهم الطلب", Boolean(call.summary?.intent)],
      [
        "tools",
        "Correct tool use",
        "استخدام الأدوات الصحيح",
        actions.every(({ outcome }) => outcome !== "FAILED"),
      ],
      [
        "confirmation",
        "Confirmation before mutation",
        "التأكيد قبل التعديل",
        mutationActions.every(
          ({ approval, outcome }) => outcome !== "COMPLETED" || approval?.status === "CONSUMED",
        ),
      ],
      ["resolution", "Resolution", "حل الطلب", Boolean(call.summary?.outcome)],
      [
        "handoff",
        "Handoff quality",
        "جودة التحويل",
        call.status !== "HUMAN_TRANSFER" || Boolean(call.handoffReason),
      ],
      [
        "privacy",
        "Safety and privacy",
        "السلامة والخصوصية",
        actions.every(({ outcome }) => outcome !== "FAILED"),
      ],
    ] as const;
    return {
      ...this.baseProjection(locale, "CALL_QUALITY", trace),
      confidence: call.transcripts.length ? 0.9 : 0.5,
      evidence: [source],
      items: checks.map(([id, labelEn, labelAr, passed]) =>
        item(
          "COMPUTED_METRIC",
          id,
          labelEn,
          labelAr,
          passed
            ? locale === "ar"
              ? "مستوفى"
              : "Met"
            : locale === "ar"
              ? "بحاجة لمراجعة"
              : "Needs review",
          [source.id],
        ),
      ),
      subjectId: call.id,
      subjectType: "CALL",
      titleAr: "مراجعة جودة المكالمة",
      titleEn: "Call quality review",
    };
  }

  private async analytics(
    transaction: TenantTransaction,
    access: TenantAccessSnapshot,
    locale: "ar" | "en",
    query: SemanticMetricQuery,
    trace: Awaited<ReturnType<CopilotRepository["loadTrace"]>>,
  ): Promise<CopilotProjection> {
    const startsAt = new Date(query.startsAt);
    const endsAt = new Date(query.endsAt);
    if (
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(endsAt.getTime()) ||
      endsAt <= startsAt ||
      endsAt.getTime() - startsAt.getTime() > 366 * 86_400_000
    ) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Metric window is invalid." });
    }
    const scoped = appointmentScopeWhere(access, "reports.read");
    if (query.branchId) {
      const scope = requireScope(access, "reports.read");
      if (scope === "ASSIGNED_BRANCHES" && !access.assignedBranchIds.includes(query.branchId)) {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "Branch is outside the reporting scope.",
        });
      }
      if (scope === "SELF" && !access.assignedBranchIds.includes(query.branchId)) {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "Branch is outside the reporting scope.",
        });
      }
    }
    const appointmentWhere: Prisma.AppointmentWhereInput = {
      ...scoped,
      ...(query.branchId ? { branchId: query.branchId } : {}),
      organizationId: access.organizationId,
      startsAt: { gte: startsAt, lt: endsAt },
    };
    let value = 0;
    switch (query.metric) {
      case "APPOINTMENTS_TOTAL":
        value = await transaction.appointment.count({ where: appointmentWhere });
        break;
      case "CANCELLATIONS_TOTAL":
        value = await transaction.appointment.count({
          where: { ...appointmentWhere, status: "CANCELLED" },
        });
        break;
      case "NO_SHOWS_TOTAL":
        value = await transaction.appointment.count({
          where: { ...appointmentWhere, status: "NO_SHOW" },
        });
        break;
      case "UNCONFIRMED_TOTAL":
        value = await transaction.appointment.count({
          where: { ...appointmentWhere, status: "PENDING" },
        });
        break;
      case "ACTIVE_WAITLIST_TOTAL":
        value = await transaction.waitlistEntry.count({
          where: { organizationId: access.organizationId, status: "ACTIVE" },
        });
        break;
      case "WAITLIST_MATCHES_TOTAL":
        throw new DomainError({
          code: "VALIDATION_FAILED",
          message: "Waitlist matches are available through the bounded daily matching use case.",
        });
      case "FAILED_MESSAGES_TOTAL":
        requireScope(access, "messages.read");
        value = await transaction.message.count({
          where: {
            createdAt: { gte: startsAt, lt: endsAt },
            organizationId: access.organizationId,
            ...(strongestScope(access, "messages.read") === "ORGANIZATION"
              ? {}
              : { appointment: { is: scoped } }),
            status: { in: ["FAILED", "DEAD_LETTER"] },
          },
        });
        break;
      case "OPEN_HANDOFFS_TOTAL":
        requireScope(access, "conversations.handoff");
        value = await transaction.humanHandoff.count({
          where: {
            createdAt: { lt: endsAt },
            organizationId: access.organizationId,
            status: { in: ["OPEN", "ASSIGNED"] },
          },
        });
        break;
      case "MISSED_CALLS_TOTAL":
        requireScope(access, "conversations.read");
        value = await transaction.call.count({
          where: {
            organizationId: access.organizationId,
            ...(strongestScope(access, "conversations.read") === "ORGANIZATION"
              ? {}
              : { summary: { is: { appointment: { is: scoped } } } }),
            startedAt: { gte: startsAt, lt: endsAt },
            status: "MISSED",
          },
        });
        break;
      case "SCHEDULED_MINUTES": {
        const appointments = await transaction.appointment.findMany({
          select: { endsAt: true, startsAt: true },
          where: appointmentWhere,
        });
        value = appointments.reduce(
          (sum, appointment) =>
            sum +
            Math.max(0, (appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000),
          0,
        );
        break;
      }
      case "SCHEDULE_GAPS_TOTAL": {
        const appointments = await transaction.appointment.findMany({
          orderBy: { startsAt: "asc" },
          select: { endsAt: true, startsAt: true },
          where: appointmentWhere,
        });
        value = appointments.slice(1).filter((appointment, index) => {
          const previous = appointments[index];
          return (
            previous !== undefined &&
            appointment.startsAt.getTime() - previous.endsAt.getTime() >= 60 * 60_000
          );
        }).length;
        break;
      }
    }
    const source = this.metricEvidence(
      locale,
      query.metric,
      startsAt,
      endsAt,
      trace.watermark,
      `${access.actorUserId}:${query.branchId ?? "all"}`,
    );
    const labels = metricLabels(query.metric);
    return {
      ...this.baseProjection(locale, "ANALYTICS", trace),
      evidence: [source],
      items: [
        item("COMPUTED_METRIC", `analytics-${query.metric}`, labels.en, labels.ar, String(value), [
          source.id,
        ]),
      ],
      metricSnapshots: [
        {
          ...(query.branchId ? { branchId: query.branchId } : {}),
          endsAt: endsAt.toISOString(),
          id: source.sourceId,
          metric: query.metric,
          startsAt: startsAt.toISOString(),
          value: String(value),
        },
      ],
      titleAr: "مساعد التحليلات",
      titleEn: "Analytics Copilot",
    };
  }

  private mapInsight(
    row: Readonly<{
      confidence: number;
      dataWatermark: Date;
      evidence: readonly Readonly<{
        classification: CopilotDataClassification;
        href: string;
        id: string;
        label: string;
        occurredAt: Date;
        sourceId: string;
        sourceType: CopilotEvidenceSourceType;
      }>[];
      expiresAt: Date;
      id: string;
      insightType: PrismaCopilotInsightType;
      knowledgeVersionIds: readonly string[];
      locale: "ar" | "en";
      modelIdentifier: string;
      promptConfigurationId: string | null;
      promptVersion: number;
      statements: Prisma.JsonValue;
      subjectId: string | null;
      subjectType: string | null;
      title: string;
    }>,
  ): CopilotInsightRecord {
    const statements = isGeneratedStatements(row.statements)
      ? row.statements.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const value = entry as Prisma.JsonObject;
          if (
            !Array.isArray(value.evidenceIds) ||
            !isStatementKind(value.kind) ||
            typeof value.projectionItemId !== "string" ||
            typeof value.text !== "string"
          )
            return [];
          const evidenceIds = value.evidenceIds.filter(
            (id): id is string => typeof id === "string",
          );
          return [
            {
              evidenceIds,
              kind: value.kind,
              projectionItemId: value.projectionItemId,
              text: value.text,
            },
          ];
        })
      : [];
    return {
      confidence: row.confidence,
      dataWatermark: row.dataWatermark.toISOString(),
      evidence: row.evidence.map((source) => ({
        classification: source.classification,
        href: source.href,
        id: source.sourceId,
        label: source.label,
        occurredAt: source.occurredAt.toISOString(),
        sourceId: source.sourceId,
        sourceType: source.sourceType,
      })),
      expiresAt: row.expiresAt.toISOString(),
      id: row.id,
      insightType: row.insightType,
      knowledgeVersionIds: row.knowledgeVersionIds,
      locale: row.locale,
      modelIdentifier: row.modelIdentifier,
      ...(row.promptConfigurationId ? { promptConfigurationId: row.promptConfigurationId } : {}),
      promptVersion: row.promptVersion,
      statements,
      ...(row.subjectId ? { subjectId: row.subjectId } : {}),
      ...(row.subjectType === "CALL" || row.subjectType === "CUSTOMER"
        ? { subjectType: row.subjectType }
        : {}),
      title: row.title,
    };
  }
}
