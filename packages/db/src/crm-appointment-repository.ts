import { createHash, randomUUID } from "node:crypto";

import {
  assertAppointmentTransition,
  canRescheduleAppointment,
  type AppointmentStatusValue,
} from "@jormall/domain/appointment-state";
import { DomainError } from "@jormall/domain/errors";
import { normalizeJordanianPhone } from "@jormall/domain/jordan-phone";
import {
  localDateForInstant,
  localDateTimePartsForInstant,
  utcRangeForLocalDate,
} from "@jormall/domain/timezone";
import type {
  PermissionCode,
  PermissionScope,
  TenantAccessSnapshot,
} from "@jormall/domain/identity";

import {
  AppointmentHistoryType,
  AppointmentSource,
  AppointmentStatus,
  ConsentStatus,
  CustomerContactKind,
  MembershipStatus,
  OrganizationStatus,
  PlatformRole,
  Prisma,
  type PrismaClient,
  type SupportedLocale,
} from "./generated/prisma/client";
import type { ConsentChannel, ConsentSource } from "./generated/prisma/client";
import {
  assertBookableSchedule,
  createAppointmentRows,
  prepareBooking,
  reserveRequiredResources,
  rescheduleAppointmentRows,
  schedulingConflict,
} from "./scheduling-transaction";
import { runInTenant, type TenantTransaction } from "./tenant-context";

export type RequestAuditDetails = Readonly<{
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}>;

export type CustomerInput = Readonly<{
  displayName: string;
  phoneOriginal?: string | undefined;
  preferredLocale?: SupportedLocale | undefined;
}>;

export type CustomerUpdateInput = CustomerInput &
  Readonly<{
    customerId: string;
    expectedVersion: number;
  }>;

export type ConsentInput = Readonly<{
  channel: ConsentChannel;
  customerId: string;
  evidence?: string | undefined;
  purpose: string;
  source: ConsentSource;
  status: ConsentStatus;
  textVersion: string;
  revokesConsentId?: string | undefined;
}>;

export type AppointmentCreateInput = Readonly<{
  branchId: string;
  customerId: string;
  idempotencyKey?: string | undefined;
  providerId: string;
  serviceId: string;
  source?: AppointmentSource | undefined;
  startsAtLocal: string;
  status?: Extract<AppointmentStatusValue, "PENDING" | "CONFIRMED"> | undefined;
}>;

export type AppointmentRescheduleInput = Readonly<{
  appointmentId: string;
  expectedVersion: number;
  idempotencyKey?: string | undefined;
  startsAtLocal: string;
}>;

export type AppointmentTransitionInput = Readonly<{
  appointmentId: string;
  expectedVersion: number;
  idempotencyKey?: string | undefined;
  reason?: string | undefined;
  recordDetails?: string | undefined;
  recordSummary?: string | undefined;
  toStatus: AppointmentStatusValue;
}>;

export type AppointmentFilters = Readonly<{
  branchId?: string | undefined;
  day?: string | undefined;
  providerId?: string | undefined;
  serviceId?: string | undefined;
  status?: AppointmentStatus | undefined;
}>;

type Resource = Readonly<{ branchId: string; providerId: string }>;

const permissionScopeRank: Readonly<Record<PermissionScope, number>> = {
  ASSIGNED_BRANCHES: 2,
  ORGANIZATION: 3,
  SELF: 1,
};

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

function requirePermissionScope(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
): PermissionScope {
  const scope = access.grants
    .filter((grant) => grant.code === permission)
    .toSorted(
      (left, right) => permissionScopeRank[right.scope] - permissionScopeRank[left.scope],
    )[0]?.scope;
  if (!scope) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "The active tenant context does not grant this permission.",
      metadata: { permission },
    });
  }
  return scope;
}

function requireResourcePermission(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
  resource: Resource,
): PermissionScope {
  const scope = requirePermissionScope(access, permission);
  if (scope === "ORGANIZATION") {
    return scope;
  }
  if (scope === "ASSIGNED_BRANCHES" && access.assignedBranchIds.includes(resource.branchId)) {
    return scope;
  }
  if (scope === "SELF" && access.staffProfileId === resource.providerId) {
    return scope;
  }
  throw new DomainError({
    code: "FORBIDDEN",
    message: "The active tenant context cannot access this appointment.",
    metadata: { permission },
  });
}

