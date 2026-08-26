import { createHash, randomUUID } from "node:crypto";

import {
  findAvailableSlots as calculateAvailableSlots,
  type AvailabilityQuery,
  type AvailabilitySnapshot,
  type RecurringAvailabilityRule,
} from "@jormall/domain/availability";
import { canRescheduleAppointment } from "@jormall/domain/appointment-state";
import { DomainError } from "@jormall/domain/errors";
import type {
  PermissionCode,
  PermissionScope,
  TenantAccessSnapshot,
} from "@jormall/domain/identity";
import { localDateTimeToUtc } from "@jormall/domain/timezone";

import {
  AppointmentSource,
  AppointmentStatus,
  MembershipStatus,
  OrganizationStatus,
  PlatformRole,
  Prisma,
  type PrismaClient,
  type ResourceKind,
  type ResourceStatus,
  type Weekday,
} from "./generated/prisma/client";
import {
  assertBookableSchedule,
  createAppointmentRows,
  prepareBooking,
  rescheduleAppointmentRows,
  schedulingConflict,
} from "./scheduling-transaction";
import { runInTenant, type TenantTransaction } from "./tenant-context";

export type SchedulingAuditDetails = Readonly<{
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}>;

export type ResourceGroupInput = Readonly<{
  branchId: string;
  kind: ResourceKind;
  nameAr: string;
  nameEn: string;
}>;

export type ResourceInput = Readonly<{
  groupId: string;
  nameAr: string;
  nameEn: string;
  staffProfileId?: string | undefined;
}>;

export type WaitlistInput = Readonly<{
  appointmentId?: string | undefined;
  branchIds: readonly string[];
  customerId: string;
  notes?: string | undefined;
  preferredEndDate: string;
  preferredEndMinute: number;
  preferredStartDate: string;
  preferredStartMinute: number;
  priority: number;
  providerIds?: readonly string[] | undefined;
  serviceId: string;
}>;

const permissionRank: Readonly<Record<PermissionScope, number>> = {
  ASSIGNED_BRANCHES: 2,
  ORGANIZATION: 3,
  SELF: 1,
};

function requireScope(access: TenantAccessSnapshot, permission: PermissionCode): PermissionScope {
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
  return scope;
}

function requireBranchScope(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
  branchId: string,
  providerId?: string,
): PermissionScope {
  const scope = requireScope(access, permission);
  if (
    scope === "ORGANIZATION" ||
    (scope === "ASSIGNED_BRANCHES" && access.assignedBranchIds.includes(branchId)) ||
    (scope === "SELF" && providerId && providerId === access.staffProfileId)
  ) {
    return scope;
  }
  throw new DomainError({
    code: "FORBIDDEN",
    message: "Branch or provider access is not granted.",
  });
}

function requireWaitlistScope(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
  branchIds: readonly string[],
  providerIds: readonly string[],
): PermissionScope {
  const scope = requireScope(access, permission);
  if (scope === "ORGANIZATION") return scope;
  if (
    scope === "ASSIGNED_BRANCHES" &&
    branchIds.length > 0 &&
    branchIds.every((branchId) => access.assignedBranchIds.includes(branchId))
  ) {
    return scope;
  }
  if (
    scope === "SELF" &&
    access.staffProfileId &&
    providerIds.length > 0 &&
    providerIds.every((providerId) => providerId === access.staffProfileId)
  ) {
    return scope;
  }
  throw new DomainError({
    code: "FORBIDDEN",
    message: "The waitlist entry is outside the granted scope.",
  });
}

function trimmed(value: string, field: string): string {
  const result = value.trim();
  if (!result || result.length > 160) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: `Invalid ${field}.` });
  }
  return result;
}

function dateOnly(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: `Invalid ${field}.` });
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== value) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: `Invalid ${field}.` });
  }
  return date;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dateRule(
  rule: Readonly<{
    effectiveFrom: Date | null;
    effectiveUntil: Date | null;
    endMinuteLocal: number;
    startMinuteLocal: number;
    weekday: Weekday;
  }>,
): RecurringAvailabilityRule {
  return {
    ...(rule.effectiveFrom ? { effectiveFrom: rule.effectiveFrom.toISOString().slice(0, 10) } : {}),
    ...(rule.effectiveUntil
      ? { effectiveUntil: rule.effectiveUntil.toISOString().slice(0, 10) }
      : {}),
    endMinuteLocal: rule.endMinuteLocal,
    startMinuteLocal: rule.startMinuteLocal,
    weekday: rule.weekday,
  };
}

async function audit(
  transaction: TenantTransaction,
  access: TenantAccessSnapshot,
  action: string,
  targetType: string,
  targetId: string,
  details?: SchedulingAuditDetails,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      action,
      actorUserId: access.actorUserId,
      ipAddress: details?.ipAddress ?? null,
      organizationId: access.organizationId,
      supportAccessId: access.supportAccessId ?? null,
      targetId,
      targetType,
      userAgent: details?.userAgent ?? null,
    },
  });
}

