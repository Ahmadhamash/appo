import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "./generated/prisma/client";
import { ImportRowStatus } from "./generated/prisma/enums";
import { CrmAppointmentRepository } from "./crm-appointment-repository";
import { IdentityRepository } from "./identity-repository";
import { hashInvitationToken } from "./invitation-token";
import { runInTenant } from "./tenant-context";
import { DomainError } from "@jormall/domain/errors";
import type { PermissionCode, TenantAccessSnapshot } from "@jormall/domain/identity";
import {
  attributionSources,
  csvCell,
  importKinds,
  ratio,
  reportMetricKeys,
  type ImportKind,
} from "@jormall/domain/operations-intelligence";
import { normalizeJordanianPhone } from "@jormall/domain/jordan-phone";
import { utcRangeForLocalDate } from "@jormall/domain/timezone";

type StringRecord = Readonly<Record<string, string>>;
type ImportStageInput = Readonly<{
  fileDigest: string;
  fileName: string;
  idempotencyKey: string;
  kind: ImportKind;
}>;

function scope(access: TenantAccessSnapshot, permission: PermissionCode) {
  const grant = access.grants.find(({ code }) => code === permission);
  if (!grant) throw new DomainError({ code: "FORBIDDEN", message: "Permission denied." });
  return grant.scope;
}

function required(value: string | undefined, field: string, maximum = 200): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > maximum) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: `${field} is invalid.` });
  }
  return normalized;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function storedStringRecord(value: Prisma.JsonValue): StringRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "Stored import payload is invalid.",
    });
  }
  const entries = Object.entries(value);
  if (!entries.every((entry) => typeof entry[1] === "string")) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "Stored import payload is invalid.",
    });
  }
  return Object.fromEntries(entries.map(([key, entry]) => [key, String(entry)]));
}

function errorDetails(error: unknown): Readonly<{ code: string; message: string }> {
  return error instanceof DomainError
    ? { code: error.code, message: error.message.slice(0, 300) }
    : { code: "IMPORT_ROW_FAILED", message: "The row could not be imported safely." };
}

function appointmentScope(access: TenantAccessSnapshot, permission: PermissionCode) {
  const granted = scope(access, permission);
  return granted === "ASSIGNED_BRANCHES"
    ? { branchId: { in: [...access.assignedBranchIds] } }
    : granted === "SELF"
      ? { providerId: access.staffProfileId ?? "00000000-0000-0000-0000-000000000000" }
      : {};
}

