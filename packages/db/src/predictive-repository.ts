import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "@jormall/domain/errors";
import type {
  PermissionCode,
  PermissionScope,
  TenantAccessSnapshot,
} from "@jormall/domain/identity";
import { isPermissionCode } from "@jormall/domain/identity";
import {
  distributionDrift,
  evaluateBinaryPredictions,
  forecastDemand,
  predictNoShow,
  predictiveAlgorithmVersions,
  predictiveCapabilities,
  predictiveMinimums,
  rankSafeReflowCandidates,
  rankValidRecommendations,
  suggestStaffing,
  type AttendanceHistoryRow,
  type DemandBucketRefusal,
  type DemandForecast,
  type DemandHistoryBucket,
  type DemandTargetBucket,
  type NoShowTarget,
  type PredictionFactor,
  type PredictionFeedbackType,
  type PredictiveCapability,
  type PredictiveRefusalReason,
  type RefusedPrediction,
} from "@jormall/domain/predictive";
import {
  localDateForInstant,
  localDateTimePartsForInstant,
  localDateTimeToUtc,
} from "@jormall/domain/timezone";

import { prisma } from "./client";
import {
  Prisma,
  type PrismaClient,
  type PredictiveJobStatus,
  type PredictiveJobType,
} from "./generated/prisma/client";
import { IdentityRepository, type SessionTenantSelection } from "./identity-repository";
import { SchedulingRepository } from "./scheduling-repository";
import { runInTenant, type TenantTransaction } from "./tenant-context";

const systemActorId = "00000000-0000-0000-0000-000000000000";
const predictiveDemandConfigurationLimit = 20;
const predictiveDemandTargetLimit = 500;
const scopeRank: Readonly<Record<PermissionScope, number>> = {
  ASSIGNED_BRANCHES: 2,
  ORGANIZATION: 3,
  SELF: 1,
};

export type TenantAccessSelection = SessionTenantSelection;

export type PredictiveCapabilityOverview = Readonly<{
  capability: PredictiveCapability;
  enabled: boolean;
  updatedAt: string;
  version: number;
}>;

export type PredictiveJobOverview = Readonly<{
  capability: PredictiveCapability;
  completedAt: string | null;
  createdAt: string;
  id: string;
  jobType: PredictiveJobType;
  processedRows: number;
  safeErrorCode: string | null;
  status: PredictiveJobStatus;
  totalRows: number;
}>;

export type PredictionExplanation = Readonly<{
  code: string;
  contribution: number;
  direction: "DECREASES_RISK" | "INCREASES_RISK" | "NEUTRAL";
  sampleSize: number;
  value: number;
}>;

export type PredictionOverview = Readonly<{
  asOf: string;
  branchId: string | null;
  capability: PredictiveCapability;
  createdAt: string;
  details: Readonly<Record<string, boolean | number | string | null>>;
  estimate: number | null;
  explanation: readonly PredictionExplanation[];
  expiresAt: string;
  horizonEndsAt: string | null;
  horizonStartsAt: string | null;
  id: string;
  lowerBound: number | null;
  modelIdentifier: string;
  modelVersion: number;
  providerId: string | null;
  refusalReason: PredictiveRefusalReason | null;
  required: number | null;
  sampleSize: number;
  serviceId: string | null;
  status: "GENERATED" | "REFUSED";
  subjectId: string | null;
  subjectType: string;
  upperBound: number | null;
}>;

export type PredictiveEvaluationOverview = Readonly<{
  capability: PredictiveCapability;
  createdAt: string;
  id: string;
  metrics: Readonly<Record<string, number | string | null>>;
  outcome: "FAILED" | "INSUFFICIENT" | "PASSED";
  runType: "BACKTEST" | "OFFLINE";
  sampleSize: number;
}>;

export type PredictiveDriftOverview = Readonly<{
  capability: PredictiveCapability;
  createdAt: string;
  id: string;
  sampleSize: number;
  score: number | null;
  status: "ALERT" | "INSUFFICIENT" | "STABLE" | "WATCH";
}>;

export type PredictiveOverview = Readonly<{
  capabilities: readonly PredictiveCapabilityOverview[];
  drift: readonly PredictiveDriftOverview[];
  evaluations: readonly PredictiveEvaluationOverview[];
  jobs: readonly PredictiveJobOverview[];
  predictions: readonly PredictionOverview[];
}>;

export type PredictiveJobRequest = Readonly<{
  actorUserId: string;
  appointmentId?: string | undefined;
  branchId?: string | undefined;
  capability: PredictiveCapability;
  endsOn?: string | undefined;
  idempotencyKey: string;
  jobType: PredictiveJobType;
  serviceId?: string | undefined;
  startsOn?: string | undefined;
}>;

export type PredictiveCapabilityUpdate = Readonly<{
  actorUserId: string;
  capability: PredictiveCapability;
  enabled: boolean;
  expectedVersion: number;
}>;

export type PredictiveFeedbackInput = Readonly<{
  actorUserId: string;
  comment?: string | undefined;
  feedbackType: PredictionFeedbackType;
  predictionId: string;
}>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nestedJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => nestedJson(entry));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, nestedJson(entry)]),
    ) as Prisma.InputJsonObject;
  }
  return String(value);
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  const normalized = nestedJson(value);
  if (normalized === null) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "A JSON object is required." });
  }
  return normalized;
}

function isAggregateDemandRefusal(
  value: readonly (DemandBucketRefusal | DemandForecast)[] | RefusedPrediction,
): value is RefusedPrediction {
  return "reason" in value;
}

function strongestScope(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
): PermissionScope | undefined {
  return access.grants
    .filter((grant) => grant.code === permission)
    .toSorted((left, right) => scopeRank[right.scope] - scopeRank[left.scope])[0]?.scope;
}

function requireScope(access: TenantAccessSnapshot, permission: PermissionCode): PermissionScope {
  const granted = strongestScope(access, permission);
  if (!granted) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "The active tenant context does not grant this predictive permission.",
      metadata: { permission },
    });
  }
  return granted;
}

function requireResourceScope(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
  resource: Readonly<{
    branchId?: string | null | undefined;
    providerId?: string | null | undefined;
  }>,
): PermissionScope {
  const granted = requireScope(access, permission);
  if (granted === "ORGANIZATION") return granted;
  if (
    granted === "ASSIGNED_BRANCHES" &&
    resource.branchId &&
    access.assignedBranchIds.includes(resource.branchId)
  ) {
    return granted;
  }
  if (granted === "SELF" && resource.providerId && access.staffProfileId === resource.providerId) {
    return granted;
  }
  throw new DomainError({
    code: "FORBIDDEN",
    message: "Predictive scope does not include this record.",
  });
}

function underlyingPermissions(capability: PredictiveCapability): readonly PermissionCode[] {
  switch (capability) {
    case "NO_SHOW":
      return ["appointments.read"];
    case "DEMAND_FORECAST":
      return ["reports.read"];
    case "STAFFING":
      return ["reports.read", "schedules.read"];
    case "SCHEDULE_REFLOW":
      return ["appointments.read", "schedules.read", "resources.read"];
    case "SERVICE_PROVIDER_RECOMMENDATION":
      return ["services.read", "staff.read", "appointments.availability.read"];
  }
}

function requireUnderlyingAccess(
  access: TenantAccessSnapshot,
  capability: PredictiveCapability,
  resource: Readonly<{
    branchId?: string | null | undefined;
    providerId?: string | null | undefined;
  }>,
): void {
  for (const permission of underlyingPermissions(capability)) {
    requireResourceScope(access, permission, resource);
  }
}

function canUnderlyingAccess(
  access: TenantAccessSnapshot,
  capability: PredictiveCapability,
  resource: Readonly<{ branchId?: string | null; providerId?: string | null }>,
): boolean {
  try {
    requireUnderlyingAccess(access, capability, resource);
    return true;
  } catch (error) {
    if (error instanceof DomainError && error.code === "FORBIDDEN") return false;
    throw error;
  }
}

type PredictiveEvidenceSourceScope = "BRANCH" | "BRANCH_SERVICE" | "ORGANIZATION";

function evidenceSourceScope(
  capability: PredictiveCapability,
  provenance: Prisma.JsonValue,
): PredictiveEvidenceSourceScope | null {
  if (capability !== "DEMAND_FORECAST" && capability !== "STAFFING") {
    return null;
  }
  const sourceScope = primitiveDetails(provenance).sourceScope;
  return sourceScope === "BRANCH" ||
    sourceScope === "BRANCH_SERVICE" ||
    sourceScope === "ORGANIZATION"
    ? sourceScope
    : null;
}

function requireEvidenceSourceCoverage(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
  prediction: Readonly<{
    branchId?: string | null;
    capability: PredictiveCapability;
    details: Prisma.JsonValue;
    providerId?: string | null;
  }>,
): void {
  const viewerScope = requireResourceScope(access, permission, prediction);
  const sourceScope = evidenceSourceScope(prediction.capability, prediction.details);
  if (
    (viewerScope === "SELF" &&
      (prediction.capability === "DEMAND_FORECAST" || prediction.capability === "STAFFING")) ||
    (viewerScope === "ASSIGNED_BRANCHES" &&
      (sourceScope === "ORGANIZATION" || sourceScope === null) &&
      (prediction.capability === "DEMAND_FORECAST" || prediction.capability === "STAFFING"))
  ) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "Predictive evidence scope exceeds the viewer's authorized scope.",
    });
  }
}

function canReadAggregateEvidence(
  access: TenantAccessSnapshot,
  aggregate: Readonly<{
    branchId?: string | null;
    capability: PredictiveCapability;
    metrics: Prisma.JsonValue;
  }>,
): boolean {
  try {
    const viewerScope = requireResourceScope(access, "predictions.read", aggregate);
    const sourceScope = evidenceSourceScope(aggregate.capability, aggregate.metrics);
    if (
      (viewerScope === "SELF" &&
        (aggregate.capability === "DEMAND_FORECAST" || aggregate.capability === "STAFFING")) ||
      (viewerScope === "ASSIGNED_BRANCHES" &&
        (sourceScope === "ORGANIZATION" || sourceScope === null) &&
        (aggregate.capability === "DEMAND_FORECAST" || aggregate.capability === "STAFFING"))
    ) {
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof DomainError && error.code === "FORBIDDEN") return false;
    throw error;
  }
}

function authorizedAggregateSourceScope(
  access: TenantAccessSnapshot,
  capability: PredictiveCapability,
  branchId: string | null,
): PredictiveEvidenceSourceScope | null {
  if (capability !== "DEMAND_FORECAST" && capability !== "STAFFING") return null;
  if (!branchId || strongestScope(access, "predictions.run") === "ORGANIZATION") {
    return "ORGANIZATION";
  }
  return "BRANCH";
}

function withEvidenceSourceScope(
  value: unknown,
  sourceScope: PredictiveEvidenceSourceScope | null,
): unknown {
  if (!sourceScope) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { sourceScope };
  return Object.fromEntries([...Object.entries(value), ["sourceScope", sourceScope]]);
}

function canReadPredictionEvidence(
  access: TenantAccessSnapshot,
  prediction: Readonly<{
    branchId?: string | null;
    capability: PredictiveCapability;
    details: Prisma.JsonValue;
    providerId?: string | null;
  }>,
): boolean {
  try {
    requireEvidenceSourceCoverage(access, "predictions.read", prediction);
    return true;
  } catch (error) {
    if (error instanceof DomainError && error.code === "FORBIDDEN") return false;
    throw error;
  }
}

function uuid(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: `${field} is invalid.` });
  }
  return value;
}

function localDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: `${field} is invalid.` });
  }
  return value;
}

function metricRecord(value: Prisma.JsonValue): Readonly<Record<string, number | string | null>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "number" || typeof entry === "string" || entry === null
        ? [[key, entry] as const]
        : [],
    ),
  );
}

function explanation(value: Prisma.JsonValue): readonly PredictionExplanation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Prisma.JsonObject;
    if (
      typeof item.code !== "string" ||
      typeof item.contribution !== "number" ||
      typeof item.sampleSize !== "number" ||
      typeof item.value !== "number" ||
      (item.direction !== "DECREASES_RISK" &&
        item.direction !== "INCREASES_RISK" &&
        item.direction !== "NEUTRAL")
    ) {
      return [];
    }
    return [
      {
        code: item.code,
        contribution: item.contribution,
        direction: item.direction,
        sampleSize: item.sampleSize,
        value: item.value,
      },
    ];
  });
}

function requiredFromDetails(value: Prisma.JsonValue): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const required = (value as Prisma.JsonObject).required;
  return typeof required === "number" && Number.isFinite(required) ? required : null;
}

function primitiveDetails(
  value: Prisma.JsonValue,
): Readonly<Record<string, boolean | number | string | null>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "boolean" ||
      typeof entry === "number" ||
      typeof entry === "string" ||
      entry === null
        ? [[key, entry] as const]
        : [],
    ),
  );
}

function mapJob(
  row: Readonly<{
    capability: PredictiveCapability;
    completedAt: Date | null;
    createdAt: Date;
    id: string;
    jobType: PredictiveJobType;
    processedRows: number;
    safeErrorCode: string | null;
    status: PredictiveJobStatus;
    totalRows: number;
  }>,
): PredictiveJobOverview {
  return {
    capability: row.capability,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    jobType: row.jobType,
    processedRows: row.processedRows,
    safeErrorCode: row.safeErrorCode,
    status: row.status,
    totalRows: row.totalRows,
  };
}

function mapPrediction(
  row: Readonly<{
    asOf: Date;
    branchId: string | null;
    capability: PredictiveCapability;
    createdAt: Date;
    details: Prisma.JsonValue;
    estimate: number | null;
    explanation: Prisma.JsonValue;
    expiresAt: Date;
    horizonEndsAt: Date | null;
    horizonStartsAt: Date | null;
    id: string;
    lowerBound: number | null;
    modelIdentifier: string;
    modelVersion: number;
    providerId: string | null;
    refusalReason: PredictiveRefusalReason | null;
    sampleSize: number;
    serviceId: string | null;
    status: "GENERATED" | "REFUSED";
    subjectId: string | null;
    subjectType: string;
    upperBound: number | null;
  }>,
  selfProjection = false,
): PredictionOverview {
  const details = primitiveDetails(row.details);
  const selfDetailKeys = new Set([
    "advisory",
    "appointmentVersion",
    "automaticDenialAllowed",
    "horizon",
    "protectedAttributesExcluded",
    "scheduledStartsAt",
    "timezone",
  ]);
  return {
    asOf: row.asOf.toISOString(),
    branchId: row.branchId,
    capability: row.capability,
    createdAt: row.createdAt.toISOString(),
    details: selfProjection
      ? {
          ...Object.fromEntries(Object.entries(details).filter(([key]) => selfDetailKeys.has(key))),
          evidenceCountsRedacted: true,
        }
      : details,
    estimate: row.estimate,
    explanation: explanation(row.explanation).filter(
      ({ code }) => !selfProjection || code === "PROVIDER_HISTORY",
    ),
    expiresAt: row.expiresAt.toISOString(),
    horizonEndsAt: row.horizonEndsAt?.toISOString() ?? null,
    horizonStartsAt: row.horizonStartsAt?.toISOString() ?? null,
    id: row.id,
    lowerBound: row.lowerBound,
    modelIdentifier: row.modelIdentifier,
    modelVersion: row.modelVersion,
    providerId: row.providerId,
    refusalReason: row.refusalReason,
    required: selfProjection ? null : requiredFromDetails(row.details),
    sampleSize: selfProjection ? 0 : row.sampleSize,
    serviceId: row.serviceId,
    status: row.status,
    subjectId: row.subjectId,
    subjectType: row.subjectType,
    upperBound: row.upperBound,
  };
}

type StoredPredictiveJob = Prisma.PredictiveJobGetPayload<object>;

function stringParameter(parameters: Prisma.JsonValue, key: string): string | undefined {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return undefined;
  const value = (parameters as Prisma.JsonObject)[key];
  return typeof value === "string" ? value : undefined;
}

function addLocalDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localWeekday(value: string): number {
  return new Date(`${value}T00:00:00Z`).getUTCDay();
}

