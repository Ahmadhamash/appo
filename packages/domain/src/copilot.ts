import { DomainError } from "./errors";
import type { TenantAccessSnapshot } from "./identity";

export const copilotInsightTypes = [
  "DAILY_BRIEFING",
  "CUSTOMER_SUMMARY",
  "SCHEDULE_GAPS",
  "WAITLIST_MATCHES",
  "CALL_QUALITY",
  "ANALYTICS",
] as const;

export const semanticMetricKeys = [
  "APPOINTMENTS_TOTAL",
  "CANCELLATIONS_TOTAL",
  "NO_SHOWS_TOTAL",
  "UNCONFIRMED_TOTAL",
  "ACTIVE_WAITLIST_TOTAL",
  "WAITLIST_MATCHES_TOTAL",
  "FAILED_MESSAGES_TOTAL",
  "OPEN_HANDOFFS_TOTAL",
  "MISSED_CALLS_TOTAL",
  "SCHEDULE_GAPS_TOTAL",
  "SCHEDULED_MINUTES",
] as const;

export const copilotFeedbackTypes = ["HELPFUL", "INCORRECT", "UNSAFE", "OUTDATED"] as const;

export type CopilotInsightType = (typeof copilotInsightTypes)[number];
export type SemanticMetricKey = (typeof semanticMetricKeys)[number];
export type CopilotFeedbackType = (typeof copilotFeedbackTypes)[number];
export type CopilotStatementKind = "AI_SUGGESTION" | "COMPUTED_METRIC" | "FACT";

export type CopilotEvidence = Readonly<{
  classification: "CONFIDENTIAL" | "INTERNAL" | "RESTRICTED";
  href: string;
  id: string;
  label: string;
  occurredAt: string;
  sourceId: string;
  sourceType:
    | "APPOINTMENT"
    | "CALL"
    | "CONSENT"
    | "CUSTOMER"
    | "HANDOFF"
    | "MESSAGE"
    | "METRIC_SNAPSHOT"
    | "WAITLIST_ENTRY";
}>;

export type CopilotProjectionItem = Readonly<{
  evidenceIds: readonly string[];
  id: string;
  kind: CopilotStatementKind;
  labelAr: string;
  labelEn: string;
  value: string;
}>;

export type CopilotProjection = Readonly<{
  confidence: number;
  dataWatermark: string;
  evidence: readonly CopilotEvidence[];
  expiresAt: string;
  insightType: CopilotInsightType;
  items: readonly CopilotProjectionItem[];
  knowledgeVersionIds: readonly string[];
  locale: "ar" | "en";
  metricSnapshots?:
    | readonly Readonly<{
        branchId?: string | undefined;
        endsAt: string;
        id: string;
        metric: SemanticMetricKey;
        startsAt: string;
        value: string;
      }>[]
    | undefined;
  promptConfigurationId?: string | undefined;
  promptVersion: number;
  subjectId?: string | undefined;
  subjectType?: "CALL" | "CUSTOMER" | undefined;
  titleAr: string;
  titleEn: string;
}>;

export type CopilotGeneratedStatement = Readonly<{
  evidenceIds: readonly string[];
  kind: CopilotStatementKind;
  projectionItemId: string;
  text: string;
}>;

export type CopilotGeneratedInsight = Readonly<{
  modelIdentifier: string;
  statements: readonly CopilotGeneratedStatement[];
}>;

export type SemanticMetricQuery = Readonly<{
  branchId?: string | undefined;
  endsAt: string;
  metric: SemanticMetricKey;
  startsAt: string;
}>;

export type CopilotInsightRecord = Readonly<{
  confidence: number;
  dataWatermark: string;
  evidence: readonly CopilotEvidence[];
  expiresAt: string;
  id: string;
  insightType: CopilotInsightType;
  knowledgeVersionIds: readonly string[];
  locale: "ar" | "en";
  modelIdentifier: string;
  promptConfigurationId?: string | undefined;
  promptVersion: number;
  statements: readonly CopilotGeneratedStatement[];
  subjectId?: string | undefined;
  subjectType?: "CALL" | "CUSTOMER" | undefined;
  title: string;
}>;

export interface CopilotProjectionPort {
  loadProjection(
    access: TenantAccessSnapshot,
    request: Readonly<{
      insightType: CopilotInsightType;
      locale: "ar" | "en";
      metricQuery?: SemanticMetricQuery | undefined;
      subjectId?: string | undefined;
    }>,
  ): Promise<CopilotProjection>;
}

export interface CopilotGenerationPort {
  generate(projection: CopilotProjection): Promise<CopilotGeneratedInsight>;
}

export interface CopilotInsightStorePort {
  saveInsight(
    access: TenantAccessSnapshot,
    projection: CopilotProjection,
    generated: CopilotGeneratedInsight,
  ): Promise<CopilotInsightRecord>;
}

const unsupportedMedicalConclusion =
  /\b(diagnos(?:is|ed)|prognosis|prescrib(?:e|ed)|medical conclusion)\b|(?:تشخيص|تنبؤ طبي|وصف دواء)/iu;

export function assertCopilotGeneration(
  projection: CopilotProjection,
  generated: CopilotGeneratedInsight,
): void {
  if (!generated.modelIdentifier.trim() || generated.modelIdentifier.length > 160) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid Copilot model trace." });
  }
  const itemById = new Map(projection.items.map((item) => [item.id, item]));
  const evidenceIds = new Set(projection.evidence.map((evidence) => evidence.id));
  if (generated.statements.length !== projection.items.length) {
    throw new DomainError({
      code: "AI_UNSUPPORTED_CLAIM",
      message: "Copilot output omitted or invented a projected statement.",
    });
  }
  const seenItems = new Set<string>();
  for (const statement of generated.statements) {
    const item = itemById.get(statement.projectionItemId);
    if (!item || seenItems.has(item.id) || statement.kind !== item.kind) {
      throw new DomainError({
        code: "AI_UNSUPPORTED_CLAIM",
        message: "Copilot output contains an unsupported statement.",
      });
    }
    if (!statement.text.trim() || statement.text.length > 1_000) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid Copilot statement." });
    }
    if (unsupportedMedicalConclusion.test(statement.text)) {
      throw new DomainError({
        code: "AI_UNSUPPORTED_CLAIM",
        message: "Copilot output contains an unsupported medical conclusion.",
      });
    }
    const expected = [...item.evidenceIds].toSorted();
    const actual = [...new Set(statement.evidenceIds)].toSorted();
    if (
      actual.length === 0 ||
      actual.some((id) => !evidenceIds.has(id)) ||
      JSON.stringify(actual) !== JSON.stringify(expected)
    ) {
      throw new DomainError({
        code: "AI_UNSUPPORTED_CLAIM",
        message: "Copilot statement is not linked to its authorized evidence.",
      });
    }
    seenItems.add(item.id);
  }
}

export class StaffCopilotService {
  constructor(
    private readonly projections: CopilotProjectionPort,
    private readonly generator: CopilotGenerationPort,
    private readonly store: CopilotInsightStorePort,
  ) {}

  async generate(
    access: TenantAccessSnapshot,
    request: Readonly<{
      insightType: CopilotInsightType;
      locale: "ar" | "en";
      metricQuery?: SemanticMetricQuery | undefined;
      subjectId?: string | undefined;
    }>,
  ): Promise<CopilotInsightRecord> {
    const projection = await this.projections.loadProjection(access, request);
    const generated = await this.generator.generate(projection);
    assertCopilotGeneration(projection, generated);
    return this.store.saveInsight(access, projection, generated);
  }
}