function requireAnyResourcePermission(
  access: TenantAccessSnapshot,
  permissions: readonly PermissionCode[],
  resource: Resource,
): PermissionScope {
  let denial: DomainError | undefined;
  for (const permission of permissions) {
    try {
      return requireResourcePermission(access, permission, resource);
    } catch (error) {
      if (error instanceof DomainError && error.code === "FORBIDDEN") {
        denial = error;
        continue;
      }
      throw error;
    }
  }
  throw (
    denial ??
    new DomainError({
      code: "FORBIDDEN",
      message: "The active tenant context cannot access this appointment.",
    })
  );
}

function resourceWhere(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
): Prisma.AppointmentWhereInput {
  const scope = requirePermissionScope(access, permission);
  if (scope === "ORGANIZATION") {
    return {};
  }
  if (scope === "ASSIGNED_BRANCHES") {
    return { branchId: { in: [...access.assignedBranchIds] } };
  }
  if (!access.staffProfileId) {
    return { id: "00000000-0000-0000-0000-000000000000" };
  }
  return { providerId: access.staffProfileId };
}

function requireTrimmed(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: `Invalid ${field}.` });
  }
  return trimmed;
}

function assertExpectedVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid record version." });
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function conflict(message: string): DomainError {
  return new DomainError({ code: "CONFLICT", message, retryable: true });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function asAppointmentStatus(value: AppointmentStatus): AppointmentStatusValue {
  return value as AppointmentStatusValue;
}

async function createAuditEvent(
  transaction: TenantTransaction,
  access: TenantAccessSnapshot,
  action: string,
  targetType: string,
  targetId: string,
  details?: RequestAuditDetails,
  reason?: string,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      action,
      actorUserId: access.actorUserId,
      ipAddress: details?.ipAddress ?? null,
      organizationId: access.organizationId,
      reason: reason ?? null,
      supportAccessId: access.supportAccessId ?? null,
      targetId,
      targetType,
      userAgent: details?.userAgent ?? null,
    },
  });
}

type IdempotencyReservation = Readonly<{ appointmentId: string; replayed: boolean }>;

async function reserveIdempotency(
  transaction: TenantTransaction,
  access: TenantAccessSnapshot,
  input: Readonly<{
    appointmentId: string;
    key?: string | undefined;
    operation: string;
    payload: unknown;
  }>,
): Promise<IdempotencyReservation> {
  if (!input.key) {
    return { appointmentId: input.appointmentId, replayed: false };
  }
  const requestFingerprint = fingerprint(input.payload);
  const inserted = await transaction.$queryRaw<Array<{ appointmentId: string }>>(Prisma.sql`
    INSERT INTO "appointment_idempotencies" (
      "organization_id", "operation", "request_key", "request_fingerprint",
      "appointment_id", "expires_at"
    ) VALUES (
      ${access.organizationId}::uuid, ${input.operation}, ${input.key}::uuid,
      ${requestFingerprint}, ${input.appointmentId}::uuid,
      ${new Date(Date.now() + 24 * 60 * 60 * 1000)}
    )
    ON CONFLICT ("organization_id", "operation", "request_key") DO NOTHING
    RETURNING "appointment_id" AS "appointmentId"
  `);
  if (inserted.length === 1) {
    return { appointmentId: input.appointmentId, replayed: false };
  }
  const prior = await transaction.appointmentIdempotency.findFirst({
    where: {
      operation: input.operation,
      organizationId: access.organizationId,
      requestKey: input.key,
    },
  });
  if (!prior || prior.requestFingerprint !== requestFingerprint) {
    throw new DomainError({
      code: "IDEMPOTENCY_CONFLICT",
      message: "This request key was already used for a different operation.",
    });
  }
  return { appointmentId: prior.appointmentId, replayed: true };
}

export class CrmAppointmentRepository {
  readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  private async assertSuperAdmin(userId: string): Promise<void> {
    const user = await this.client.user.findUnique({
      select: { platformRole: true },
      where: { id: userId },
    });
    if (user?.platformRole !== PlatformRole.JORMALL_SUPER_ADMIN) {
      throw new DomainError({ code: "FORBIDDEN", message: "Super Admin access is required." });
    }
  }