export class SchedulingRepository {
  readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  private async runWithAccess<T>(
    access: TenantAccessSnapshot,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    if (access.supportAccessId) {
      const user = await this.client.user.findUnique({
        select: { platformRole: true },
        where: { id: access.actorUserId },
      });
      if (user?.platformRole !== PlatformRole.JORMALL_SUPER_ADMIN) {
        throw new DomainError({ code: "FORBIDDEN", message: "Super Admin access is required." });
      }
      const support = await this.client.platformSupportAccess.findFirst({
        where: {
          expiresAt: { gt: new Date() },
          id: access.supportAccessId,
          organizationId: access.organizationId,
          revokedAt: null,
          userId: access.actorUserId,
        },
      });
      if (!support) {
        throw new DomainError({ code: "FORBIDDEN", message: "Support access is invalid." });
      }
    }
    return runInTenant(this.client, access, async (transaction) => {
      const organization = await transaction.organization.findUnique({
        select: { status: true },
        where: { id: access.organizationId },
      });
      if (!organization) {
        throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
      }
      if (organization.status === OrganizationStatus.SUSPENDED) {
        throw new DomainError({
          code: "ORGANIZATION_SUSPENDED",
          message: "Organization is suspended.",
        });
      }
      if (organization.status !== OrganizationStatus.ACTIVE) {
        throw new DomainError({ code: "FORBIDDEN", message: "Organization is not active." });
      }
      if (access.membershipId) {
        const membership = await transaction.organizationMembership.findFirst({
          select: { status: true },
          where: {
            id: access.membershipId,
            organizationId: access.organizationId,
            userId: access.actorUserId,
          },
        });
        if (membership?.status !== MembershipStatus.ACTIVE) {
          throw new DomainError({
            code: "MEMBERSHIP_SUSPENDED",
            message: "Membership is not active.",
          });
        }
      } else if (access.gatewayActionId) {
        const gatewayAction = await transaction.aIAction.findFirst({
          select: { requiredPermission: true },
          where: {
            actorId: access.actorUserId,
            id: access.gatewayActionId,
            organizationId: access.organizationId,
            outcome: { in: ["PENDING", "REQUIRES_CONFIRMATION"] },
          },
        });
        if (
          !gatewayAction ||
          !access.grants.some(({ code }) => code === gatewayAction.requiredPermission)
        ) {
          throw new DomainError({
            code: "FORBIDDEN",
            message: "AI Action Gateway authorization is invalid.",
          });
        }
      } else if (!access.supportAccessId) {
        throw new DomainError({
          code: "TENANT_CONTEXT_REQUIRED",
          message: "An active tenant context is required.",
        });
      }
      return operation(transaction);
    });
  }

  async listResourceConfiguration(access: TenantAccessSnapshot) {
    const scope = requireScope(access, "resources.read");
    return this.runWithAccess(access, async (transaction) => {
      const branchFilter =
        scope === "ORGANIZATION" ? {} : { id: { in: [...access.assignedBranchIds] } };
      const branches = await transaction.branch.findMany({
        include: { hoursRules: { orderBy: [{ weekday: "asc" }, { startMinuteLocal: "asc" }] } },
        orderBy: { nameEn: "asc" },
        where: { ...branchFilter, organizationId: access.organizationId },
      });
      const branchIds = branches.map(({ id }) => id);
      const [groups, services, providers] = await Promise.all([
        transaction.resourceGroup.findMany({
          include: {
            requirements: {
              include: { service: { select: { id: true, nameAr: true, nameEn: true } } },
            },
            resources: { include: { availabilityRules: true }, orderBy: { nameEn: "asc" } },
          },
          orderBy: { nameEn: "asc" },
          where: { branchId: { in: branchIds }, organizationId: access.organizationId },
        }),
        transaction.service.findMany({
          orderBy: { nameEn: "asc" },
          select: { id: true, nameAr: true, nameEn: true },
          where: { isActive: true, organizationId: access.organizationId },
        }),
        transaction.staffProfile.findMany({
          orderBy: { displayNameEn: "asc" },
          select: { displayNameAr: true, displayNameEn: true, id: true },
          where: { isBookable: true, organizationId: access.organizationId },
        }),
      ]);
      return { branches, groups, providers, services };
    });
  }

  async createResourceGroup(
    access: TenantAccessSnapshot,
    input: ResourceGroupInput,
    details?: SchedulingAuditDetails,
  ) {
    requireBranchScope(access, "resources.manage", input.branchId);
    const nameEn = trimmed(input.nameEn, "English name");
    const nameAr = trimmed(input.nameAr, "Arabic name");
    return this.runWithAccess(access, async (transaction) => {
      const branch = await transaction.branch.findFirst({
        select: { id: true },
        where: { id: input.branchId, isActive: true, organizationId: access.organizationId },
      });
      if (!branch) throw new DomainError({ code: "NOT_FOUND", message: "Branch not found." });
      const group = await transaction.resourceGroup.create({
        data: {
          branchId: input.branchId,
          kind: input.kind,
          nameAr,
          nameEn,
          organizationId: access.organizationId,
        },
      });
      await audit(
        transaction,
        access,
        "RESOURCE_GROUP_CREATED",
        "ResourceGroup",
        group.id,
        details,
      );
      return group;
    });
  }

