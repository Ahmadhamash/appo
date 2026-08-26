import { randomUUID } from "node:crypto";

import { DeterministicCopilotModel } from "@jormall/ai/copilot";
import { createPrismaClient } from "@jormall/db/client";
import { CopilotRepository } from "@jormall/db/copilot-repository";
import { CrmAppointmentRepository } from "@jormall/db/crm-appointment-repository";
import { OrganizationStatus, PlatformRole } from "@jormall/db/generated/enums";
import { IdentityRepository } from "@jormall/db/identity-repository";
import { SchedulingRepository } from "@jormall/db/scheduling-repository";
import { runInTenant } from "@jormall/db/tenant-context";
import { StaffCopilotService } from "@jormall/domain/copilot";
import { DomainError } from "@jormall/domain/errors";
import type { TenantAccessSnapshot } from "@jormall/domain/identity";
import { localDateForInstant, localDateTimeToUtc } from "@jormall/domain/timezone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A PostgreSQL integration-test URL is required.");

const client = createPrismaClient(databaseUrl);
const identity = new IdentityRepository(client);
const appointments = new CrmAppointmentRepository(client);
const scheduling = new SchedulingRepository(client);
const copilot = new CopilotRepository(client);
const service = new StaffCopilotService(copilot, new DeterministicCopilotModel(), copilot);
const suffix = randomUUID().slice(0, 8);

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let fixture: Fixture;

async function createUser(label: string, platformRole = PlatformRole.USER) {
  return client.user.create({
    data: {
      email: `copilot-${label}-${suffix}@example.invalid`,
      name: `Copilot ${label}`,
      platformRole,
    },
  });
}

