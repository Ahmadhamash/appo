import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@jormall/db/client";
import { CrmAppointmentRepository } from "@jormall/db/crm-appointment-repository";
import { OrganizationStatus, PlatformRole } from "@jormall/db/generated/enums";
import { IdentityRepository } from "@jormall/db/identity-repository";
import { OperationsIntelligenceRepository } from "@jormall/db/operations-intelligence-repository";
import { runInTenant } from "@jormall/db/tenant-context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A PostgreSQL integration-test URL is required.");
const client = createPrismaClient(databaseUrl);
const identity = new IdentityRepository(client);
const crm = new CrmAppointmentRepository(client);
const operations = new OperationsIntelligenceRepository(client);
const suffix = randomUUID().slice(0, 8);

async function user(label: string, platformRole = PlatformRole.USER) {
  return client.user.create({
    data: {
      email: `phase7-${label}-${suffix}@example.invalid`,
      name: `Phase7 ${label}`,
      platformRole,
    },
  });
}

async function organization(
  superAdminId: string,
  owner: Readonly<{ email: string; id: string }>,
  label: string,
) {
  const created = await identity.createOrganization(superAdminId, {
    nameAr: `${label} عربي`,
    nameEn: label,
    ownerEmail: owner.email,
    slug: `phase7-${label.toLowerCase()}-${suffix}`,
  });
  const accepted = await identity.acceptInvitation(owner.id, owner.email, created.invitationToken);
  await identity.setOrganizationStatus(
    superAdminId,
    created.organizationId,
    OrganizationStatus.ACTIVE,
  );
  const access = await identity.loadTenantAccess(
    owner.id,
    { activeMembershipId: accepted.membershipId, activeOrganizationId: accepted.organizationId },
    {},
  );
  return { access, id: created.organizationId };
}

type Fixture = Awaited<ReturnType<typeof fixtureData>>;
let fixture: Fixture;

async function fixtureData() {
  const [admin, ownerA, ownerB] = await Promise.all([
    user("admin", PlatformRole.JORMALL_SUPER_ADMIN),
    user("owner-a"),
    user("owner-b"),
  ]);
  const [a, b] = await Promise.all([
    organization(admin.id, ownerA, "Reports A"),
    organization(admin.id, ownerB, "Reports B"),
  ]);
  await identity.createBranch(a.access, {
    nameAr: "فرع التقارير",
    nameEn: "Reports Branch",
    timezone: "Asia/Amman",
  });
  await identity.createService(a.access, {
    currency: "JOD",
    defaultDurationMins: 30,
    defaultPriceMinor: 1000,
    nameAr: "خدمة التقارير",
    nameEn: "Reports Service",
  });
  const [branch] = await identity.listBranches(a.access);
  const [service] = await identity.listServices(a.access);
  if (!branch || !service) throw new Error("Report fixture catalog is missing.");
  await identity.configureServiceBranch(a.access, {
    branchId: branch.id,
    durationMins: 30,
    isEnabled: true,
    priceMinor: 1000,
    serviceId: service.id,
  });
  const customer = (
    await crm.createCustomer(a.access, {
      displayName: "Metric Customer",
      phoneOriginal: "0799001100",
      preferredLocale: "en",
    })
  ).customer;
  const provider = await runInTenant(client, a.access, async (transaction) => {
    const profile = await transaction.staffProfile.create({
      data: {
        displayNameAr: "مزود التقارير",
        displayNameEn: "Reports Provider",
        membershipId: a.access.membershipId ?? "00000000-0000-0000-0000-000000000000",
        organizationId: a.id,
      },
    });
    await transaction.staffProfile.update({
      data: { isBookable: true },
      where: { id: profile.id },
    });
    await transaction.staffBranchAssignment.create({
      data: { branchId: branch.id, organizationId: a.id, staffProfileId: profile.id },
    });
    await transaction.staffService.create({
      data: {
        isEnabled: true,
        organizationId: a.id,
        serviceId: service.id,
        staffProfileId: profile.id,
      },
    });
    return profile;
  });
  const now = new Date();
  await runInTenant(client, a.access, async (transaction) => {
    const appointments = await Promise.all(
      ["COMPLETED", "CANCELLED", "NO_SHOW"].map((status, index) =>
        transaction.appointment.create({
          data: {
            branchId: branch.id,
            customerId: customer.id,
            endsAt: new Date(now.getTime() + (index * 60 + 30) * 60_000),
            organizationId: a.id,
            providerId: provider.id,
            serviceId: service.id,
            source: index === 0 ? "PUBLIC_BOOKING" : "STAFF",
            startsAt: new Date(now.getTime() + index * 60 * 60_000),
            status: status as "COMPLETED" | "CANCELLED" | "NO_SHOW",
            timezone: "Asia/Amman",
          },
        }),
      ),
    );
    await transaction.attributionEvent.createMany({
      data: [
        {
          appointmentId: appointments[0]?.id,
          customerId: customer.id,
          occurredAt: now,
          organizationId: a.id,
          source: "PUBLIC_BOOKING",
        },
        {
          customerId: customer.id,
          occurredAt: now,
          organizationId: a.id,
          source: "PUBLIC_BOOKING",
        },
        {
          appointmentId: appointments[1]?.id,
          customerId: customer.id,
          occurredAt: now,
          organizationId: a.id,
          source: "STAFF_MANUAL",
        },
      ],
    });
  });
  return { a, admin, b, customer, ownerA };
}