  async createResource(
    access: TenantAccessSnapshot,
    input: ResourceInput,
    details?: SchedulingAuditDetails,
  ) {
    const nameEn = trimmed(input.nameEn, "English name");
    const nameAr = trimmed(input.nameAr, "Arabic name");
    return this.runWithAccess(access, async (transaction) => {
      const group = await transaction.resourceGroup.findFirst({
        where: { id: input.groupId, isActive: true, organizationId: access.organizationId },
      });
      if (!group) {
        throw new DomainError({ code: "NOT_FOUND", message: "Resource group not found." });
      }
      requireBranchScope(access, "resources.manage", group.branchId);
      if (input.staffProfileId) {
        const provider = await transaction.staffProfile.findFirst({
          where: { id: input.staffProfileId, organizationId: access.organizationId },
        });
        if (!provider) {
          throw new DomainError({ code: "NOT_FOUND", message: "Provider not found." });
        }
      }
      const resource = await transaction.resource.create({
        data: {
          branchId: group.branchId,
          groupId: group.id,
          nameAr,
          nameEn,
          organizationId: access.organizationId,
          staffProfileId: input.staffProfileId ?? null,
        },
      });
      await audit(transaction, access, "RESOURCE_CREATED", "Resource", resource.id, details);
      return resource;
    });
  }

  async setResourceStatus(
    access: TenantAccessSnapshot,
    input: Readonly<{ resourceId: string; status: ResourceStatus }>,
    details?: SchedulingAuditDetails,
  ) {
    return this.runWithAccess(access, async (transaction) => {
      const resource = await transaction.resource.findFirst({
        where: { id: input.resourceId, organizationId: access.organizationId },
      });
      if (!resource) throw new DomainError({ code: "NOT_FOUND", message: "Resource not found." });
      requireBranchScope(access, "resources.manage", resource.branchId);
      const updated = await transaction.resource.update({
        data: { status: input.status },
        where: { id: resource.id },
      });
      await audit(transaction, access, "RESOURCE_STATUS_CHANGED", "Resource", resource.id, details);
      return updated;
    });
  }