async function createOrganization(
  superAdminId: string,
  owner: Readonly<{ email: string; id: string }>,
  label: string,
) {
  const created = await identity.createOrganization(superAdminId, {
    nameAr: `${label} العربية`,
    nameEn: `${label} English`,
    ownerEmail: owner.email,
    slug: `copilot-${label.toLowerCase()}-${suffix}`,
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
  return { access, organizationId: created.organizationId };
}

async function createFixture() {
  const [superAdmin, ownerA, ownerB, providerUser] = await Promise.all([
    createUser("super", PlatformRole.JORMALL_SUPER_ADMIN),
    createUser("owner-a"),
    createUser("owner-b"),
    createUser("provider"),
  ]);
  const [organizationA, organizationB] = await Promise.all([
    createOrganization(superAdmin.id, ownerA, "TenantA"),
    createOrganization(superAdmin.id, ownerB, "TenantB"),
  ]);
  await identity.createBranch(organizationA.access, {
    nameAr: "فرع المساعد",
    nameEn: "Copilot Branch",
    timezone: "Asia/Amman",
  });
  await identity.createService(organizationA.access, {
    currency: "JOD",
    defaultDurationMins: 30,
    defaultPriceMinor: 2000,
    nameAr: "خدمة المساعد",
    nameEn: "Copilot Service",
  });
  const [branch] = await identity.listBranches(organizationA.access);
  const [catalogService] = await identity.listServices(organizationA.access);
  if (!branch || !catalogService) throw new Error("Copilot catalog fixture is missing.");
  await identity.configureServiceBranch(organizationA.access, {
    branchId: branch.id,
    durationMins: 30,
    isEnabled: true,
    priceMinor: 2000,
    serviceId: catalogService.id,
  });
  const roles = await identity.listRoles(organizationA.access);
  const providerRole = roles.find(({ systemKey }) => systemKey === "PROVIDER");
  if (!providerRole) throw new Error("Provider role is missing.");
  const invitation = await identity.createInvitation(
    organizationA.access,
    providerUser.email,
    providerRole.id,
  );
  const providerMembership = await identity.acceptInvitation(
    providerUser.id,
    providerUser.email,
    invitation,
  );
  const provider = await runInTenant(
    client,
    { actorUserId: ownerA.id, organizationId: organizationA.organizationId },
    async (transaction) => {
      const profile = await transaction.staffProfile.findFirstOrThrow({
        where: {
          membershipId: providerMembership.membershipId,
          organizationId: organizationA.organizationId,
        },
      });
      await transaction.staffProfile.update({
        data: { isBookable: true },
        where: { id: profile.id },
      });
      await transaction.staffBranchAssignment.create({
        data: {
          branchId: branch.id,
          organizationId: organizationA.organizationId,
          staffProfileId: profile.id,
        },
      });
      await transaction.staffService.create({
        data: {
          isEnabled: true,
          organizationId: organizationA.organizationId,
          serviceId: catalogService.id,
          staffProfileId: profile.id,
        },
      });
      return profile;
    },
  );
  for (const weekday of [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
  ] as const) {
    await identity.createAvailabilityRule(organizationA.access, {
      branchId: branch.id,
      endMinuteLocal: 1_440,
      staffProfileId: provider.id,
      startMinuteLocal: 0,
      weekday,
    });
    await scheduling.createBranchHoursRule(organizationA.access, {
      branchId: branch.id,
      endMinuteLocal: 1_440,
      startMinuteLocal: 0,
      weekday,
    });
  }
  const customerA = (
    await appointments.createCustomer(organizationA.access, {
      displayName: "Authorized Customer",
      phoneOriginal: "079 700 1122",
      preferredLocale: "en",
    })
  ).customer;
  const customerB = (
    await appointments.createCustomer(organizationB.access, {
      displayName: "Other Tenant Customer",
      phoneOriginal: "079 700 3344",
      preferredLocale: "en",
    })
  ).customer;
  const localDay = localDateForInstant(new Date(Date.now() + 24 * 60 * 60_000), "Asia/Amman");
  const appointment = await appointments.createAppointment(organizationA.access, {
    branchId: branch.id,
    customerId: customerA.id,
    idempotencyKey: randomUUID(),
    providerId: provider.id,
    serviceId: catalogService.id,
    startsAtLocal: `${localDay}T11:00`,
    status: "CONFIRMED",
  });
  const today = localDateForInstant(new Date(), "Asia/Amman");
  await runInTenant(
    client,
    { actorUserId: ownerA.id, organizationId: organizationA.organizationId },
    async (transaction) => {
      for (const [startsAtLocal, endsAtLocal] of [
        [`${today}T09:00`, `${today}T09:30`],
        [`${today}T13:00`, `${today}T13:30`],
      ] as const) {
        await transaction.appointment.create({
          data: {
            branchId: branch.id,
            customerId: customerA.id,
            endsAt: localDateTimeToUtc(endsAtLocal, "Asia/Amman"),
            organizationId: organizationA.organizationId,
            providerId: provider.id,
            serviceId: catalogService.id,
            source: "STAFF",
            startsAt: localDateTimeToUtc(startsAtLocal, "Asia/Amman"),
            status: "CONFIRMED",
            timezone: "Asia/Amman",
          },
        });
      }
    },
  );
  const waitlistEntry = await scheduling.createWaitlistEntry(organizationA.access, {
    branchIds: [branch.id],
    customerId: customerA.id,
    preferredEndDate: today,
    preferredEndMinute: 12 * 60,
    preferredStartDate: today,
    preferredStartMinute: 10 * 60,
    priority: 10,
    providerIds: [provider.id],
    serviceId: catalogService.id,
  });
  const providerAccess = await identity.loadTenantAccess(
    providerUser.id,
    {
      activeMembershipId: providerMembership.membershipId,
      activeOrganizationId: organizationA.organizationId,
    },
    {},
  );
  return {
    appointment,
    branch,
    customerA,
    customerB,
    organizationA,
    organizationB,
    ownerA,
    providerAccess,
    waitlistEntry,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
});

afterAll(async () => {
  await client.$disconnect();
});

describe("Phase 6 Staff Copilot", () => {
  it("persists evidence, traceability, deterministic regeneration and append-only feedback", async () => {
    const [first, duplicate] = await Promise.all([
      service.generate(fixture.organizationA.access, {
        insightType: "DAILY_BRIEFING",
        locale: "en",
      }),
      service.generate(fixture.organizationA.access, {
        insightType: "DAILY_BRIEFING",
        locale: "en",
      }),
    ]);
    expect(duplicate.id).toBe(first.id);
    expect(first.statements.length).toBeGreaterThan(0);
    expect(first.statements.every(({ evidenceIds }) => evidenceIds.length > 0)).toBe(true);
    expect(first.modelIdentifier).toBe("jormall-copilot-deterministic-mock-v1");
    expect(first.promptVersion).toBeGreaterThan(0);
    await copilot.recordFeedback(
      fixture.organizationA.access,
      first.id,
      "INCORRECT",
      "Fixture correction",
    );
    const listed = await copilot.listInsights(fixture.organizationA.access);
    expect(listed.find(({ id }) => id === first.id)?.feedback).toHaveLength(1);
  });

  it("enforces tenant isolation through repository predicates and PostgreSQL RLS", async () => {
    const insight = await service.generate(fixture.organizationA.access, {
      insightType: "CUSTOMER_SUMMARY",
      locale: "en",
      subjectId: fixture.customerA.id,
    });
    expect(await copilot.listInsights(fixture.organizationB.access)).toEqual([]);
    await expect(
      service.generate(fixture.organizationA.access, {
        insightType: "CUSTOMER_SUMMARY",
        locale: "en",
        subjectId: fixture.customerB.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const leaked = await runInTenant(
      client,
      {
        actorUserId: fixture.organizationB.access.actorUserId,
        organizationId: fixture.organizationB.organizationId,
      },
      (transaction) => transaction.copilotInsight.findFirst({ where: { id: insight.id } }),
    );
    expect(leaked).toBeNull();
  });

  it("applies provider self scope and does not reveal an unrelated customer", async () => {
    const own = await service.generate(fixture.providerAccess, {
      insightType: "CUSTOMER_SUMMARY",
      locale: "en",
      subjectId: fixture.customerA.id,
    });
    expect(own.subjectId).toBe(fixture.customerA.id);
    await expect(
      service.generate(fixture.providerAccess, {
        insightType: "CUSTOMER_SUMMARY",
        locale: "en",
        subjectId: fixture.customerB.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects missing permissions and restricted call review without recording access", async () => {
    const noReports: TenantAccessSnapshot = {
      ...fixture.organizationA.access,
      grants: fixture.organizationA.access.grants.filter(({ code }) => code !== "reports.read"),
    };
    await expect(
      service.generate(noReports, { insightType: "DAILY_BRIEFING", locale: "en" }),
    ).rejects.toBeInstanceOf(DomainError);
    const noRecording: TenantAccessSnapshot = {
      ...fixture.organizationA.access,
      grants: fixture.organizationA.access.grants.filter(({ code }) => code !== "recordings.read"),
    };
    await expect(
      service.generate(noRecording, {
        insightType: "CALL_QUALITY",
        locale: "en",
        subjectId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("uses an allowlisted semantic metric and never mutates the appointment", async () => {
    const before = await appointments.getAppointment(
      fixture.organizationA.access,
      fixture.appointment.id,
    );
    const insight = await service.generate(fixture.organizationA.access, {
      insightType: "ANALYTICS",
      locale: "en",
      metricQuery: {
        endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        metric: "APPOINTMENTS_TOTAL",
        startsAt: new Date().toISOString(),
      },
    });
    const after = await appointments.getAppointment(
      fixture.organizationA.access,
      fixture.appointment.id,
    );
    expect(insight.statements[0]?.kind).toBe("COMPUTED_METRIC");
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
  });

  it("detects provider-local gaps and matches an eligible waitlist entry without mutation", async () => {
    const gaps = await service.generate(fixture.organizationA.access, {
      insightType: "SCHEDULE_GAPS",
      locale: "en",
    });
    const matches = await service.generate(fixture.organizationA.access, {
      insightType: "WAITLIST_MATCHES",
      locale: "en",
    });
    expect(gaps.statements.some(({ kind }) => kind === "AI_SUGGESTION")).toBe(true);
    expect(
      matches.statements.some(
        ({ evidenceIds, kind }) =>
          kind === "AI_SUGGESTION" && evidenceIds.includes(fixture.waitlistEntry.id),
      ),
    ).toBe(true);
    const entry = await runInTenant(
      client,
      {
        actorUserId: fixture.organizationA.access.actorUserId,
        organizationId: fixture.organizationA.organizationId,
      },
      (transaction) =>
        transaction.waitlistEntry.findFirst({ where: { id: fixture.waitlistEntry.id } }),
    );
    expect(entry?.status).toBe("ACTIVE");
  });
});