  private async runWithAccess<T>(
    access: TenantAccessSnapshot,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    if (access.supportAccessId) {
      await this.assertSuperAdmin(access.actorUserId);
      const supportAccess = await this.client.platformSupportAccess.findFirst({
        select: { id: true },
        where: {
          expiresAt: { gt: new Date() },
          id: access.supportAccessId,
          organizationId: access.organizationId,
          revokedAt: null,
          userId: access.actorUserId,
        },
      });
      if (!supportAccess) {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "Support access is invalid or expired.",
        });
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
      assertActiveOrganization(organization.status);
      if (access.membershipId) {
        const membership = await transaction.organizationMembership.findFirst({
          select: { status: true },
          where: {
            id: access.membershipId,
            organizationId: access.organizationId,
            userId: access.actorUserId,
          },
        });
        if (!membership) {
          throw new DomainError({ code: "NOT_FOUND", message: "Membership not found." });
        }
        if (membership.status !== MembershipStatus.ACTIVE) {
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
          message: "An active membership or support access is required.",
        });
      }
      return operation(transaction);
    });
  }

  async listCustomers(access: TenantAccessSnapshot, query?: string) {
    const appointmentAccess = resourceWhere(access, "customers.read");
    const searched = query?.trim();
    const normalizedPhone = searched ? normalizeJordanianPhone(searched) : null;
    return this.runWithAccess(access, (transaction) =>
      transaction.customer.findMany({
        include: {
          contacts: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            select: {
              id: true,
              isPrimary: true,
              kind: true,
              normalizedPhoneE164: true,
              originalValue: true,
            },
          },
        },
        orderBy: [{ isArchived: "asc" }, { displayName: "asc" }],
        take: 100,
        where: {
          organizationId: access.organizationId,
          ...(Object.keys(appointmentAccess).length
            ? { appointments: { some: appointmentAccess } }
            : {}),
          ...(searched
            ? {
                OR: [
                  { displayName: { contains: searched, mode: "insensitive" } },
                  ...(normalizedPhone
                    ? [{ contacts: { some: { normalizedPhoneE164: normalizedPhone } } }]
                    : []),
                ],
              }
            : {}),
        },
      }),
    );
  }

  async getCustomer(access: TenantAccessSnapshot, customerId: string) {
    requirePermissionScope(access, "customers.read");
    requirePermissionScope(access, "consent.read");
    const appointmentAccess = resourceWhere(access, "appointments.read");
    return this.runWithAccess(access, async (transaction) => {
      const customer = await transaction.customer.findFirst({
        include: {
          appointments: {
            include: {
              branch: { select: { id: true, nameAr: true, nameEn: true, timezone: true } },
              provider: { select: { id: true, displayNameAr: true, displayNameEn: true } },
              service: { select: { id: true, nameAr: true, nameEn: true } },
            },
            orderBy: { startsAt: "desc" },
            take: 50,
            where: appointmentAccess,
          },
          consents: { orderBy: { recordedAt: "desc" } },
          contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        },
        where: {
          id: customerId,
          organizationId: access.organizationId,
          ...(Object.keys(appointmentAccess).length
            ? { appointments: { some: appointmentAccess } }
            : {}),
        },
      });
      if (!customer) {
        throw new DomainError({ code: "NOT_FOUND", message: "Customer not found." });
      }
      return customer;
    });
  }

  async createCustomer(
    access: TenantAccessSnapshot,
    input: CustomerInput,
    details?: RequestAuditDetails,
  ) {
    requirePermissionScope(access, "customers.write");
    const displayName = requireTrimmed(input.displayName, "customer name", 160);
    const phoneOriginal = input.phoneOriginal?.trim() || undefined;
    if (phoneOriginal && phoneOriginal.length > 80) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid customer phone." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const customer = await transaction.customer.create({
        data: {
          displayName,
          organizationId: access.organizationId,
          preferredLocale: input.preferredLocale ?? "en",
          ...(phoneOriginal
            ? {
                contacts: {
                  create: {
                    isPrimary: true,
                    kind: CustomerContactKind.PHONE,
                    normalizedPhoneE164: normalizeJordanianPhone(phoneOriginal),
                    originalValue: phoneOriginal,
                  },
                },
              }
            : {}),
        },
        include: { contacts: true },
      });
      await createAuditEvent(
        transaction,
        access,
        "CUSTOMER_CREATED",
        "Customer",
        customer.id,
        details,
      );
      return {
        customer,
        likelyDuplicates: await this.findLikelyDuplicatesInTransaction(
          transaction,
          access.organizationId,
          {
            displayName,
            normalizedPhone: phoneOriginal ? normalizeJordanianPhone(phoneOriginal) : null,
            omitCustomerId: customer.id,
          },
        ),
      };
    });
  }

  async updateCustomer(
    access: TenantAccessSnapshot,
    input: CustomerUpdateInput,
    details?: RequestAuditDetails,
  ) {
    requirePermissionScope(access, "customers.write");
    assertExpectedVersion(input.expectedVersion);
    const displayName = requireTrimmed(input.displayName, "customer name", 160);
    const phoneOriginal = input.phoneOriginal?.trim() || undefined;
    if (phoneOriginal && phoneOriginal.length > 80) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid customer phone." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const current = await transaction.customer.findFirst({
        include: { contacts: { where: { isPrimary: true, kind: CustomerContactKind.PHONE } } },
        where: { id: input.customerId, organizationId: access.organizationId },
      });
      if (!current) {
        throw new DomainError({ code: "NOT_FOUND", message: "Customer not found." });
      }
      const changed = await transaction.customer.updateMany({
        data: {
          displayName,
          preferredLocale: input.preferredLocale ?? "en",
          version: { increment: 1 },
        },
        where: {
          id: input.customerId,
          organizationId: access.organizationId,
          version: input.expectedVersion,
        },
      });
      if (changed.count !== 1) {
        throw conflict("Customer changed by another user. Refresh and try again.");
      }
      const primaryPhone = current.contacts[0];
      if (phoneOriginal) {
        const contact = {
          normalizedPhoneE164: normalizeJordanianPhone(phoneOriginal),
          originalValue: phoneOriginal,
        };
        if (primaryPhone) {
          await transaction.customerContact.update({
            data: contact,
            where: { id: primaryPhone.id },
          });
        } else {
          await transaction.customerContact.create({
            data: {
              ...contact,
              customerId: input.customerId,
              isPrimary: true,
              kind: CustomerContactKind.PHONE,
              organizationId: access.organizationId,
            },
          });
        }
      } else if (primaryPhone) {
        await transaction.customerContact.delete({ where: { id: primaryPhone.id } });
      }
      const customer = await transaction.customer.findFirstOrThrow({
        include: { contacts: true },
        where: { id: input.customerId, organizationId: access.organizationId },
      });
      await createAuditEvent(
        transaction,
        access,
        "CUSTOMER_UPDATED",
        "Customer",
        customer.id,
        details,
      );
      return {
        customer,
        likelyDuplicates: await this.findLikelyDuplicatesInTransaction(
          transaction,
          access.organizationId,
          {
            displayName,
            normalizedPhone: phoneOriginal ? normalizeJordanianPhone(phoneOriginal) : null,
            omitCustomerId: customer.id,
          },
        ),
      };
    });
  }

  async recordConsent(
    access: TenantAccessSnapshot,
    input: ConsentInput,
    details?: RequestAuditDetails,
  ) {
    requirePermissionScope(access, "consent.record");
    const purpose = requireTrimmed(input.purpose, "consent purpose", 120);
    const textVersion = requireTrimmed(input.textVersion, "consent version", 80);
    const evidence = input.evidence?.trim() || null;
    if (evidence && evidence.length > 2_000) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Consent evidence is too long.",
      });
    }
    return this.runWithAccess(access, async (transaction) => {
      const customer = await transaction.customer.findFirst({
        select: { id: true },
        where: { id: input.customerId, organizationId: access.organizationId },
      });
      if (!customer) {
        throw new DomainError({ code: "NOT_FOUND", message: "Customer not found." });
      }
      if (input.status === ConsentStatus.REVOKED && !input.revokesConsentId) {
        throw new DomainError({
          code: "VALIDATION_FAILED",
          message: "A revoked consent must reference consent.",
        });
      }
      if (input.revokesConsentId) {
        const prior = await transaction.consent.findFirst({
          select: { customerId: true, purpose: true, status: true },
          where: { id: input.revokesConsentId, organizationId: access.organizationId },
        });
        if (
          !prior ||
          prior.customerId !== input.customerId ||
          prior.purpose !== purpose ||
          prior.status !== ConsentStatus.GRANTED
        ) {
          throw new DomainError({ code: "CONFLICT", message: "The consent cannot be revoked." });
        }
      }
      const consent = await transaction.consent.create({
        data: {
          actorUserId: access.actorUserId,
          channel: input.channel,
          customerId: input.customerId,
          evidence,
          organizationId: access.organizationId,
          purpose,
          revokesConsentId: input.revokesConsentId ?? null,
          source: input.source,
          status: input.status,
          textVersion,
        },
      });
      await createAuditEvent(
        transaction,
        access,
        input.status === ConsentStatus.REVOKED ? "CONSENT_REVOKED" : "CONSENT_RECORDED",
        "Consent",
        consent.id,
        details,
      );
      return consent;
    });
  }

  async listAppointmentFormOptions(access: TenantAccessSnapshot) {
    requirePermissionScope(access, "appointments.create");
    requirePermissionScope(access, "customers.read");
    return this.runWithAccess(access, async (transaction) => {
      const [customers, branches, services, providers] = await Promise.all([
        transaction.customer.findMany({
          orderBy: { displayName: "asc" },
          select: { displayName: true, id: true },
          take: 100,
          where: { isArchived: false, organizationId: access.organizationId },
        }),
        transaction.branch.findMany({
          orderBy: { nameEn: "asc" },
          select: { id: true, nameAr: true, nameEn: true, timezone: true },
          where: { isActive: true, organizationId: access.organizationId },
        }),
        transaction.service.findMany({
          orderBy: { nameEn: "asc" },
          select: { id: true, nameAr: true, nameEn: true },
          where: { isActive: true, organizationId: access.organizationId },
        }),
        transaction.staffProfile.findMany({
          orderBy: { displayNameEn: "asc" },
          select: { id: true, displayNameAr: true, displayNameEn: true },
          where: { isBookable: true, organizationId: access.organizationId },
        }),
      ]);
      return { branches, customers, providers, services };
    });
  }

  async createAppointment(
    access: TenantAccessSnapshot,
    input: AppointmentCreateInput,
    details?: RequestAuditDetails,
  ) {
    requireResourcePermission(access, "appointments.create", input);
    const appointmentId = randomUUID();
    const status = input.status ?? "CONFIRMED";
    return this.runWithAccess(access, async (transaction) => {
      const reservation = await reserveIdempotency(transaction, access, {
        appointmentId,
        key: input.idempotencyKey,
        operation: "CREATE",
        payload: { ...input, status },
      });
      if (reservation.replayed) {
        const prior = await transaction.appointment.findFirst({
          where: { id: reservation.appointmentId, organizationId: access.organizationId },
        });
        if (!prior) {
          throw conflict("The prior appointment request did not complete.");
        }
        return prior;
      }
      const appointment = await createAppointmentRows(transaction, {
        actorUserId: access.actorUserId,
        appointmentId,
        branchId: input.branchId,
        customerId: input.customerId,
        organizationId: access.organizationId,
        providerId: input.providerId,
        serviceId: input.serviceId,
        source: input.source ?? AppointmentSource.STAFF,
        startsAtLocal: input.startsAtLocal,
        status: status as AppointmentStatus,
      });
      await createAuditEvent(
        transaction,
        access,
        "APPOINTMENT_CREATED",
        "Appointment",
        appointment.id,
        details,
      );
      return appointment;
    });
  }

  async listAppointments(access: TenantAccessSnapshot, filters: AppointmentFilters = {}) {
    const accessFilter = resourceWhere(access, "appointments.read");
    return this.runWithAccess(access, async (transaction) => {
      const scope = requirePermissionScope(access, "appointments.read");
      if (
        scope === "ASSIGNED_BRANCHES" &&
        filters.branchId &&
        !access.assignedBranchIds.includes(filters.branchId)
      ) {
        throw new DomainError({ code: "FORBIDDEN", message: "Branch access is not granted." });
      }
      if (scope === "SELF" && filters.providerId && filters.providerId !== access.staffProfileId) {
        throw new DomainError({ code: "FORBIDDEN", message: "Provider access is not granted." });
      }
      let dayRange: Readonly<{ endsAt: Date; startsAt: Date }> | undefined;
      if (filters.day) {
        const timezone = filters.branchId
          ? await transaction.branch
              .findFirst({
                select: { timezone: true },
                where: { id: filters.branchId, organizationId: access.organizationId },
              })
              .then((branch) => branch?.timezone)
          : await transaction.organizationSettings
              .findFirst({
                select: { timezone: true },
                where: { organizationId: access.organizationId },
              })
              .then((settings) => settings?.timezone ?? "Asia/Amman");
        if (!timezone) {
          throw new DomainError({ code: "NOT_FOUND", message: "Branch not found." });
        }
        dayRange = utcRangeForLocalDate(filters.day, timezone);
      }
      const appointments = await transaction.appointment.findMany({
        include: {
          branch: { select: { id: true, nameAr: true, nameEn: true, timezone: true } },
          customer: { select: { displayName: true, id: true } },
          provider: { select: { displayNameAr: true, displayNameEn: true, id: true } },
          resourceReservations: { select: { id: true, resourceGroupId: true, resourceId: true } },
          service: { select: { id: true, nameAr: true, nameEn: true } },
        },
        orderBy: { startsAt: "asc" },
        where: {
          ...accessFilter,
          ...(filters.branchId ? { branchId: filters.branchId } : {}),
          ...(filters.providerId ? { providerId: filters.providerId } : {}),
          ...(filters.serviceId ? { serviceId: filters.serviceId } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(dayRange ? { startsAt: { gte: dayRange.startsAt, lt: dayRange.endsAt } } : {}),
          organizationId: access.organizationId,
        },
      });
      const requirements = await transaction.serviceResourceRequirement.findMany({
        select: { branchId: true, quantity: true, serviceId: true },
        where: {
          OR: appointments.map(({ branchId, serviceId }) => ({ branchId, serviceId })),
          organizationId: access.organizationId,
        },
      });
      const requiredByServiceBranch = new Map<string, number>();
      for (const requirement of requirements) {
        const key = `${requirement.branchId}:${requirement.serviceId}`;
        requiredByServiceBranch.set(
          key,
          (requiredByServiceBranch.get(key) ?? 0) + requirement.quantity,
        );
      }
      return appointments.map((appointment) => {
        const required =
          requiredByServiceBranch.get(`${appointment.branchId}:${appointment.serviceId}`) ?? 0;
        const released = ["COMPLETED", "CANCELLED", "NO_SHOW"].includes(appointment.status);
        return {
          ...appointment,
          conflictIndicator: released
            ? ("RELEASED" as const)
            : appointment.resourceReservations.length >= required
              ? ("PROTECTED" as const)
              : ("MISSING_RESOURCE" as const),
          requiredResourceCount: required,
        };
      });
    });
  }

  async getAppointment(access: TenantAccessSnapshot, appointmentId: string) {
    const accessFilter = resourceWhere(access, "appointments.read");
    return this.runWithAccess(access, async (transaction) => {
      const appointment = await transaction.appointment.findFirst({
        include: {
          branch: { select: { id: true, nameAr: true, nameEn: true, timezone: true } },
          customer: { select: { displayName: true, id: true } },
          history: { orderBy: { createdAt: "desc" } },
          provider: { select: { displayNameAr: true, displayNameEn: true, id: true } },
          service: { select: { id: true, nameAr: true, nameEn: true } },
        },
        where: { ...accessFilter, id: appointmentId, organizationId: access.organizationId },
      });
      if (!appointment) {
        throw new DomainError({ code: "NOT_FOUND", message: "Appointment not found." });
      }
      return appointment;
    });
  }

  async getAppointmentOperationalDetail(access: TenantAccessSnapshot, appointmentId: string) {
    return this.runWithAccess(access, async (transaction) => {
      const basic = await transaction.appointment.findFirst({
        select: { branchId: true, id: true, providerId: true },
        where: { id: appointmentId, organizationId: access.organizationId },
      });
      if (!basic) {
        throw new DomainError({ code: "NOT_FOUND", message: "Appointment not found." });
      }
      requireResourcePermission(access, "appointment_records.read", basic);
      return transaction.appointment.findFirstOrThrow({
        include: {
          notes: {
            include: { author: { select: { email: true, id: true, name: true } } },
            orderBy: { createdAt: "desc" },
          },
          record: true,
        },
        where: { id: basic.id, organizationId: access.organizationId },
      });
    });
  }

  /** This intentionally never selects internal notes or operational records. */
  async getPublicAppointmentProjection(access: TenantAccessSnapshot, appointmentId: string) {
    const accessFilter = resourceWhere(access, "appointments.read");
    return this.runWithAccess(access, async (transaction) => {
      const appointment = await transaction.appointment.findFirst({
        select: {
          branch: { select: { nameAr: true, nameEn: true, timezone: true } },
          customer: { select: { displayName: true } },
          endsAt: true,
          id: true,
          provider: { select: { displayNameAr: true, displayNameEn: true } },
          service: { select: { nameAr: true, nameEn: true } },
          startsAt: true,
          status: true,
        },
        where: { ...accessFilter, id: appointmentId, organizationId: access.organizationId },
      });
      if (!appointment) {
        throw new DomainError({ code: "NOT_FOUND", message: "Appointment not found." });
      }
      return appointment;
    });
  }

  async rescheduleAppointment(
    access: TenantAccessSnapshot,
    input: AppointmentRescheduleInput,
    details?: RequestAuditDetails,
  ) {
    assertExpectedVersion(input.expectedVersion);
    return this.runWithAccess(access, async (transaction) => {
      const current = await transaction.appointment.findFirst({
        where: { id: input.appointmentId, organizationId: access.organizationId },
      });
      if (!current) {
        throw new DomainError({ code: "NOT_FOUND", message: "Appointment not found." });
      }
      requireResourcePermission(access, "appointments.reschedule", current);
      if (!canRescheduleAppointment(asAppointmentStatus(current.status))) {
        throw conflict("Only pending or confirmed appointments can be rescheduled.");
      }
      const idempotency = await reserveIdempotency(transaction, access, {
        appointmentId: current.id,
        key: input.idempotencyKey,
        operation: "RESCHEDULE",
        payload: input,
      });
      if (idempotency.replayed) {
        return current;
      }
      const appointment = await rescheduleAppointmentRows(transaction, {
        actorUserId: access.actorUserId,
        appointmentId: current.id,
        expectedVersion: input.expectedVersion,
        organizationId: access.organizationId,
        startsAtLocal: input.startsAtLocal,
      });
      await createAuditEvent(
        transaction,
        access,
        "APPOINTMENT_RESCHEDULED",
        "Appointment",
        current.id,
        details,
      );
      return appointment;
    });
  }

  async transitionAppointment(
    access: TenantAccessSnapshot,
    input: AppointmentTransitionInput,
    details?: RequestAuditDetails,
  ) {
    assertExpectedVersion(input.expectedVersion);
    const reason = input.reason?.trim() || undefined;
    if (reason && reason.length > 500) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Reason is too long." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const current = await transaction.appointment.findFirst({
        include: { reservation: true },
        where: { id: input.appointmentId, organizationId: access.organizationId },
      });
      if (!current) {
        throw new DomainError({ code: "NOT_FOUND", message: "Appointment not found." });
      }
      const idempotency = await reserveIdempotency(transaction, access, {
        appointmentId: current.id,
        key: input.idempotencyKey,
        operation: `TRANSITION:${input.toStatus}`,
        payload: input,
      });
      if (idempotency.replayed) {
        requireAnyResourcePermission(
          access,
          input.toStatus === "CANCELLED"
            ? ["appointments.cancel"]
            : input.toStatus === "CHECKED_IN"
              ? ["appointments.status.transition", "appointments.status.correct"]
              : ["appointments.status.transition"],
          current,
        );
        return current;
      }
      const permission =
        current.status === AppointmentStatus.NO_SHOW && input.toStatus === "CHECKED_IN"
          ? "appointments.status.correct"
          : input.toStatus === "CANCELLED"
            ? "appointments.cancel"
            : "appointments.status.transition";
      requireResourcePermission(access, permission, current);
      assertAppointmentTransition(asAppointmentStatus(current.status), input.toStatus);
      if ((input.toStatus === "CANCELLED" || input.toStatus === "NO_SHOW") && !reason) {
        throw new DomainError({ code: "VALIDATION_FAILED", message: "A reason is required." });
      }
      const recordSummary = input.recordSummary?.trim();
      if (input.toStatus === "COMPLETED" && !recordSummary) {
        throw new DomainError({
          code: "VALIDATION_FAILED",
          message: "Completion requires a record summary.",
        });
      }
      if (recordSummary && recordSummary.length > 5_000) {
        throw new DomainError({
          code: "VALIDATION_FAILED",
          message: "Record summary is too long.",
        });
      }
      const restoringNoShowReservation =
        current.status === AppointmentStatus.NO_SHOW && input.toStatus === "CHECKED_IN";
      const localParts = restoringNoShowReservation
        ? localDateTimePartsForInstant(current.startsAt, current.timezone)
        : null;
      const restorationBooking = localParts
        ? await prepareBooking(transaction, {
            branchId: current.branchId,
            organizationId: access.organizationId,
            providerId: current.providerId,
            serviceId: current.serviceId,
            startsAtLocal: `${localParts.year.toString().padStart(4, "0")}-${localParts.month
              .toString()
              .padStart(2, "0")}-${localParts.day.toString().padStart(2, "0")}T${localParts.hour
              .toString()
              .padStart(2, "0")}:${localParts.minute.toString().padStart(2, "0")}`,
          })
        : null;
      if (restorationBooking) {
        await assertBookableSchedule(transaction, restorationBooking, current.id);
      }
      const changed = await transaction.appointment.updateMany({
        data: {
          cancelledAt: input.toStatus === "CANCELLED" ? new Date() : current.cancelledAt,
          status: input.toStatus as AppointmentStatus,
          version: { increment: 1 },
        },
        where: {
          id: current.id,
          organizationId: access.organizationId,
          status: current.status,
          version: input.expectedVersion,
        },
      });
      if (changed.count !== 1) {
        throw conflict("Appointment changed by another user. Refresh and try again.");
      }
      if (input.toStatus === "COMPLETED") {
        if (!recordSummary) {
          throw new DomainError({
            code: "VALIDATION_FAILED",
            message: "Completion requires a record summary.",
          });
        }
        await transaction.appointmentRecord.upsert({
          create: {
            appointmentId: current.id,
            authoredByUserId: access.actorUserId,
            details: input.recordDetails?.trim() || null,
            organizationId: access.organizationId,
            summary: recordSummary,
          },
          update: {
            authoredByUserId: access.actorUserId,
            details: input.recordDetails?.trim() || null,
            summary: recordSummary,
            version: { increment: 1 },
          },
          where: { appointmentId: current.id },
        });
      }
      if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(input.toStatus)) {
        await Promise.all([
          transaction.appointmentStaffReservation.deleteMany({
            where: { appointmentId: current.id, organizationId: access.organizationId },
          }),
          transaction.appointmentResource.deleteMany({
            where: { appointmentId: current.id, organizationId: access.organizationId },
          }),
        ]);
      } else if (restoringNoShowReservation && restorationBooking) {
        try {
          await transaction.appointmentStaffReservation.create({
            data: {
              appointmentId: current.id,
              endsAt: restorationBooking.reservationEndsAt,
              organizationId: access.organizationId,
              providerId: current.providerId,
              startsAt: restorationBooking.reservationStartsAt,
            },
          });
          await reserveRequiredResources(transaction, restorationBooking, current.id, current.id);
        } catch (error) {
          if (isPrismaCode(error, "P2010")) {
            throw schedulingConflict("The provider or resource is no longer available.");
          }
          throw error;
        }
      }
      await transaction.appointmentStatusHistory.create({
        data: {
          actorUserId: access.actorUserId,
          appointmentId: current.id,
          endsAt: current.endsAt,
          eventType: AppointmentHistoryType.STATUS_CHANGED,
          fromStatus: current.status,
          organizationId: access.organizationId,
          reason: reason ?? null,
          source: current.source,
          startsAt: current.startsAt,
          toStatus: input.toStatus as AppointmentStatus,
          version: input.expectedVersion + 1,
        },
      });
      await createAuditEvent(
        transaction,
        access,
        `APPOINTMENT_${input.toStatus}`,
        "Appointment",
        current.id,
        details,
        reason,
      );
      return transaction.appointment.findFirstOrThrow({
        where: { id: current.id, organizationId: access.organizationId },
      });
    });
  }

  async addInternalNote(
    access: TenantAccessSnapshot,
    input: Readonly<{ appointmentId: string; body: string }>,
    details?: RequestAuditDetails,
  ) {
    const body = requireTrimmed(input.body, "note", 10_000);
    return this.runWithAccess(access, async (transaction) => {
      const appointment = await transaction.appointment.findFirst({
        select: { branchId: true, id: true, providerId: true },
        where: { id: input.appointmentId, organizationId: access.organizationId },
      });
      if (!appointment) {
        throw new DomainError({ code: "NOT_FOUND", message: "Appointment not found." });
      }
      requireResourcePermission(access, "appointment_records.write", appointment);
      const note = await transaction.appointmentNote.create({
        data: {
          appointmentId: appointment.id,
          authorUserId: access.actorUserId,
          body,
          organizationId: access.organizationId,
        },
      });
      await createAuditEvent(
        transaction,
        access,
        "APPOINTMENT_NOTE_ADDED",
        "Appointment",
        appointment.id,
        details,
      );
      return note;
    });
  }

  async listTodayOperations(
    access: TenantAccessSnapshot,
    filters: Omit<AppointmentFilters, "day"> = {},
  ) {
    const timezone = await this.runWithAccess(access, async (transaction) => {
      if (filters.branchId) {
        const branch = await transaction.branch.findFirst({
          select: { timezone: true },
          where: { id: filters.branchId, organizationId: access.organizationId },
        });
        if (!branch) {
          throw new DomainError({ code: "NOT_FOUND", message: "Branch not found." });
        }
        return branch.timezone;
      }
      const settings = await transaction.organizationSettings.findFirst({
        select: { timezone: true },
        where: { organizationId: access.organizationId },
      });
      return settings?.timezone ?? "Asia/Amman";
    });
    return this.listAppointments(access, {
      ...filters,
      day: localDateForInstant(new Date(), timezone),
    });
  }

  private async findLikelyDuplicatesInTransaction(
    transaction: TenantTransaction,
    organizationId: string,
    input: Readonly<{
      displayName: string;
      normalizedPhone: string | null;
      omitCustomerId: string;
    }>,
  ) {
    const duplicateWhere: Prisma.CustomerWhereInput = {
      id: { not: input.omitCustomerId },
      organizationId,
      OR: [
        { displayName: { equals: input.displayName, mode: "insensitive" } },
        ...(input.normalizedPhone
          ? [{ contacts: { some: { normalizedPhoneE164: input.normalizedPhone } } }]
          : []),
      ],
    };
    return transaction.customer.findMany({
      include: { contacts: { select: { normalizedPhoneE164: true, originalValue: true } } },
      orderBy: { displayName: "asc" },
      take: 10,
      where: duplicateWhere,
    });
  }
}