beforeAll(async () => {
  fixture = await fixtureData();
});
afterAll(async () => {
  await client.$disconnect();
});

describe("Phase 7 operations intelligence", () => {
  it("creates an idempotent dry run, commits through the customer use case, and rolls back safely", async () => {
    const key = `customer-${randomUUID()}`;
    const input = {
      fileDigest: "a".repeat(64),
      fileName: "customers.csv",
      idempotencyKey: key,
      kind: "CUSTOMERS" as const,
    };
    const first = await operations.startImport(fixture.a.access, input);
    expect((await operations.startImport(fixture.a.access, input)).id).toBe(first.id);
    await expect(
      operations.startImport(fixture.a.access, { ...input, fileDigest: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await operations.stageImportRow(fixture.a.access, first.id, 2, {
      display_name: "Imported Customer",
      external_key: "customer-1",
      phone: "079 880 7788",
      preferred_locale: "ar",
    });
    const preview = await operations.finishDryRun(fixture.a.access, first.id);
    expect(preview.validRows).toBe(1);
    const committed = await operations.commitImport(fixture.a.access, first.id);
    expect(committed.importedRows).toBe(1);
    expect((await operations.rollbackImport(fixture.a.access, first.id)).status).toBe(
      "ROLLED_BACK",
    );
  });

  it("claims a batch once when commit requests run concurrently", async () => {
    const phone = `0797${suffix
      .replace(/[^0-9]/gu, "")
      .padEnd(6, "4")
      .slice(0, 6)}`;
    const batch = await operations.startImport(fixture.a.access, {
      fileDigest: "9".repeat(64),
      fileName: "concurrent-customers.csv",
      idempotencyKey: randomUUID(),
      kind: "CUSTOMERS",
    });
    await operations.stageImportRow(fixture.a.access, batch.id, 2, {
      display_name: "Concurrent Import",
      external_key: "concurrent-customer",
      phone,
      preferred_locale: "en",
    });
    await operations.finishDryRun(fixture.a.access, batch.id);
    await Promise.all([
      operations.commitImport(fixture.a.access, batch.id),
      operations.commitImport(fixture.a.access, batch.id),
    ]);
    const normalized = `+962${phone.slice(1)}`;
    const created = await runInTenant(client, fixture.a.access, (transaction) =>
      transaction.customerContact.count({
        where: { normalizedPhoneE164: normalized, organizationId: fixture.a.id },
      }),
    );
    expect(created).toBe(1);
  });

  it("detects duplicates without merging and exposes no PII in error rows", async () => {
    const batch = await operations.startImport(fixture.a.access, {
      fileDigest: "c".repeat(64),
      fileName: "duplicates.csv",
      idempotencyKey: randomUUID(),
      kind: "CUSTOMERS",
    });
    await operations.stageImportRow(fixture.a.access, batch.id, 2, {
      display_name: "Duplicate",
      external_key: "duplicate-1",
      phone: "0799001100",
      preferred_locale: "en",
    });
    const preview = await operations.finishDryRun(fixture.a.access, batch.id);
    expect(preview.duplicateRows).toBe(1);
    const [error] = await operations.getImportErrors(fixture.a.access, batch.id, 0);
    expect(error?.errorCode).toBe("DUPLICATE");
    expect(JSON.stringify(error)).not.toContain("0799001100");
  });

  it("imports services and staff invitations through authorized use cases", async () => {
    const serviceBatch = await operations.startImport(fixture.a.access, {
      fileDigest: "f".repeat(64),
      fileName: "services.csv",
      idempotencyKey: randomUUID(),
      kind: "SERVICES",
    });
    await operations.stageImportRow(fixture.a.access, serviceBatch.id, 2, {
      currency: "JOD",
      duration_minutes: "45",
      external_key: "phase7-service",
      name_ar: `خدمة ${suffix}`,
      name_en: `Imported Service ${suffix}`,
      price_minor: "1750",
    });
    expect((await operations.finishDryRun(fixture.a.access, serviceBatch.id)).validRows).toBe(1);
    expect((await operations.commitImport(fixture.a.access, serviceBatch.id)).importedRows).toBe(1);

    const staffBatch = await operations.startImport(fixture.a.access, {
      fileDigest: "1".repeat(64),
      fileName: "staff.csv",
      idempotencyKey: randomUUID(),
      kind: "STAFF",
    });
    const invitedEmail = `phase7-imported-${suffix}@example.invalid`;
    await operations.stageImportRow(fixture.a.access, staffBatch.id, 2, {
      email: invitedEmail,
      external_key: "phase7-staff",
      role_key: "PROVIDER",
    });
    expect((await operations.finishDryRun(fixture.a.access, staffBatch.id)).validRows).toBe(1);
    expect((await operations.commitImport(fixture.a.access, staffBatch.id)).importedRows).toBe(1);
    const invitation = await runInTenant(client, fixture.a.access, (transaction) =>
      transaction.organizationInvitation.findFirst({
        where: { email: invitedEmail, organizationId: fixture.a.id, status: "PENDING" },
      }),
    );
    expect(invitation).not.toBeNull();
    await operations.rollbackImport(fixture.a.access, staffBatch.id);
    const revoked = await runInTenant(client, fixture.a.access, (transaction) =>
      transaction.organizationInvitation.findFirst({
        where: { email: invitedEmail, organizationId: fixture.a.id },
      }),
    );
    expect(revoked?.status).toBe("REVOKED");
  });

  it("calculates documented rates, attribution and reliable revenue in organization time", async () => {
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Amman" });
    const report = await operations.runOperationalReport(fixture.a.access, date, date);
    expect(report.cancellationRate).toBeCloseTo(1 / 3);
    expect(report.noShowRate).toBeCloseTo(1 / 3);
    expect(report.revenueEstimateMinor).toBe(1000);
    expect(
      report.conversionsByChannel.find(({ source }) => source === "PUBLIC_BOOKING")?.rate,
    ).toBe(0.5);
    expect(report.timezone).toBe("Asia/Amman");
  });

  it("enforces tenant isolation for imports, reports, exports and PostgreSQL RLS", async () => {
    const batch = await operations.startImport(fixture.a.access, {
      fileDigest: "d".repeat(64),
      fileName: "isolated.csv",
      idempotencyKey: randomUUID(),
      kind: "SERVICES",
    });
    expect((await operations.listImports(fixture.b.access)).some(({ id }) => id === batch.id)).toBe(
      false,
    );
    const leaked = await runInTenant(client, fixture.b.access, (transaction) =>
      transaction.importBatch.findFirst({ where: { id: batch.id } }),
    );
    expect(leaked).toBeNull();
    const exportJob = await operations.createExportJob(fixture.a.access, "CUSTOMERS");
    await expect(operations.getExportPage(fixture.b.access, exportJob.id, 0)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
  });

  it("checks explicit permissions before imports, reports, audit reads and exports", async () => {
    const restricted = { ...fixture.a.access, grants: [] };
    await expect(
      operations.startImport(restricted, {
        fileDigest: "e".repeat(64),
        fileName: "forbidden.csv",
        idempotencyKey: randomUUID(),
        kind: "CUSTOMERS",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      operations.runOperationalReport(restricted, "2026-08-01", "2026-08-01"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(operations.listAudit(restricted, 1)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(operations.createExportJob(restricted, "CUSTOMERS")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("applies self scope when exporting customer PII", async () => {
    const scoped = {
      ...fixture.a.access,
      grants: [
        { code: "exports.manage" as const, scope: "ORGANIZATION" as const },
        { code: "customers.read" as const, scope: "SELF" as const },
      ],
      staffProfileId: randomUUID(),
    };
    const job = await operations.createExportJob(scoped, "CUSTOMERS");
    const page = await operations.getExportPage(scoped, job.id, 0);
    expect(page.rows).toHaveLength(0);
  });

  it("requires a reason for super-admin global audit and records the access", async () => {
    await expect(operations.listPlatformAudit(fixture.admin.id, "", 1)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await operations.listPlatformAudit(fixture.admin.id, "Phase 7 integration verification", 1);
    const evidence = await client.platformAuditEvent.findFirst({
      where: { actorUserId: fixture.admin.id, action: "PLATFORM_AUDIT_VIEWED" },
    });
    expect(evidence?.reason).toBe("Phase 7 integration verification");
  });
});