function weekdayCounts(startsOn: string, endsOn: string): Readonly<Record<string, number>> {
  const start = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${endsOn}T00:00:00Z`);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end < start ||
    end.getTime() - start.getTime() > 366 * 86_400_000
  ) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Report date range is invalid." });
  }
  const names = [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
  ] as const;
  const counts: Record<string, number> = {};
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    const name = names[cursor.getUTCDay()];
    if (name) counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

export class OperationsIntelligenceRepository {
  private readonly crm: CrmAppointmentRepository;
  private readonly identity: IdentityRepository;

  constructor(private readonly client: PrismaClient) {
    this.crm = new CrmAppointmentRepository(client);
    this.identity = new IdentityRepository(client);
  }

  async startImport(access: TenantAccessSnapshot, input: ImportStageInput) {
    scope(access, "imports.manage");
    if (!importKinds.includes(input.kind) || !/^[0-9a-f]{64}$/u.test(input.fileDigest)) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Import metadata is invalid." });
    }
    return runInTenant(this.client, access, async (transaction) => {
      const prior = await transaction.importBatch.findUnique({
        where: {
          organizationId_idempotencyKey: {
            idempotencyKey: input.idempotencyKey,
            organizationId: access.organizationId,
          },
        },
      });
      if (prior) {
        if (prior.fileDigest !== input.fileDigest || prior.kind !== input.kind) {
          throw new DomainError({
            code: "IDEMPOTENCY_CONFLICT",
            message: "Import key was reused.",
          });
        }
        if (prior.status === "FAILED") {
          await transaction.importRow.deleteMany({
            where: { batchId: prior.id, organizationId: access.organizationId },
          });
          const reset = await transaction.importBatch.update({
            data: {
              duplicateRows: 0,
              failedRows: 0,
              importedRows: 0,
              invalidRows: 0,
              status: "STAGING",
              totalRows: 0,
              validRows: 0,
            },
            where: { id: prior.id },
          });
          return { ...reset, stageRequired: true };
        }
        return { ...prior, stageRequired: false };
      }
      const batch = await transaction.importBatch.create({
        data: {
          actorUserId: access.actorUserId,
          fileDigest: input.fileDigest,
          fileName: required(input.fileName, "file name", 240),
          idempotencyKey: required(input.idempotencyKey, "idempotency key", 160),
          kind: input.kind,
          organizationId: access.organizationId,
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: "IMPORT_DRY_RUN_STARTED",
          actorUserId: access.actorUserId,
          organizationId: access.organizationId,
          targetId: batch.id,
          targetType: "ImportBatch",
        },
      });
      return { ...batch, stageRequired: true };
    });
  }

  async failImport(access: TenantAccessSnapshot, batchId: string): Promise<void> {
    scope(access, "imports.manage");
    await runInTenant(this.client, access, (transaction) =>
      transaction.importBatch.updateMany({
        data: { status: "FAILED" },
        where: { id: batchId, organizationId: access.organizationId, status: "STAGING" },
      }),
    );
  }

  async stageImportRow(
    access: TenantAccessSnapshot,
    batchId: string,
    rowNumber: number,
    payload: StringRecord,
  ): Promise<void> {
    scope(access, "imports.manage");
    await runInTenant(this.client, access, async (transaction) => {
      const batch = await transaction.importBatch.findFirst({
        where: { id: batchId, organizationId: access.organizationId, status: "STAGING" },
      });
      if (!batch) throw new DomainError({ code: "NOT_FOUND", message: "Import batch not found." });
      const externalKey = required(payload.external_key, "external key", 160);
      let status: ImportRowStatus = ImportRowStatus.VALID;
      let errorCode: string | null = null;
      let safeMessage: string | null = null;
      try {
        await this.validateRow(transaction, access, batch.kind, payload, batchId, externalKey);
      } catch (error) {
        const details = errorDetails(error);
        status = details.code === "DUPLICATE" ? ImportRowStatus.DUPLICATE : ImportRowStatus.INVALID;
        errorCode = details.code;
        safeMessage = details.message;
      }
      await transaction.importRow.create({
        data: {
          batchId,
          errorCode,
          externalKey,
          organizationId: access.organizationId,
          payload,
          payloadDigest: digest(payload),
          rowNumber,
          safeMessage,
          status,
        },
      });
    });
  }

  private async validateRow(
    transaction: Prisma.TransactionClient,
    access: TenantAccessSnapshot,
    kind: ImportKind,
    payload: StringRecord,
    batchId: string,
    externalKey: string,
  ): Promise<void> {
    const duplicateKey = await transaction.importRow.findFirst({
      where: { batchId, externalKey, organizationId: access.organizationId },
    });
    if (duplicateKey)
      throw new DomainError({ code: "DUPLICATE", message: "Duplicate external key." });
    if (kind === "CUSTOMERS") {
      required(payload.display_name, "display name", 160);
      const phone = normalizeJordanianPhone(required(payload.phone, "phone", 80));
      if (!["en", "ar"].includes(payload.preferred_locale ?? "")) {
        throw new DomainError({
          code: "VALIDATION_FAILED",
          message: "Preferred locale is invalid.",
        });
      }
      if (
        await transaction.customerContact.findFirst({
          where: { normalizedPhoneE164: phone, organizationId: access.organizationId },
        })
      ) {
        throw new DomainError({
          code: "DUPLICATE",
          message: "A customer with this phone already exists.",
        });
      }
      return;
    }
    if (kind === "STAFF") {
      const email = required(payload.email, "email", 320).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
        throw new DomainError({ code: "VALIDATION_FAILED", message: "Email is invalid." });
      if (!["ORGANIZATION_MANAGER", "SECRETARY", "PROVIDER"].includes(payload.role_key ?? "")) {
        throw new DomainError({
          code: "VALIDATION_FAILED",
          message: "Imported role is not allowed.",
        });
      }
      if (
        await transaction.organizationInvitation.findFirst({
          where: { email, organizationId: access.organizationId, status: "PENDING" },
        })
      ) {
        throw new DomainError({
          code: "DUPLICATE",
          message: "A pending invitation already exists.",
        });
      }
      return;
    }
    if (kind === "SERVICES") {
      const nameEn = required(payload.name_en, "English name", 160);
      const nameAr = required(payload.name_ar, "Arabic name", 160);
      const duration = Number(payload.duration_minutes);
      if (!Number.isInteger(duration) || duration < 1 || duration > 1440)
        throw new DomainError({ code: "VALIDATION_FAILED", message: "Duration is invalid." });
      if (!/^[A-Z]{3}$/u.test(payload.currency ?? ""))
        throw new DomainError({ code: "VALIDATION_FAILED", message: "Currency is invalid." });
      if (
        await transaction.service.findFirst({
          where: {
            organizationId: access.organizationId,
            OR: [
              { nameEn: { equals: nameEn, mode: "insensitive" } },
              { nameAr: { equals: nameAr, mode: "insensitive" } },
            ],
          },
        })
      ) {
        throw new DomainError({ code: "DUPLICATE", message: "A matching service already exists." });
      }
      return;
    }
    const phone = normalizeJordanianPhone(required(payload.customer_phone, "customer phone", 80));
    const branchName = required(payload.branch_name, "branch name", 160);
    const serviceName = required(payload.service_name, "service name", 160);
    const providerEmail = required(payload.provider_email, "provider email", 320).toLowerCase();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(payload.starts_at_local ?? ""))
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Local appointment time is invalid.",
      });
    if (!["PENDING", "CONFIRMED"].includes(payload.status ?? ""))
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Imported appointment status is invalid.",
      });
    const [contact, branch, service, providerUser] = await Promise.all([
      transaction.customerContact.findFirst({
        where: { normalizedPhoneE164: phone, organizationId: access.organizationId },
      }),
      transaction.branch.findFirst({
        where: {
          nameEn: { equals: branchName, mode: "insensitive" },
          organizationId: access.organizationId,
        },
      }),
      transaction.service.findFirst({
        where: {
          nameEn: { equals: serviceName, mode: "insensitive" },
          organizationId: access.organizationId,
        },
      }),
      transaction.user.findFirst({ where: { email: providerEmail } }),
    ]);
    const provider = providerUser
      ? await transaction.staffProfile.findFirst({
          where: {
            membership: { userId: providerUser.id },
            organizationId: access.organizationId,
          },
        })
      : null;
    if (!contact || !branch || !service || !provider) {
      throw new DomainError({
        code: "NOT_FOUND",
        message: "Customer, branch, service, or provider was not found.",
      });
    }
  }

  async finishDryRun(access: TenantAccessSnapshot, batchId: string) {
    scope(access, "imports.manage");
    return runInTenant(this.client, access, async (transaction) => {
      const grouped = await transaction.importRow.groupBy({
        by: ["status"],
        _count: { _all: true },
        where: { batchId, organizationId: access.organizationId },
      });
      const count = (status: ImportRowStatus) =>
        grouped.find((row) => row.status === status)?._count._all ?? 0;
      return transaction.importBatch.update({
        data: {
          duplicateRows: count(ImportRowStatus.DUPLICATE),
          invalidRows: count(ImportRowStatus.INVALID),
          status: "DRY_RUN_READY",
          totalRows: grouped.reduce((sum, row) => sum + row._count._all, 0),
          validRows: count(ImportRowStatus.VALID),
        },
        where: { id: batchId },
      });
    });
  }

  async listImports(access: TenantAccessSnapshot, page = 1) {
    scope(access, "imports.manage");
    return runInTenant(this.client, access, (transaction) =>
      transaction.importBatch.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * 20,
        take: 20,
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async commitImport(access: TenantAccessSnapshot, batchId: string) {
    scope(access, "imports.manage");
    const claim = await runInTenant(this.client, access, async (transaction) => {
      const found = await transaction.importBatch.findFirst({
        where: { id: batchId, organizationId: access.organizationId },
      });
      if (!found) throw new DomainError({ code: "NOT_FOUND", message: "Import batch not found." });
      if (["COMMITTED", "ROLLED_BACK", "COMMITTING"].includes(found.status)) {
        return { batch: found, shouldProcess: false };
      }
      if (found.status === "DRY_RUN_READY" && (found.invalidRows > 0 || found.duplicateRows > 0))
        throw new DomainError({
          code: "CONFLICT",
          message: "Resolve all dry-run errors before commit.",
        });
      if (!["DRY_RUN_READY", "PARTIAL"].includes(found.status))
        throw new DomainError({ code: "CONFLICT", message: "Import batch cannot be committed." });
      if (found.status !== "DRY_RUN_READY")
        await transaction.importRow.updateMany({
          data: { errorCode: null, safeMessage: null, status: "VALID" },
          where: { batchId: found.id, organizationId: access.organizationId, status: "FAILED" },
        });
      const claimed = await transaction.importBatch.updateMany({
        data: { status: "COMMITTING" },
        where: { id: found.id, organizationId: access.organizationId, status: found.status },
      });
      if (claimed.count !== 1) {
        const current = await transaction.importBatch.findFirstOrThrow({
          where: { id: found.id, organizationId: access.organizationId },
        });
        return { batch: current, shouldProcess: false };
      }
      return {
        batch: await transaction.importBatch.findFirstOrThrow({
          where: { id: found.id, organizationId: access.organizationId },
        }),
        shouldProcess: true,
      };
    });
    if (!claim.shouldProcess) return claim.batch;
    const batch = claim.batch;
    let imported = batch.importedRows;
    let failed = 0;
    for (;;) {
      const rows = await runInTenant(this.client, access, (transaction) =>
        transaction.importRow.findMany({
          orderBy: { id: "asc" },
          take: 100,
          where: { batchId, organizationId: access.organizationId, status: "VALID" },
        }),
      );
      if (!rows.length) break;
      for (const row of rows) {
        try {
          const target = await this.executeRow(
            access,
            batch.kind,
            row.id,
            storedStringRecord(row.payload),
          );
          await runInTenant(this.client, access, (transaction) =>
            transaction.importRow.update({
              data: { status: "IMPORTED", targetId: target.id, targetType: target.type },
              where: { id: row.id },
            }),
          );
          imported += 1;
        } catch (error) {
          const details = errorDetails(error);
          await runInTenant(this.client, access, (transaction) =>
            transaction.importRow.update({
              data: { errorCode: details.code, safeMessage: details.message, status: "FAILED" },
              where: { id: row.id },
            }),
          );
          failed += 1;
        }
      }
    }
    return runInTenant(this.client, access, async (transaction) => {
      const updated = await transaction.importBatch.update({
        data: {
          committedAt: new Date(),
          failedRows: failed,
          importedRows: imported,
          status: failed ? "PARTIAL" : "COMMITTED",
        },
        where: { id: batchId },
      });
      await transaction.auditEvent.create({
        data: {
          action: "IMPORT_COMMITTED",
          actorUserId: access.actorUserId,
          metadata: { failed, imported },
          organizationId: access.organizationId,
          targetId: batchId,
          targetType: "ImportBatch",
        },
      });
      return updated;
    });
  }

  private async executeRow(
    access: TenantAccessSnapshot,
    kind: ImportKind,
    rowId: string,
    payload: StringRecord,
  ) {
    if (kind === "CUSTOMERS") {
      const result = await this.crm.createCustomer(access, {
        displayName: required(payload.display_name, "display name", 160),
        phoneOriginal: required(payload.phone, "phone", 80),
        preferredLocale: payload.preferred_locale === "ar" ? "ar" : "en",
      });
      return { id: result.customer.id, type: "Customer" };
    }
    if (kind === "SERVICES") {
      const before = await this.identity.listServices(access);
      await this.identity.createService(access, {
        currency: required(payload.currency, "currency", 3),
        defaultDurationMins: Number(payload.duration_minutes),
        ...(payload.price_minor ? { defaultPriceMinor: Number(payload.price_minor) } : {}),
        nameAr: required(payload.name_ar, "Arabic name", 160),
        nameEn: required(payload.name_en, "English name", 160),
      });
      const after = await this.identity.listServices(access);
      const created = after.find(({ id }) => !before.some((prior) => prior.id === id));
      if (!created)
        throw new DomainError({
          code: "IMPORT_ROW_FAILED",
          message: "Created service was not found.",
        });
      return { id: created.id, type: "Service" };
    }
    if (kind === "STAFF") {
      const roles = await this.identity.listRoles(access);
      const role = roles.find(({ systemKey }) => systemKey === payload.role_key);
      if (!role) throw new DomainError({ code: "NOT_FOUND", message: "Role was not found." });
      const token = await this.identity.createInvitation(
        access,
        required(payload.email, "email", 320),
        role.id,
      );
      const invitation = await runInTenant(this.client, access, (transaction) =>
        transaction.organizationInvitation.findFirst({
          orderBy: { createdAt: "desc" },
          where: {
            organizationId: access.organizationId,
            tokenHash: hashInvitationToken(token),
          },
        }),
      );
      if (!invitation)
        throw new DomainError({ code: "IMPORT_ROW_FAILED", message: "Invitation was not found." });
      return { id: invitation.id, type: "OrganizationInvitation" };
    }
    const resolved = await runInTenant(this.client, access, async (transaction) => {
      const phone = normalizeJordanianPhone(required(payload.customer_phone, "customer phone", 80));
      const [contact, branch, service, user] = await Promise.all([
        transaction.customerContact.findFirst({
          where: { normalizedPhoneE164: phone, organizationId: access.organizationId },
        }),
        transaction.branch.findFirst({
          where: {
            nameEn: { equals: required(payload.branch_name, "branch", 160), mode: "insensitive" },
            organizationId: access.organizationId,
          },
        }),
        transaction.service.findFirst({
          where: {
            nameEn: { equals: required(payload.service_name, "service", 160), mode: "insensitive" },
            organizationId: access.organizationId,
          },
        }),
        transaction.user.findFirst({
          where: { email: required(payload.provider_email, "provider email", 320).toLowerCase() },
        }),
      ]);
      const provider = user
        ? await transaction.staffProfile.findFirst({
            where: { membership: { userId: user.id }, organizationId: access.organizationId },
          })
        : null;
      if (!contact || !branch || !service || !provider)
        throw new DomainError({
          code: "NOT_FOUND",
          message: "Customer, branch, service, or provider was not found.",
        });
      return { branch, contact, provider, service };
    });
    const appointment = await this.crm.createAppointment(access, {
      branchId: resolved.branch.id,
      customerId: resolved.contact.customerId,
      idempotencyKey: `phase7:${rowId}`,
      providerId: resolved.provider.id,
      serviceId: resolved.service.id,
      source: "IMPORT",
      startsAtLocal: required(payload.starts_at_local, "start", 30),
      status: payload.status === "PENDING" ? "PENDING" : "CONFIRMED",
    });
    const sourceDetail = payload.source_detail?.trim().slice(0, 200);
    if (sourceDetail) {
      await runInTenant(this.client, access, async (transaction) => {
        await transaction.appointment.updateMany({
          data: { sourceDetail },
          where: { id: appointment.id, organizationId: access.organizationId },
        });
        await transaction.auditEvent.create({
          data: {
            action: "APPOINTMENT_IMPORT_SOURCE_DETAIL_SET",
            actorUserId: access.actorUserId,
            metadata: { importRowId: rowId },
            organizationId: access.organizationId,
            targetId: appointment.id,
            targetType: "Appointment",
          },
        });
      });
    }
    return { id: appointment.id, type: "Appointment" };
  }

  async rollbackImport(access: TenantAccessSnapshot, batchId: string) {
    scope(access, "imports.manage");
    const rows = await runInTenant(this.client, access, (transaction) =>
      transaction.importRow.findMany({
        orderBy: { rowNumber: "desc" },
        where: { batchId, organizationId: access.organizationId, status: "IMPORTED" },
      }),
    );
    let rolledBack = 0;
    let retained = 0;
    for (const row of rows) {
      if (!row.targetId || !row.targetType) continue;
      const targetId = row.targetId;
      const safe = await runInTenant(this.client, access, async (transaction) => {
        if (row.targetType === "Customer")
          return (
            (
              await transaction.customer.deleteMany({
                where: {
                  id: targetId,
                  organizationId: access.organizationId,
                  version: 1,
                  appointments: { none: {} },
                  consents: { none: {} },
                  messages: { none: {} },
                },
              })
            ).count === 1
          );
        if (row.targetType === "Service")
          return (
            (
              await transaction.service.deleteMany({
                where: {
                  id: targetId,
                  organizationId: access.organizationId,
                  appointments: { none: {} },
                  waitlistEntries: { none: {} },
                },
              })
            ).count === 1
          );
        if (row.targetType === "OrganizationInvitation")
          return (
            (
              await transaction.organizationInvitation.updateMany({
                data: { status: "REVOKED" },
                where: {
                  id: targetId,
                  organizationId: access.organizationId,
                  status: "PENDING",
                },
              })
            ).count === 1
          );
        return false;
      });
      if (safe) {
        await runInTenant(this.client, access, (transaction) =>
          transaction.importRow.update({ data: { status: "ROLLED_BACK" }, where: { id: row.id } }),
        );
        rolledBack += 1;
      } else retained += 1;
    }
    return runInTenant(this.client, access, async (transaction) => {
      const updated = await transaction.importBatch.update({
        data: {
          rollbackSummary: { retained, rolledBack },
          rolledBackAt: new Date(),
          status: retained ? "PARTIAL" : "ROLLED_BACK",
        },
        where: { id: batchId },
      });
      await transaction.auditEvent.create({
        data: {
          action: "IMPORT_ROLLBACK_COMPLETED",
          actorUserId: access.actorUserId,
          metadata: { retained, rolledBack },
          organizationId: access.organizationId,
          targetId: batchId,
          targetType: "ImportBatch",
        },
      });
      return updated;
    });
  }

  async listAudit(access: TenantAccessSnapshot, page = 1) {
    const granted = scope(access, "audit.read");
    return runInTenant(this.client, access, async (transaction) => {
      const targetIds = granted === "ASSIGNED_BRANCHES" ? [...access.assignedBranchIds] : [];
      await transaction.auditEvent.create({
        data: {
          action: "AUDIT_LOG_VIEWED",
          actorUserId: access.actorUserId,
          metadata: { page },
          organizationId: access.organizationId,
          targetType: "AuditEvent",
        },
      });
      return transaction.auditEvent.findMany({
        include: { actor: { select: { email: true, name: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * 50,
        take: 50,
        where: {
          organizationId: access.organizationId,
          ...(granted === "ASSIGNED_BRANCHES"
            ? { targetId: { in: targetIds } }
            : granted === "SELF"
              ? { actorUserId: access.actorUserId }
              : {}),
        },
      });
    });
  }

  async listPlatformAudit(actorUserId: string, reason: string, page = 1) {
    await this.identity.assertSuperAdmin(actorUserId);
    const safeReason = required(reason, "reason", 500);
    return this.client.$transaction(async (transaction) => {
      await transaction.platformAuditEvent.create({
        data: {
          action: "PLATFORM_AUDIT_VIEWED",
          actorUserId,
          metadata: { page },
          reason: safeReason,
        },
      });
      return transaction.auditEvent.findMany({
        include: {
          actor: { select: { email: true, name: true } },
          organization: { select: { nameEn: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * 50,
        take: 50,
      });
    });
  }

  async getPlatformAggregates(actorUserId: string, reason: string) {
    await this.identity.assertSuperAdmin(actorUserId);
    const safeReason = required(reason, "reason", 500);
    return this.client.$transaction(async (transaction) => {
      await transaction.platformAuditEvent.create({
        data: {
          action: "PLATFORM_AGGREGATES_VIEWED",
          actorUserId,
          metadata: { lifetime: true },
          reason: safeReason,
        },
      });
      const [organizations, appointments, handoffs, usage] = await Promise.all([
        transaction.organization.groupBy({ by: ["status"], _count: { _all: true } }),
        transaction.appointment.count(),
        transaction.humanHandoff.count(),
        transaction.aIUsage.aggregate({
          _sum: { estimatedCostMicros: true, inputTokens: true, outputTokens: true },
        }),
      ]);
      return { appointments, handoffs, organizations, usage: usage._sum };
    });
  }

  async recordAttribution(
    access: TenantAccessSnapshot,
    input: Readonly<{
      appointmentId?: string | undefined;
      campaignMedium?: string | undefined;
      campaignName?: string | undefined;
      campaignSource?: string | undefined;
      customerId?: string | undefined;
      occurredAt: Date;
      source: (typeof attributionSources)[number];
      sourceDetail?: string | undefined;
    }>,
  ) {
    scope(access, "appointments.create");
    if (!attributionSources.includes(input.source))
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Attribution source is invalid.",
      });
    return runInTenant(this.client, access, (transaction) =>
      transaction.attributionEvent.create({
        data: {
          appointmentId: input.appointmentId ?? null,
          campaignMedium: input.campaignMedium?.slice(0, 120) ?? null,
          campaignName: input.campaignName?.slice(0, 160) ?? null,
          campaignSource: input.campaignSource?.slice(0, 120) ?? null,
          customerId: input.customerId ?? null,
          occurredAt: input.occurredAt,
          organizationId: access.organizationId,
          source: input.source,
          sourceDetail: input.sourceDetail?.slice(0, 200) ?? null,
        },
      }),
    );
  }

  async runOperationalReport(access: TenantAccessSnapshot, startsOn: string, endsOn: string) {
    const granted = scope(access, "reports.read");
    const trace = await runInTenant(this.client, access, (transaction) =>
      transaction.organizationSettings.findFirst({
        where: { organizationId: access.organizationId },
      }),
    );
    const timezone = trace?.timezone ?? "Asia/Amman";
    const startsAt = utcRangeForLocalDate(startsOn, timezone).startsAt;
    const endsAt = utcRangeForLocalDate(endsOn, timezone).endsAt;
    const scoped = appointmentScope(access, "reports.read");
    const days = weekdayCounts(startsOn, endsOn);
    const result = await runInTenant(this.client, access, async (transaction) => {
      const [
        waitlistTotal,
        waitlistFulfilled,
        aiTotal,
        aiContained,
        aiHandedOff,
        calls,
        messages,
        usage,
        attributionTouches,
        attributionConversions,
        availabilityRules,
      ] = await Promise.all([
        transaction.waitlistEntry.count({
          where: {
            organizationId: access.organizationId,
            createdAt: { gte: startsAt, lt: endsAt },
          },
        }),
        transaction.waitlistEntry.count({
          where: {
            createdAt: { gte: startsAt, lt: endsAt },
            organizationId: access.organizationId,
            status: "FULFILLED",
          },
        }),
        transaction.aIConversation.count({
          where: {
            organizationId: access.organizationId,
            createdAt: { gte: startsAt, lt: endsAt },
          },
        }),
        transaction.aIConversation.count({
          where: {
            createdAt: { gte: startsAt, lt: endsAt },
            handoffs: { none: {} },
            organizationId: access.organizationId,
          },
        }),
        transaction.aIConversation.count({
          where: {
            createdAt: { gte: startsAt, lt: endsAt },
            handoffs: { some: {} },
            organizationId: access.organizationId,
          },
        }),
        transaction.call.groupBy({
          by: ["status"],
          _count: { _all: true },
          where: {
            organizationId: access.organizationId,
            startedAt: { gte: startsAt, lt: endsAt },
          },
        }),
        transaction.message.groupBy({
          by: ["status"],
          _count: { _all: true },
          where: {
            direction: "OUTBOUND",
            organizationId: access.organizationId,
            createdAt: { gte: startsAt, lt: endsAt },
          },
        }),
        transaction.aIUsage.groupBy({
          by: ["channel"],
          _sum: { estimatedCostMicros: true, inputTokens: true, outputTokens: true },
          _count: { _all: true },
          where: {
            organizationId: access.organizationId,
            occurredAt: { gte: startsAt, lt: endsAt },
          },
        }),
        transaction.attributionEvent.groupBy({
          by: ["source"],
          _count: { _all: true },
          where: {
            organizationId: access.organizationId,
            occurredAt: { gte: startsAt, lt: endsAt },
          },
        }),
        transaction.attributionEvent.groupBy({
          by: ["source"],
          _count: { _all: true },
          where: {
            appointmentId: { not: null },
            organizationId: access.organizationId,
            occurredAt: { gte: startsAt, lt: endsAt },
          },
        }),
        transaction.availabilityRule.findMany({
          select: { endMinuteLocal: true, startMinuteLocal: true, weekday: true },
          where: {
            organizationId: access.organizationId,
            ...(granted === "ASSIGNED_BRANCHES"
              ? { branchId: { in: [...access.assignedBranchIds] } }
              : granted === "SELF"
                ? {
                    staffProfileId: access.staffProfileId ?? "00000000-0000-0000-0000-000000000000",
                  }
                : {}),
          },
        }),
      ]);
      let total = 0;
      let cancelled = 0;
      let noShows = 0;
      let scheduledMinutes = 0;
      let revenueEstimateMinor = 0;
      let completedWithPrice = 0;
      let completedWithoutPrice = 0;
      let cursor: string | undefined;
      const groups = new Map<
        string,
        { bookings: number; branch: string; provider: string; service: string; source: string }
      >();
      for (;;) {
        const page = await transaction.appointment.findMany({
          include: { branch: true, provider: true, service: { include: { branches: true } } },
          orderBy: { id: "asc" },
          take: 500,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          where: {
            ...scoped,
            organizationId: access.organizationId,
            startsAt: { gte: startsAt, lt: endsAt },
          },
        });
        for (const appointment of page) {
          total += 1;
          if (appointment.status === "CANCELLED") cancelled += 1;
          if (appointment.status === "NO_SHOW") noShows += 1;
          if (appointment.status !== "CANCELLED")
            scheduledMinutes +=
              (appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000;
          if (appointment.status === "COMPLETED") {
            const price =
              appointment.service.branches.find(({ branchId }) => branchId === appointment.branchId)
                ?.priceMinor ?? appointment.service.defaultPriceMinor;
            if (price === null) completedWithoutPrice += 1;
            else {
              completedWithPrice += 1;
              revenueEstimateMinor += price;
            }
          }
          const key = `${appointment.branchId}:${appointment.serviceId}:${appointment.providerId}:${appointment.source}`;
          const prior = groups.get(key);
          groups.set(key, {
            bookings: (prior?.bookings ?? 0) + 1,
            branch: appointment.branch.nameEn,
            provider: appointment.provider.displayNameEn,
            service: appointment.service.nameEn,
            source: appointment.source,
          });
        }
        if (page.length < 500) break;
        cursor = page.at(-1)?.id;
      }
      const messageTotal = messages.reduce((sum, row) => sum + row._count._all, 0);
      const messageFailures = messages
        .filter(({ status }) => ["FAILED", "DEAD_LETTER"].includes(status))
        .reduce((sum, row) => sum + row._count._all, 0);
      const availableMinutes = availabilityRules.reduce(
        (sum, rule) =>
          sum + (days[rule.weekday] ?? 0) * (rule.endMinuteLocal - rule.startMinuteLocal),
        0,
      );
      const conversionsByChannel = attributionTouches.map((touch) => ({
        conversions:
          attributionConversions.find(({ source }) => source === touch.source)?._count._all ?? 0,
        rate: ratio(
          attributionConversions.find(({ source }) => source === touch.source)?._count._all ?? 0,
          touch._count._all,
        ),
        source: touch.source,
        touches: touch._count._all,
      }));
      return {
        ai: {
          containmentRate: ratio(aiContained, aiTotal),
          handoffRate: ratio(aiHandedOff, aiTotal),
          usage,
        },
        bookings: [...groups.values()],
        calls,
        conversionsByChannel,
        cancellationRate: ratio(cancelled, total),
        messageFailureRate: ratio(messageFailures, messageTotal),
        noShowRate: ratio(noShows, total),
        revenueEstimateMinor:
          completedWithoutPrice > 0 || completedWithPrice === 0 ? null : revenueEstimateMinor,
        scheduleUtilizationRate: ratio(scheduledMinutes, availableMinutes),
        waitlistConversionRate: ratio(waitlistFulfilled, waitlistTotal),
      };
    });
    const watermark = new Date();
    const run = await runInTenant(this.client, access, async (transaction) => {
      const created = await transaction.reportRun.create({
        data: {
          actorUserId: access.actorUserId,
          dataWatermark: watermark,
          dimensions: { scope: granted },
          endsAt,
          metricKey: "OPERATIONAL_OVERVIEW",
          organizationId: access.organizationId,
          result,
          startsAt,
          timezone,
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: "REPORT_RUN_CREATED",
          actorUserId: access.actorUserId,
          organizationId: access.organizationId,
          targetId: created.id,
          targetType: "ReportRun",
        },
      });
      return created;
    });
    return {
      ...result,
      definitionVersion: run.definitionVersion,
      endsAt,
      startsAt,
      timezone,
      watermark,
    };
  }

  async listReportRuns(access: TenantAccessSnapshot, page = 1) {
    scope(access, "reports.read");
    return runInTenant(this.client, access, (transaction) =>
      transaction.reportRun.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * 20,
        take: 20,
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async listExportJobs(access: TenantAccessSnapshot, page = 1) {
    scope(access, "exports.manage");
    return runInTenant(this.client, access, (transaction) =>
      transaction.dataExportJob.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * 20,
        take: 20,
        where: { actorUserId: access.actorUserId, organizationId: access.organizationId },
      }),
    );
  }

  async createExportJob(
    access: TenantAccessSnapshot,
    type: "CUSTOMERS" | "APPOINTMENTS" | "AUDIT_LOG" | "REPORT",
  ) {
    scope(access, "exports.manage");
    const permission: PermissionCode =
      type === "CUSTOMERS"
        ? "customers.read"
        : type === "APPOINTMENTS"
          ? "appointments.read"
          : type === "AUDIT_LOG"
            ? "audit.read"
            : "reports.read";
    scope(access, permission);
    return runInTenant(this.client, access, async (transaction) => {
      const job = await transaction.dataExportJob.create({
        data: {
          actorUserId: access.actorUserId,
          expiresAt: new Date(Date.now() + 60 * 60_000),
          organizationId: access.organizationId,
          parameters: { permission },
          type,
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: "DATA_EXPORT_CREATED",
          actorUserId: access.actorUserId,
          organizationId: access.organizationId,
          targetId: job.id,
          targetType: "DataExportJob",
        },
      });
      return job;
    });
  }

  async getExportPage(access: TenantAccessSnapshot, jobId: string, offset: number, take = 250) {
    scope(access, "exports.manage");
    return runInTenant(this.client, access, async (transaction) => {
      const job = await transaction.dataExportJob.findFirst({
        where: {
          actorUserId: access.actorUserId,
          expiresAt: { gt: new Date() },
          id: jobId,
          organizationId: access.organizationId,
          status: "READY",
        },
      });
      if (!job) throw new DomainError({ code: "NOT_FOUND", message: "Export job not found." });
      scope(
        access,
        job.type === "CUSTOMERS"
          ? "customers.read"
          : job.type === "APPOINTMENTS"
            ? "appointments.read"
            : job.type === "AUDIT_LOG"
              ? "audit.read"
              : "reports.read",
      );
      if (job.type === "CUSTOMERS") {
        const customerAccess = appointmentScope(access, "customers.read");
        return {
          job,
          rows: await transaction.customer.findMany({
            orderBy: { id: "asc" },
            select: { createdAt: true, displayName: true, preferredLocale: true },
            skip: offset,
            take,
            where: {
              ...(Object.keys(customerAccess).length
                ? { appointments: { some: customerAccess } }
                : {}),
              organizationId: access.organizationId,
            },
          }),
        };
      }
      if (job.type === "APPOINTMENTS")
        return {
          job,
          rows: await transaction.appointment.findMany({
            include: {
              branch: { select: { nameEn: true } },
              customer: { select: { displayName: true } },
              provider: { select: { displayNameEn: true } },
              service: { select: { nameEn: true } },
            },
            orderBy: { id: "asc" },
            skip: offset,
            take,
            where: {
              ...appointmentScope(access, "appointments.read"),
              organizationId: access.organizationId,
            },
          }),
        };
      if (job.type === "AUDIT_LOG")
        return {
          job,
          rows: await transaction.auditEvent.findMany({
            orderBy: { id: "asc" },
            select: { action: true, actorUserId: true, createdAt: true, targetType: true },
            skip: offset,
            take,
            where: { organizationId: access.organizationId },
          }),
        };
      return {
        job,
        rows: await transaction.reportRun.findMany({
          orderBy: { id: "asc" },
          select: {
            createdAt: true,
            dataWatermark: true,
            metricKey: true,
            result: true,
            timezone: true,
          },
          skip: offset,
          take,
          where: { organizationId: access.organizationId },
        }),
      };
    });
  }

  async getExportCsvPage(access: TenantAccessSnapshot, jobId: string, offset: number, take = 250) {
    const page = await this.getExportPage(access, jobId, offset, take);
    if (page.job.type === "CUSTOMERS") {
      const rows = page.rows as readonly Readonly<{
        createdAt: Date;
        displayName: string;
        preferredLocale: string;
      }>[];
      return {
        header: "display_name,preferred_locale,created_at",
        lines: rows.map((row) =>
          [row.displayName, row.preferredLocale, row.createdAt.toISOString()]
            .map(csvCell)
            .join(","),
        ),
      };
    }
    if (page.job.type === "APPOINTMENTS") {
      const rows = page.rows as readonly Readonly<{
        branch: { nameEn: string };
        customer: { displayName: string };
        provider: { displayNameEn: string };
        service: { nameEn: string };
        source: string;
        startsAt: Date;
        status: string;
      }>[];
      return {
        header: "customer,branch,service,provider,status,source,starts_at_utc",
        lines: rows.map((row) =>
          [
            row.customer.displayName,
            row.branch.nameEn,
            row.service.nameEn,
            row.provider.displayNameEn,
            row.status,
            row.source,
            row.startsAt.toISOString(),
          ]
            .map(csvCell)
            .join(","),
        ),
      };
    }
    if (page.job.type === "AUDIT_LOG") {
      const rows = page.rows as readonly Readonly<{
        action: string;
        actorUserId: string | null;
        createdAt: Date;
        targetType: string | null;
      }>[];
      return {
        header: "created_at,action,target_type,actor_present",
        lines: rows.map((row) =>
          [
            row.createdAt.toISOString(),
            row.action,
            row.targetType ?? "",
            row.actorUserId ? "yes" : "no",
          ]
            .map(csvCell)
            .join(","),
        ),
      };
    }
    const rows = page.rows as readonly Readonly<{
      createdAt: Date;
      dataWatermark: Date;
      metricKey: string;
      result: Prisma.JsonValue;
      timezone: string;
    }>[];
    return {
      header: "created_at,metric_key,timezone,data_watermark,result_json",
      lines: rows.map((row) =>
        [
          row.createdAt.toISOString(),
          row.metricKey,
          row.timezone,
          row.dataWatermark.toISOString(),
          JSON.stringify(row.result),
        ]
          .map(csvCell)
          .join(","),
      ),
    };
  }

  async recordExportDownload(access: TenantAccessSnapshot, jobId: string): Promise<void> {
    scope(access, "exports.manage");
    await runInTenant(this.client, access, async (transaction) => {
      const updated = await transaction.dataExportJob.updateMany({
        data: { downloadedAt: new Date() },
        where: {
          actorUserId: access.actorUserId,
          expiresAt: { gt: new Date() },
          id: jobId,
          organizationId: access.organizationId,
          status: "READY",
        },
      });
      if (updated.count !== 1)
        throw new DomainError({ code: "NOT_FOUND", message: "Export job not found." });
      await transaction.auditEvent.create({
        data: {
          action: "DATA_EXPORT_DOWNLOADED",
          actorUserId: access.actorUserId,
          organizationId: access.organizationId,
          targetId: jobId,
          targetType: "DataExportJob",
        },
      });
    });
  }

  async getImportErrors(access: TenantAccessSnapshot, batchId: string, offset: number, take = 250) {
    scope(access, "imports.manage");
    return runInTenant(this.client, access, async (transaction) => {
      if (offset === 0)
        await transaction.auditEvent.create({
          data: {
            action: "IMPORT_ERROR_REPORT_DOWNLOADED",
            actorUserId: access.actorUserId,
            organizationId: access.organizationId,
            targetId: batchId,
            targetType: "ImportBatch",
          },
        });
      return transaction.importRow.findMany({
        orderBy: { rowNumber: "asc" },
        select: {
          errorCode: true,
          errorField: true,
          rowNumber: true,
          safeMessage: true,
          status: true,
        },
        skip: offset,
        take,
        where: {
          batchId,
          organizationId: access.organizationId,
          status: { in: ["INVALID", "DUPLICATE", "FAILED"] },
        },
      });
    });
  }
}

export const phaseSevenAttributionSources = attributionSources;
export const phaseSevenReportMetricKeys = reportMetricKeys;