function calendarWeek(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  const isoWeekday = date.getUTCDay() || 7;
  const thursday = new Date(date.getTime() + (4 - isoWeekday) * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((1 + (thursday.getTime() - yearStart.getTime()) / 86_400_000) / 7);
  return `${isoYear}-${String(week).padStart(2, "0")}`;
}

function comparableLeafWeeks(
  history: readonly DemandHistoryBucket[],
  target: DemandTargetBucket,
): number {
  return new Set(
    history
      .filter(
        (row) =>
          row.branchId === target.branchId &&
          row.serviceId === target.serviceId &&
          row.localWeekday === target.localWeekday &&
          row.localHour === target.localHour,
      )
      .map(({ localDate }) => calendarWeek(localDate)),
  ).size;
}

function weekdayNumber(value: string): number {
  const byName: Readonly<Record<string, number>> = {
    FRIDAY: 5,
    MONDAY: 1,
    SATURDAY: 6,
    SUNDAY: 0,
    THURSDAY: 4,
    TUESDAY: 2,
    WEDNESDAY: 3,
  };
  return byName[value] ?? -1;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

type DemandPlanningContext = Readonly<{
  branchId: string;
  durationMinutes: number;
  endsOn: string;
  serviceId: string;
  startsOn: string;
  targets: readonly DemandTargetBucket[];
  timezone: string;
}>;

type DemandGenerationScope = Readonly<{
  organizationRequest: boolean;
  organizationTimezone: string | null;
  plans: readonly DemandPlanningContext[];
  truncated: boolean;
}>;

type AttendanceEvidenceRow = AttendanceHistoryRow &
  Readonly<{
    dimensionVerifiedAt: string;
    recordedAt: string;
    resolvedVerifiedAt: string;
  }>;

type GeneratedPredictionInput = Readonly<{
  asOf: Date;
  branchId: string | null;
  details: unknown;
  estimate: number;
  explanation: readonly PredictionFactor[];
  expiresAt: Date;
  featureSnapshotId: string;
  generationSubject: unknown;
  horizonEndsAt: Date | null;
  horizonStartsAt: Date | null;
  lowerBound: number | null;
  modelIdentifier: string;
  modelVersion: number;
  modelVersionId: string;
  providerId: string | null;
  sampleSize: number;
  serviceId: string | null;
  subjectId: string | null;
  subjectType: string;
  upperBound: number | null;
}>;

export class PredictiveRepository {
  private readonly identity: IdentityRepository;
  private readonly scheduling: SchedulingRepository;

  constructor(private readonly client: PrismaClient) {
    this.identity = new IdentityRepository(client);
    this.scheduling = new SchedulingRepository(client);
  }

  private loadAccess(selection: TenantAccessSelection, actorUserId: string) {
    return this.identity.loadTenantAccess(actorUserId, selection, {});
  }

  private async reauthorizeJob(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    allowDisabled = false,
  ): Promise<TenantAccessSnapshot> {
    const selection: TenantAccessSelection = {
      activeOrganizationId: access.organizationId,
      ...(job.membershipId ? { activeMembershipId: job.membershipId } : {}),
      ...(job.supportAccessId ? { activeSupportAccessId: job.supportAccessId } : {}),
    };
    const current = await this.loadAccess(selection, job.actorUserId);
    requireResourceScope(current, "predictions.run", { branchId: job.branchId });
    requireUnderlyingAccess(current, job.capability, { branchId: job.branchId });
    if (!allowDisabled && job.jobType !== "DATA_AUDIT") {
      const setting = await runInTenant(this.client, current, (transaction) =>
        transaction.predictiveCapabilitySetting.findUnique({
          where: {
            organizationId_capability: {
              capability: job.capability,
              organizationId: current.organizationId,
            },
          },
        }),
      );
      if (!setting?.enabled) {
        throw new DomainError({ code: "FORBIDDEN", message: "Predictive capability is disabled." });
      }
    }
    return current;
  }

  private async lockEvidenceAuthorization(
    transaction: TenantTransaction,
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    allowDisabled = false,
  ): Promise<void> {
    const [result] = await transaction.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`
      SELECT lock_predictive_evidence_authorization_v2(
        ${access.organizationId}::uuid,
        ${job.id}::uuid,
        ${job.actorUserId}::uuid,
        ${job.membershipId}::uuid,
        ${job.supportAccessId}::uuid,
        ${job.leaseToken}::uuid,
        ${allowDisabled}
      ) AS allowed
    `);
    if (!result?.allowed) {
      throw new DomainError({
        code: "FORBIDDEN",
        message: "Predictive evidence authorization is no longer active.",
      });
    }
  }

  private async lockAndReloadForegroundAccess(
    transaction: TenantTransaction,
    access: TenantAccessSnapshot,
  ): Promise<TenantAccessSnapshot> {
    const [authorization] = await transaction.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`
      SELECT lock_predictive_foreground_authorization(
        ${access.organizationId}::uuid,
        ${access.actorUserId}::uuid,
        ${access.membershipId ?? null}::uuid,
        ${access.supportAccessId ?? null}::uuid
      ) AS allowed
    `);
    if (!authorization?.allowed) {
      throw new DomainError({
        code: "FORBIDDEN",
        message: "The current tenant authorization is no longer active.",
      });
    }

    if (access.membershipId) {
      const membership = await transaction.organizationMembership.findFirst({
        include: {
          roles: {
            include: {
              role: { include: { permissions: { include: { permission: true } } } },
            },
          },
          staffProfile: { include: { branchAssignments: true } },
        },
        where: {
          id: access.membershipId,
          organizationId: access.organizationId,
          status: "ACTIVE",
          userId: access.actorUserId,
        },
      });
      if (!membership) {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "The active membership is no longer authorized.",
        });
      }
      const grants = membership.roles.flatMap(({ role }) =>
        role.permissions.flatMap(({ permission, scope }) =>
          isPermissionCode(permission.code) ? [{ code: permission.code, scope }] : [],
        ),
      );
      return {
        actorUserId: access.actorUserId,
        assignedBranchIds:
          membership.staffProfile?.branchAssignments.map(({ branchId }) => branchId) ?? [],
        grants,
        membershipId: membership.id,
        organizationId: access.organizationId,
        ...(membership.staffProfile ? { staffProfileId: membership.staffProfile.id } : {}),
      };
    }

    if (access.supportAccessId) {
      const supportAccess = await transaction.platformSupportAccess.findFirst({
        select: { permissionCodes: true },
        where: {
          expiresAt: { gt: new Date() },
          id: access.supportAccessId,
          organizationId: access.organizationId,
          revokedAt: null,
          startsAt: { lte: new Date() },
          userId: access.actorUserId,
        },
      });
      if (!supportAccess) {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "Platform support access is no longer authorized.",
        });
      }
      return {
        actorUserId: access.actorUserId,
        assignedBranchIds: [],
        grants: supportAccess.permissionCodes.flatMap((code) =>
          isPermissionCode(code) ? [{ code, scope: "ORGANIZATION" as const }] : [],
        ),
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
      };
    }

    throw new DomainError({
      code: "FORBIDDEN",
      message: "A current tenant authorization lineage is required.",
    });
  }

  async getOverview(
    selection: TenantAccessSelection,
    actorUserId: string,
  ): Promise<PredictiveOverview> {
    const initialAccess = await this.loadAccess(selection, actorUserId);
    return runInTenant(this.client, initialAccess, async (transaction) => {
      const access = await this.lockAndReloadForegroundAccess(transaction, initialAccess);
      const readScope = requireScope(access, "predictions.read");
      const visibleCapabilities = predictiveCapabilities.filter((capability) =>
        underlyingPermissions(capability).every(
          (permission) => strongestScope(access, permission) !== undefined,
        ),
      );
      const predictionWhere: Prisma.PredictionWhereInput = {
        capability: { in: [...visibleCapabilities] },
        organizationId: access.organizationId,
        ...(readScope === "ORGANIZATION"
          ? {}
          : readScope === "ASSIGNED_BRANCHES"
            ? { branchId: { in: [...access.assignedBranchIds] } }
            : { providerId: access.staffProfileId ?? systemActorId }),
      };
      const branchWhere =
        readScope === "ORGANIZATION"
          ? {}
          : readScope === "ASSIGNED_BRANCHES"
            ? { branchId: { in: [...access.assignedBranchIds] } }
            : { branchId: systemActorId };
      const [settings, jobs, predictions, evaluations, drift] = await Promise.all([
        transaction.predictiveCapabilitySetting.findMany({
          orderBy: { capability: "asc" },
          where: { organizationId: access.organizationId },
        }),
        transaction.predictiveJob.findMany({
          orderBy: { createdAt: "desc" },
          take: 25,
          where: {
            organizationId: access.organizationId,
            capability: { in: [...visibleCapabilities] },
            ...(readScope === "SELF" ? { actorUserId: access.actorUserId } : branchWhere),
          },
        }),
        transaction.prediction.findMany({
          include: {
            job: { select: { jobType: true, status: true } },
            modelDefinition: { select: { isActive: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 50,
          where: predictionWhere,
        }),
        transaction.predictiveEvaluationRun.findMany({
          orderBy: { createdAt: "desc" },
          take: 20,
          where: {
            organizationId: access.organizationId,
            ...branchWhere,
            job: { status: "COMPLETED" },
          },
        }),
        transaction.predictiveDriftRun.findMany({
          orderBy: { createdAt: "desc" },
          take: 20,
          where: {
            organizationId: access.organizationId,
            ...branchWhere,
            job: { status: "COMPLETED" },
          },
        }),
      ]);
      const settingsByCapability = new Map(
        settings.map((setting) => [setting.capability, setting]),
      );
      const appointmentIds = predictions.flatMap((prediction) => {
        const details = primitiveDetails(prediction.details);
        return typeof details.appointmentVersion === "number" && prediction.subjectId
          ? [prediction.subjectId]
          : [];
      });
      const currentAppointments = appointmentIds.length
        ? await transaction.appointment.findMany({
            select: { id: true, startsAt: true, version: true },
            where: { id: { in: appointmentIds }, organizationId: access.organizationId },
          })
        : [];
      const appointmentsById = new Map(
        currentAppointments.map((appointment) => [appointment.id, appointment]),
      );
      const now = new Date();
      const isCurrentPrediction = (prediction: (typeof predictions)[number]): boolean => {
        if (prediction.job?.status !== "COMPLETED") return false;
        if (prediction.expiresAt <= now) return false;
        if (prediction.status === "GENERATED" && !prediction.modelDefinition?.isActive)
          return false;
        if (
          !settingsByCapability.get(prediction.capability)?.enabled &&
          prediction.job?.jobType !== "DATA_AUDIT"
        ) {
          return false;
        }
        const details = primitiveDetails(prediction.details);
        if (typeof details.appointmentVersion !== "number") return true;
        if (!prediction.subjectId) return false;
        const appointment = appointmentsById.get(prediction.subjectId);
        if (!appointment || appointment.version !== details.appointmentVersion) return false;
        return (
          typeof details.scheduledStartsAt !== "string" ||
          appointment.startsAt.toISOString() === details.scheduledStartsAt
        );
      };
      return {
        capabilities: visibleCapabilities.map((capability) => {
          const setting = settingsByCapability.get(capability);
          return {
            capability,
            enabled: setting?.enabled ?? false,
            updatedAt: (setting?.updatedAt ?? new Date(0)).toISOString(),
            version: setting?.version ?? 1,
          };
        }),
        drift: drift
          .filter((row) => canReadAggregateEvidence(access, row))
          .filter((row) => canUnderlyingAccess(access, row.capability, row))
          .map((row) => ({
            capability: row.capability,
            createdAt: row.createdAt.toISOString(),
            id: row.id,
            sampleSize: row.sampleSize,
            score: row.score,
            status: row.status,
          })),
        evaluations: evaluations
          .filter((row) => canReadAggregateEvidence(access, row))
          .filter((row) => canUnderlyingAccess(access, row.capability, row))
          .map((row) => ({
            capability: row.capability,
            createdAt: row.createdAt.toISOString(),
            id: row.id,
            metrics: metricRecord(row.metrics),
            outcome: row.outcome,
            runType: row.runType,
            sampleSize: row.sampleSize,
          })),
        jobs: jobs.filter((row) => canUnderlyingAccess(access, row.capability, row)).map(mapJob),
        predictions: predictions
          .filter(isCurrentPrediction)
          .filter((row) => canReadPredictionEvidence(access, row))
          .filter((row) => canUnderlyingAccess(access, row.capability, row))
          .map((row) => mapPrediction(row, readScope === "SELF")),
      };
    });
  }

  async requestJob(
    selection: TenantAccessSelection,
    input: PredictiveJobRequest,
  ): Promise<PredictiveJobOverview & Readonly<{ reused: boolean }>> {
    const initialAccess = await this.loadAccess(selection, input.actorUserId);
    if (!predictiveCapabilities.includes(input.capability)) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Unknown predictive capability.",
      });
    }
    if (!/^[A-Za-z0-9:_-]{16,160}$/u.test(input.idempotencyKey)) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid idempotency key." });
    }
    const appointmentId = uuid(input.appointmentId, "Appointment");
    const requestedBranchId = uuid(input.branchId, "Branch");
    const serviceId = uuid(input.serviceId, "Service");
    const startsOn = localDate(input.startsOn, "Start date");
    const endsOn = localDate(input.endsOn, "End date");
    if (
      (startsOn && !endsOn) ||
      (!startsOn && endsOn) ||
      (startsOn && endsOn && endsOn < startsOn)
    ) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Predictive date range is invalid.",
      });
    }
    if (
      startsOn &&
      endsOn &&
      new Date(`${endsOn}T00:00:00Z`).getTime() - new Date(`${startsOn}T00:00:00Z`).getTime() >
        366 * 86_400_000
    ) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Predictive date range is too large.",
      });
    }
    return runInTenant(this.client, initialAccess, async (transaction) => {
      const access = await this.lockAndReloadForegroundAccess(transaction, initialAccess);
      const runScope = requireScope(access, "predictions.run");
      const appointment = appointmentId
        ? await transaction.appointment.findFirst({
            select: { branchId: true, providerId: true, serviceId: true },
            where: { id: appointmentId, organizationId: access.organizationId },
          })
        : null;
      if (appointmentId && !appointment) {
        throw new DomainError({ code: "NOT_FOUND", message: "Predictive target was not found." });
      }
      const branchId = appointment?.branchId ?? requestedBranchId;
      const providerId = appointment?.providerId;
      if (appointment && requestedBranchId && appointment.branchId !== requestedBranchId) {
        throw new DomainError({ code: "NOT_FOUND", message: "Predictive target was not found." });
      }
      requireResourceScope(access, "predictions.run", { branchId, providerId });
      requireUnderlyingAccess(access, input.capability, { branchId, providerId });
      if (runScope === "ASSIGNED_BRANCHES" && !branchId) {
        throw new DomainError({ code: "FORBIDDEN", message: "A permitted branch is required." });
      }
      if (branchId) {
        const branch = await transaction.branch.findFirst({
          select: { id: true },
          where: { id: branchId, isActive: true, organizationId: access.organizationId },
        });
        if (!branch) throw new DomainError({ code: "NOT_FOUND", message: "Branch not found." });
      }
      const resolvedServiceId = appointment?.serviceId ?? serviceId;
      if (resolvedServiceId) {
        const service = await transaction.service.findFirst({
          select: { id: true },
          where: { id: resolvedServiceId, isActive: true, organizationId: access.organizationId },
        });
        if (!service) throw new DomainError({ code: "NOT_FOUND", message: "Service not found." });
      }
      const setting = await transaction.predictiveCapabilitySetting.findUnique({
        where: {
          organizationId_capability: {
            capability: input.capability,
            organizationId: access.organizationId,
          },
        },
      });
      if (input.jobType !== "DATA_AUDIT" && !setting?.enabled) {
        throw new DomainError({ code: "FORBIDDEN", message: "Predictive capability is disabled." });
      }
      const parameters = {
        ...(startsOn ? { startsOn } : {}),
        ...(endsOn ? { endsOn } : {}),
      };
      const fingerprint = hash({
        appointmentId,
        branchId,
        capability: input.capability,
        jobType: input.jobType,
        parameters,
        serviceId: resolvedServiceId,
      });
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${access.organizationId}:predictive-job:${input.idempotencyKey}`}, 0))`;
      const prior = await transaction.predictiveJob.findUnique({
        where: {
          organizationId_idempotencyKey: {
            idempotencyKey: input.idempotencyKey,
            organizationId: access.organizationId,
          },
        },
      });
      if (prior) {
        if (prior.requestFingerprint !== fingerprint) {
          throw new DomainError({
            code: "IDEMPOTENCY_CONFLICT",
            message: "Idempotency key was reused with different predictive input.",
          });
        }
        return { ...mapJob(prior), reused: true };
      }
      const created = await transaction.predictiveJob.create({
        data: {
          actorUserId: access.actorUserId,
          appointmentId: appointmentId ?? null,
          branchId: branchId ?? null,
          capability: input.capability,
          idempotencyKey: input.idempotencyKey,
          jobType: input.jobType,
          membershipId: access.membershipId ?? null,
          organizationId: access.organizationId,
          parameters,
          requestFingerprint: fingerprint,
          serviceId: resolvedServiceId ?? null,
          supportAccessId: access.supportAccessId ?? null,
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: "PREDICTIVE_JOB_REQUESTED",
          actorUserId: access.actorUserId,
          metadata: { capability: input.capability, jobType: input.jobType },
          organizationId: access.organizationId,
          supportAccessId: access.supportAccessId ?? null,
          targetId: created.id,
          targetType: "PredictiveJob",
        },
      });
      return { ...mapJob(created), reused: false };
    });
  }

  async updateCapability(
    selection: TenantAccessSelection,
    input: PredictiveCapabilityUpdate,
  ): Promise<PredictiveCapabilityOverview> {
    const initialAccess = await this.loadAccess(selection, input.actorUserId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid capability version." });
    }
    return runInTenant(this.client, initialAccess, async (transaction) => {
      const access = await this.lockAndReloadForegroundAccess(transaction, initialAccess);
      if (requireScope(access, "predictions.configure") !== "ORGANIZATION") {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "Organization predictive configuration is required.",
        });
      }
      const current = await transaction.predictiveCapabilitySetting.findUnique({
        where: {
          organizationId_capability: {
            capability: input.capability,
            organizationId: access.organizationId,
          },
        },
      });
      if (!current) {
        throw new DomainError({
          code: "NOT_FOUND",
          message: "Predictive capability setting not found.",
        });
      }
      if (current.enabled === input.enabled) {
        return {
          capability: current.capability,
          enabled: current.enabled,
          updatedAt: current.updatedAt.toISOString(),
          version: current.version,
        };
      }
      const changed = await transaction.predictiveCapabilitySetting.updateMany({
        data: {
          enabled: input.enabled,
          updatedByUserId: access.actorUserId,
          version: { increment: 1 },
        },
        where: {
          capability: input.capability,
          organizationId: access.organizationId,
          version: input.expectedVersion,
        },
      });
      if (changed.count !== 1) {
        throw new DomainError({
          code: "CONFLICT",
          message: "Predictive configuration changed. Refresh and retry.",
        });
      }
      if (!input.enabled) {
        await transaction.predictiveJob.updateMany({
          data: { completedAt: new Date(), safeErrorCode: "CAPABILITY_DISABLED", status: "FAILED" },
          where: {
            capability: input.capability,
            organizationId: access.organizationId,
            status: { in: ["PENDING", "CLAIMED", "ENQUEUED"] },
          },
        });
      }
      const updated = await transaction.predictiveCapabilitySetting.findUniqueOrThrow({
        where: {
          organizationId_capability: {
            capability: input.capability,
            organizationId: access.organizationId,
          },
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: input.enabled
            ? "PREDICTIVE_CAPABILITY_ENABLED"
            : "PREDICTIVE_CAPABILITY_DISABLED",
          actorUserId: access.actorUserId,
          metadata: { capability: input.capability, version: updated.version },
          organizationId: access.organizationId,
          supportAccessId: access.supportAccessId ?? null,
          targetType: "PredictiveCapabilitySetting",
        },
      });
      return {
        capability: updated.capability,
        enabled: updated.enabled,
        updatedAt: updated.updatedAt.toISOString(),
        version: updated.version,
      };
    });
  }

  async recordFeedback(
    selection: TenantAccessSelection,
    input: PredictiveFeedbackInput,
  ): Promise<
    Readonly<{
      comment: string | null;
      createdAt: string;
      feedbackType: PredictionFeedbackType;
      id: string;
      predictionId: string;
    }>
  > {
    const initialAccess = await this.loadAccess(selection, input.actorUserId);
    const comment = input.comment?.trim() || null;
    if ((comment?.length ?? 0) > 500) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Feedback is too long." });
    }
    return runInTenant(this.client, initialAccess, async (transaction) => {
      const access = await this.lockAndReloadForegroundAccess(transaction, initialAccess);
      requireScope(access, "predictions.feedback");
      requireScope(access, "predictions.read");
      const prediction = await transaction.prediction.findFirst({
        where: { id: input.predictionId, organizationId: access.organizationId },
      });
      if (!prediction)
        throw new DomainError({ code: "NOT_FOUND", message: "Prediction not found." });
      requireEvidenceSourceCoverage(access, "predictions.feedback", prediction);
      requireEvidenceSourceCoverage(access, "predictions.read", prediction);
      requireUnderlyingAccess(access, prediction.capability, prediction);
      const existing = await transaction.predictiveFeedback.findFirst({
        where: {
          actorUserId: access.actorUserId,
          feedbackType: input.feedbackType,
          organizationId: access.organizationId,
          predictionId: prediction.id,
        },
      });
      const feedback =
        existing ??
        (await transaction.predictiveFeedback.create({
          data: {
            actorUserId: access.actorUserId,
            comment,
            feedbackType: input.feedbackType,
            organizationId: access.organizationId,
            predictionId: prediction.id,
          },
        }));
      if (!existing) {
        await transaction.auditEvent.create({
          data: {
            action: "PREDICTIVE_FEEDBACK_RECORDED",
            actorUserId: access.actorUserId,
            metadata: { feedbackType: input.feedbackType },
            organizationId: access.organizationId,
            supportAccessId: access.supportAccessId ?? null,
            targetId: feedback.id,
            targetType: "PredictiveFeedback",
          },
        });
      }
      return {
        comment: feedback.comment,
        createdAt: feedback.createdAt.toISOString(),
        feedbackType: feedback.feedbackType,
        id: feedback.id,
        predictionId: feedback.predictionId,
      };
    });
  }

  async claimPendingJobs(
    workerId: string,
    limit = 20,
  ): Promise<readonly Readonly<{ id: string; leaseToken: string; organizationId: string }>[]> {
    if (
      !workerId.trim() ||
      workerId.length > 120 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Invalid predictive worker claim.",
      });
    }
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_relay"');
      await transaction.$executeRaw`
        UPDATE "predictive_jobs"
        SET "status" = 'DEAD_LETTER',
            "completed_at" = GREATEST(statement_timestamp(), "created_at"),
            "safe_error_code" = 'MAX_ATTEMPTS_EXCEEDED',
            "updated_at" = GREATEST(statement_timestamp(), "created_at")
        WHERE "attempts" >= "max_attempts"
          AND (
            "status" = 'PENDING'
            OR ("status" = 'CLAIMED' AND "claimed_at" < statement_timestamp() - INTERVAL '2 minutes')
            OR ("status" = 'ENQUEUED' AND "enqueued_at" < statement_timestamp() - INTERVAL '5 minutes')
            OR ("status" = 'RUNNING' AND "started_at" < statement_timestamp() - INTERVAL '30 minutes')
          )
      `;
      return transaction.$queryRaw<
        Array<{ id: string; leaseToken: string; organizationId: string }>
      >(Prisma.sql`
        WITH candidate AS (
          SELECT "id" FROM "predictive_jobs"
          WHERE (
            "status" = 'PENDING'
            OR ("status" = 'CLAIMED' AND "claimed_at" < statement_timestamp() - INTERVAL '2 minutes')
            OR ("status" = 'ENQUEUED' AND "enqueued_at" < statement_timestamp() - INTERVAL '5 minutes')
            OR ("status" = 'RUNNING' AND "started_at" < statement_timestamp() - INTERVAL '30 minutes')
          )
          AND "attempts" < "max_attempts"
          ORDER BY "created_at"
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE "predictive_jobs" AS job
        SET "status" = 'CLAIMED', "claimed_at" = GREATEST(statement_timestamp(), job."created_at"),
            "claimed_by" = ${workerId},
            "lease_token" = CASE
              WHEN job."status" = 'CLAIMED' THEN COALESCE(job."lease_token", gen_random_uuid())
              ELSE gen_random_uuid()
            END,
            "updated_at" = GREATEST(statement_timestamp(), job."created_at")
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING job."id", job."lease_token" AS "leaseToken",
                  job."organization_id" AS "organizationId"
      `);
    });
  }

  async markJobEnqueued(jobId: string, leaseToken: string): Promise<void> {
    await this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_relay"');
      await transaction.$executeRaw`
        UPDATE "predictive_jobs"
        SET "enqueued_at" = GREATEST(statement_timestamp(), "created_at"),
            "status" = 'ENQUEUED',
            "updated_at" = GREATEST(statement_timestamp(), "created_at")
        WHERE "id" = ${jobId}::uuid
          AND "lease_token" = ${leaseToken}::uuid
          AND "status" = 'CLAIMED'
      `;
    });
  }

  async processJob(organizationId: string, jobId: string, leaseToken?: string): Promise<void> {
    const stored = await runInTenant(
      this.client,
      { actorUserId: systemActorId, organizationId },
      (transaction) =>
        transaction.predictiveJob.findFirst({ where: { id: jobId, organizationId } }),
    );
    if (!stored) throw new DomainError({ code: "NOT_FOUND", message: "Predictive job not found." });
    if (["COMPLETED", "DEAD_LETTER", "FAILED"].includes(stored.status)) return;
    if (leaseToken && stored.leaseToken !== leaseToken) {
      throw new DomainError({
        code: "CONFLICT",
        message: "The predictive job delivery has a stale processing lease.",
        metadata: { reason: "STALE_JOB_LEASE" },
        retryable: true,
      });
    }
    const processingLeaseToken = leaseToken ?? randomUUID();
    const selection: TenantAccessSelection = {
      activeOrganizationId: organizationId,
      ...(stored.membershipId ? { activeMembershipId: stored.membershipId } : {}),
      ...(stored.supportAccessId ? { activeSupportAccessId: stored.supportAccessId } : {}),
    };
    const access = await this.loadAccess(selection, stored.actorUserId);
    requireResourceScope(access, "predictions.run", { branchId: stored.branchId });
    requireUnderlyingAccess(access, stored.capability, { branchId: stored.branchId });
    const claimed = await runInTenant(this.client, access, async (transaction) => {
      const changed = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "predictive_jobs"
        SET "attempts" = "attempts" + 1,
            "lease_token" = ${processingLeaseToken}::uuid,
            "safe_error_code" = NULL,
            "evaluation_at" = COALESCE(
              "evaluation_at",
              GREATEST(statement_timestamp(), "created_at")
            ),
            "started_at" = GREATEST(statement_timestamp(), "created_at"),
            "status" = 'RUNNING',
            "updated_at" = GREATEST(statement_timestamp(), "created_at")
        WHERE "id" = ${jobId}::uuid
          AND "organization_id" = ${organizationId}::uuid
          ${leaseToken ? Prisma.sql`AND "lease_token" = ${leaseToken}::uuid` : Prisma.empty}
          AND (
            "status" IN ('PENDING', 'CLAIMED', 'ENQUEUED')
            OR (
              "status" = 'RUNNING'
              AND "started_at" < statement_timestamp() - INTERVAL '30 minutes'
            )
          )
        RETURNING "id"
      `);
      if (!changed[0]) {
        const current = await transaction.predictiveJob.findFirst({
          select: { status: true },
          where: { id: jobId, organizationId },
        });
        if (current?.status === "RUNNING") {
          throw new DomainError({
            code: "CONFLICT",
            message: "The predictive job already has an active processing lease.",
            metadata: { reason: "JOB_ALREADY_RUNNING" },
            retryable: true,
          });
        }
        return null;
      }
      return transaction.predictiveJob.findFirstOrThrow({ where: { id: jobId, organizationId } });
    });
    if (!claimed) return;
    if (claimed.attempts > 1) {
      if (await this.hasPersistedJobEvidence(access, claimed)) {
        throw new DomainError({
          code: "CONFLICT",
          message: "A partially persisted predictive job cannot append evidence on retry.",
          metadata: { reason: "PARTIAL_EVIDENCE_ON_RETRY" },
          retryable: false,
        });
      }
      const replayableAudit =
        claimed.jobType === "DATA_AUDIT" &&
        ["DEMAND_FORECAST", "NO_SHOW"].includes(claimed.capability);
      if (!replayableAudit) {
        throw new DomainError({
          code: "CONFLICT",
          message: "This predictive computation must be submitted as a new job after interruption.",
          metadata: { reason: "MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB" },
          retryable: false,
        });
      }
    }
    const enabled = await runInTenant(this.client, access, (transaction) =>
      transaction.predictiveCapabilitySetting.findUnique({
        where: {
          organizationId_capability: {
            capability: claimed.capability,
            organizationId,
          },
        },
      }),
    );
    let processedRows: number;
    const disabledRefusal = claimed.jobType !== "DATA_AUDIT" && !enabled?.enabled;
    if (disabledRefusal) {
      await this.createRefusal(access, claimed, "CAPABILITY_DISABLED", 1, 0);
      processedRows = 1;
    } else {
      processedRows = await this.executeJob(access, claimed);
    }
    const completionAccess = await this.reauthorizeJob(access, claimed, disabledRefusal);
    await runInTenant(this.client, completionAccess, async (transaction) => {
      await this.lockEvidenceAuthorization(transaction, completionAccess, claimed, disabledRefusal);
      const completed = await transaction.predictiveJob.updateMany({
        data: {
          completedAt: new Date(),
          processedRows,
          safeErrorCode: null,
          status: "COMPLETED",
          totalRows: processedRows,
        },
        where: {
          id: jobId,
          leaseToken: processingLeaseToken,
          organizationId,
          status: "RUNNING",
        },
      });
      if (completed.count === 1) {
        await transaction.auditEvent.create({
          data: {
            action: "PREDICTIVE_JOB_COMPLETED",
            actorUserId: completionAccess.actorUserId,
            metadata: { capability: claimed.capability, jobType: claimed.jobType },
            organizationId,
            supportAccessId: completionAccess.supportAccessId ?? null,
            targetId: jobId,
            targetType: "PredictiveJob",
          },
        });
      }
    });
  }

  private async executeJob(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
  ): Promise<number> {
    switch (job.jobType) {
      case "DATA_AUDIT":
        await this.persistDataAudit(access, job, true);
        return 1;
      case "FEATURE_COMPUTE": {
        const audit = await this.persistDataAudit(access, job, false);
        if (audit.eligible) {
          await this.ensureModelVersion(access, job, audit);
          await this.ensureFeatureSnapshot(access, job, {
            asOf: audit.dataWatermark,
            features: {
              counts: audit.counts,
              dataAuditId: audit.id,
              sampleSize: audit.sampleSize,
              warnings: audit.warnings,
            },
            subjectId: job.branchId,
            subjectType: job.branchId ? "BRANCH_AGGREGATE" : "ORGANIZATION_AGGREGATE",
          });
        } else {
          await this.createRefusal(
            access,
            job,
            audit.refusalReason ?? "INSUFFICIENT_SAMPLE",
            this.requiredFor(job.capability, audit.refusalReason),
            audit.sampleSize,
          );
        }
        return 1;
      }
      case "GENERATE":
        return this.generate(access, job);
      case "BACKTEST":
        return this.backtest(access, job);
      case "DRIFT":
        return this.drift(access, job);
    }
  }

  private hasPersistedJobEvidence(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
  ): Promise<boolean> {
    return runInTenant(this.client, access, async (transaction) => {
      const [audits, snapshots, predictions, evaluations, drift] = await Promise.all([
        transaction.predictiveDataAudit.count({
          where: { jobId: job.id, organizationId: access.organizationId },
        }),
        transaction.predictiveFeatureSnapshot.count({
          where: { jobId: job.id, organizationId: access.organizationId },
        }),
        transaction.prediction.count({
          where: { jobId: job.id, organizationId: access.organizationId },
        }),
        transaction.predictiveEvaluationRun.count({
          where: { jobId: job.id, organizationId: access.organizationId },
        }),
        transaction.predictiveDriftRun.count({
          where: { jobId: job.id, organizationId: access.organizationId },
        }),
      ]);
      return audits + snapshots + predictions + evaluations + drift > 0;
    });
  }

  private requiredFor(
    capability: PredictiveCapability,
    reason: PredictiveRefusalReason | null,
  ): number {
    if (capability === "NO_SHOW") {
      if (reason === "INSUFFICIENT_POSITIVES") return predictiveMinimums.NO_SHOW.noShows;
      if (reason === "INSUFFICIENT_HISTORY_SPAN") return predictiveMinimums.NO_SHOW.historyDays;
      return predictiveMinimums.NO_SHOW.resolvedAppointments;
    }
    if (capability === "DEMAND_FORECAST") {
      if (reason === "INSUFFICIENT_HISTORY_SPAN")
        return predictiveMinimums.DEMAND_FORECAST.historyDays;
      return predictiveMinimums.DEMAND_FORECAST.appointments;
    }
    return 1;
  }

  private async loadAttendanceHistory(
    transaction: TenantTransaction,
    organizationId: string,
    asOf: Date,
    branchId: string | null,
  ): Promise<
    Readonly<{
      capped: boolean;
      maturityWindowCapped: boolean;
      rows: readonly AttendanceEvidenceRow[];
      unverifiedDimensions: number;
      unknownMatured: number;
    }>
  > {
    const maturityCutoff = new Date(asOf.getTime() - 7 * 86_400_000);
    const unverifiedDimensions = await transaction.appointmentStatusHistory.count({
      where: {
        ...(branchId ? { branchSnapshotId: branchId } : {}),
        createdAt: { lt: asOf },
        dimensionSnapshotVerifiedAt: null,
        endsAt: { lte: maturityCutoff },
        eventType: "CREATED",
        organizationId,
        source: { not: "IMPORT" },
      },
    });
    const history: AttendanceEvidenceRow[] = [];
    let cursor: string | undefined;
    let capped = false;
    let maturityWindowCapped = false;
    let unknownMatured = 0;
    while (history.length < 5_000) {
      const page = await transaction.appointmentStatusHistory.findMany({
        ...(cursor ? { cursor: { id: cursor } } : {}),
        orderBy: [{ startsAt: "desc" }, { id: "desc" }],
        select: {
          appointment: {
            select: {
              history: {
                orderBy: [{ createdAt: "desc" }, { version: "desc" }, { id: "desc" }],
                select: {
                  createdAt: true,
                  dimensionSnapshotVerifiedAt: true,
                  eventType: true,
                  startsAt: true,
                  toStatus: true,
                },
                take: 50,
                where: {
                  createdAt: { lte: asOf },
                  dimensionSnapshotVerifiedAt: { lte: asOf, not: null },
                },
              },
            },
          },
          appointmentId: true,
          branchSnapshotId: true,
          createdAt: true,
          customerSnapshotId: true,
          dimensionSnapshotVerifiedAt: true,
          endsAt: true,
          id: true,
          providerSnapshotId: true,
          serviceSnapshotId: true,
          source: true,
          startsAt: true,
          timezoneSnapshot: true,
        },
        skip: cursor ? 1 : 0,
        take: 500,
        where: {
          ...(branchId ? { branchSnapshotId: branchId } : {}),
          createdAt: { lt: asOf },
          dimensionSnapshotVerifiedAt: { lte: asOf, not: null },
          endsAt: { lte: maturityCutoff },
          eventType: "CREATED",
          organizationId,
          source: { not: "IMPORT" },
        },
      });
      for (const created of page) {
        if (
          !created.branchSnapshotId ||
          !created.customerSnapshotId ||
          !created.dimensionSnapshotVerifiedAt ||
          !created.providerSnapshotId ||
          !created.serviceSnapshotId ||
          !created.timezoneSnapshot
        ) {
          continue;
        }
        if (created.appointment.history.some(({ eventType }) => eventType === "RESCHEDULED")) {
          continue;
        }
        const maturedAt = new Date(created.endsAt.getTime() + 7 * 86_400_000);
        const frozenHistory = created.appointment.history.filter(
          ({ createdAt }) => createdAt <= maturedAt,
        );
        const attended = frozenHistory
          .filter(({ toStatus }) => ["CHECKED_IN", "IN_PROGRESS", "COMPLETED"].includes(toStatus))
          .at(0);
        const noShow = frozenHistory.filter(({ toStatus }) => toStatus === "NO_SHOW").at(0);
        const resolved = attended ?? noShow;
        if (!resolved && created.appointment.history.length === 50) maturityWindowCapped = true;
        if (!resolved?.dimensionSnapshotVerifiedAt) {
          unknownMatured += 1;
          continue;
        }
        const local = localDateForInstant(created.startsAt, created.timezoneSnapshot);
        const parts = localDateTimePartsForInstant(created.startsAt, created.timezoneSnapshot);
        history.push({
          appointmentId: created.appointmentId,
          customerId: created.customerSnapshotId,
          dimensionVerifiedAt: created.dimensionSnapshotVerifiedAt.toISOString(),
          leadTimeDays: Math.max(
            0,
            (created.startsAt.getTime() - created.createdAt.getTime()) / 86_400_000,
          ),
          localDate: local,
          localHour: parts.hour,
          localWeekday: localWeekday(local),
          maturedAt: maturedAt.toISOString(),
          outcome: attended ? "ATTENDED" : "NO_SHOW",
          providerId: created.providerSnapshotId,
          recordedAt: created.createdAt.toISOString(),
          resolvedAt: resolved.createdAt.toISOString(),
          resolvedVerifiedAt: resolved.dimensionSnapshotVerifiedAt.toISOString(),
          scheduledAt: created.startsAt.toISOString(),
          serviceId: created.serviceSnapshotId,
          source: created.source,
        });
        if (history.length >= 5_000) {
          capped = true;
          break;
        }
      }
      if (page.length < 500 || capped) break;
      cursor = page.at(-1)?.id;
      if (!cursor) break;
    }
    return {
      capped,
      maturityWindowCapped,
      rows: history,
      unverifiedDimensions,
      unknownMatured,
    };
  }

  private async loadDemandHistory(
    transaction: TenantTransaction,
    organizationId: string,
    asOf: Date,
    branchId: string | null,
    serviceId: string | null,
  ): Promise<
    Readonly<{
      capped: boolean;
      densificationCapped: boolean;
      rows: readonly DemandHistoryBucket[];
      unverifiedDimensions: number;
    }>
  > {
    const startsAfter = new Date(asOf.getTime() - 730 * 86_400_000);
    const unverifiedDimensions = await transaction.appointmentStatusHistory.count({
      where: {
        ...(branchId ? { branchSnapshotId: branchId } : {}),
        createdAt: { lt: asOf },
        dimensionSnapshotVerifiedAt: null,
        eventType: "CREATED",
        organizationId,
        ...(serviceId ? { serviceSnapshotId: serviceId } : {}),
        source: { not: "IMPORT" },
        startsAt: { gte: startsAfter, lt: asOf },
      },
    });
    const buckets = new Map<string, DemandHistoryBucket>();
    let cursor: string | undefined;
    let seen = 0;
    let capped = false;
    while (seen < 5_000) {
      const page = await transaction.appointmentStatusHistory.findMany({
        ...(cursor ? { cursor: { id: cursor } } : {}),
        orderBy: [{ startsAt: "desc" }, { id: "desc" }],
        select: {
          branchSnapshotId: true,
          id: true,
          serviceSnapshotId: true,
          startsAt: true,
          timezoneSnapshot: true,
        },
        skip: cursor ? 1 : 0,
        take: 500,
        where: {
          ...(branchId ? { branchSnapshotId: branchId } : {}),
          createdAt: { lt: asOf },
          dimensionSnapshotVerifiedAt: { lte: asOf, not: null },
          eventType: "CREATED",
          organizationId,
          ...(serviceId ? { serviceSnapshotId: serviceId } : {}),
          source: { not: "IMPORT" },
          startsAt: { gte: startsAfter, lt: asOf },
        },
      });
      for (const created of page) {
        if (!created.branchSnapshotId || !created.serviceSnapshotId || !created.timezoneSnapshot) {
          continue;
        }
        const date = localDateForInstant(created.startsAt, created.timezoneSnapshot);
        const parts = localDateTimePartsForInstant(created.startsAt, created.timezoneSnapshot);
        const key = `${created.branchSnapshotId}:${created.serviceSnapshotId}:${date}:${parts.hour}`;
        const prior = buckets.get(key);
        buckets.set(key, {
          branchId: created.branchSnapshotId,
          count: (prior?.count ?? 0) + 1,
          localDate: date,
          localHour: parts.hour,
          localWeekday: localWeekday(date),
          serviceId: created.serviceSnapshotId,
        });
        seen += 1;
        if (seen >= 5_000) {
          capped = true;
          break;
        }
      }
      if (page.length < 500 || capped) break;
      cursor = page.at(-1)?.id;
      if (!cursor) break;
    }
    const observed = [...buckets.values()];
    if (observed.length === 0) {
      return { capped, densificationCapped: false, rows: [], unverifiedDimensions };
    }
    const series = new Map<
      string,
      Readonly<{
        firstDate: string;
        lastDate: string;
        sample: DemandHistoryBucket;
      }>
    >();
    for (const row of observed) {
      const key = `${row.branchId}:${row.serviceId}:${row.localWeekday}:${row.localHour}`;
      const prior = series.get(key);
      series.set(key, {
        firstDate: prior && prior.firstDate < row.localDate ? prior.firstDate : row.localDate,
        lastDate: prior && prior.lastDate > row.localDate ? prior.lastDate : row.localDate,
        sample: row,
      });
    }
    const dense = new Map(buckets);
    let densificationCapped = false;
    for (const { firstDate, lastDate, sample } of series.values()) {
      for (let date = firstDate; date <= lastDate; date = addLocalDays(date, 1)) {
        if (localWeekday(date) !== sample.localWeekday) continue;
        const key = `${sample.branchId}:${sample.serviceId}:${date}:${sample.localHour}`;
        if (!dense.has(key)) {
          dense.set(key, {
            branchId: sample.branchId,
            count: 0,
            localDate: date,
            localHour: sample.localHour,
            localWeekday: sample.localWeekday,
            serviceId: sample.serviceId,
          });
        }
        if (dense.size >= 50_000) {
          densificationCapped = true;
          break;
        }
      }
      if (densificationCapped) break;
    }
    return { capped, densificationCapped, rows: [...dense.values()], unverifiedDimensions };
  }

  private loadAuthorizedDemandHistory(
    transaction: TenantTransaction,
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    asOf: Date,
  ) {
    const runScope = requireScope(access, "predictions.run");
    return this.loadDemandHistory(
      transaction,
      access.organizationId,
      asOf,
      runScope === "ORGANIZATION" ? null : job.branchId,
      null,
    );
  }

  private async persistDataAudit(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    createRefusal: boolean,
  ) {
    const existing = await runInTenant(this.client, access, (transaction) =>
      transaction.predictiveDataAudit.findFirst({
        where: { jobId: job.id, organizationId: access.organizationId },
      }),
    );
    if (existing) {
      if (createRefusal && !existing.eligible) {
        await this.createRefusal(
          access,
          job,
          existing.refusalReason ?? "INSUFFICIENT_SAMPLE",
          this.requiredFor(job.capability, existing.refusalReason),
          existing.sampleSize,
        );
      }
      return existing;
    }
    const asOf = job.createdAt;
    const computed = await runInTenant(this.client, access, async (transaction) => {
      if (job.capability === "NO_SHOW") {
        const loaded = await this.loadAttendanceHistory(
          transaction,
          access.organizationId,
          asOf,
          job.branchId,
        );
        const noShows = loaded.rows.filter(({ outcome }) => outcome === "NO_SHOW").length;
        const attended = loaded.rows.length - noShows;
        const dates = loaded.rows.map(({ scheduledAt }) => new Date(scheduledAt).getTime());
        const historyDays =
          dates.length > 1 ? Math.floor((Math.max(...dates) - Math.min(...dates)) / 86_400_000) : 0;
        const activeWeeks = new Set(loaded.rows.map(({ localDate }) => calendarWeek(localDate)))
          .size;
        const reason: PredictiveRefusalReason | null =
          loaded.unverifiedDimensions > 0 || loaded.maturityWindowCapped
            ? "MODEL_DEGRADED"
            : loaded.rows.length < predictiveMinimums.NO_SHOW.resolvedAppointments
              ? "INSUFFICIENT_SAMPLE"
              : noShows < predictiveMinimums.NO_SHOW.noShows
                ? "INSUFFICIENT_POSITIVES"
                : attended < predictiveMinimums.NO_SHOW.attended
                  ? "INSUFFICIENT_SAMPLE"
                  : activeWeeks < predictiveMinimums.NO_SHOW.activeWeeks ||
                      historyDays < predictiveMinimums.NO_SHOW.historyDays
                    ? "INSUFFICIENT_HISTORY_SPAN"
                    : null;
        return {
          counts: {
            activeWeeks,
            attended,
            historyDays,
            noShows,
            resolved: loaded.rows.length,
            unverifiedDimensions: loaded.unverifiedDimensions,
            unknownMatured: loaded.unknownMatured,
          },
          eligible: reason === null,
          historyEndsAt: dates.length ? new Date(Math.max(...dates)) : null,
          historyStartsAt: dates.length ? new Date(Math.min(...dates)) : null,
          refusalReason: reason,
          sampleSize: loaded.rows.length,
          warnings: [
            ...(loaded.capped ? ["HISTORY_CAPPED_AT_5000"] : []),
            ...(loaded.maturityWindowCapped ? ["MATURITY_STATUS_WINDOW_CAPPED"] : []),
            ...(loaded.unverifiedDimensions > 0
              ? ["UNVERIFIED_HISTORICAL_DIMENSIONS_EXCLUDED"]
              : []),
            ...(loaded.unknownMatured > 0 ? ["MATURED_UNKNOWN_OUTCOMES_EXCLUDED"] : []),
            "PROTECTED_ATTRIBUTES_EXCLUDED",
            "IMPORTED_ROWS_EXCLUDED",
            "RESCHEDULED_ROWS_EXCLUDED",
          ],
        };
      }
      if (job.capability === "DEMAND_FORECAST") {
        const loaded = await this.loadAuthorizedDemandHistory(transaction, access, job, asOf);
        const outcome = forecastDemand(loaded.rows, []);
        const dates = loaded.rows.map(({ localDate }) =>
          new Date(`${localDate}T00:00:00Z`).getTime(),
        );
        const total = loaded.rows.reduce((sum, bucket) => sum + bucket.count, 0);
        const reliableOutcome =
          !loaded.densificationCapped &&
          loaded.unverifiedDimensions === 0 &&
          !isAggregateDemandRefusal(outcome);
        return {
          counts: {
            appointments: total,
            buckets: loaded.rows.length,
            nonZeroWeeks: new Set(loaded.rows.map(({ localDate }) => calendarWeek(localDate))).size,
            unverifiedDimensions: loaded.unverifiedDimensions,
          },
          eligible: reliableOutcome,
          historyEndsAt: dates.length ? new Date(Math.max(...dates)) : null,
          historyStartsAt: dates.length ? new Date(Math.min(...dates)) : null,
          refusalReason:
            loaded.densificationCapped || loaded.unverifiedDimensions > 0
              ? ("MODEL_DEGRADED" as const)
              : isAggregateDemandRefusal(outcome)
                ? outcome.reason
                : null,
          sampleSize: total,
          warnings: [
            ...(loaded.capped ? ["HISTORY_CAPPED_AT_5000"] : []),
            ...(loaded.densificationCapped ? ["ZERO_BUCKET_DENSIFICATION_CAPPED"] : []),
            ...(loaded.unverifiedDimensions > 0
              ? ["UNVERIFIED_HISTORICAL_DIMENSIONS_EXCLUDED"]
              : []),
            "BOOKED_DEMAND_ONLY",
            "UNSERVED_AVAILABILITY_SEARCHES_NOT_STORED",
          ],
        };
      }
      const [branchHours, availability, services, eligibleStaff, resources] = await Promise.all([
        transaction.branchHoursRule.count({
          where: {
            ...(job.branchId ? { branchId: job.branchId } : {}),
            organizationId: access.organizationId,
          },
        }),
        transaction.availabilityRule.count({
          where: {
            ...(job.branchId ? { branchId: job.branchId } : {}),
            organizationId: access.organizationId,
          },
        }),
        transaction.serviceBranch.count({
          where: {
            ...(job.branchId ? { branchId: job.branchId } : {}),
            isEnabled: true,
            organizationId: access.organizationId,
          },
        }),
        transaction.staffService.count({
          where: { isEnabled: true, organizationId: access.organizationId },
        }),
        transaction.resource.count({
          where: {
            ...(job.branchId ? { branchId: job.branchId } : {}),
            organizationId: access.organizationId,
            status: "ACTIVE",
          },
        }),
      ]);
      const sampleSize = branchHours + availability + services + eligibleStaff + resources;
      const eligible = branchHours > 0 && availability > 0 && services > 0 && eligibleStaff > 0;
      return {
        counts: { availability, branchHours, eligibleStaff, resources, services },
        eligible,
        historyEndsAt: null,
        historyStartsAt: null,
        refusalReason: eligible ? null : ("MISSING_SCHEDULE_CONFIGURATION" as const),
        sampleSize,
        warnings: ["HISTORICAL_SCHEDULE_CONFIGURATION_UNAVAILABLE"],
      };
    });
    const checksum = hash({ ...computed, asOf: asOf.toISOString(), capability: job.capability });
    const currentAccess = await this.reauthorizeJob(access, job);
    const created = await runInTenant(this.client, currentAccess, async (transaction) => {
      await this.lockEvidenceAuthorization(transaction, currentAccess, job);
      return transaction.predictiveDataAudit.create({
        data: {
          auditChecksum: checksum,
          branchId: job.branchId,
          capability: job.capability,
          counts: inputJson(computed.counts),
          dataWatermark: asOf,
          eligible: computed.eligible,
          historyEndsAt: computed.historyEndsAt,
          historyStartsAt: computed.historyStartsAt,
          jobId: job.id,
          organizationId: access.organizationId,
          refusalReason: computed.refusalReason,
          sampleSize: computed.sampleSize,
          warnings: computed.warnings,
        },
      });
    });
    if (createRefusal && !created.eligible) {
      await this.createRefusal(
        access,
        job,
        created.refusalReason ?? "INSUFFICIENT_SAMPLE",
        this.requiredFor(job.capability, created.refusalReason),
        created.sampleSize,
      );
    }
    return created;
  }

  private async createRefusal(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    reason: PredictiveRefusalReason,
    required: number,
    sampleSize: number,
    evidence?: Readonly<{
      asOf?: Date | undefined;
      branchId?: string | null | undefined;
      details?: Readonly<Record<string, boolean | null | number | string>> | undefined;
      generationSubject?: unknown;
      providerId?: string | null | undefined;
      serviceId?: string | null | undefined;
      subjectId?: string | null | undefined;
      subjectType?: string | undefined;
    }>,
  ) {
    const asOf = evidence?.asOf ?? job.createdAt;
    const currentAccess = await this.reauthorizeJob(access, job, reason === "CAPABILITY_DISABLED");
    const defaultSourceScope = authorizedAggregateSourceScope(
      currentAccess,
      job.capability,
      evidence?.branchId ?? job.branchId,
    );
    const context = await runInTenant(this.client, currentAccess, (transaction) =>
      job.appointmentId
        ? transaction.appointment.findFirst({
            select: { providerId: true },
            where: { id: job.appointmentId, organizationId: access.organizationId },
          })
        : Promise.resolve(null),
    );
    const generationKey = hash({
      capability: job.capability,
      jobId: job.id,
      reason,
      ...(evidence?.generationSubject === undefined
        ? {}
        : { generationSubject: evidence.generationSubject }),
      subjectId: evidence?.subjectId ?? job.appointmentId,
      subjectType: evidence?.subjectType,
    });
    return runInTenant(this.client, currentAccess, async (transaction) => {
      await this.lockEvidenceAuthorization(
        transaction,
        currentAccess,
        job,
        reason === "CAPABILITY_DISABLED",
      );
      const existing = await transaction.prediction.findUnique({
        where: {
          organizationId_generationKey: { generationKey, organizationId: access.organizationId },
        },
      });
      if (existing) return existing;
      return transaction.prediction.create({
        data: {
          asOf,
          branchId: evidence?.branchId ?? job.branchId,
          capability: job.capability,
          details: {
            advisory: true,
            algorithmVersion: predictiveAlgorithmVersions[job.capability],
            asOf: asOf.toISOString(),
            available: sampleSize,
            required,
            version: 1,
            ...(defaultSourceScope ? { sourceScope: defaultSourceScope } : {}),
            ...(evidence?.details ?? {}),
          },
          estimate: null,
          expiresAt: new Date(asOf.getTime() + 15 * 60_000),
          explanation: [],
          generationKey,
          jobId: job.id,
          lowerBound: null,
          modelIdentifier: predictiveAlgorithmVersions[job.capability],
          modelVersion: 1,
          organizationId: access.organizationId,
          providerId: evidence?.providerId ?? context?.providerId ?? null,
          refusalReason: reason,
          sampleSize,
          serviceId: evidence?.serviceId ?? job.serviceId,
          status: "REFUSED",
          subjectId: evidence?.subjectId ?? job.appointmentId,
          subjectType: evidence?.subjectType ?? (job.appointmentId ? "APPOINTMENT" : "CAPABILITY"),
          upperBound: null,
        },
      });
    });
  }

  private async ensureModelVersion(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    audit: Readonly<{
      dataWatermark: Date;
      historyEndsAt: Date | null;
      historyStartsAt: Date | null;
      sampleSize: number;
    }>,
  ) {
    const currentAccess = await this.reauthorizeJob(access, job);
    const capability = job.capability;
    return runInTenant(this.client, currentAccess, async (transaction) => {
      await this.lockEvidenceAuthorization(transaction, currentAccess, job);
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${access.organizationId}:${capability}:model`}, 0))`;
      const parameters = {
        deterministic: true,
        featureDefinitionVersion: 1,
        labelDefinitionVersion: 1,
        minimums:
          capability === "NO_SHOW"
            ? predictiveMinimums.NO_SHOW
            : capability === "DEMAND_FORECAST"
              ? predictiveMinimums.DEMAND_FORECAST
              : { validConfigurationRequired: true },
        tenantPooling: false,
      };
      const checksum = hash({
        algorithm: predictiveAlgorithmVersions[capability],
        capability,
        parameters,
      });
      const active = await transaction.predictiveModelVersion.findFirst({
        where: { capability, isActive: true, organizationId: access.organizationId },
      });
      if (
        active?.algorithmIdentifier === predictiveAlgorithmVersions[capability] &&
        active.checksum === checksum
      ) {
        return active;
      }
      const prior = await transaction.predictiveModelVersion.findFirst({
        where: { checksum, organizationId: access.organizationId },
      });
      if (active) {
        await transaction.predictiveModelVersion.update({
          data: { isActive: false },
          where: { id: active.id },
        });
      }
      if (prior) {
        return transaction.predictiveModelVersion.update({
          data: { isActive: true },
          where: { id: prior.id },
        });
      }
      const latest = await transaction.predictiveModelVersion.aggregate({
        _max: { version: true },
        where: { capability, organizationId: access.organizationId },
      });
      return transaction.predictiveModelVersion.create({
        data: {
          algorithmIdentifier: predictiveAlgorithmVersions[capability],
          capability,
          checksum,
          dataWatermark: audit.dataWatermark,
          featureDefinitionVersion: 1,
          isActive: true,
          labelDefinitionVersion: 1,
          organizationId: access.organizationId,
          parameters: inputJson(parameters),
          sampleSize: audit.sampleSize,
          trainingEndsAt: audit.historyEndsAt,
          trainingStartsAt: audit.historyStartsAt,
          version: (latest._max.version ?? 0) + 1,
        },
      });
    });
  }

  private async demandPlanningContext(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    configurationReadAt: Date,
    requestedScope?: Readonly<{ branchId: string; serviceId: string }> | undefined,
  ): Promise<DemandPlanningContext | null> {
    const branchId = requestedScope?.branchId ?? job.branchId;
    const serviceId = requestedScope?.serviceId ?? job.serviceId;
    if (!branchId || !serviceId) return null;
    return runInTenant(this.client, access, async (transaction) => {
      const branch = await transaction.branch.findFirst({
        include: { hoursRules: true },
        where: { id: branchId, isActive: true, organizationId: access.organizationId },
      });
      const serviceBranch = await transaction.serviceBranch.findFirst({
        include: { service: { select: { defaultDurationMins: true, isActive: true } } },
        where: {
          branchId,
          isEnabled: true,
          organizationId: access.organizationId,
          serviceId,
        },
      });
      if (!branch || !serviceBranch || !serviceBranch.service.isActive) return null;
      const today = localDateForInstant(configurationReadAt, branch.timezone);
      const requestedStartsOn =
        stringParameter(job.parameters, "startsOn") ?? addLocalDays(today, 1);
      const startsOn = requestedStartsOn < today ? today : requestedStartsOn;
      const requestedEndsOn =
        stringParameter(job.parameters, "endsOn") ?? addLocalDays(startsOn, 6);
      if (requestedEndsOn < startsOn) return null;
      const endsOn =
        requestedEndsOn > addLocalDays(startsOn, 30) ? addLocalDays(startsOn, 30) : requestedEndsOn;
      const events = await transaction.operationalCalendarEvent.findMany({
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        where: {
          branchId,
          isActive: true,
          localDate: {
            gte: new Date(`${startsOn}T00:00:00Z`),
            lte: new Date(`${endsOn}T00:00:00Z`),
          },
          organizationId: access.organizationId,
        },
      });
      const organizationEvents = await transaction.operationalCalendarEvent.findMany({
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        where: {
          branchId: null,
          isActive: true,
          localDate: {
            gte: new Date(`${startsOn}T00:00:00Z`),
            lte: new Date(`${endsOn}T00:00:00Z`),
          },
          organizationId: access.organizationId,
        },
      });
      const targets: DemandTargetBucket[] = [];
      for (let date = startsOn; date <= endsOn; date = addLocalDays(date, 1)) {
        const dayEvents = [
          ...events.filter((event) => dateOnly(event.localDate) === date),
          ...organizationEvents.filter((event) => dateOnly(event.localDate) === date),
        ];
        if (dayEvents.some(({ eventType }) => eventType === "CLOSURE")) continue;
        const calendar = dayEvents[0];
        const rules = branch.hoursRules.filter(
          (rule) =>
            weekdayNumber(rule.weekday) === localWeekday(date) &&
            (!rule.effectiveFrom || dateOnly(rule.effectiveFrom) <= date) &&
            (!rule.effectiveUntil || dateOnly(rule.effectiveUntil) >= date),
        );
        const hours = new Set<number>();
        for (const rule of rules) {
          const firstHour = Math.ceil(rule.startMinuteLocal / 60);
          const lastMinute = rule.endMinuteLocal;
          for (let hour = firstHour; hour * 60 < lastMinute; hour += 1) hours.add(hour);
        }
        for (const hour of [...hours].toSorted((left, right) => left - right)) {
          let bucketStart: Date;
          try {
            bucketStart = localDateTimeToUtc(
              `${date}T${hour.toString().padStart(2, "0")}:00`,
              branch.timezone,
            );
          } catch (error) {
            if (error instanceof DomainError && error.code === "VALIDATION_FAILED") continue;
            throw error;
          }
          if (bucketStart.getTime() + 60 * 60_000 <= configurationReadAt.getTime()) continue;
          targets.push({
            branchId: branch.id,
            ...(calendar?.demandAdjustment === null || calendar?.demandAdjustment === undefined
              ? {}
              : { calendarAdjustment: calendar.demandAdjustment }),
            isHoliday: calendar?.eventType === "HOLIDAY",
            localDate: date,
            localHour: hour,
            localWeekday: localWeekday(date),
            serviceId: serviceBranch.serviceId,
          });
        }
      }
      return {
        branchId: branch.id,
        durationMinutes: serviceBranch.durationMins ?? serviceBranch.service.defaultDurationMins,
        endsOn,
        serviceId: serviceBranch.serviceId,
        startsOn,
        targets,
        timezone: branch.timezone,
      };
    });
  }

  private async demandGenerationScope(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    configurationReadAt: Date,
  ): Promise<DemandGenerationScope> {
    const organizationRequest = !job.branchId && !job.serviceId;
    if (job.branchId && job.serviceId) {
      const plan = await this.demandPlanningContext(access, job, configurationReadAt);
      return {
        organizationRequest: false,
        organizationTimezone: null,
        plans: plan ? [plan] : [],
        truncated: false,
      };
    }
    const configuration = await runInTenant(this.client, access, async (transaction) => {
      const [settings, serviceBranches] = await Promise.all([
        transaction.organizationSettings.findUnique({
          select: { timezone: true },
          where: { organizationId: access.organizationId },
        }),
        transaction.serviceBranch.findMany({
          orderBy: [{ branchId: "asc" }, { serviceId: "asc" }],
          select: { branchId: true, serviceId: true },
          take: predictiveDemandConfigurationLimit + 1,
          where: {
            ...(job.branchId ? { branchId: job.branchId } : {}),
            ...(job.serviceId ? { serviceId: job.serviceId } : {}),
            branch: { is: { isActive: true } },
            isEnabled: true,
            organizationId: access.organizationId,
            service: { is: { isActive: true } },
          },
        }),
      ]);
      return { serviceBranches, timezone: settings?.timezone ?? null };
    });
    const bounded = configuration.serviceBranches.slice(0, predictiveDemandConfigurationLimit);
    const plans = (
      await Promise.all(
        bounded.map((scope) => this.demandPlanningContext(access, job, configurationReadAt, scope)),
      )
    ).flatMap((plan) => (plan ? [plan] : []));
    return {
      organizationRequest,
      organizationTimezone: configuration.timezone,
      plans,
      truncated: configuration.serviceBranches.length > bounded.length,
    };
  }

  private async ensureFeatureSnapshot(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    input: Readonly<{
      asOf: Date;
      features: unknown;
      subjectId: string | null;
      subjectType: string;
    }>,
  ) {
    const featureHash = hash({
      asOf: input.asOf.toISOString(),
      capability: job.capability,
      features: input.features,
      jobId: job.id,
      subjectId: input.subjectId,
      subjectType: input.subjectType,
    });
    const currentAccess = await this.reauthorizeJob(access, job);
    return runInTenant(this.client, currentAccess, async (transaction) => {
      await this.lockEvidenceAuthorization(transaction, currentAccess, job);
      const existing = await transaction.predictiveFeatureSnapshot.findUnique({
        where: {
          organizationId_featureHash: { featureHash, organizationId: access.organizationId },
        },
      });
      if (existing) return existing;
      return transaction.predictiveFeatureSnapshot.create({
        data: {
          asOf: input.asOf,
          capability: job.capability,
          featureHash,
          features: inputJson(input.features),
          jobId: job.id,
          organizationId: access.organizationId,
          sourceWatermark: input.asOf,
          subjectId: input.subjectId,
          subjectType: input.subjectType,
        },
      });
    });
  }

  private async persistGeneratedPrediction(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
    input: GeneratedPredictionInput,
  ) {
    const generationKey = hash({
      capability: job.capability,
      jobId: job.id,
      subject: input.generationSubject,
    });
    const currentAccess = await this.reauthorizeJob(access, job);
    return runInTenant(this.client, currentAccess, async (transaction) => {
      await this.lockEvidenceAuthorization(transaction, currentAccess, job);
      const existing = await transaction.prediction.findUnique({
        where: {
          organizationId_generationKey: { generationKey, organizationId: access.organizationId },
        },
      });
      if (existing) return existing;
      return transaction.prediction.create({
        data: {
          asOf: input.asOf,
          branchId: input.branchId,
          capability: job.capability,
          details: inputJson(input.details),
          estimate: input.estimate,
          expiresAt: input.expiresAt,
          explanation: inputJson(input.explanation),
          featureSnapshotId: input.featureSnapshotId,
          generationKey,
          horizonEndsAt: input.horizonEndsAt,
          horizonStartsAt: input.horizonStartsAt,
          jobId: job.id,
          lowerBound: input.lowerBound,
          modelIdentifier: input.modelIdentifier,
          modelVersion: input.modelVersion,
          modelVersionId: input.modelVersionId,
          organizationId: access.organizationId,
          providerId: input.providerId,
          refusalReason: null,
          sampleSize: input.sampleSize,
          serviceId: input.serviceId,
          status: "GENERATED",
          subjectId: input.subjectId,
          subjectType: input.subjectType,
          upperBound: input.upperBound,
        },
      });
    });
  }

  private async generate(access: TenantAccessSnapshot, job: StoredPredictiveJob): Promise<number> {
    switch (job.capability) {
      case "NO_SHOW":
        return this.generateNoShow(access, job);
      case "DEMAND_FORECAST":
        return this.generateDemand(access, job);
      case "STAFFING":
        return this.generateStaffing(access, job);
      case "SCHEDULE_REFLOW":
        return this.generateReflow(access, job);
      case "SERVICE_PROVIDER_RECOMMENDATION":
        return this.generateRecommendations(access, job);
    }
  }

  private async generateNoShow(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
  ): Promise<number> {
    const executionTime = job.createdAt;
    const targets = await runInTenant(this.client, access, (transaction) =>
      transaction.appointment.findMany({
        orderBy: { id: "asc" },
        select: {
          history: {
            orderBy: [{ createdAt: "desc" }, { version: "desc" }, { id: "desc" }],
            select: {
              branchSnapshotId: true,
              customerSnapshotId: true,
              dimensionSnapshotVerifiedAt: true,
              endsAt: true,
              providerSnapshotId: true,
              serviceSnapshotId: true,
              source: true,
              startsAt: true,
              timezoneSnapshot: true,
              toStatus: true,
              version: true,
            },
            take: 1,
            where: {
              createdAt: { lte: job.createdAt },
              dimensionSnapshotVerifiedAt: { lte: job.createdAt, not: null },
            },
          },
          id: true,
        },
        take: job.appointmentId ? 1 : 500,
        where: {
          ...(job.appointmentId ? { id: job.appointmentId } : {}),
          createdAt: { lte: job.createdAt },
          organizationId: access.organizationId,
        },
      }),
    );
    const eligibleTargets = targets
      .flatMap((appointment) => {
        const snapshot = appointment.history[0];
        if (
          !snapshot ||
          !snapshot.branchSnapshotId ||
          !snapshot.customerSnapshotId ||
          !snapshot.dimensionSnapshotVerifiedAt ||
          !snapshot.providerSnapshotId ||
          !snapshot.serviceSnapshotId ||
          !snapshot.timezoneSnapshot ||
          snapshot.startsAt <= job.createdAt ||
          (job.branchId !== null && snapshot.branchSnapshotId !== job.branchId) ||
          !["PENDING", "CONFIRMED"].includes(snapshot.toStatus)
        ) {
          return [];
        }
        return [
          {
            ...appointment,
            snapshot: {
              ...snapshot,
              branchSnapshotId: snapshot.branchSnapshotId,
              customerSnapshotId: snapshot.customerSnapshotId,
              providerSnapshotId: snapshot.providerSnapshotId,
              serviceSnapshotId: snapshot.serviceSnapshotId,
              timezoneSnapshot: snapshot.timezoneSnapshot,
            },
          },
        ];
      })
      .toSorted(
        (left, right) =>
          left.snapshot.startsAt.getTime() - right.snapshot.startsAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, 100);
    if (eligibleTargets.length === 0) {
      await this.createRefusal(access, job, "NO_ELIGIBLE_TARGET", 1, 0);
      return 1;
    }
    const audit = await this.persistDataAudit(access, job, false);
    if (!audit.eligible) {
      await this.createRefusal(
        access,
        job,
        audit.refusalReason ?? "INSUFFICIENT_SAMPLE",
        this.requiredFor(job.capability, audit.refusalReason),
        audit.sampleSize,
      );
      return 1;
    }
    const model = await this.ensureModelVersion(access, job, audit);
    const history = await runInTenant(this.client, access, (transaction) =>
      this.loadAttendanceHistory(transaction, access.organizationId, executionTime, job.branchId),
    );
    let persisted = 0;
    for (const appointment of eligibleTargets) {
      const predictionTime = job.createdAt;
      const parts = localDateTimePartsForInstant(
        appointment.snapshot.startsAt,
        appointment.snapshot.timezoneSnapshot,
      );
      const target: NoShowTarget = {
        appointmentId: appointment.id,
        customerId: appointment.snapshot.customerSnapshotId,
        leadTimeDays: Math.max(
          0,
          (appointment.snapshot.startsAt.getTime() - job.createdAt.getTime()) / 86_400_000,
        ),
        localHour: parts.hour,
        localWeekday: localWeekday(
          localDateForInstant(appointment.snapshot.startsAt, appointment.snapshot.timezoneSnapshot),
        ),
        predictedAt: predictionTime.toISOString(),
        providerId: appointment.snapshot.providerSnapshotId,
        serviceId: appointment.snapshot.serviceSnapshotId,
        source: appointment.snapshot.source,
      };
      const result = predictNoShow(history.rows, target);
      if (result.status === "REFUSED") {
        await this.createRefusal(access, job, result.reason, result.required, result.sampleSize, {
          asOf: predictionTime,
          branchId: appointment.snapshot.branchSnapshotId,
          providerId: appointment.snapshot.providerSnapshotId,
          serviceId: appointment.snapshot.serviceSnapshotId,
          subjectId: appointment.id,
          subjectType: "APPOINTMENT",
        });
        persisted += 1;
        continue;
      }
      const snapshot = await this.ensureFeatureSnapshot(access, job, {
        asOf: predictionTime,
        features: {
          baselineProbability: result.baselineProbability,
          factors: result.factors,
          horizon: "REQUEST_AS_OF",
          target: {
            leadTimeDays: target.leadTimeDays,
            localHour: target.localHour,
            localWeekday: target.localWeekday,
            source: target.source,
          },
        },
        subjectId: appointment.id,
        subjectType: "APPOINTMENT",
      });
      await this.persistGeneratedPrediction(access, job, {
        asOf: predictionTime,
        branchId: appointment.snapshot.branchSnapshotId,
        details: {
          advisory: true,
          automaticDenialAllowed: false,
          baselineProbability: result.baselineProbability,
          horizon: "REQUEST_AS_OF",
          appointmentVersion: appointment.snapshot.version,
          protectedAttributesExcluded: true,
          scheduledStartsAt: appointment.snapshot.startsAt.toISOString(),
          timezone: appointment.snapshot.timezoneSnapshot,
        },
        estimate: result.probability,
        explanation: result.factors,
        expiresAt: appointment.snapshot.startsAt,
        featureSnapshotId: snapshot.id,
        generationSubject: { appointmentId: appointment.id, horizon: "REQUEST_AS_OF" },
        horizonEndsAt: appointment.snapshot.endsAt,
        horizonStartsAt: predictionTime,
        lowerBound: null,
        modelIdentifier: model.algorithmIdentifier,
        modelVersion: model.version,
        modelVersionId: model.id,
        providerId: appointment.snapshot.providerSnapshotId,
        sampleSize: result.sampleSize,
        serviceId: appointment.snapshot.serviceSnapshotId,
        subjectId: appointment.id,
        subjectType: "APPOINTMENT",
        upperBound: null,
      });
      persisted += 1;
    }
    return persisted;
  }

  private async generateDemand(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
  ): Promise<number> {
    const configurationReadAt = job.evaluationAt ?? job.createdAt;
    const historyCutoff = job.createdAt;
    const authorizedHistoryScope: PredictiveEvidenceSourceScope =
      requireScope(access, "predictions.run") === "ORGANIZATION" ? "ORGANIZATION" : "BRANCH";
    const provenance = {
      configurationReadAt: configurationReadAt.toISOString(),
      historyCutoff: historyCutoff.toISOString(),
      sourceScope: authorizedHistoryScope,
    };
    const scope = await this.demandGenerationScope(access, job, configurationReadAt);
    const branchCount = new Set(scope.plans.map(({ branchId }) => branchId)).size;
    const serviceCount = new Set(scope.plans.map(({ serviceId }) => serviceId)).size;
    const componentTargetCount = scope.plans.reduce((sum, plan) => sum + plan.targets.length, 0);
    const refuseRequest = async (
      reason: PredictiveRefusalReason,
      required: number,
      sampleSize: number,
      details: Readonly<Record<string, boolean | null | number | string>> = {},
    ): Promise<number> => {
      await this.createRefusal(access, job, reason, required, sampleSize, {
        asOf: configurationReadAt,
        ...(scope.organizationRequest
          ? {
              branchId: null,
              generationSubject: { scope: "ORGANIZATION" },
              serviceId: null,
              subjectId: null,
              subjectType: "ORGANIZATION_DEMAND_BUCKET",
            }
          : {}),
        details: {
          ...provenance,
          ...(scope.organizationRequest
            ? {
                aggregationMethod: "SUM_BRANCH_SERVICE_BASELINES_V1",
                branchCount,
                complete: false,
                componentCount: scope.plans.length,
                scope: "ORGANIZATION",
                serviceCount,
                targetCount: componentTargetCount,
                timezone: scope.organizationTimezone,
              }
            : {}),
          ...details,
        },
      });
      return 1;
    };
    if (scope.truncated) {
      return refuseRequest(
        "MODEL_DEGRADED",
        predictiveDemandConfigurationLimit,
        scope.plans.length,
        { configurationLimit: predictiveDemandConfigurationLimit },
      );
    }
    if (
      scope.plans.length === 0 ||
      componentTargetCount === 0 ||
      (scope.organizationRequest && !scope.organizationTimezone)
    ) {
      return refuseRequest("MISSING_SCHEDULE_CONFIGURATION", 1, 0);
    }
    if (componentTargetCount > predictiveDemandTargetLimit) {
      return refuseRequest("MODEL_DEGRADED", predictiveDemandTargetLimit, componentTargetCount, {
        targetLimit: predictiveDemandTargetLimit,
      });
    }
    const audit = await this.persistDataAudit(access, job, false);
    if (!audit.eligible) {
      return refuseRequest(
        audit.refusalReason ?? "INSUFFICIENT_SAMPLE",
        this.requiredFor(job.capability, audit.refusalReason),
        audit.sampleSize,
      );
    }
    const history = await runInTenant(this.client, access, (transaction) =>
      this.loadAuthorizedDemandHistory(transaction, access, job, historyCutoff),
    );
    if (history.densificationCapped) {
      return refuseRequest("MODEL_DEGRADED", 1, history.rows.length);
    }
    type ComponentOutcome = Readonly<{
      endsAt: Date;
      plan: DemandPlanningContext;
      result: DemandBucketRefusal | DemandForecast;
      startsAt: Date;
    }>;
    const outcomes: ComponentOutcome[] = [];
    for (const plan of scope.plans) {
      const results = forecastDemand(history.rows, plan.targets);
      if (isAggregateDemandRefusal(results)) {
        return refuseRequest(results.reason, results.required, results.sampleSize);
      }
      outcomes.push(
        ...results.map((result) => {
          const startsAt = localDateTimeToUtc(
            `${result.target.localDate}T${result.target.localHour.toString().padStart(2, "0")}:00`,
            plan.timezone,
          );
          return {
            endsAt: new Date(startsAt.getTime() + 60 * 60_000),
            plan,
            result,
            startsAt,
          };
        }),
      );
    }
    const model = await this.ensureModelVersion(access, job, audit);
    const snapshot = await this.ensureFeatureSnapshot(access, job, {
      asOf: configurationReadAt,
      features: {
        bookedDemandOnly: true,
        componentConfigurationCount: scope.plans.length,
        configurationReadAt: configurationReadAt.toISOString(),
        denseZeroBuckets: true,
        historyBucketCount: history.rows.length,
        historyCapped: history.capped,
        historyCutoff: historyCutoff.toISOString(),
        organizationAggregate: scope.organizationRequest,
        targetCount: componentTargetCount,
      },
      subjectId: scope.organizationRequest ? null : (scope.plans[0]?.branchId ?? null),
      subjectType: scope.organizationRequest ? "ORGANIZATION_DEMAND_HORIZON" : "DEMAND_HORIZON",
    });
    let persisted = 0;
    for (const { endsAt, plan, result, startsAt } of outcomes) {
      if (result.status === "REFUSED") {
        await this.createRefusal(access, job, result.reason, result.required, result.sampleSize, {
          asOf: configurationReadAt,
          branchId: plan.branchId,
          details: {
            localDate: result.target.localDate,
            localHour: result.target.localHour,
            configurationReadAt: configurationReadAt.toISOString(),
            historyCutoff: historyCutoff.toISOString(),
            sourceScope: authorizedHistoryScope,
            timezone: plan.timezone,
          },
          generationSubject: {
            branchId: plan.branchId,
            localDate: result.target.localDate,
            localHour: result.target.localHour,
            serviceId: plan.serviceId,
          },
          serviceId: plan.serviceId,
          subjectId: plan.branchId,
          subjectType: "DEMAND_BUCKET",
        });
        persisted += 1;
        continue;
      }
      if (result.fallbackLevel !== "BRANCH_SERVICE") {
        await this.createRefusal(
          access,
          job,
          "INSUFFICIENT_SAMPLE",
          predictiveMinimums.DEMAND_FORECAST.bucketWeeks,
          comparableLeafWeeks(history.rows, result.target),
          {
            asOf: configurationReadAt,
            branchId: plan.branchId,
            details: {
              attemptedFallbackLevel: result.fallbackLevel,
              configurationReadAt: configurationReadAt.toISOString(),
              historyCutoff: historyCutoff.toISOString(),
              localDate: result.target.localDate,
              localHour: result.target.localHour,
              sourceScope: result.fallbackLevel,
              timezone: plan.timezone,
            },
            generationSubject: {
              branchId: plan.branchId,
              localDate: result.target.localDate,
              localHour: result.target.localHour,
              serviceId: plan.serviceId,
            },
            serviceId: plan.serviceId,
            subjectId: plan.branchId,
            subjectType: "DEMAND_BUCKET",
          },
        );
        persisted += 1;
        continue;
      }
      await this.persistGeneratedPrediction(access, job, {
        asOf: configurationReadAt,
        branchId: plan.branchId,
        details: {
          advisory: true,
          calendarAdjustment: result.target.calendarAdjustment ?? null,
          configurationReadAt: configurationReadAt.toISOString(),
          fallbackLevel: result.fallbackLevel,
          isHoliday: result.target.isHoliday,
          localDate: result.target.localDate,
          localHour: result.target.localHour,
          historyCutoff: historyCutoff.toISOString(),
          sampleWeeks: result.sampleWeeks,
          sourceScope: result.fallbackLevel,
          timezone: plan.timezone,
        },
        estimate: result.expectedCount,
        explanation: [],
        expiresAt: endsAt,
        featureSnapshotId: snapshot.id,
        generationSubject: {
          branchId: plan.branchId,
          localDate: result.target.localDate,
          localHour: result.target.localHour,
          serviceId: plan.serviceId,
        },
        horizonEndsAt: endsAt,
        horizonStartsAt: startsAt,
        lowerBound: result.lowerBound,
        modelIdentifier: model.algorithmIdentifier,
        modelVersion: model.version,
        modelVersionId: model.id,
        providerId: null,
        sampleSize: result.sampleWeeks,
        serviceId: plan.serviceId,
        subjectId: plan.branchId,
        subjectType: "DEMAND_BUCKET",
        upperBound: result.upperBound,
      });
      persisted += 1;
    }
    if (!scope.organizationRequest || !scope.organizationTimezone) return persisted;

    const aggregateGroups = new Map<string, ComponentOutcome[]>();
    for (const outcome of outcomes) {
      const localDate = localDateForInstant(outcome.startsAt, scope.organizationTimezone);
      const localHour = localDateTimePartsForInstant(
        outcome.startsAt,
        scope.organizationTimezone,
      ).hour;
      const key = `${localDate}:${localHour}`;
      aggregateGroups.set(key, [...(aggregateGroups.get(key) ?? []), outcome]);
    }
    for (const group of aggregateGroups.values()) {
      const first = group[0];
      if (!first) continue;
      const localDate = localDateForInstant(first.startsAt, scope.organizationTimezone);
      const localHour = localDateTimePartsForInstant(
        first.startsAt,
        scope.organizationTimezone,
      ).hour;
      const groupBranchCount = new Set(group.map(({ plan }) => plan.branchId)).size;
      const groupServiceCount = new Set(group.map(({ plan }) => plan.serviceId)).size;
      const refusal = group.find(
        (entry): entry is ComponentOutcome & Readonly<{ result: DemandBucketRefusal }> =>
          entry.result.status === "REFUSED",
      );
      if (refusal) {
        await this.createRefusal(
          access,
          job,
          refusal.result.reason,
          refusal.result.required,
          refusal.result.sampleSize,
          {
            asOf: configurationReadAt,
            branchId: null,
            details: {
              aggregationMethod: "SUM_BRANCH_SERVICE_BASELINES_V1",
              branchCount: groupBranchCount,
              complete: false,
              componentCount: group.length,
              configurationReadAt: configurationReadAt.toISOString(),
              generatedComponentCount: group.filter(({ result }) => result.status === "GENERATED")
                .length,
              historyCutoff: historyCutoff.toISOString(),
              localDate,
              localHour,
              refusedComponentCount: group.filter(({ result }) => result.status === "REFUSED")
                .length,
              scope: "ORGANIZATION",
              serviceCount: groupServiceCount,
              sourceScope: "ORGANIZATION",
              timezone: scope.organizationTimezone,
            },
            generationSubject: { localDate, localHour, scope: "ORGANIZATION" },
            serviceId: null,
            subjectId: null,
            subjectType: "ORGANIZATION_DEMAND_BUCKET",
          },
        );
        persisted += 1;
        continue;
      }
      const generated = group.flatMap((entry) =>
        entry.result.status === "GENERATED" ? [{ ...entry, result: entry.result }] : [],
      );
      const nonLeaf = generated.filter(({ result }) => result.fallbackLevel !== "BRANCH_SERVICE");
      if (nonLeaf.length > 0) {
        const availableLeafWeeks = Math.min(
          ...nonLeaf.map(({ result }) => comparableLeafWeeks(history.rows, result.target)),
        );
        await this.createRefusal(
          access,
          job,
          "INSUFFICIENT_SAMPLE",
          predictiveMinimums.DEMAND_FORECAST.bucketWeeks,
          availableLeafWeeks,
          {
            asOf: configurationReadAt,
            branchId: null,
            details: {
              aggregationMethod: "SUM_BRANCH_SERVICE_BASELINES_V1",
              branchCount: groupBranchCount,
              complete: false,
              componentCount: group.length,
              configurationReadAt: configurationReadAt.toISOString(),
              fallbackComponentCount: nonLeaf.length,
              generatedComponentCount: generated.length - nonLeaf.length,
              historyCutoff: historyCutoff.toISOString(),
              localDate,
              localHour,
              refusedComponentCount: nonLeaf.length,
              scope: "ORGANIZATION",
              serviceCount: groupServiceCount,
              sourceScope: "ORGANIZATION",
              timezone: scope.organizationTimezone,
            },
            generationSubject: { localDate, localHour, scope: "ORGANIZATION" },
            serviceId: null,
            subjectId: null,
            subjectType: "ORGANIZATION_DEMAND_BUCKET",
          },
        );
        persisted += 1;
        continue;
      }
      const horizonStartsAt = localDateTimeToUtc(
        `${localDate}T${localHour.toString().padStart(2, "0")}:00`,
        scope.organizationTimezone,
      );
      const horizonEndsAt = new Date(horizonStartsAt.getTime() + 60 * 60_000);
      await this.persistGeneratedPrediction(access, job, {
        asOf: configurationReadAt,
        branchId: null,
        details: {
          advisory: true,
          aggregationMethod: "SUM_BRANCH_SERVICE_BASELINES_V1",
          branchCount: groupBranchCount,
          complete: true,
          componentCount: generated.length,
          configurationReadAt: configurationReadAt.toISOString(),
          historyCutoff: historyCutoff.toISOString(),
          localDate,
          localHour,
          scope: "ORGANIZATION",
          serviceCount: groupServiceCount,
          sourceScope: "ORGANIZATION",
          timezone: scope.organizationTimezone,
          uncertaintyMethod: "SUM_COMPONENT_MARGINAL_INTERVALS",
        },
        estimate: generated.reduce((sum, entry) => sum + entry.result.expectedCount, 0),
        explanation: [],
        expiresAt: horizonEndsAt,
        featureSnapshotId: snapshot.id,
        generationSubject: { localDate, localHour, scope: "ORGANIZATION" },
        horizonEndsAt,
        horizonStartsAt,
        lowerBound: generated.reduce((sum, entry) => sum + entry.result.lowerBound, 0),
        modelIdentifier: model.algorithmIdentifier,
        modelVersion: model.version,
        modelVersionId: model.id,
        providerId: null,
        sampleSize: Math.min(...generated.map(({ result }) => result.sampleWeeks)),
        serviceId: null,
        subjectId: null,
        subjectType: "ORGANIZATION_DEMAND_BUCKET",
        upperBound: generated.reduce((sum, entry) => sum + entry.result.upperBound, 0),
      });
      persisted += 1;
    }
    return persisted;
  }

  private async configuredStaffMinutes(
    access: TenantAccessSnapshot,
    plan: DemandPlanningContext,
  ): Promise<number> {
    return runInTenant(this.client, access, async (transaction) => {
      const branch = await transaction.branch.findFirst({
        include: { hoursRules: true },
        where: { id: plan.branchId, isActive: true, organizationId: access.organizationId },
      });
      if (!branch) return 0;
      const closureEvents = await transaction.operationalCalendarEvent.findMany({
        select: { localDate: true },
        where: {
          eventType: "CLOSURE",
          isActive: true,
          localDate: {
            gte: new Date(`${plan.startsOn}T00:00:00Z`),
            lte: new Date(`${plan.endsOn}T00:00:00Z`),
          },
          OR: [{ branchId: plan.branchId }, { branchId: null }],
          organizationId: access.organizationId,
        },
      });
      const closureDates = new Set(closureEvents.map(({ localDate }) => dateOnly(localDate)));
      const providers = await transaction.staffProfile.findMany({
        include: {
          availabilityRules: {
            where: { OR: [{ branchId: plan.branchId }, { branchId: null }] },
          },
          timeOffEntries: {
            where: {
              OR: [{ branchId: plan.branchId }, { branchId: null }],
              endsAt: { gt: localDateTimeToUtc(`${plan.startsOn}T00:00`, plan.timezone) },
              startsAt: {
                lt: localDateTimeToUtc(`${addLocalDays(plan.endsOn, 1)}T00:00`, plan.timezone),
              },
            },
          },
        },
        where: {
          branchAssignments: { some: { branchId: plan.branchId } },
          isBookable: true,
          organizationId: access.organizationId,
          services: { some: { isEnabled: true, serviceId: plan.serviceId } },
        },
      });
      let milliseconds = 0;
      for (let date = plan.startsOn; date <= plan.endsOn; date = addLocalDays(date, 1)) {
        if (closureDates.has(date)) continue;
        const branchIntervals = branch.hoursRules
          .filter(
            (rule) =>
              weekdayNumber(rule.weekday) === localWeekday(date) &&
              (!rule.effectiveFrom || dateOnly(rule.effectiveFrom) <= date) &&
              (!rule.effectiveUntil || dateOnly(rule.effectiveUntil) >= date),
          )
          .flatMap((rule) => {
            const startHour = Math.floor(rule.startMinuteLocal / 60)
              .toString()
              .padStart(2, "0");
            const startMinute = (rule.startMinuteLocal % 60).toString().padStart(2, "0");
            const endDate = rule.endMinuteLocal === 1440 ? addLocalDays(date, 1) : date;
            const endMinuteValue = rule.endMinuteLocal === 1440 ? 0 : rule.endMinuteLocal;
            const endHour = Math.floor(endMinuteValue / 60)
              .toString()
              .padStart(2, "0");
            const endMinute = (endMinuteValue % 60).toString().padStart(2, "0");
            try {
              return [
                {
                  endsAt: localDateTimeToUtc(`${endDate}T${endHour}:${endMinute}`, plan.timezone),
                  startsAt: localDateTimeToUtc(
                    `${date}T${startHour}:${startMinute}`,
                    plan.timezone,
                  ),
                },
              ];
            } catch (error) {
              if (error instanceof DomainError && error.code === "VALIDATION_FAILED") return [];
              throw error;
            }
          })
          .toSorted((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
        const mergedBranchIntervals: Array<{ endsAt: Date; startsAt: Date }> = [];
        for (const interval of branchIntervals) {
          const prior = mergedBranchIntervals.at(-1);
          if (prior && interval.startsAt <= prior.endsAt) {
            if (interval.endsAt > prior.endsAt) prior.endsAt = interval.endsAt;
          } else {
            mergedBranchIntervals.push({ endsAt: interval.endsAt, startsAt: interval.startsAt });
          }
        }
        if (mergedBranchIntervals.length === 0) continue;
        for (const provider of providers) {
          const intervals = provider.availabilityRules
            .filter(
              (rule) =>
                weekdayNumber(rule.weekday) === localWeekday(date) &&
                (!rule.effectiveFrom || dateOnly(rule.effectiveFrom) <= date) &&
                (!rule.effectiveUntil || dateOnly(rule.effectiveUntil) >= date),
            )
            .flatMap((rule) => {
              const startHour = Math.floor(rule.startMinuteLocal / 60)
                .toString()
                .padStart(2, "0");
              const startMinute = (rule.startMinuteLocal % 60).toString().padStart(2, "0");
              const endDate = rule.endMinuteLocal === 1440 ? addLocalDays(date, 1) : date;
              const endMinuteValue = rule.endMinuteLocal === 1440 ? 0 : rule.endMinuteLocal;
              const endHour = Math.floor(endMinuteValue / 60)
                .toString()
                .padStart(2, "0");
              const endMinute = (endMinuteValue % 60).toString().padStart(2, "0");
              try {
                return [
                  {
                    endsAt: localDateTimeToUtc(`${endDate}T${endHour}:${endMinute}`, plan.timezone),
                    startsAt: localDateTimeToUtc(
                      `${date}T${startHour}:${startMinute}`,
                      plan.timezone,
                    ),
                  },
                ];
              } catch (error) {
                if (error instanceof DomainError && error.code === "VALIDATION_FAILED") return [];
                throw error;
              }
            })
            .toSorted((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
          const merged: Array<{ endsAt: Date; startsAt: Date }> = [];
          for (const interval of intervals) {
            const prior = merged.at(-1);
            if (prior && interval.startsAt <= prior.endsAt) {
              if (interval.endsAt > prior.endsAt) prior.endsAt = interval.endsAt;
            } else {
              merged.push({ endsAt: interval.endsAt, startsAt: interval.startsAt });
            }
          }
          const configuredIntervals: Array<{ endsAt: Date; startsAt: Date }> = [];
          for (const providerInterval of merged) {
            for (const branchInterval of mergedBranchIntervals) {
              const startsAt = new Date(
                Math.max(providerInterval.startsAt.getTime(), branchInterval.startsAt.getTime()),
              );
              const endsAt = new Date(
                Math.min(providerInterval.endsAt.getTime(), branchInterval.endsAt.getTime()),
              );
              if (startsAt < endsAt) configuredIntervals.push({ endsAt, startsAt });
            }
          }
          for (const interval of configuredIntervals) {
            const blockedIntervals = provider.timeOffEntries
              .map((timeOff) => ({
                endsAt: new Date(Math.min(interval.endsAt.getTime(), timeOff.endsAt.getTime())),
                startsAt: new Date(
                  Math.max(interval.startsAt.getTime(), timeOff.startsAt.getTime()),
                ),
              }))
              .filter(({ endsAt, startsAt }) => startsAt < endsAt)
              .toSorted((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
            const mergedBlockedIntervals: Array<{ endsAt: Date; startsAt: Date }> = [];
            for (const blockedInterval of blockedIntervals) {
              const prior = mergedBlockedIntervals.at(-1);
              if (prior && blockedInterval.startsAt <= prior.endsAt) {
                if (blockedInterval.endsAt > prior.endsAt) prior.endsAt = blockedInterval.endsAt;
              } else {
                mergedBlockedIntervals.push({
                  endsAt: blockedInterval.endsAt,
                  startsAt: blockedInterval.startsAt,
                });
              }
            }
            const blocked = mergedBlockedIntervals.reduce(
              (total, blockedInterval) =>
                total + blockedInterval.endsAt.getTime() - blockedInterval.startsAt.getTime(),
              0,
            );
            milliseconds += Math.max(
              0,
              interval.endsAt.getTime() - interval.startsAt.getTime() - blocked,
            );
          }
        }
      }
      return Math.round(milliseconds / 60_000);
    });
  }

  private async generateStaffing(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
  ): Promise<number> {
    const configurationReadAt = job.evaluationAt ?? job.createdAt;
    const historyCutoff = job.createdAt;
    const authorizedHistoryScope: PredictiveEvidenceSourceScope =
      requireScope(access, "predictions.run") === "ORGANIZATION" ? "ORGANIZATION" : "BRANCH";
    const provenance = {
      configurationReadAt: configurationReadAt.toISOString(),
      historyCutoff: historyCutoff.toISOString(),
      sourceScope: authorizedHistoryScope,
    };
    const plan = await this.demandPlanningContext(access, job, configurationReadAt);
    if (!plan || plan.targets.length === 0) {
      await this.createRefusal(access, job, "MISSING_SCHEDULE_CONFIGURATION", 1, 0, {
        asOf: configurationReadAt,
        details: provenance,
      });
      return 1;
    }
    const [audit, history, availableMinutes] = await Promise.all([
      this.persistDataAudit(access, job, false),
      runInTenant(this.client, access, (transaction) =>
        this.loadAuthorizedDemandHistory(transaction, access, job, historyCutoff),
      ),
      this.configuredStaffMinutes(access, plan),
    ]);
    if (!audit.eligible) {
      await this.createRefusal(
        access,
        job,
        audit.refusalReason ?? "MISSING_SCHEDULE_CONFIGURATION",
        1,
        audit.sampleSize,
        { asOf: configurationReadAt, details: provenance },
      );
      return 1;
    }
    if (history.densificationCapped) {
      await this.createRefusal(access, job, "MODEL_DEGRADED", 1, history.rows.length, {
        asOf: configurationReadAt,
        details: provenance,
      });
      return 1;
    }
    const forecast = forecastDemand(history.rows, plan.targets);
    if (isAggregateDemandRefusal(forecast)) {
      await this.createRefusal(
        access,
        job,
        forecast.reason,
        forecast.required,
        forecast.sampleSize,
        { asOf: configurationReadAt, details: provenance },
      );
      return 1;
    }
    const refused = forecast.find((row): row is DemandBucketRefusal => row.status === "REFUSED");
    if (refused) {
      await this.createRefusal(access, job, refused.reason, refused.required, refused.sampleSize, {
        asOf: configurationReadAt,
        details: provenance,
      });
      return 1;
    }
    const generated = forecast.filter((row): row is DemandForecast => row.status === "GENERATED");
    if (generated.length === 0) {
      await this.createRefusal(
        access,
        job,
        "INSUFFICIENT_SAMPLE",
        predictiveMinimums.DEMAND_FORECAST.bucketWeeks,
        0,
        { asOf: configurationReadAt, details: provenance },
      );
      return 1;
    }
    const fallbackScope: PredictiveEvidenceSourceScope = generated.some(
      ({ fallbackLevel }) => fallbackLevel === "ORGANIZATION",
    )
      ? "ORGANIZATION"
      : generated.some(({ fallbackLevel }) => fallbackLevel === "BRANCH")
        ? "BRANCH"
        : "BRANCH_SERVICE";
    if (fallbackScope !== "BRANCH_SERVICE") {
      await this.createRefusal(
        access,
        job,
        "INSUFFICIENT_SAMPLE",
        predictiveMinimums.DEMAND_FORECAST.bucketWeeks,
        Math.min(...generated.map(({ target }) => comparableLeafWeeks(history.rows, target))),
        {
          asOf: configurationReadAt,
          branchId: plan.branchId,
          details: {
            ...provenance,
            attemptedFallbackLevel: fallbackScope,
            sourceScope: fallbackScope,
          },
          serviceId: plan.serviceId,
          subjectId: plan.branchId,
          subjectType: "STAFFING_HORIZON",
        },
      );
      return 1;
    }
    const suggestion = suggestStaffing(
      generated.map((row) => ({
        durationMinutes: plan.durationMinutes,
        expectedCount: row.expectedCount,
        lowerBound: row.lowerBound,
        upperBound: row.upperBound,
      })),
      availableMinutes,
    );
    const model = await this.ensureModelVersion(access, job, audit);
    const snapshot = await this.ensureFeatureSnapshot(access, job, {
      asOf: configurationReadAt,
      features: {
        availableMinutes,
        configurationReadAt: configurationReadAt.toISOString(),
        demandForecastCount: generated.length,
        durationMinutes: plan.durationMinutes,
        historyCutoff: historyCutoff.toISOString(),
        timeOffApplied: true,
      },
      subjectId: plan.branchId,
      subjectType: "STAFFING_HORIZON",
    });
    const horizonStartsAt = localDateTimeToUtc(`${plan.startsOn}T00:00`, plan.timezone);
    const horizonEndsAt = localDateTimeToUtc(
      `${addLocalDays(plan.endsOn, 1)}T00:00`,
      plan.timezone,
    );
    await this.persistGeneratedPrediction(access, job, {
      asOf: configurationReadAt,
      branchId: plan.branchId,
      details: {
        action: suggestion.action,
        advisory: true,
        automaticScheduleMutationAllowed: false,
        availableMinutes: suggestion.availableMinutes,
        configurationReadAt: configurationReadAt.toISOString(),
        endsOn: plan.endsOn,
        startsOn: plan.startsOn,
        historyCutoff: historyCutoff.toISOString(),
        sourceScope: "BRANCH_SERVICE",
        timezone: plan.timezone,
      },
      estimate: suggestion.expectedLoadMinutes,
      explanation: [],
      expiresAt: horizonEndsAt,
      featureSnapshotId: snapshot.id,
      generationSubject: { branchId: plan.branchId, endsOn: plan.endsOn, startsOn: plan.startsOn },
      horizonEndsAt,
      horizonStartsAt,
      lowerBound: suggestion.lowerLoadMinutes,
      modelIdentifier: model.algorithmIdentifier,
      modelVersion: model.version,
      modelVersionId: model.id,
      providerId: null,
      sampleSize: generated.reduce((sum, row) => sum + row.sampleWeeks, 0),
      serviceId: plan.serviceId,
      subjectId: plan.branchId,
      subjectType: "STAFFING_HORIZON",
      upperBound: suggestion.upperLoadMinutes,
    });
    return 1;
  }

  private async generateRecommendations(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
  ): Promise<number> {
    if (!job.branchId) {
      await this.createRefusal(access, job, "NO_ELIGIBLE_TARGET", 1, 0);
      return 1;
    }
    const evaluationTime = job.evaluationAt ?? job.createdAt;
    const recommendationScope = await runInTenant(this.client, access, async (transaction) => {
      const branch = await transaction.branch.findFirst({
        select: { timezone: true },
        where: {
          id: job.branchId ?? systemActorId,
          isActive: true,
          organizationId: access.organizationId,
        },
      });
      if (!branch) return null;
      const serviceBranches = await transaction.serviceBranch.findMany({
        orderBy: { serviceId: "asc" },
        select: { serviceId: true },
        take: 21,
        where: {
          branchId: job.branchId ?? systemActorId,
          isEnabled: true,
          organizationId: access.organizationId,
          ...(job.serviceId ? { serviceId: job.serviceId } : {}),
          service: { is: { isActive: true } },
        },
      });
      const boundedServiceBranches = serviceBranches.slice(0, 20);
      return {
        serviceEnumerationTruncated: serviceBranches.length > boundedServiceBranches.length,
        serviceIds: boundedServiceBranches.map(({ serviceId }) => serviceId),
        timezone: branch.timezone,
      };
    });
    if (!recommendationScope) {
      await this.createRefusal(access, job, "MISSING_SCHEDULE_CONFIGURATION", 1, 0);
      return 1;
    }
    if (recommendationScope.serviceIds.length === 0) {
      await this.createRefusal(
        access,
        job,
        job.serviceId ? "MISSING_SCHEDULE_CONFIGURATION" : "NO_ELIGIBLE_TARGET",
        1,
        0,
      );
      return 1;
    }
    const today = localDateForInstant(evaluationTime, recommendationScope.timezone);
    const requestedStartsOn = stringParameter(job.parameters, "startsOn") ?? today;
    const startsOn = requestedStartsOn < today ? today : requestedStartsOn;
    const endsOn = stringParameter(job.parameters, "endsOn") ?? addLocalDays(startsOn, 14);
    if (endsOn < startsOn) {
      await this.createRefusal(access, job, "NO_VALID_CANDIDATE", 1, 0, {
        asOf: evaluationTime,
      });
      return 1;
    }
    const slots: Array<
      Readonly<{ endsAt: Date; providerId: string; serviceId: string; startsAt: Date }>
    > = [];
    let configurationFailures = 0;
    for (const serviceId of recommendationScope.serviceIds) {
      try {
        const serviceSlots = await this.scheduling.findAvailableSlots(access, {
          branchId: job.branchId,
          endsOn: endsOn > addLocalDays(startsOn, 30) ? addLocalDays(startsOn, 30) : endsOn,
          limit: job.serviceId ? 100 : 25,
          serviceId,
          startsOn,
        });
        slots.push(
          ...serviceSlots
            .filter(({ startsAt }) => startsAt > evaluationTime)
            .map(({ endsAt, providerId, startsAt }) => ({
              endsAt,
              providerId,
              serviceId,
              startsAt,
            })),
        );
      } catch (error) {
        if (
          error instanceof DomainError &&
          ["NOT_FOUND", "VALIDATION_FAILED"].includes(error.code)
        ) {
          configurationFailures += 1;
          continue;
        }
        throw error;
      }
    }
    if (slots.length === 0) {
      await this.createRefusal(
        access,
        job,
        configurationFailures === recommendationScope.serviceIds.length
          ? "MISSING_SCHEDULE_CONFIGURATION"
          : "NO_VALID_CANDIDATE",
        1,
        0,
      );
      return 1;
    }
    const completed = await runInTenant(this.client, access, (transaction) =>
      transaction.appointmentStatusHistory.findMany({
        distinct: ["appointmentId"],
        orderBy: [{ createdAt: "desc" }, { version: "desc" }, { id: "desc" }],
        select: {
          appointment: { select: { providerId: true, serviceId: true } },
          appointmentId: true,
        },
        where: {
          appointment: {
            branchId: job.branchId ?? systemActorId,
            providerId: { in: [...new Set(slots.map(({ providerId }) => providerId))] },
            serviceId: { in: recommendationScope.serviceIds },
            updatedAt: { lte: evaluationTime },
          },
          createdAt: { lte: evaluationTime },
          organizationId: access.organizationId,
          toStatus: "COMPLETED",
        },
      }),
    );
    const counts = completed.reduce<Map<string, number>>((byProviderService, row) => {
      const key = `${row.appointment.serviceId}:${row.appointment.providerId}`;
      byProviderService.set(key, (byProviderService.get(key) ?? 0) + 1);
      return byProviderService;
    }, new Map());
    const ranked = rankValidRecommendations(
      slots
        .toSorted(
          (left, right) =>
            left.startsAt.getTime() - right.startsAt.getTime() ||
            left.providerId.localeCompare(right.providerId) ||
            left.serviceId.localeCompare(right.serviceId),
        )
        .map((slot) => ({
          available: true,
          completedCount: counts.get(`${slot.serviceId}:${slot.providerId}`) ?? 0,
          continuity: false,
          eligible: true,
          preferenceMatch: false,
          providerId: slot.providerId,
          resourceValid: true,
          serviceId: slot.serviceId,
          slotStartsAt: slot.startsAt.toISOString(),
        })),
    )
      .toSorted(
        (left, right) =>
          right.score - left.score ||
          left.slotStartsAt.localeCompare(right.slotStartsAt) ||
          left.providerId.localeCompare(right.providerId) ||
          left.serviceId.localeCompare(right.serviceId),
      )
      .slice(0, 10);
    if (ranked.length === 0) {
      await this.createRefusal(access, job, "NO_VALID_CANDIDATE", 1, 0);
      return 1;
    }
    const audit = await this.persistDataAudit(access, job, false);
    const model = await this.ensureModelVersion(access, job, audit);
    const asOf = evaluationTime;
    const snapshot = await this.ensureFeatureSnapshot(access, job, {
      asOf,
      features: {
        candidateCount: slots.length,
        eligibleServiceCount: recommendationScope.serviceIds.length,
        resourceEngineValidated: true,
        serviceEnumerationTruncated: recommendationScope.serviceEnumerationTruncated,
      },
      subjectId: job.branchId,
      subjectType: "RECOMMENDATION_SET",
    });
    for (const candidate of ranked) {
      const startsAt = new Date(candidate.slotStartsAt);
      const slot = slots.find(
        (entry) =>
          entry.providerId === candidate.providerId &&
          entry.serviceId === candidate.serviceId &&
          entry.startsAt.getTime() === startsAt.getTime(),
      );
      if (!slot) continue;
      await this.persistGeneratedPrediction(access, job, {
        asOf,
        branchId: job.branchId,
        details: {
          acceptanceProbability: false,
          advisory: true,
          automaticBookingAllowed: false,
          estimateMeaning: "DETERMINISTIC_OPERATIONAL_RANKING_SCORE",
          rankingMethod: "DETERMINISTIC_OPERATIONAL_V1",
          requiresCustomerConfirmation: true,
          requiresStaffConfirmation: true,
          slotStartsAt: candidate.slotStartsAt,
          timezone: recommendationScope.timezone,
        },
        estimate: candidate.score,
        explanation: [],
        expiresAt: new Date(Math.min(asOf.getTime() + 15 * 60_000, startsAt.getTime())),
        featureSnapshotId: snapshot.id,
        generationSubject: {
          providerId: candidate.providerId,
          serviceId: candidate.serviceId,
          slotStartsAt: candidate.slotStartsAt,
        },
        horizonEndsAt: slot.endsAt,
        horizonStartsAt: startsAt,
        lowerBound: candidate.score,
        modelIdentifier: model.algorithmIdentifier,
        modelVersion: model.version,
        modelVersionId: model.id,
        providerId: candidate.providerId,
        sampleSize: candidate.completedCount,
        serviceId: candidate.serviceId,
        subjectId: candidate.providerId,
        subjectType: "PROVIDER_SLOT",
        upperBound: candidate.score,
      });
    }
    return ranked.length;
  }

  private async generateReflow(
    access: TenantAccessSnapshot,
    job: StoredPredictiveJob,
  ): Promise<number> {
    if (!job.appointmentId) {
      await this.createRefusal(access, job, "NO_ELIGIBLE_TARGET", 1, 0);
      return 1;
    }
    const appointment = await runInTenant(this.client, access, (transaction) =>
      transaction.appointment.findFirst({
        select: {
          branchId: true,
          customerId: true,
          id: true,
          providerId: true,
          serviceId: true,
          startsAt: true,
          status: true,
          timezone: true,
          version: true,
        },
        where: {
          id: job.appointmentId ?? systemActorId,
          organizationId: access.organizationId,
          status: { in: ["PENDING", "CONFIRMED"] },
        },
      }),
    );
    if (!appointment) {
      await this.createRefusal(access, job, "NO_ELIGIBLE_TARGET", 1, 0);
      return 1;
    }
    const evaluationTime = job.evaluationAt ?? job.createdAt;
    const today = localDateForInstant(evaluationTime, appointment.timezone);
    const requestedStartsOn = stringParameter(job.parameters, "startsOn") ?? today;
    const startsOn = requestedStartsOn < today ? today : requestedStartsOn;
    const requestedEndsOn = stringParameter(job.parameters, "endsOn") ?? addLocalDays(startsOn, 30);
    if (requestedEndsOn < startsOn) {
      await this.createRefusal(access, job, "NO_VALID_CANDIDATE", 1, 0, {
        asOf: evaluationTime,
      });
      return 1;
    }
    const endsOn =
      requestedEndsOn > addLocalDays(startsOn, 30) ? addLocalDays(startsOn, 30) : requestedEndsOn;
    const [slots, latestConsent] = await Promise.all([
      this.scheduling
        .findAvailableSlots(access, {
          branchId: appointment.branchId,
          endsOn,
          limit: 100,
          providerId: appointment.providerId,
          serviceId: appointment.serviceId,
          startsOn,
        })
        .then((available) => available.filter(({ startsAt }) => startsAt > evaluationTime)),
      runInTenant(this.client, access, (transaction) =>
        transaction.consent.findFirst({
          orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
          where: {
            customerId: appointment.customerId,
            organizationId: access.organizationId,
            purpose: "appointment_slot_offers",
          },
        }),
      ),
    ]);
    const customerConflicts =
      slots.length === 0
        ? []
        : await runInTenant(this.client, access, (transaction) =>
            transaction.appointment.findMany({
              select: { endsAt: true, startsAt: true },
              where: {
                customerId: appointment.customerId,
                endsAt: { gt: slots[0]?.startsAt ?? evaluationTime },
                id: { not: appointment.id },
                organizationId: access.organizationId,
                startsAt: { lt: slots.at(-1)?.endsAt ?? appointment.startsAt },
                status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"] },
              },
            }),
          );
    const ranked = rankSafeReflowCandidates(
      slots
        .filter(({ startsAt }) => startsAt < appointment.startsAt)
        .map((slot) => ({
          bufferValid: true,
          consentAllowsContact: latestConsent?.status === "GRANTED",
          customerConstraintValid: !customerConflicts.some(
            (conflict) => conflict.startsAt < slot.endsAt && slot.startsAt < conflict.endsAt,
          ),
          improvementMinutes: Math.round(
            (appointment.startsAt.getTime() - slot.startsAt.getTime()) / 60_000,
          ),
          providerValid: slot.providerId === appointment.providerId,
          requiresCustomerConfirmation: true as const,
          requiresStaffConfirmation: true as const,
          resourceValid: true,
          slotStartsAt: slot.startsAt.toISOString(),
          subjectAppointmentId: appointment.id,
        })),
    ).slice(0, 10);
    if (ranked.length === 0) {
      await this.createRefusal(
        access,
        job,
        latestConsent?.status === "GRANTED" ? "NO_VALID_CANDIDATE" : "NO_ELIGIBLE_TARGET",
        1,
        slots.length,
        {
          branchId: appointment.branchId,
          providerId: appointment.providerId,
          serviceId: appointment.serviceId,
          subjectId: appointment.id,
          subjectType: "APPOINTMENT",
        },
      );
      return 1;
    }
    const audit = await this.persistDataAudit(access, job, false);
    const model = await this.ensureModelVersion(access, job, audit);
    const asOf = evaluationTime;
    const snapshot = await this.ensureFeatureSnapshot(access, job, {
      asOf,
      features: {
        appointmentVersion: appointment.version,
        consentCheckedAt: asOf.toISOString(),
        feasibleCandidateCount: ranked.length,
        resourceEngineValidated: true,
      },
      subjectId: appointment.id,
      subjectType: "APPOINTMENT",
    });
    for (const candidate of ranked) {
      const slot = slots.find(({ startsAt }) => startsAt.toISOString() === candidate.slotStartsAt);
      const startsAt = new Date(candidate.slotStartsAt);
      await this.persistGeneratedPrediction(access, job, {
        asOf,
        branchId: appointment.branchId,
        details: {
          advisory: true,
          appointmentVersion: appointment.version,
          automaticRescheduleAllowed: false,
          requiresCustomerConfirmation: candidate.requiresCustomerConfirmation,
          requiresStaffConfirmation: candidate.requiresStaffConfirmation,
          slotStartsAt: candidate.slotStartsAt,
          timezone: appointment.timezone,
        },
        estimate: candidate.improvementMinutes,
        explanation: [],
        expiresAt: new Date(Math.min(asOf.getTime() + 15 * 60_000, startsAt.getTime())),
        featureSnapshotId: snapshot.id,
        generationSubject: {
          appointmentId: appointment.id,
          slotStartsAt: candidate.slotStartsAt,
        },
        horizonEndsAt: slot?.endsAt ?? startsAt,
        horizonStartsAt: startsAt,
        lowerBound: candidate.improvementMinutes,
        modelIdentifier: model.algorithmIdentifier,
        modelVersion: model.version,
        modelVersionId: model.id,
        providerId: appointment.providerId,
        sampleSize: ranked.length,
        serviceId: appointment.serviceId,
        subjectId: appointment.id,
        subjectType: "APPOINTMENT_REFLOW",
        upperBound: candidate.improvementMinutes,
      });
    }
    return ranked.length;
  }

  private async backtest(access: TenantAccessSnapshot, job: StoredPredictiveJob): Promise<number> {
    const existing = await runInTenant(this.client, access, (transaction) =>
      transaction.predictiveEvaluationRun.findFirst({
        where: { jobId: job.id, organizationId: access.organizationId },
      }),
    );
    if (existing) return 1;
    const asOf = job.createdAt;
    const sourceScope = authorizedAggregateSourceScope(access, job.capability, job.branchId);
    const audit = await this.persistDataAudit(access, job, false);
    let modelVersionId: string | null = null;
    if (audit.eligible) {
      modelVersionId = (await this.ensureModelVersion(access, job, audit)).id;
    }
    let outcome: "FAILED" | "INSUFFICIENT" | "PASSED" = "INSUFFICIENT";
    let metrics: unknown = {
      reason: audit.refusalReason ?? "NO_SUPPORTED_BACKTEST",
      required: this.requiredFor(job.capability, audit.refusalReason),
      sampleSize: audit.sampleSize,
    };
    let sampleSize = 0;
    let startsAt: Date | null = null;
    let endsAt: Date | null = null;
    if (job.capability === "NO_SHOW" && audit.eligible) {
      const loaded = await runInTenant(this.client, access, (transaction) =>
        this.loadAttendanceHistory(transaction, access.organizationId, asOf, job.branchId),
      );
      const ordered = loaded.rows.toSorted(
        (left, right) =>
          new Date(left.resolvedAt).getTime() - new Date(right.resolvedAt).getTime() ||
          left.appointmentId.localeCompare(right.appointmentId),
      );
      const evaluationRows: Array<{
        actual: 0 | 1;
        baselineProbability: number;
        probability: number;
      }> = [];
      for (const row of ordered
        .slice(predictiveMinimums.NO_SHOW.resolvedAppointments)
        .slice(-100)) {
        const predictedAt = new Date(
          new Date(row.scheduledAt).getTime() - row.leadTimeDays * 86_400_000,
        );
        if (new Date(row.dimensionVerifiedAt) > predictedAt) continue;
        const result = predictNoShow(
          ordered.filter(
            ({ dimensionVerifiedAt, recordedAt, resolvedVerifiedAt }) =>
              new Date(dimensionVerifiedAt) <= predictedAt &&
              new Date(recordedAt) < predictedAt &&
              new Date(resolvedVerifiedAt) <= predictedAt,
          ),
          {
            appointmentId: row.appointmentId,
            customerId: row.customerId,
            leadTimeDays: row.leadTimeDays,
            localHour: row.localHour,
            localWeekday: row.localWeekday,
            predictedAt: predictedAt.toISOString(),
            providerId: row.providerId,
            serviceId: row.serviceId,
            source: row.source,
          },
        );
        if (result.status === "GENERATED") {
          evaluationRows.push({
            actual: row.outcome === "NO_SHOW" ? 1 : 0,
            baselineProbability: result.baselineProbability,
            probability: result.probability,
          });
        }
      }
      const positives = evaluationRows.filter(({ actual }) => actual === 1).length;
      const negatives = evaluationRows.length - positives;
      if (
        evaluationRows.length >= predictiveMinimums.NO_SHOW.evaluationRows &&
        positives >= predictiveMinimums.NO_SHOW.evaluationPositives &&
        negatives >= predictiveMinimums.NO_SHOW.evaluationNegatives
      ) {
        const result = evaluateBinaryPredictions(evaluationRows);
        const baseline = evaluateBinaryPredictions(
          evaluationRows.map(({ actual, baselineProbability }) => ({
            actual,
            probability: baselineProbability,
          })),
        );
        metrics = {
          ...result,
          baselineBrierScore: baseline.brierScore,
          baselineLogLoss: baseline.logLoss,
          brierImprovement: baseline.brierScore - result.brierScore,
          logLossImprovement: baseline.logLoss - result.logLoss,
        };
        sampleSize = result.sampleSize;
        outcome =
          result.brierScore <= 0.25 &&
          result.calibrationError <= 0.15 &&
          result.brierScore <= baseline.brierScore &&
          result.logLoss <= baseline.logLoss
            ? "PASSED"
            : "FAILED";
        startsAt = ordered.at(-evaluationRows.length)?.resolvedAt
          ? new Date(ordered.at(-evaluationRows.length)?.resolvedAt ?? asOf)
          : null;
        endsAt = ordered.at(-1)?.resolvedAt ? new Date(ordered.at(-1)?.resolvedAt ?? asOf) : null;
      } else {
        metrics = {
          availableNegatives: negatives,
          availablePositives: positives,
          availableRows: evaluationRows.length,
          reason: "INSUFFICIENT_MATURE_HOLDOUT",
          requiredNegatives: predictiveMinimums.NO_SHOW.evaluationNegatives,
          requiredPositives: predictiveMinimums.NO_SHOW.evaluationPositives,
          requiredRows: predictiveMinimums.NO_SHOW.evaluationRows,
        };
        sampleSize = evaluationRows.length;
      }
    } else if (job.capability === "DEMAND_FORECAST" && audit.eligible) {
      metrics = {
        availableBookedDemandEvents: audit.sampleSize,
        calendarEvidence: "PHASE8_FORWARD_ONLY",
        holidayEvaluation: "NOT_EVALUATED",
        historicalConfigurationEvaluation: "NOT_EVALUATED",
        reason: "HISTORICAL_CALENDAR_AND_CONFIGURATION_EVIDENCE_UNAVAILABLE",
        required: "EFFECTIVE_DATED_CALENDAR_AND_CONFIGURATION_HISTORY",
      };
      sampleSize = 0;
      outcome = "INSUFFICIENT";
    }
    const currentAccess = await this.reauthorizeJob(access, job);
    await runInTenant(this.client, currentAccess, async (transaction) => {
      await this.lockEvidenceAuthorization(transaction, currentAccess, job);
      return transaction.predictiveEvaluationRun.create({
        data: {
          branchId: job.branchId,
          capability: job.capability,
          dataWatermark: asOf,
          endsAt,
          jobId: job.id,
          metrics: inputJson(withEvidenceSourceScope(metrics, sourceScope)),
          modelVersionId,
          organizationId: access.organizationId,
          outcome,
          runType: "BACKTEST",
          sampleSize,
          startsAt,
        },
      });
    });
    return 1;
  }

  private async drift(access: TenantAccessSnapshot, job: StoredPredictiveJob): Promise<number> {
    const existing = await runInTenant(this.client, access, (transaction) =>
      transaction.predictiveDriftRun.findFirst({
        where: { jobId: job.id, organizationId: access.organizationId },
      }),
    );
    if (existing) return 1;
    const asOf = job.createdAt;
    const sourceScope = authorizedAggregateSourceScope(access, job.capability, job.branchId);
    const audit = await this.persistDataAudit(access, job, false);
    let modelVersionId: string | null = null;
    if (audit.eligible) {
      modelVersionId = (await this.ensureModelVersion(access, job, audit)).id;
    }
    let baselineStartsAt: Date | null = null;
    let baselineEndsAt: Date | null = null;
    let currentStartsAt: Date | null = null;
    let currentEndsAt: Date | null = null;
    let metrics: unknown = {
      reason: audit.refusalReason ?? "NO_STABLE_FEATURE_DISTRIBUTION",
      required: predictiveMinimums.DRIFT.currentSample,
    };
    let sampleSize = 0;
    let score: number | null = null;
    let status: "ALERT" | "INSUFFICIENT" | "STABLE" | "WATCH" = "INSUFFICIENT";
    if (job.capability === "NO_SHOW" && audit.eligible) {
      const loaded = await runInTenant(this.client, access, (transaction) =>
        this.loadAttendanceHistory(transaction, access.organizationId, asOf, job.branchId),
      );
      const ordered = loaded.rows.toSorted(
        (left, right) =>
          new Date(left.resolvedAt).getTime() - new Date(right.resolvedAt).getTime() ||
          left.appointmentId.localeCompare(right.appointmentId),
      );
      const current = ordered.slice(-predictiveMinimums.DRIFT.currentSample);
      const baseline = ordered.slice(
        -predictiveMinimums.DRIFT.currentSample - predictiveMinimums.DRIFT.referenceSample,
        -predictiveMinimums.DRIFT.currentSample,
      );
      if (
        current.length >= predictiveMinimums.DRIFT.currentSample &&
        baseline.length >= predictiveMinimums.DRIFT.referenceSample
      ) {
        const distribution = (rows: readonly AttendanceHistoryRow[]) =>
          rows.reduce<Record<string, number>>((counts, row) => {
            counts[row.source] = (counts[row.source] ?? 0) + 1;
            return counts;
          }, {});
        const result = distributionDrift(distribution(baseline), distribution(current));
        status = result.status;
        score = result.status === "INSUFFICIENT" ? null : result.score;
        sampleSize = current.length;
        metrics = { dimension: "APPOINTMENT_SOURCE", score: result.score };
        baselineStartsAt = baseline[0] ? new Date(baseline[0].resolvedAt) : null;
        baselineEndsAt = baseline.at(-1) ? new Date(baseline.at(-1)?.resolvedAt ?? asOf) : null;
        currentStartsAt = current[0] ? new Date(current[0].resolvedAt) : null;
        currentEndsAt = current.at(-1) ? new Date(current.at(-1)?.resolvedAt ?? asOf) : null;
      } else {
        sampleSize = current.length;
        metrics = {
          availableBaseline: baseline.length,
          availableCurrent: current.length,
          reason: "INSUFFICIENT_DRIFT_WINDOWS",
          requiredPerWindow: predictiveMinimums.DRIFT.currentSample,
        };
      }
    } else if (job.capability === "DEMAND_FORECAST" && audit.eligible) {
      const loaded = await runInTenant(this.client, access, (transaction) =>
        this.loadAuthorizedDemandHistory(transaction, access, job, asOf),
      );
      const dates = [...new Set(loaded.rows.map(({ localDate }) => localDate))].toSorted();
      const midpoint = dates[Math.floor(dates.length / 2)];
      const baseline = midpoint
        ? loaded.rows
            .filter(({ localDate }) => localDate < midpoint)
            .toSorted(
              (left, right) =>
                left.localDate.localeCompare(right.localDate) ||
                left.localHour - right.localHour ||
                left.branchId.localeCompare(right.branchId) ||
                left.serviceId.localeCompare(right.serviceId),
            )
        : [];
      const current = midpoint
        ? loaded.rows
            .filter(({ localDate }) => localDate >= midpoint)
            .toSorted(
              (left, right) =>
                left.localDate.localeCompare(right.localDate) ||
                left.localHour - right.localHour ||
                left.branchId.localeCompare(right.branchId) ||
                left.serviceId.localeCompare(right.serviceId),
            )
        : [];
      const baselineCount = baseline.reduce((sum, row) => sum + row.count, 0);
      const currentCount = current.reduce((sum, row) => sum + row.count, 0);
      if (
        !loaded.densificationCapped &&
        baselineCount >= predictiveMinimums.DRIFT.referenceSample &&
        currentCount >= predictiveMinimums.DRIFT.currentSample
      ) {
        const distribution = (rows: readonly DemandHistoryBucket[]) =>
          rows.reduce<Record<string, number>>((counts, row) => {
            const key = `${row.localWeekday}:${row.localHour}`;
            counts[key] = (counts[key] ?? 0) + row.count;
            return counts;
          }, {});
        const result = distributionDrift(distribution(baseline), distribution(current));
        status = result.status;
        score = result.status === "INSUFFICIENT" ? null : result.score;
        sampleSize = currentCount;
        metrics = { dimension: "WEEKDAY_HOUR", score: result.score };
        baselineStartsAt = baseline[0] ? new Date(`${baseline[0].localDate}T00:00:00Z`) : null;
        baselineEndsAt = baseline.at(-1)
          ? new Date(`${baseline.at(-1)?.localDate ?? ""}T00:00:00Z`)
          : null;
        currentStartsAt = current[0] ? new Date(`${current[0].localDate}T00:00:00Z`) : null;
        currentEndsAt = current.at(-1)
          ? new Date(`${current.at(-1)?.localDate ?? ""}T00:00:00Z`)
          : null;
      } else {
        sampleSize = currentCount;
        metrics = {
          availableBaseline: baselineCount,
          availableCurrent: currentCount,
          densificationCapped: loaded.densificationCapped,
          reason: "INSUFFICIENT_DRIFT_WINDOWS",
          requiredPerWindow: predictiveMinimums.DRIFT.currentSample,
        };
      }
    }
    const currentAccess = await this.reauthorizeJob(access, job);
    await runInTenant(this.client, currentAccess, async (transaction) => {
      await this.lockEvidenceAuthorization(transaction, currentAccess, job);
      return transaction.predictiveDriftRun.create({
        data: {
          baselineEndsAt,
          baselineStartsAt,
          branchId: job.branchId,
          capability: job.capability,
          currentEndsAt,
          currentStartsAt,
          dataWatermark: asOf,
          jobId: job.id,
          metrics: inputJson(withEvidenceSourceScope(metrics, sourceScope)),
          modelVersionId,
          organizationId: access.organizationId,
          sampleSize,
          score,
          status,
        },
      });
    });
    return 1;
  }

  async markJobFailure(
    organizationId: string,
    jobId: string,
    safeErrorCode: string,
    finalAttempt: boolean,
    leaseToken: string,
  ): Promise<void> {
    await runInTenant(
      this.client,
      { actorUserId: systemActorId, organizationId },
      async (transaction) => {
        const normalizedErrorCode = safeErrorCode.slice(0, 100);
        const changed = await transaction.predictiveJob.updateMany({
          data: {
            ...(finalAttempt
              ? { completedAt: new Date(), status: "DEAD_LETTER" as const }
              : { status: "ENQUEUED" as const }),
            safeErrorCode: normalizedErrorCode,
          },
          where: {
            id: jobId,
            leaseToken,
            organizationId,
            status: { in: ["CLAIMED", "ENQUEUED", "RUNNING"] },
          },
        });
        if (changed.count !== 1 || !finalAttempt) return;
        const job = await transaction.predictiveJob.findFirst({
          select: {
            actorUserId: true,
            capability: true,
            jobType: true,
            supportAccessId: true,
          },
          where: { id: jobId, leaseToken, organizationId, status: "DEAD_LETTER" },
        });
        if (!job) return;
        await transaction.auditEvent.create({
          data: {
            action: "PREDICTIVE_JOB_FAILED",
            actorUserId: job.actorUserId,
            metadata: {
              capability: job.capability,
              jobType: job.jobType,
              safeErrorCode: normalizedErrorCode,
            },
            organizationId,
            supportAccessId: job.supportAccessId,
            targetId: jobId,
            targetType: "PredictiveJob",
          },
        });
      },
    );
  }
}

let singleton: PredictiveRepository | undefined;

export function getPredictiveRepository(): PredictiveRepository {
  singleton ??= new PredictiveRepository(prisma);
  return singleton;
}