  async createBranchHoursRule(
    access: TenantAccessSnapshot,
    input: Readonly<{
      branchId: string;
      endMinuteLocal: number;
      startMinuteLocal: number;
      weekday: Weekday;
    }>,
  ) {
    requireBranchScope(access, "resources.manage", input.branchId);
    if (
      !Number.isInteger(input.startMinuteLocal) ||
      !Number.isInteger(input.endMinuteLocal) ||
      input.startMinuteLocal < 0 ||
      input.startMinuteLocal >= input.endMinuteLocal ||
      input.endMinuteLocal > 1440
    ) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid branch hours." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const branch = await transaction.branch.findFirst({
        where: { id: input.branchId, organizationId: access.organizationId },
      });
      if (!branch) throw new DomainError({ code: "NOT_FOUND", message: "Branch not found." });
      return transaction.branchHoursRule.create({
        data: { ...input, organizationId: access.organizationId },
      });
    });
  }

  async createResourceAvailabilityRule(
    access: TenantAccessSnapshot,
    input: Readonly<{
      endMinuteLocal: number;
      resourceId: string;
      startMinuteLocal: number;
      weekday: Weekday;
    }>,
  ) {
    return this.runWithAccess(access, async (transaction) => {
      const resource = await transaction.resource.findFirst({
        where: { id: input.resourceId, organizationId: access.organizationId },
      });
      if (!resource) throw new DomainError({ code: "NOT_FOUND", message: "Resource not found." });
      requireBranchScope(access, "resources.manage", resource.branchId);
      if (
        !Number.isInteger(input.startMinuteLocal) ||
        !Number.isInteger(input.endMinuteLocal) ||
        input.startMinuteLocal < 0 ||
        input.startMinuteLocal >= input.endMinuteLocal ||
        input.endMinuteLocal > 1440
      ) {
        throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid resource hours." });
      }
      return transaction.resourceAvailabilityRule.create({
        data: { ...input, organizationId: access.organizationId },
      });
    });
  }

  async setServiceResourceRequirement(
    access: TenantAccessSnapshot,
    input: Readonly<{
      branchId: string;
      quantity: number;
      resourceGroupId: string;
      serviceId: string;
    }>,
    details?: SchedulingAuditDetails,
  ) {
    requireBranchScope(access, "resources.manage", input.branchId);
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid resource quantity." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const [group, serviceBranch] = await Promise.all([
        transaction.resourceGroup.findFirst({
          where: {
            branchId: input.branchId,
            id: input.resourceGroupId,
            isActive: true,
            organizationId: access.organizationId,
          },
        }),
        transaction.serviceBranch.findFirst({
          where: {
            branchId: input.branchId,
            isEnabled: true,
            organizationId: access.organizationId,
            serviceId: input.serviceId,
          },
        }),
      ]);
      if (!group || !serviceBranch) {
        throw new DomainError({ code: "NOT_FOUND", message: "Service or resource is invalid." });
      }
      const requirement = await transaction.serviceResourceRequirement.upsert({
        create: { ...input, organizationId: access.organizationId },
        update: { quantity: input.quantity },
        where: {
          organizationId_serviceId_branchId_resourceGroupId: {
            branchId: input.branchId,
            organizationId: access.organizationId,
            resourceGroupId: input.resourceGroupId,
            serviceId: input.serviceId,
          },
        },
      });
      await audit(
        transaction,
        access,
        "SERVICE_RESOURCE_REQUIREMENT_SET",
        "ResourceGroup",
        group.id,
        details,
      );
      return requirement;
    });
  }

  async findAvailableSlots(access: TenantAccessSnapshot, query: AvailabilityQuery) {
    const scope = requireBranchScope(
      access,
      "appointments.availability.read",
      query.branchId,
      query.providerId,
    );
    const normalizedQuery =
      scope === "SELF"
        ? { ...query, providerId: access.staffProfileId ?? "00000000-0000-0000-0000-000000000000" }
        : query;
    return this.runWithAccess(access, async (transaction) => {
      const roughStart = localDateTimeToUtc(`${query.startsOn}T00:00`, "UTC");
      const roughEnd = new Date(
        localDateTimeToUtc(`${query.endsOn}T00:00`, "UTC").getTime() + 2 * 86_400_000,
      );
      const [branch, serviceBranch, providers, requirements] = await Promise.all([
        transaction.branch.findFirst({
          include: { hoursRules: true },
          where: { id: query.branchId, isActive: true, organizationId: access.organizationId },
        }),
        transaction.serviceBranch.findFirst({
          include: { service: { select: { defaultDurationMins: true, isActive: true } } },
          where: {
            branchId: query.branchId,
            isEnabled: true,
            organizationId: access.organizationId,
            serviceId: query.serviceId,
          },
        }),
        transaction.staffProfile.findMany({
          include: {
            appointmentReservations: {
              select: { endsAt: true, startsAt: true },
              where: { endsAt: { gt: roughStart }, startsAt: { lt: roughEnd } },
            },
            availabilityRules: {
              where: { OR: [{ branchId: query.branchId }, { branchId: null }] },
            },
            timeOffEntries: {
              select: { endsAt: true, startsAt: true },
              where: {
                OR: [{ branchId: query.branchId }, { branchId: null }],
                endsAt: { gt: roughStart },
                startsAt: { lt: roughEnd },
              },
            },
          },
          orderBy: { id: "asc" },
          where: {
            ...(normalizedQuery.providerId ? { id: normalizedQuery.providerId } : {}),
            branchAssignments: { some: { branchId: query.branchId } },
            isBookable: true,
            organizationId: access.organizationId,
            services: { some: { isEnabled: true, serviceId: query.serviceId } },
          },
        }),
        transaction.serviceResourceRequirement.findMany({
          include: {
            resourceGroup: {
              include: {
                resources: {
                  include: {
                    availabilityRules: true,
                    reservations: {
                      select: { endsAt: true, startsAt: true },
                      where: { endsAt: { gt: roughStart }, startsAt: { lt: roughEnd } },
                    },
                  },
                  orderBy: { id: "asc" },
                  where: { status: "ACTIVE" },
                },
              },
            },
          },
          orderBy: { resourceGroupId: "asc" },
          where: {
            branchId: query.branchId,
            organizationId: access.organizationId,
            serviceId: query.serviceId,
          },
        }),
      ]);
      if (!branch || !serviceBranch || !serviceBranch.service.isActive) {
        throw new DomainError({
          code: "NOT_FOUND",
          message: "Scheduling configuration not found.",
        });
      }
      const snapshot: AvailabilitySnapshot = {
        branchHours: branch.hoursRules.map(dateRule),
        bufferAfterMins: serviceBranch.bufferAfterMins,
        bufferBeforeMins: serviceBranch.bufferBeforeMins,
        durationMins: serviceBranch.durationMins ?? serviceBranch.service.defaultDurationMins,
        providers: providers.map((provider) => ({
          id: provider.id,
          reservations: provider.appointmentReservations,
          rules: provider.availabilityRules.map(dateRule),
          timeOff: provider.timeOffEntries,
        })),
        requirements: requirements.map((requirement) => ({
          groupId: requirement.resourceGroupId,
          quantity: requirement.quantity,
          resources: requirement.resourceGroup.resources.map((resource) => ({
            id: resource.id,
            reservations: resource.reservations,
            rules: resource.availabilityRules.map(dateRule),
          })),
        })),
        timezone: branch.timezone,
      };
      return calculateAvailableSlots(normalizedQuery, snapshot);
    });
  }

  async listWaitlist(access: TenantAccessSnapshot) {
    const scope = requireScope(access, "waitlist.read");
    return this.runWithAccess(access, async (transaction) =>
      transaction.waitlistEntry.findMany({
        include: {
          branches: { include: { branch: true } },
          customer: { select: { displayName: true, id: true } },
          offers: { include: { attempts: true }, orderBy: { createdAt: "desc" } },
          providers: { include: { provider: true } },
          service: { select: { id: true, nameAr: true, nameEn: true } },
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        where: {
          ...(scope === "ASSIGNED_BRANCHES"
            ? {
                branches: {
                  every: { branchId: { in: [...access.assignedBranchIds] } },
                  some: { branchId: { in: [...access.assignedBranchIds] } },
                },
              }
            : scope === "SELF"
              ? {
                  providers: {
                    every: {
                      providerId: access.staffProfileId ?? "00000000-0000-0000-0000-000000000000",
                    },
                    some: {
                      providerId: access.staffProfileId ?? "00000000-0000-0000-0000-000000000000",
                    },
                  },
                }
              : {}),
          organizationId: access.organizationId,
        },
      }),
    );
  }

  async listWaitlistFormOptions(access: TenantAccessSnapshot) {
    const scope = requireScope(access, "waitlist.manage");
    return this.runWithAccess(access, async (transaction) => {
      const [branches, customers, providers, services] = await Promise.all([
        transaction.branch.findMany({
          orderBy: { nameEn: "asc" },
          select: { id: true, nameAr: true, nameEn: true },
          where: {
            ...(scope === "ORGANIZATION" ? {} : { id: { in: [...access.assignedBranchIds] } }),
            isActive: true,
            organizationId: access.organizationId,
          },
        }),
        transaction.customer.findMany({
          orderBy: { displayName: "asc" },
          select: { displayName: true, id: true },
          take: 200,
          where: { isArchived: false, organizationId: access.organizationId },
        }),
        transaction.staffProfile.findMany({
          orderBy: { displayNameEn: "asc" },
          select: { displayNameAr: true, displayNameEn: true, id: true },
          where: {
            ...(scope === "ASSIGNED_BRANCHES"
              ? {
                  branchAssignments: {
                    some: { branchId: { in: [...access.assignedBranchIds] } },
                  },
                }
              : scope === "SELF"
                ? { id: access.staffProfileId ?? "00000000-0000-0000-0000-000000000000" }
                : {}),
            isBookable: true,
            organizationId: access.organizationId,
          },
        }),
        transaction.service.findMany({
          orderBy: { nameEn: "asc" },
          select: { id: true, nameAr: true, nameEn: true },
          where: {
            ...(scope === "ORGANIZATION"
              ? {}
              : {
                  branches: {
                    some: { branchId: { in: [...access.assignedBranchIds] }, isEnabled: true },
                  },
                }),
            isActive: true,
            organizationId: access.organizationId,
          },
        }),
      ]);
      return { branches, customers, providers, services };
    });
  }

  async createWaitlistEntry(
    access: TenantAccessSnapshot,
    input: WaitlistInput,
    details?: SchedulingAuditDetails,
  ) {
    const branchIds = [...new Set(input.branchIds)];
    const providerIds = [...new Set(input.providerIds ?? [])];
    requireWaitlistScope(access, "waitlist.manage", branchIds, providerIds);
    const startDate = dateOnly(input.preferredStartDate, "preferred start date");
    const endDate = dateOnly(input.preferredEndDate, "preferred end date");
    if (
      branchIds.length < 1 ||
      branchIds.length > 10 ||
      providerIds.length > 20 ||
      endDate < startDate ||
      endDate.getTime() - startDate.getTime() > 180 * 86_400_000 ||
      !Number.isInteger(input.preferredStartMinute) ||
      !Number.isInteger(input.preferredEndMinute) ||
      input.preferredStartMinute < 0 ||
      input.preferredStartMinute >= input.preferredEndMinute ||
      input.preferredEndMinute > 1440 ||
      !Number.isInteger(input.priority) ||
      input.priority < -100 ||
      input.priority > 100 ||
      (input.notes?.trim().length ?? 0) > 500
    ) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Invalid waitlist preferences.",
      });
    }
    return this.runWithAccess(access, async (transaction) => {
      const [customer, service, branches, providers, appointment] = await Promise.all([
        transaction.customer.findFirst({
          where: { id: input.customerId, isArchived: false, organizationId: access.organizationId },
        }),
        transaction.service.findFirst({
          where: { id: input.serviceId, isActive: true, organizationId: access.organizationId },
        }),
        transaction.branch.findMany({
          where: { id: { in: branchIds }, isActive: true, organizationId: access.organizationId },
        }),
        transaction.staffProfile.findMany({
          where: {
            id: { in: providerIds },
            isBookable: true,
            organizationId: access.organizationId,
          },
        }),
        input.appointmentId
          ? transaction.appointment.findFirst({
              where: { id: input.appointmentId, organizationId: access.organizationId },
            })
          : Promise.resolve(null),
      ]);
      if (
        !customer ||
        !service ||
        branches.length !== branchIds.length ||
        providers.length !== providerIds.length ||
        (input.appointmentId &&
          (!appointment ||
            appointment.customerId !== input.customerId ||
            appointment.serviceId !== input.serviceId ||
            !canRescheduleAppointment(appointment.status)))
      ) {
        throw new DomainError({ code: "NOT_FOUND", message: "Waitlist references are invalid." });
      }
      const entry = await transaction.waitlistEntry.create({
        data: {
          appointmentId: input.appointmentId ?? null,
          branches: { create: branchIds.map((branchId) => ({ branchId })) },
          customerId: input.customerId,
          notes: input.notes?.trim() || null,
          organizationId: access.organizationId,
          preferredEndDate: endDate,
          preferredEndMinute: input.preferredEndMinute,
          preferredStartDate: startDate,
          preferredStartMinute: input.preferredStartMinute,
          priority: input.priority,
          providers: { create: providerIds.map((providerId) => ({ providerId })) },
          serviceId: input.serviceId,
        },
      });
      await audit(
        transaction,
        access,
        "WAITLIST_ENTRY_CREATED",
        "WaitlistEntry",
        entry.id,
        details,
      );
      return entry;
    });
  }

  async cancelWaitlistEntry(
    access: TenantAccessSnapshot,
    input: Readonly<{ entryId: string; expectedVersion: number }>,
    details?: SchedulingAuditDetails,
  ) {
    return this.runWithAccess(access, async (transaction) => {
      const entry = await transaction.waitlistEntry.findFirst({
        include: { branches: true, providers: true },
        where: { id: input.entryId, organizationId: access.organizationId },
      });
      if (!entry) {
        throw schedulingConflict("The waitlist entry changed or is no longer active.");
      }
      requireWaitlistScope(
        access,
        "waitlist.manage",
        entry.branches.map(({ branchId }) => branchId),
        entry.providers.map(({ providerId }) => providerId),
      );
      const changed = await transaction.waitlistEntry.updateMany({
        data: { status: "CANCELLED", version: { increment: 1 } },
        where: {
          id: input.entryId,
          organizationId: access.organizationId,
          status: { in: ["ACTIVE", "OFFERED"] },
          version: input.expectedVersion,
        },
      });
      if (changed.count !== 1) {
        throw schedulingConflict("The waitlist entry changed or is no longer active.");
      }
      await transaction.slotOffer.updateMany({
        data: { status: "DECLINED", declinedAt: new Date(), version: { increment: 1 } },
        where: {
          organizationId: access.organizationId,
          status: "PENDING",
          waitlistEntryId: input.entryId,
        },
      });
      await audit(
        transaction,
        access,
        "WAITLIST_ENTRY_CANCELLED",
        "WaitlistEntry",
        input.entryId,
        details,
      );
      return transaction.waitlistEntry.findFirstOrThrow({
        where: { id: input.entryId, organizationId: access.organizationId },
      });
    });
  }

  async sendMockSlotOffer(
    access: TenantAccessSnapshot,
    input: Readonly<{
      branchId: string;
      expiresAt: Date;
      providerId: string;
      startsAtLocal: string;
      waitlistEntryId: string;
    }>,
    details?: SchedulingAuditDetails,
  ) {
    requireScope(access, "slot_offers.manage");
    if (input.expiresAt <= new Date() || input.expiresAt.getTime() > Date.now() + 7 * 86_400_000) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid offer expiry." });
    }
    return this.runWithAccess(access, async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "waitlist_entries"
        WHERE "organization_id" = ${access.organizationId}::uuid
          AND "id" = ${input.waitlistEntryId}::uuid
        FOR UPDATE
      `);
      const entry = await transaction.waitlistEntry.findFirst({
        include: { branches: true, providers: true },
        where: { id: input.waitlistEntryId, organizationId: access.organizationId },
      });
      if (!entry || !["ACTIVE", "OFFERED"].includes(entry.status)) {
        throw schedulingConflict("The waitlist entry is no longer active.");
      }
      if (
        !entry.branches.some(({ branchId }) => branchId === input.branchId) ||
        (entry.providers.length > 0 &&
          !entry.providers.some(({ providerId }) => providerId === input.providerId))
      ) {
        throw new DomainError({ code: "NOT_FOUND", message: "Offer preferences are invalid." });
      }
      requireBranchScope(access, "slot_offers.manage", input.branchId, input.providerId);
      const latestConsent = await transaction.consent.findFirst({
        orderBy: { recordedAt: "desc" },
        where: {
          customerId: entry.customerId,
          organizationId: access.organizationId,
          purpose: "appointment_slot_offers",
        },
      });
      if (latestConsent?.status !== "GRANTED") {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "Current customer consent is required before sending a slot offer.",
        });
      }
      const booking = await prepareBooking(transaction, {
        branchId: input.branchId,
        organizationId: access.organizationId,
        providerId: input.providerId,
        serviceId: entry.serviceId,
        startsAtLocal: input.startsAtLocal,
      });
      const offeredDate = input.startsAtLocal.slice(0, 10);
      const offeredHour = Number(input.startsAtLocal.slice(11, 13));
      const offeredMinute = Number(input.startsAtLocal.slice(14, 16));
      const offeredStartMinute = offeredHour * 60 + offeredMinute;
      const offeredEndMinute =
        offeredStartMinute + (booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000;
      if (
        offeredDate < entry.preferredStartDate.toISOString().slice(0, 10) ||
        offeredDate > entry.preferredEndDate.toISOString().slice(0, 10) ||
        offeredStartMinute < entry.preferredStartMinute ||
        offeredEndMinute > entry.preferredEndMinute
      ) {
        throw new DomainError({
          code: "VALIDATION_FAILED",
          message: "The offered slot is outside the waitlist preferences.",
        });
      }
      await assertBookableSchedule(transaction, booking, entry.appointmentId ?? undefined);
      const offer = await transaction.slotOffer.create({
        data: {
          branchId: input.branchId,
          endsAt: booking.endsAt,
          expiresAt: input.expiresAt,
          organizationId: access.organizationId,
          providerId: input.providerId,
          serviceId: entry.serviceId,
          startsAt: booking.startsAt,
          targetAppointmentId: entry.appointmentId,
          targetAppointmentVersion: entry.appointmentId
            ? await transaction.appointment
                .findFirst({
                  select: { version: true },
                  where: { id: entry.appointmentId, organizationId: access.organizationId },
                })
                .then((appointment) => appointment?.version ?? null)
            : null,
          timezone: booking.timezone,
          waitlistEntryId: entry.id,
        },
      });
      await Promise.all([
        transaction.waitlistEntry.update({
          data: { status: "OFFERED", version: { increment: 1 } },
          where: { id: entry.id },
        }),
        transaction.slotOfferAttempt.create({
          data: {
            actorUserId: access.actorUserId,
            attemptType: "MOCK_SENT",
            organizationId: access.organizationId,
            result: "SUCCEEDED",
            slotOfferId: offer.id,
          },
        }),
        audit(transaction, access, "MOCK_SLOT_OFFER_SENT", "SlotOffer", offer.id, details),
      ]);
      return offer;
    });
  }

  async declineSlotOffer(
    access: TenantAccessSnapshot,
    input: Readonly<{ offerId: string; requestKey: string }>,
    details?: SchedulingAuditDetails,
  ) {
    requireScope(access, "slot_offers.manage");
    return this.runWithAccess(access, async (transaction) => {
      await this.lockOffer(transaction, access.organizationId, input.offerId);
      const offer = await transaction.slotOffer.findFirst({
        where: { id: input.offerId, organizationId: access.organizationId },
      });
      if (!offer) throw new DomainError({ code: "NOT_FOUND", message: "Slot offer not found." });
      requireBranchScope(access, "slot_offers.manage", offer.branchId, offer.providerId);
      const prior = await transaction.slotOfferAttempt.findFirst({
        where: {
          attemptType: "DECLINED",
          organizationId: access.organizationId,
          requestKey: input.requestKey,
          slotOfferId: offer.id,
        },
      });
      if (prior && offer.status === "DECLINED") return offer;
      if (offer.status !== "PENDING") {
        throw schedulingConflict("The slot offer has already been resolved.");
      }
      const updated = await transaction.slotOffer.update({
        data: { declinedAt: new Date(), status: "DECLINED", version: { increment: 1 } },
        where: { id: offer.id },
      });
      await Promise.all([
        transaction.waitlistEntry.updateMany({
          data: { status: "ACTIVE", version: { increment: 1 } },
          where: {
            id: offer.waitlistEntryId,
            organizationId: access.organizationId,
            status: "OFFERED",
          },
        }),
        transaction.slotOfferAttempt.create({
          data: {
            actorUserId: access.actorUserId,
            attemptType: "DECLINED",
            organizationId: access.organizationId,
            requestKey: input.requestKey,
            result: "SUCCEEDED",
            slotOfferId: offer.id,
          },
        }),
        audit(transaction, access, "SLOT_OFFER_DECLINED", "SlotOffer", offer.id, details),
      ]);
      return updated;
    });
  }

  async expireSlotOffer(
    access: TenantAccessSnapshot,
    offerId: string,
    now = new Date(),
    details?: SchedulingAuditDetails,
  ) {
    requireScope(access, "slot_offers.manage");
    return this.runWithAccess(access, async (transaction) => {
      await this.lockOffer(transaction, access.organizationId, offerId);
      const offer = await transaction.slotOffer.findFirst({
        where: { id: offerId, organizationId: access.organizationId },
      });
      if (!offer) throw new DomainError({ code: "NOT_FOUND", message: "Slot offer not found." });
      requireBranchScope(access, "slot_offers.manage", offer.branchId, offer.providerId);
      if (offer.status === "EXPIRED") return offer;
      if (offer.status !== "PENDING") {
        throw schedulingConflict("The slot offer has already been resolved.");
      }
      if (offer.expiresAt > now) {
        throw new DomainError({ code: "CONFLICT", message: "The slot offer has not expired yet." });
      }
      const updated = await transaction.slotOffer.update({
        data: { status: "EXPIRED", version: { increment: 1 } },
        where: { id: offer.id },
      });
      await Promise.all([
        transaction.waitlistEntry.updateMany({
          data: { status: "ACTIVE", version: { increment: 1 } },
          where: {
            id: offer.waitlistEntryId,
            organizationId: access.organizationId,
            status: "OFFERED",
          },
        }),
        transaction.slotOfferAttempt.create({
          data: {
            actorUserId: access.actorUserId,
            attemptType: "EXPIRED",
            organizationId: access.organizationId,
            result: "SUCCEEDED",
            slotOfferId: offer.id,
          },
        }),
        audit(transaction, access, "SLOT_OFFER_EXPIRED", "SlotOffer", offer.id, details),
      ]);
      return updated;
    });
  }

  async acceptSlotOffer(
    access: TenantAccessSnapshot,
    input: Readonly<{ offerId: string; requestKey: string }>,
    details?: SchedulingAuditDetails,
  ) {
    requireScope(access, "slot_offers.manage");
    const requestFingerprint = fingerprint({ offerId: input.offerId });
    const outcome = await this.runWithAccess(access, async (transaction) => {
      await this.lockOffer(transaction, access.organizationId, input.offerId);
      const offer = await transaction.slotOffer.findFirst({
        include: { waitlistEntry: true },
        where: { id: input.offerId, organizationId: access.organizationId },
      });
      if (!offer) throw new DomainError({ code: "NOT_FOUND", message: "Slot offer not found." });
      requireBranchScope(access, "slot_offers.manage", offer.branchId, offer.providerId);
      if (offer.status === "ACCEPTED") {
        if (
          offer.acceptedRequestKey === input.requestKey &&
          offer.acceptedFingerprint === requestFingerprint &&
          offer.acceptedAppointmentId
        ) {
          return { appointmentId: offer.acceptedAppointmentId } as const;
        }
        throw schedulingConflict("The slot offer has already been accepted.");
      }
      if (offer.status !== "PENDING") {
        throw schedulingConflict("The slot offer is no longer available.");
      }
      if (offer.expiresAt <= new Date()) {
        await Promise.all([
          transaction.slotOffer.update({
            data: { status: "EXPIRED", version: { increment: 1 } },
            where: { id: offer.id },
          }),
          transaction.waitlistEntry.updateMany({
            data: { status: "ACTIVE", version: { increment: 1 } },
            where: {
              id: offer.waitlistEntryId,
              organizationId: access.organizationId,
              status: "OFFERED",
            },
          }),
          transaction.slotOfferAttempt.create({
            data: {
              actorUserId: access.actorUserId,
              attemptType: "EXPIRED",
              organizationId: access.organizationId,
              reason: "Acceptance attempted after expiry",
              requestKey: input.requestKey,
              requestFingerprint,
              result: "REJECTED",
              slotOfferId: offer.id,
            },
          }),
        ]);
        return { expired: true } as const;
      }
      const local = new Intl.DateTimeFormat("en-CA", {
        day: "2-digit",
        hour: "2-digit",
        hour12: false,
        hourCycle: "h23",
        minute: "2-digit",
        month: "2-digit",
        timeZone: offer.timezone,
        year: "numeric",
      });
      const parts = Object.fromEntries(
        local
          .formatToParts(offer.startsAt)
          .filter(({ type }) => type !== "literal")
          .map(({ type, value }) => [type, value]),
      );
      const startsAtLocal = `${parts.year}-${parts.month}-${parts.day}T${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
      let appointment;
      if (offer.targetAppointmentId && offer.targetAppointmentVersion) {
        const current = await transaction.appointment.findFirst({
          where: {
            id: offer.targetAppointmentId,
            organizationId: access.organizationId,
          },
        });
        if (!current || !canRescheduleAppointment(current.status)) {
          throw schedulingConflict("The appointment can no longer be rescheduled.");
        }
        appointment = await rescheduleAppointmentRows(transaction, {
          actorUserId: access.actorUserId,
          appointmentId: current.id,
          expectedVersion: offer.targetAppointmentVersion,
          organizationId: access.organizationId,
          startsAtLocal,
        });
      } else {
        appointment = await createAppointmentRows(transaction, {
          actorUserId: access.actorUserId,
          appointmentId: randomUUID(),
          branchId: offer.branchId,
          customerId: offer.waitlistEntry.customerId,
          organizationId: access.organizationId,
          providerId: offer.providerId,
          serviceId: offer.serviceId,
          source: AppointmentSource.STAFF,
          startsAtLocal,
          status: AppointmentStatus.CONFIRMED,
        });
      }
      await Promise.all([
        transaction.slotOffer.update({
          data: {
            acceptedAppointmentId: appointment.id,
            acceptedAt: new Date(),
            acceptedFingerprint: requestFingerprint,
            acceptedRequestKey: input.requestKey,
            status: "ACCEPTED",
            version: { increment: 1 },
          },
          where: { id: offer.id },
        }),
        transaction.waitlistEntry.update({
          data: { status: "FULFILLED", version: { increment: 1 } },
          where: { id: offer.waitlistEntryId },
        }),
        transaction.slotOfferAttempt.create({
          data: {
            actorUserId: access.actorUserId,
            attemptType: "ACCEPTED",
            organizationId: access.organizationId,
            requestFingerprint,
            requestKey: input.requestKey,
            result: "SUCCEEDED",
            slotOfferId: offer.id,
          },
        }),
        transaction.attributionEvent.create({
          data: {
            appointmentId: appointment.id,
            customerId: offer.waitlistEntry.customerId,
            occurredAt: new Date(),
            organizationId: access.organizationId,
            source: "WAITLIST_CONVERSION",
            sourceDetail: "Accepted slot offer",
          },
        }),
        audit(transaction, access, "SLOT_OFFER_ACCEPTED", "SlotOffer", offer.id, details),
        audit(
          transaction,
          access,
          offer.targetAppointmentId
            ? "APPOINTMENT_RESCHEDULED_FROM_SLOT_OFFER"
            : "APPOINTMENT_CREATED_FROM_SLOT_OFFER",
          "Appointment",
          appointment.id,
          details,
        ),
      ]);
      return { appointmentId: appointment.id } as const;
    });
    if ("expired" in outcome) {
      throw schedulingConflict("The slot offer expired before it could be accepted.");
    }
    return this.runWithAccess(access, async (transaction) =>
      transaction.appointment.findFirstOrThrow({
        where: { id: outcome.appointmentId, organizationId: access.organizationId },
      }),
    );
  }

  private async lockOffer(
    transaction: TenantTransaction,
    organizationId: string,
    offerId: string,
  ): Promise<void> {
    await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "slot_offers"
      WHERE "organization_id" = ${organizationId}::uuid AND "id" = ${offerId}::uuid
      FOR UPDATE
    `);
  }
}
