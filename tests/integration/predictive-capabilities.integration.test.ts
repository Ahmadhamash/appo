import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@jormall/db/client";
import {
  AppointmentHistoryType,
  AppointmentSource,
  AppointmentStatus,
  ConsentChannel,
  ConsentSource,
  ConsentStatus,
  OrganizationStatus,
  PlatformRole,
  Weekday,
} from "@jormall/db/generated/enums";
import { IdentityRepository } from "@jormall/db/identity-repository";
import {
  PredictiveRepository,
  type TenantAccessSelection,
} from "@jormall/db/predictive-repository";
import { runInTenant } from "@jormall/db/tenant-context";
import type { PredictiveCapability } from "@jormall/domain/predictive";
import { localDateForInstant, localDateTimeToUtc } from "@jormall/domain/timezone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A PostgreSQL integration-test URL is required.");

const client = createPrismaClient(databaseUrl);
const identity = new IdentityRepository(client);
const predictive = new PredictiveRepository(client);
const suffix = randomUUID().slice(0, 8);
const timezone = "Asia/Amman";
const weekdays = [
  Weekday.SUNDAY,
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
] as const;
type PlatformRoleValue = (typeof PlatformRole)[keyof typeof PlatformRole];

function addLocalDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function detail(details: unknown, key: string): unknown {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  return Reflect.get(details, key);
}

function detailBoolean(details: unknown, key: string): boolean | undefined {
  const value = detail(details, key);
  return typeof value === "boolean" ? value : undefined;
}

function detailNumber(details: unknown, key: string): number | undefined {
  const value = detail(details, key);
  return typeof value === "number" ? value : undefined;
}

function detailString(details: unknown, key: string): string | undefined {
  const value = detail(details, key);
  return typeof value === "string" ? value : undefined;
}

async function createUser(label: string, platformRole: PlatformRoleValue = PlatformRole.USER) {
  return client.user.create({
    data: {
      email: `phase8-capabilities-${label}-${suffix}@example.invalid`,
      name: `Phase 8 Capabilities ${label}`,
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
    nameEn: label,
    ownerEmail: owner.email,
    slug: `phase8-capabilities-${label.toLowerCase().replaceAll(" ", "-")}-${suffix}`,
  });
  const accepted = await identity.acceptInvitation(owner.id, owner.email, created.invitationToken);
  await identity.setOrganizationStatus(
    superAdminId,
    created.organizationId,
    OrganizationStatus.ACTIVE,
  );
  const selection: TenantAccessSelection = {
    activeMembershipId: accepted.membershipId,
    activeOrganizationId: accepted.organizationId,
  };
  const access = await identity.loadTenantAccess(owner.id, selection, {});
  return { access, id: created.organizationId, selection };
}

type Tenant = Awaited<ReturnType<typeof createOrganization>>;

async function inviteProvider(tenant: Tenant, provider: Readonly<{ email: string; id: string }>) {
  const roles = await identity.listRoles(tenant.access);
  const providerRole = roles.find(({ systemKey }) => systemKey === "PROVIDER");
  if (!providerRole) throw new Error("Provider role fixture is missing.");
  const token = await identity.createInvitation(tenant.access, provider.email, providerRole.id);
  const accepted = await identity.acceptInvitation(provider.id, provider.email, token);
  const profile = await runInTenant(client, tenant.access, (transaction) =>
    transaction.staffProfile.findFirstOrThrow({
      where: { membershipId: accepted.membershipId, organizationId: tenant.id },
    }),
  );
  const selection: TenantAccessSelection = {
    activeMembershipId: accepted.membershipId,
    activeOrganizationId: tenant.id,
  };
  const access = await identity.loadTenantAccess(provider.id, selection, {});
  return { ...profile, access, selection, userId: provider.id };
}

async function inviteAssignedManager(
  tenant: Tenant,
  manager: Readonly<{ email: string; id: string }>,
  branchId: string,
) {
  const roles = await identity.listRoles(tenant.access);
  const managerRole = roles.find(({ systemKey }) => systemKey === "ORGANIZATION_MANAGER");
  if (!managerRole) throw new Error("Manager role fixture is missing.");
  const token = await identity.createInvitation(tenant.access, manager.email, managerRole.id);
  const accepted = await identity.acceptInvitation(manager.id, manager.email, token);
  await runInTenant(client, tenant.access, async (transaction) => {
    const profile = await transaction.staffProfile.create({
      data: {
        displayNameAr: "مدير الأدلة التنبؤية",
        displayNameEn: "Predictive evidence manager",
        isBookable: false,
        membershipId: accepted.membershipId,
        organizationId: tenant.id,
      },
    });
    await transaction.staffBranchAssignment.create({
      data: { branchId, organizationId: tenant.id, staffProfileId: profile.id },
    });
  });
  const selection: TenantAccessSelection = {
    activeMembershipId: accepted.membershipId,
    activeOrganizationId: tenant.id,
  };
  const access = await identity.loadTenantAccess(manager.id, selection, {});
  return { access, selection, userId: manager.id };
}

async function enableCapabilities(
  tenant: Tenant,
  actorUserId: string,
  capabilities: readonly PredictiveCapability[],
) {
  const overview = await predictive.getOverview(tenant.selection, actorUserId);
  for (const capability of capabilities) {
    const setting = overview.capabilities.find((candidate) => candidate.capability === capability);
    if (!setting) throw new Error(`${capability} capability fixture is missing.`);
    await predictive.updateCapability(tenant.selection, {
      actorUserId,
      capability,
      enabled: true,
      expectedVersion: setting.version,
    });
  }
}

async function loadScheduleState(tenant: Tenant) {
  return runInTenant(client, tenant.access, async (transaction) => ({
    availability: await transaction.availabilityRule.findMany({
      orderBy: { id: "asc" },
      select: {
        branchId: true,
        effectiveFrom: true,
        effectiveUntil: true,
        endMinuteLocal: true,
        id: true,
        staffProfileId: true,
        startMinuteLocal: true,
        weekday: true,
      },
      where: { organizationId: tenant.id },
    }),
    branchHours: await transaction.branchHoursRule.findMany({
      orderBy: { id: "asc" },
      select: {
        branchId: true,
        effectiveFrom: true,
        effectiveUntil: true,
        endMinuteLocal: true,
        id: true,
        startMinuteLocal: true,
        weekday: true,
      },
      where: { organizationId: tenant.id },
    }),
    reservations: await transaction.appointmentStaffReservation.findMany({
      orderBy: { id: "asc" },
      select: {
        appointmentId: true,
        endsAt: true,
        id: true,
        providerId: true,
        startsAt: true,
      },
      where: { organizationId: tenant.id },
    }),
    staff: await transaction.staffProfile.findMany({
      orderBy: { id: "asc" },
      select: { id: true, isBookable: true },
      where: { organizationId: tenant.id },
    }),
    timeOff: await transaction.timeOff.findMany({
      orderBy: { id: "asc" },
      select: {
        branchId: true,
        endsAt: true,
        id: true,
        staffProfileId: true,
        startsAt: true,
      },
      where: { organizationId: tenant.id },
    }),
  }));
}

async function predictionRows(tenant: Tenant, jobId: string) {
  return runInTenant(client, tenant.access, (transaction) =>
    transaction.prediction.findMany({
      orderBy: [{ horizonStartsAt: "asc" }, { id: "asc" }],
      where: { jobId, organizationId: tenant.id },
    }),
  );
}

async function createConsentTieEvidence(tenant: Tenant, actorUserId: string, customerId: string) {
  const existing = await runInTenant(client, tenant.access, (transaction) =>
    transaction.consent.findFirstOrThrow({
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      where: {
        customerId,
        organizationId: tenant.id,
        purpose: "appointment_slot_offers",
      },
    }),
  );
  const [lowerId, higherId] = [randomUUID(), randomUUID()].toSorted();
  if (!lowerId || !higherId) throw new Error("Consent tie IDs are missing.");
  const recordedAt = new Date(Math.max(Date.now(), existing.recordedAt.getTime() + 1));
  await runInTenant(client, tenant.access, (transaction) =>
    transaction.consent.createMany({
      data: [
        {
          actorUserId,
          channel: ConsentChannel.STAFF,
          customerId,
          evidence: "Lower-ID deterministic tie revocation fixture.",
          id: lowerId,
          organizationId: tenant.id,
          purpose: "appointment_slot_offers",
          recordedAt,
          revokesConsentId: existing.id,
          source: ConsentSource.STAFF,
          status: ConsentStatus.REVOKED,
          textVersion: "phase8-consent-tie-v1",
        },
        {
          actorUserId,
          channel: ConsentChannel.STAFF,
          customerId,
          evidence: "Higher-ID deterministic tie grant fixture.",
          id: higherId,
          organizationId: tenant.id,
          purpose: "appointment_slot_offers",
          recordedAt,
          source: ConsentSource.STAFF,
          status: ConsentStatus.GRANTED,
          textVersion: "phase8-consent-tie-v1",
        },
      ],
    }),
  );
  return { higherId, lowerId, recordedAt };
}

async function createSparseDemandCatalog(tenant: Tenant) {
  await identity.createBranch(tenant.access, {
    nameAr: "فرع الطلب المتناثر",
    nameEn: "Sparse demand branch",
    timezone,
  });
  await identity.createService(tenant.access, {
    currency: "JOD",
    defaultDurationMins: 30,
    nameAr: "خدمة الطلب المتناثر",
    nameEn: "Sparse demand service",
  });
  const branches = await identity.listBranches(tenant.access);
  const services = await identity.listServices(tenant.access);
  const branch = branches.find(({ nameEn }) => nameEn === "Sparse demand branch");
  const service = services.find(({ nameEn }) => nameEn === "Sparse demand service");
  if (!branch || !service) throw new Error("Sparse demand catalog fixture is missing.");
  await identity.configureServiceBranch(tenant.access, {
    branchId: branch.id,
    durationMins: 30,
    isEnabled: true,
    serviceId: service.id,
  });
  await runInTenant(client, tenant.access, (transaction) =>
    transaction.branchHoursRule.updateMany({
      data: { endMinuteLocal: 660, startMinuteLocal: 600 },
      where: { branchId: branch.id, organizationId: tenant.id },
    }),
  );
  return { branch, service };
}

async function createUnsupportedDemandBranch(tenant: Tenant, serviceId: string) {
  await identity.createBranch(tenant.access, {
    nameAr: "فرع طلب بلا تاريخ مماثل",
    nameEn: "Unsupported demand hour branch",
    timezone,
  });
  const branches = await identity.listBranches(tenant.access);
  const branch = branches.find(({ nameEn }) => nameEn === "Unsupported demand hour branch");
  if (!branch) throw new Error("Unsupported demand branch fixture is missing.");
  await identity.configureServiceBranch(tenant.access, {
    branchId: branch.id,
    durationMins: 30,
    isEnabled: true,
    serviceId,
  });
  await runInTenant(client, tenant.access, (transaction) =>
    transaction.branchHoursRule.updateMany({
      data: { endMinuteLocal: 720, startMinuteLocal: 660 },
      where: { branchId: branch.id, organizationId: tenant.id },
    }),
  );
  return branch;
}

async function createAggregateScopeEvidence(
  tenant: Tenant,
  owner: Readonly<{ id: string }>,
  providerId: string,
  managerUser: Readonly<{ email: string; id: string }>,
  today: string,
) {
  const leafBranchName = `Leaf aggregation branch ${suffix}`;
  const provenanceBranchName = `Broader provenance branch ${suffix}`;
  const serviceNames = ["Leaf demand A", "Leaf demand B", "Sparse demand C"] as const;
  await identity.createBranch(tenant.access, {
    nameAr: `فرع التجميع الورقي ${suffix}`,
    nameEn: leafBranchName,
    timezone,
  });
  for (const [index, nameEn] of serviceNames.entries()) {
    await identity.createService(tenant.access, {
      currency: "JOD",
      defaultDurationMins: 30,
      nameAr: `خدمة التجميع ${index + 1} ${suffix}`,
      nameEn: `${nameEn} ${suffix}`,
    });
  }
  const [branches, services] = await Promise.all([
    identity.listBranches(tenant.access),
    identity.listServices(tenant.access),
  ]);
  const leafBranch = branches.find(({ nameEn }) => nameEn === leafBranchName);
  const configuredServices = serviceNames.map((name) =>
    services.find(({ nameEn }) => nameEn === `${name} ${suffix}`),
  );
  const [serviceA, serviceB, serviceC] = configuredServices;
  if (!leafBranch || !serviceA || !serviceB || !serviceC) {
    throw new Error("Leaf aggregation catalog fixture is missing.");
  }
  for (const service of configuredServices) {
    if (!service) throw new Error("Leaf aggregation service fixture is missing.");
    await identity.configureServiceBranch(tenant.access, {
      branchId: leafBranch.id,
      durationMins: 30,
      isEnabled: true,
      serviceId: service.id,
    });
  }
  await runInTenant(client, tenant.access, (transaction) =>
    transaction.branchHoursRule.updateMany({
      data: { endMinuteLocal: 600, startMinuteLocal: 540 },
      where: { branchId: leafBranch.id, organizationId: tenant.id },
    }),
  );

  const targetLocalDate = addLocalDays(today, 14);
  const historyDates = Array.from({ length: 27 }, (_, index) =>
    addLocalDays(targetLocalDate, -(index + 4) * 7),
  );
  const customer = await runInTenant(client, tenant.access, (transaction) =>
    transaction.customer.create({
      data: {
        displayName: `Aggregate scope evidence ${suffix}`,
        organizationId: tenant.id,
        preferredLocale: "en",
      },
    }),
  );
  const denseAppointments = historyDates.flatMap((localDate) =>
    [serviceA, serviceB].flatMap((service) =>
      Array.from({ length: 4 }, () => {
        const startsAt = localDateTimeToUtc(`${localDate}T09:00`, timezone);
        return {
          createdAt: new Date(startsAt.getTime() - 14 * 86_400_000),
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          id: randomUUID(),
          serviceId: service.id,
          startsAt,
        };
      }),
    ),
  );
  const sparseStartsAt = localDateTimeToUtc(`${historyDates[0]}T09:00`, timezone);
  const appointments = [
    ...denseAppointments,
    {
      createdAt: new Date(sparseStartsAt.getTime() - 14 * 86_400_000),
      endsAt: new Date(sparseStartsAt.getTime() + 30 * 60_000),
      id: randomUUID(),
      serviceId: serviceC.id,
      startsAt: sparseStartsAt,
    },
  ];
  await runInTenant(client, tenant.access, async (transaction) => {
    await transaction.appointment.createMany({
      data: appointments.map((appointment) => ({
        branchId: leafBranch.id,
        createdAt: appointment.createdAt,
        customerId: customer.id,
        endsAt: appointment.endsAt,
        id: appointment.id,
        organizationId: tenant.id,
        providerId,
        serviceId: appointment.serviceId,
        source: AppointmentSource.STAFF,
        startsAt: appointment.startsAt,
        status: AppointmentStatus.COMPLETED,
        timezone,
      })),
    });
    await transaction.appointmentStatusHistory.createMany({
      data: appointments.map((appointment) => ({
        actorUserId: owner.id,
        appointmentId: appointment.id,
        createdAt: appointment.createdAt,
        endsAt: appointment.endsAt,
        eventType: AppointmentHistoryType.CREATED,
        organizationId: tenant.id,
        source: AppointmentSource.STAFF,
        startsAt: appointment.startsAt,
        toStatus: AppointmentStatus.CONFIRMED,
        version: 1,
      })),
    });
  });

  const aggregationJob = await predictive.requestJob(tenant.selection, {
    actorUserId: owner.id,
    capability: "DEMAND_FORECAST",
    endsOn: targetLocalDate,
    idempotencyKey: `phase8:aggregate-leaves:${randomUUID()}`,
    jobType: "GENERATE",
    startsOn: targetLocalDate,
  });
  await predictive.processJob(tenant.id, aggregationJob.id);

  await identity.createBranch(tenant.access, {
    nameAr: `فرع مصدر أوسع ${suffix}`,
    nameEn: provenanceBranchName,
    timezone,
  });
  const updatedBranches = await identity.listBranches(tenant.access);
  const provenanceBranch = updatedBranches.find(({ nameEn }) => nameEn === provenanceBranchName);
  if (!provenanceBranch) throw new Error("Broader provenance branch fixture is missing.");
  await identity.configureServiceBranch(tenant.access, {
    branchId: provenanceBranch.id,
    durationMins: 30,
    isEnabled: true,
    serviceId: serviceC.id,
  });
  await runInTenant(client, tenant.access, (transaction) =>
    transaction.branchHoursRule.updateMany({
      data: { endMinuteLocal: 600, startMinuteLocal: 540 },
      where: { branchId: provenanceBranch.id, organizationId: tenant.id },
    }),
  );
  const manager = await inviteAssignedManager(tenant, managerUser, provenanceBranch.id);
  const provenanceJob = await predictive.requestJob(tenant.selection, {
    actorUserId: owner.id,
    branchId: provenanceBranch.id,
    capability: "DEMAND_FORECAST",
    endsOn: targetLocalDate,
    idempotencyKey: `phase8:organization-provenance:${randomUUID()}`,
    jobType: "GENERATE",
    serviceId: serviceC.id,
    startsOn: targetLocalDate,
  });
  const evaluationJob = await predictive.requestJob(tenant.selection, {
    actorUserId: owner.id,
    branchId: provenanceBranch.id,
    capability: "DEMAND_FORECAST",
    idempotencyKey: `phase8:organization-provenance-eval:${randomUUID()}`,
    jobType: "BACKTEST",
    serviceId: serviceC.id,
  });
  const driftJob = await predictive.requestJob(tenant.selection, {
    actorUserId: owner.id,
    branchId: provenanceBranch.id,
    capability: "DEMAND_FORECAST",
    idempotencyKey: `phase8:organization-provenance-drift:${randomUUID()}`,
    jobType: "DRIFT",
    serviceId: serviceC.id,
  });
  await predictive.processJob(tenant.id, provenanceJob.id);
  await predictive.processJob(tenant.id, evaluationJob.id);
  await predictive.processJob(tenant.id, driftJob.id);
  return {
    aggregationJob,
    driftJob,
    evaluationJob,
    leafBranch,
    manager,
    provenanceBranch,
    provenanceJob,
    serviceA,
    serviceB,
    serviceC,
    targetLocalDate,
  };
}

async function createCatalogAndHistory(
  tenant: Tenant,
  owner: Readonly<{ id: string }>,
  providerUser: Readonly<{ email: string; id: string }>,
  otherProviderUser: Readonly<{ email: string; id: string }>,
  managerUser: Readonly<{ email: string; id: string }>,
) {
  await identity.createBranch(tenant.access, {
    nameAr: "فرع الأدلة التنبؤية",
    nameEn: "Primary predictive evidence branch",
    timezone,
  });
  await identity.createBranch(tenant.access, {
    nameAr: "فرع الأدلة التنبؤية الثاني",
    nameEn: "Secondary predictive evidence branch",
    timezone,
  });
  await identity.createService(tenant.access, {
    currency: "JOD",
    defaultDurationMins: 30,
    defaultPriceMinor: 2_500,
    nameAr: "خدمة الأدلة التنبؤية",
    nameEn: "Predictive evidence service",
  });
  const branches = await identity.listBranches(tenant.access);
  const branch = branches.find(({ nameEn }) => nameEn === "Primary predictive evidence branch");
  const otherBranch = branches.find(
    ({ nameEn }) => nameEn === "Secondary predictive evidence branch",
  );
  const [service] = await identity.listServices(tenant.access);
  if (!branch || !otherBranch || !service) {
    throw new Error("Predictive catalog fixture is missing.");
  }
  await identity.configureServiceBranch(tenant.access, {
    branchId: branch.id,
    durationMins: 30,
    isEnabled: true,
    priceMinor: 2_500,
    serviceId: service.id,
  });
  await identity.configureServiceBranch(tenant.access, {
    branchId: otherBranch.id,
    durationMins: 30,
    isEnabled: true,
    priceMinor: 2_500,
    serviceId: service.id,
  });
  const provider = await inviteProvider(tenant, providerUser);
  const otherProvider = await inviteProvider(tenant, otherProviderUser);
  const manager = await inviteAssignedManager(tenant, managerUser, branch.id);
  await runInTenant(client, tenant.access, async (transaction) => {
    await transaction.branchHoursRule.updateMany({
      data: { endMinuteLocal: 660, startMinuteLocal: 600 },
      where: { branchId: { in: [branch.id, otherBranch.id] }, organizationId: tenant.id },
    });
    await transaction.staffBranchAssignment.createMany({
      data: [
        {
          branchId: branch.id,
          organizationId: tenant.id,
          staffProfileId: provider.id,
        },
        {
          branchId: otherBranch.id,
          organizationId: tenant.id,
          staffProfileId: otherProvider.id,
        },
      ],
    });
    await transaction.staffService.createMany({
      data: [provider, otherProvider].map((candidate) => ({
        isEnabled: true,
        organizationId: tenant.id,
        serviceId: service.id,
        staffProfileId: candidate.id,
      })),
    });
    await transaction.availabilityRule.createMany({
      data: [
        ...weekdays.map((weekday) => ({
          branchId: branch.id,
          endMinuteLocal: 660,
          organizationId: tenant.id,
          staffProfileId: provider.id,
          startMinuteLocal: 600,
          weekday,
        })),
        ...weekdays.map((weekday) => ({
          branchId: otherBranch.id,
          endMinuteLocal: 660,
          organizationId: tenant.id,
          staffProfileId: otherProvider.id,
          startMinuteLocal: 600,
          weekday,
        })),
      ],
    });
  });

  const { demandCustomer, otherReflowCustomer, reflowCustomer } = await runInTenant(
    client,
    tenant.access,
    async (transaction) => {
      const demandCustomer = await transaction.customer.create({
        data: {
          displayName: `Predictive demand evidence ${suffix}`,
          organizationId: tenant.id,
          preferredLocale: "en",
        },
      });
      const reflowCustomer = await transaction.customer.create({
        data: {
          displayName: `Predictive reflow evidence ${suffix}`,
          organizationId: tenant.id,
          preferredLocale: "ar",
        },
      });
      const otherReflowCustomer = await transaction.customer.create({
        data: {
          displayName: `Predictive other reflow evidence ${suffix}`,
          organizationId: tenant.id,
          preferredLocale: "en",
        },
      });
      return { demandCustomer, otherReflowCustomer, reflowCustomer };
    },
  );

  const today = localDateForInstant(new Date(), timezone);
  const appointments = Array.from({ length: 240 }, (_, dayIndex) => {
    const localDate = addLocalDays(today, dayIndex - 280);
    const startsAt = localDateTimeToUtc(`${localDate}T10:00`, timezone);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const count = Math.floor(dayIndex / 7) % 2 === 0 ? 1 : 2;
    const evidenceBranch = dayIndex % 2 === 0 ? branch : otherBranch;
    const evidenceProvider = dayIndex % 2 === 0 ? provider : otherProvider;
    return Array.from({ length: count }, () => {
      const id = randomUUID();
      return {
        branchId: evidenceBranch.id,
        createdAt: new Date(startsAt.getTime() - 14 * 86_400_000),
        endsAt,
        id,
        providerId: evidenceProvider.id,
        startsAt,
      };
    });
  }).flat();
  await runInTenant(client, tenant.access, async (transaction) => {
    await transaction.appointment.createMany({
      data: appointments.map((appointment) => ({
        branchId: appointment.branchId,
        createdAt: appointment.createdAt,
        customerId: demandCustomer.id,
        endsAt: appointment.endsAt,
        id: appointment.id,
        organizationId: tenant.id,
        providerId: appointment.providerId,
        serviceId: service.id,
        source: AppointmentSource.STAFF,
        startsAt: appointment.startsAt,
        status: AppointmentStatus.COMPLETED,
        timezone,
        version: 2,
      })),
    });
    await transaction.appointmentStatusHistory.createMany({
      data: appointments.map((appointment) => ({
        actorUserId: owner.id,
        appointmentId: appointment.id,
        createdAt: appointment.createdAt,
        endsAt: appointment.endsAt,
        eventType: AppointmentHistoryType.CREATED,
        organizationId: tenant.id,
        source: AppointmentSource.STAFF,
        startsAt: appointment.startsAt,
        toStatus: AppointmentStatus.CONFIRMED,
        version: 1,
      })),
    });
    await transaction.appointmentStatusHistory.createMany({
      data: appointments.map((appointment) => ({
        actorUserId: owner.id,
        appointmentId: appointment.id,
        createdAt: new Date(appointment.endsAt.getTime() + 5 * 60_000),
        endsAt: appointment.endsAt,
        eventType: AppointmentHistoryType.STATUS_CHANGED,
        fromStatus: AppointmentStatus.CONFIRMED,
        organizationId: tenant.id,
        source: AppointmentSource.STAFF,
        startsAt: appointment.startsAt,
        toStatus: AppointmentStatus.COMPLETED,
        version: 2,
      })),
    });
  });

  const targetLocalDate = addLocalDays(today, 21);
  const targetStartsAt = localDateTimeToUtc(`${targetLocalDate}T10:00`, timezone);
  const targetEndsAt = new Date(targetStartsAt.getTime() + 30 * 60_000);
  const target = await runInTenant(client, tenant.access, async (transaction) => {
    const appointment = await transaction.appointment.create({
      data: {
        branchId: branch.id,
        customerId: reflowCustomer.id,
        endsAt: targetEndsAt,
        organizationId: tenant.id,
        providerId: provider.id,
        serviceId: service.id,
        source: AppointmentSource.STAFF,
        startsAt: targetStartsAt,
        status: AppointmentStatus.CONFIRMED,
        timezone,
      },
    });
    await transaction.appointmentStatusHistory.create({
      data: {
        actorUserId: owner.id,
        appointmentId: appointment.id,
        endsAt: targetEndsAt,
        eventType: AppointmentHistoryType.CREATED,
        organizationId: tenant.id,
        source: AppointmentSource.STAFF,
        startsAt: targetStartsAt,
        toStatus: AppointmentStatus.CONFIRMED,
        version: 1,
      },
    });
    await transaction.appointmentStaffReservation.create({
      data: {
        appointmentId: appointment.id,
        endsAt: targetEndsAt,
        organizationId: tenant.id,
        providerId: provider.id,
        startsAt: targetStartsAt,
      },
    });
    await transaction.consent.create({
      data: {
        actorUserId: owner.id,
        channel: ConsentChannel.STAFF,
        customerId: reflowCustomer.id,
        evidence: "Integration-test consent evidence; no external delivery.",
        organizationId: tenant.id,
        purpose: "appointment_slot_offers",
        source: ConsentSource.STAFF,
        status: ConsentStatus.GRANTED,
        textVersion: "phase8-integration-v1",
      },
    });
    return appointment;
  });
  const otherTarget = await runInTenant(client, tenant.access, async (transaction) => {
    const appointment = await transaction.appointment.create({
      data: {
        branchId: otherBranch.id,
        customerId: otherReflowCustomer.id,
        endsAt: targetEndsAt,
        organizationId: tenant.id,
        providerId: otherProvider.id,
        serviceId: service.id,
        source: AppointmentSource.STAFF,
        startsAt: targetStartsAt,
        status: AppointmentStatus.CONFIRMED,
        timezone,
      },
    });
    await transaction.appointmentStatusHistory.create({
      data: {
        actorUserId: owner.id,
        appointmentId: appointment.id,
        endsAt: targetEndsAt,
        eventType: AppointmentHistoryType.CREATED,
        organizationId: tenant.id,
        source: AppointmentSource.STAFF,
        startsAt: targetStartsAt,
        toStatus: AppointmentStatus.CONFIRMED,
        version: 1,
      },
    });
    await transaction.appointmentStaffReservation.create({
      data: {
        appointmentId: appointment.id,
        endsAt: targetEndsAt,
        organizationId: tenant.id,
        providerId: otherProvider.id,
        startsAt: targetStartsAt,
      },
    });
    await transaction.consent.create({
      data: {
        actorUserId: owner.id,
        channel: ConsentChannel.STAFF,
        customerId: otherReflowCustomer.id,
        evidence: "Integration-test consent evidence; no external delivery.",
        organizationId: tenant.id,
        purpose: "appointment_slot_offers",
        source: ConsentSource.STAFF,
        status: ConsentStatus.GRANTED,
        textVersion: "phase8-integration-v1",
      },
    });
    return appointment;
  });
  return {
    branch,
    historicalAppointmentCount: appointments.length,
    manager,
    otherBranch,
    otherProvider,
    otherTarget,
    provider,
    service,
    target,
    today,
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let fixture: Fixture;

async function createFixture() {
  const [admin, evidenceManagerUser, managerUser, otherProviderUser, ownerA, ownerB, providerUser] =
    await Promise.all([
      createUser("admin", PlatformRole.JORMALL_SUPER_ADMIN),
      createUser("evidence-manager"),
      createUser("manager"),
      createUser("other-provider"),
      createUser("owner-a"),
      createUser("owner-b"),
      createUser("provider"),
    ]);
  const [organizationA, organizationB] = await Promise.all([
    createOrganization(admin.id, ownerA, "Predictive Capability A"),
    createOrganization(admin.id, ownerB, "Predictive Capability B"),
  ]);
  await createSparseDemandCatalog(organizationB);
  const catalog = await createCatalogAndHistory(
    organizationA,
    ownerA,
    providerUser,
    otherProviderUser,
    managerUser,
  );
  const consentTie = await createConsentTieEvidence(
    organizationA,
    ownerA.id,
    catalog.target.customerId,
  );
  await enableCapabilities(organizationA, ownerA.id, [
    "DEMAND_FORECAST",
    "STAFFING",
    "SCHEDULE_REFLOW",
    "SERVICE_PROVIDER_RECOMMENDATION",
  ]);
  await enableCapabilities(organizationB, ownerB.id, ["DEMAND_FORECAST"]);

  const startsOn = addLocalDays(catalog.today, 1);
  const demandEndsOn = startsOn;
  const recommendationEndsOn = addLocalDays(startsOn, 2);
  const reflowEndsOn = addLocalDays(startsOn, 7);
  const demandJob = await predictive.requestJob(organizationA.selection, {
    actorUserId: ownerA.id,
    branchId: catalog.branch.id,
    capability: "DEMAND_FORECAST",
    endsOn: demandEndsOn,
    idempotencyKey: `phase8:capability:demand:${randomUUID()}`,
    jobType: "GENERATE",
    serviceId: catalog.service.id,
    startsOn,
  });
  const organizationDemandJob = await predictive.requestJob(organizationA.selection, {
    actorUserId: ownerA.id,
    capability: "DEMAND_FORECAST",
    endsOn: demandEndsOn,
    idempotencyKey: `phase8:capability:organization-demand:${randomUUID()}`,
    jobType: "GENERATE",
    startsOn,
  });
  const sparseOrganizationDemandJob = await predictive.requestJob(organizationB.selection, {
    actorUserId: ownerB.id,
    capability: "DEMAND_FORECAST",
    endsOn: demandEndsOn,
    idempotencyKey: `phase8:capability:sparse-organization-demand:${randomUUID()}`,
    jobType: "GENERATE",
    startsOn,
  });
  const staffingJob = await predictive.requestJob(organizationA.selection, {
    actorUserId: ownerA.id,
    branchId: catalog.branch.id,
    capability: "STAFFING",
    endsOn: demandEndsOn,
    idempotencyKey: `phase8:capability:staffing:${randomUUID()}`,
    jobType: "GENERATE",
    serviceId: catalog.service.id,
    startsOn,
  });
  const recommendationJob = await predictive.requestJob(organizationA.selection, {
    actorUserId: ownerA.id,
    branchId: catalog.branch.id,
    capability: "SERVICE_PROVIDER_RECOMMENDATION",
    endsOn: recommendationEndsOn,
    idempotencyKey: `phase8:capability:recommendation:${randomUUID()}`,
    jobType: "GENERATE",
    serviceId: catalog.service.id,
    startsOn,
  });
  const reflowJob = await predictive.requestJob(organizationA.selection, {
    actorUserId: ownerA.id,
    appointmentId: catalog.target.id,
    capability: "SCHEDULE_REFLOW",
    endsOn: reflowEndsOn,
    idempotencyKey: `phase8:capability:reflow:${randomUUID()}`,
    jobType: "GENERATE",
    startsOn,
  });
  const otherReflowJob = await predictive.requestJob(organizationA.selection, {
    actorUserId: ownerA.id,
    appointmentId: catalog.otherTarget.id,
    capability: "SCHEDULE_REFLOW",
    endsOn: reflowEndsOn,
    idempotencyKey: `phase8:capability:other-reflow:${randomUUID()}`,
    jobType: "GENERATE",
    startsOn,
  });
  const backtestJob = await predictive.requestJob(organizationA.selection, {
    actorUserId: ownerA.id,
    branchId: catalog.branch.id,
    capability: "DEMAND_FORECAST",
    idempotencyKey: `phase8:capability:backtest:${randomUUID()}`,
    jobType: "BACKTEST",
    serviceId: catalog.service.id,
  });

  await predictive.processJob(organizationA.id, demandJob.id);
  await predictive.processJob(organizationA.id, organizationDemandJob.id);
  const unsupportedDemandBranch = await createUnsupportedDemandBranch(
    organizationA,
    catalog.service.id,
  );
  const incompleteOrganizationDemandJob = await predictive.requestJob(organizationA.selection, {
    actorUserId: ownerA.id,
    capability: "DEMAND_FORECAST",
    endsOn: demandEndsOn,
    idempotencyKey: `phase8:capability:incomplete-organization-demand:${randomUUID()}`,
    jobType: "GENERATE",
    startsOn,
  });
  await predictive.processJob(organizationA.id, incompleteOrganizationDemandJob.id);
  await predictive.processJob(organizationB.id, sparseOrganizationDemandJob.id);
  const aggregateScope = await createAggregateScopeEvidence(
    organizationA,
    ownerA,
    catalog.provider.id,
    evidenceManagerUser,
    catalog.today,
  );
  const scheduleBeforeStaffing = await loadScheduleState(organizationA);
  await predictive.processJob(organizationA.id, staffingJob.id);
  const scheduleAfterStaffing = await loadScheduleState(organizationA);

  const bookingCountBeforeRecommendation = await runInTenant(
    client,
    organizationA.access,
    (transaction) => transaction.appointment.count({ where: { organizationId: organizationA.id } }),
  );
  const reservationCountBeforeRecommendation = await runInTenant(
    client,
    organizationA.access,
    (transaction) =>
      transaction.appointmentStaffReservation.count({
        where: { organizationId: organizationA.id },
      }),
  );
  await predictive.processJob(organizationA.id, recommendationJob.id);
  const bookingCountAfterRecommendation = await runInTenant(
    client,
    organizationA.access,
    (transaction) => transaction.appointment.count({ where: { organizationId: organizationA.id } }),
  );
  const reservationCountAfterRecommendation = await runInTenant(
    client,
    organizationA.access,
    (transaction) =>
      transaction.appointmentStaffReservation.count({
        where: { organizationId: organizationA.id },
      }),
  );

  const targetBeforeReflow = await runInTenant(client, organizationA.access, (transaction) =>
    transaction.appointment.findFirstOrThrow({
      select: {
        endsAt: true,
        id: true,
        startsAt: true,
        status: true,
        updatedAt: true,
        version: true,
      },
      where: { id: catalog.target.id, organizationId: organizationA.id },
    }),
  );
  await predictive.processJob(organizationA.id, reflowJob.id);
  await predictive.processJob(organizationA.id, otherReflowJob.id);
  const targetAfterReflow = await runInTenant(client, organizationA.access, (transaction) =>
    transaction.appointment.findFirstOrThrow({
      select: {
        endsAt: true,
        id: true,
        startsAt: true,
        status: true,
        updatedAt: true,
        version: true,
      },
      where: { id: catalog.target.id, organizationId: organizationA.id },
    }),
  );
  await predictive.processJob(organizationA.id, backtestJob.id);

  return {
    aggregateScope,
    backtestJob,
    bookingCountAfterRecommendation,
    bookingCountBeforeRecommendation,
    catalog,
    consentTie,
    demandJob,
    incompleteOrganizationDemandJob,
    organizationDemandJob,
    organizationA,
    organizationB,
    ownerA,
    ownerB,
    otherReflowJob,
    recommendationJob,
    reflowJob,
    reservationCountAfterRecommendation,
    reservationCountBeforeRecommendation,
    scheduleAfterStaffing,
    scheduleBeforeStaffing,
    sparseOrganizationDemandJob,
    staffingJob,
    targetAfterReflow,
    targetBeforeReflow,
    unsupportedDemandBranch,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
}, 180_000);

afterAll(async () => {
  await client.$disconnect();
});

describe("Phase 8 predictive capability PostgreSQL evidence", () => {
  it("persists a demand forecast with an uncertainty interval and reversible Amman bucket provenance", async () => {
    const rows = await predictionRows(fixture.organizationA, fixture.demandJob.id);
    const audit = await runInTenant(client, fixture.organizationA.access, (transaction) =>
      transaction.predictiveDataAudit.findFirstOrThrow({
        where: { jobId: fixture.demandJob.id, organizationId: fixture.organizationA.id },
      }),
    );
    expect(audit).toMatchObject({
      eligible: true,
      sampleSize: fixture.catalog.historicalAppointmentCount,
    });
    if (!audit.historyStartsAt || !audit.historyEndsAt) {
      throw new Error("Demand history boundary evidence is missing.");
    }
    expect(
      (audit.historyEndsAt.getTime() - audit.historyStartsAt.getTime()) / 86_400_000,
    ).toBeGreaterThanOrEqual(182);
    expect(rows).toHaveLength(1);
    const [prediction] = rows;
    if (!prediction) throw new Error("Demand prediction evidence is missing.");
    expect(prediction).toMatchObject({
      branchId: fixture.catalog.branch.id,
      capability: "DEMAND_FORECAST",
      serviceId: fixture.catalog.service.id,
      status: "GENERATED",
      subjectType: "DEMAND_BUCKET",
    });
    expect(prediction.estimate).not.toBeNull();
    expect(prediction.lowerBound).not.toBeNull();
    expect(prediction.upperBound).not.toBeNull();
    expect(prediction.lowerBound).toBeLessThanOrEqual(prediction.estimate ?? -1);
    expect(prediction.upperBound).toBeGreaterThanOrEqual(prediction.estimate ?? Number.MAX_VALUE);
    expect(detailString(prediction.details, "timezone")).toBe(timezone);
    expect(detailString(prediction.details, "localDate")).toBe(
      addLocalDays(fixture.catalog.today, 1),
    );
    expect(detailNumber(prediction.details, "localHour")).toBe(10);
    const localDate = detailString(prediction.details, "localDate");
    const localHour = detailNumber(prediction.details, "localHour");
    if (!localDate || localHour === undefined || !prediction.horizonStartsAt) {
      throw new Error("Demand bucket time provenance is incomplete.");
    }
    expect(prediction.horizonStartsAt).toEqual(
      localDateTimeToUtc(`${localDate}T${localHour.toString().padStart(2, "0")}:00`, timezone),
    );
    expect(prediction.horizonStartsAt.toISOString()).toMatch(/Z$/u);
    expect(detailString(prediction.details, "historyCutoff")).toBe(
      new Date(fixture.demandJob.createdAt).toISOString(),
    );
    expect(detailString(prediction.details, "configurationReadAt")).toBe(
      prediction.asOf.toISOString(),
    );
    expect(prediction.asOf.getTime()).toBeGreaterThanOrEqual(
      new Date(fixture.demandJob.createdAt).getTime(),
    );
  });

  it("persists branch components and a branchless organization-timezone demand total", async () => {
    const rows = await predictionRows(fixture.organizationA, fixture.organizationDemandJob.id);
    const components = rows.filter(({ subjectType }) => subjectType === "DEMAND_BUCKET");
    const totals = rows.filter(({ subjectType }) => subjectType === "ORGANIZATION_DEMAND_BUCKET");
    expect(new Set(components.map(({ branchId }) => branchId))).toEqual(
      new Set([fixture.catalog.branch.id, fixture.catalog.otherBranch.id]),
    );
    expect(components.every(({ serviceId }) => serviceId === fixture.catalog.service.id)).toBe(
      true,
    );
    expect(totals).toHaveLength(1);
    const [total] = totals;
    if (!total) throw new Error("Organization demand total evidence is missing.");
    expect(total).toMatchObject({
      branchId: null,
      capability: "DEMAND_FORECAST",
      providerId: null,
      serviceId: null,
      status: "GENERATED",
      subjectId: null,
      subjectType: "ORGANIZATION_DEMAND_BUCKET",
    });
    expect(detailString(total.details, "scope")).toBe("ORGANIZATION");
    expect(detailString(total.details, "timezone")).toBe(timezone);
    expect(detailString(total.details, "aggregationMethod")).toBeTruthy();
    expect(detailNumber(total.details, "componentCount")).toBe(2);
    expect(detailNumber(total.details, "branchCount")).toBe(2);
    expect(detailNumber(total.details, "serviceCount")).toBe(1);
    const componentEstimate = components.reduce(
      (sum, component) => sum + (component.estimate ?? 0),
      0,
    );
    const componentLower = components.reduce(
      (sum, component) => sum + (component.lowerBound ?? 0),
      0,
    );
    const componentUpper = components.reduce(
      (sum, component) => sum + (component.upperBound ?? 0),
      0,
    );
    expect(total.estimate).toBeCloseTo(componentEstimate);
    expect(total.lowerBound).toBeCloseTo(componentLower);
    expect(total.upperBound).toBeCloseTo(componentUpper);
    expect(total.horizonStartsAt).toEqual(components[0]?.horizonStartsAt);
    expect(total.horizonEndsAt).toEqual(components[0]?.horizonEndsAt);
  });

  it("persists an explicit branchless refusal when organization demand is incomplete", async () => {
    const rows = await predictionRows(
      fixture.organizationB,
      fixture.sparseOrganizationDemandJob.id,
    );
    const totals = rows.filter(({ subjectType }) => subjectType === "ORGANIZATION_DEMAND_BUCKET");
    expect(totals).toHaveLength(1);
    const [total] = totals;
    if (!total) throw new Error("Sparse organization demand refusal is missing.");
    expect(total).toMatchObject({
      branchId: null,
      capability: "DEMAND_FORECAST",
      estimate: null,
      lowerBound: null,
      providerId: null,
      refusalReason: "INSUFFICIENT_SAMPLE",
      serviceId: null,
      status: "REFUSED",
      subjectId: null,
      subjectType: "ORGANIZATION_DEMAND_BUCKET",
      upperBound: null,
    });
    expect(detailString(total.details, "scope")).toBe("ORGANIZATION");
    expect(detailBoolean(total.details, "complete")).toBe(false);
    expect(detailNumber(total.details, "available")).toBe(0);
    expect(detailNumber(total.details, "required")).toBe(200);
  });

  it("refuses an organization time bucket when a required configured component is unsupported", async () => {
    const rows = await predictionRows(
      fixture.organizationA,
      fixture.incompleteOrganizationDemandJob.id,
    );
    const componentRefusal = rows.find(
      ({ branchId, status, subjectType }) =>
        branchId === fixture.unsupportedDemandBranch.id &&
        status === "REFUSED" &&
        subjectType === "DEMAND_BUCKET",
    );
    expect(componentRefusal).toMatchObject({
      estimate: null,
      lowerBound: null,
      refusalReason: "INSUFFICIENT_SAMPLE",
      upperBound: null,
    });
    const total = rows.find(
      ({ branchId, status, subjectType }) =>
        branchId === null && status === "REFUSED" && subjectType === "ORGANIZATION_DEMAND_BUCKET",
    );
    expect(total).toMatchObject({
      estimate: null,
      lowerBound: null,
      refusalReason: "INSUFFICIENT_SAMPLE",
      serviceId: null,
      subjectId: null,
      upperBound: null,
    });
    if (!total) throw new Error("Incomplete organization time-bucket refusal is missing.");
    expect(detailString(total.details, "scope")).toBe("ORGANIZATION");
    expect(detailBoolean(total.details, "complete")).toBe(false);
    expect(detailNumber(total.details, "componentCount")).toBe(1);
    expect(detailNumber(total.details, "generatedComponentCount")).toBe(0);
    expect(detailNumber(total.details, "refusedComponentCount")).toBe(1);
    expect(detailNumber(total.details, "available")).toBe(0);
    expect(detailNumber(total.details, "required")).toBe(8);
  });

  it("refuses an organization total instead of double-counting a same-branch fallback component", async () => {
    const rows = await predictionRows(
      fixture.organizationA,
      fixture.aggregateScope.aggregationJob.id,
    );
    const components = rows.filter(
      ({ branchId, subjectType }) =>
        branchId === fixture.aggregateScope.leafBranch.id && subjectType === "DEMAND_BUCKET",
    );
    expect(components).toHaveLength(3);
    const componentByService = new Map(components.map((row) => [row.serviceId, row]));
    for (const service of [fixture.aggregateScope.serviceA, fixture.aggregateScope.serviceB]) {
      const component = componentByService.get(service.id);
      expect(component).toMatchObject({ status: "GENERATED" });
      expect(detailString(component?.details, "fallbackLevel")).toBe("BRANCH_SERVICE");
      expect(detailString(component?.details, "sourceScope")).toBe("BRANCH_SERVICE");
    }
    const sparse = componentByService.get(fixture.aggregateScope.serviceC.id);
    expect(sparse).toMatchObject({
      estimate: null,
      refusalReason: "INSUFFICIENT_SAMPLE",
      status: "REFUSED",
    });
    expect(detailString(sparse?.details, "attemptedFallbackLevel")).toBe("BRANCH");
    expect(detailString(sparse?.details, "sourceScope")).toBe("BRANCH");
    expect(detailNumber(sparse?.details, "available")).toBe(1);
    expect(detailNumber(sparse?.details, "required")).toBe(8);

    const matchingTotal = rows.find(
      ({ branchId, details, subjectType }) =>
        branchId === null &&
        subjectType === "ORGANIZATION_DEMAND_BUCKET" &&
        detailString(details, "localDate") === fixture.aggregateScope.targetLocalDate &&
        detailNumber(details, "localHour") === 9,
    );
    expect(matchingTotal).toMatchObject({
      estimate: null,
      lowerBound: null,
      refusalReason: "INSUFFICIENT_SAMPLE",
      status: "REFUSED",
      upperBound: null,
    });
    if (!matchingTotal) throw new Error("Leaf-only organization refusal is missing.");
    expect(detailBoolean(matchingTotal.details, "complete")).toBe(false);
    expect(detailNumber(matchingTotal.details, "componentCount")).toBe(3);
    expect(detailNumber(matchingTotal.details, "fallbackComponentCount")).toBe(1);
    expect(detailNumber(matchingTotal.details, "available")).toBe(1);
    expect(detailNumber(matchingTotal.details, "required")).toBe(8);
    expect(detailString(matchingTotal.details, "sourceScope")).toBe("ORGANIZATION");
  });

  it("withholds organization-sourced branch evidence and aggregates from branch and self viewers", async () => {
    const [rows, managerOverview, providerOverview, evaluation, drift] = await Promise.all([
      predictionRows(fixture.organizationA, fixture.aggregateScope.provenanceJob.id),
      predictive.getOverview(
        fixture.aggregateScope.manager.selection,
        fixture.aggregateScope.manager.userId,
      ),
      predictive.getOverview(fixture.catalog.provider.selection, fixture.catalog.provider.userId),
      runInTenant(client, fixture.organizationA.access, (transaction) =>
        transaction.predictiveEvaluationRun.findFirstOrThrow({
          where: {
            jobId: fixture.aggregateScope.evaluationJob.id,
            organizationId: fixture.organizationA.id,
          },
        }),
      ),
      runInTenant(client, fixture.organizationA.access, (transaction) =>
        transaction.predictiveDriftRun.findFirstOrThrow({
          where: {
            jobId: fixture.aggregateScope.driftJob.id,
            organizationId: fixture.organizationA.id,
          },
        }),
      ),
    ]);
    expect(rows).toHaveLength(1);
    const [prediction] = rows;
    if (!prediction) throw new Error("Organization-source branch prediction is missing.");
    expect(prediction).toMatchObject({
      branchId: fixture.aggregateScope.provenanceBranch.id,
      estimate: null,
      refusalReason: "INSUFFICIENT_SAMPLE",
      status: "REFUSED",
      subjectType: "DEMAND_BUCKET",
    });
    expect(detailString(prediction.details, "attemptedFallbackLevel")).toBe("ORGANIZATION");
    expect(detailString(prediction.details, "sourceScope")).toBe("ORGANIZATION");
    expect(detailString(evaluation.metrics, "sourceScope")).toBe("ORGANIZATION");
    expect(detailString(drift.metrics, "sourceScope")).toBe("ORGANIZATION");

    const managerPredictionIds = new Set(managerOverview.predictions.map(({ id }) => id));
    const providerPredictionIds = new Set(providerOverview.predictions.map(({ id }) => id));
    expect(managerPredictionIds.has(prediction.id)).toBe(false);
    expect(providerPredictionIds.has(prediction.id)).toBe(false);
    expect(managerOverview.evaluations.some(({ id }) => id === evaluation.id)).toBe(false);
    expect(managerOverview.drift.some(({ id }) => id === drift.id)).toBe(false);
    expect(providerOverview.evaluations.some(({ id }) => id === evaluation.id)).toBe(false);
    expect(providerOverview.drift.some(({ id }) => id === drift.id)).toBe(false);
    await expect(
      predictive.recordFeedback(fixture.aggregateScope.manager.selection, {
        actorUserId: fixture.aggregateScope.manager.userId,
        feedbackType: "HELPFUL",
        predictionId: prediction.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      predictive.recordFeedback(fixture.catalog.provider.selection, {
        actorUserId: fixture.catalog.provider.userId,
        feedbackType: "HELPFUL",
        predictionId: prediction.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("persists a bounded staffing advisory without changing configured staff schedules", async () => {
    const rows = await predictionRows(fixture.organizationA, fixture.staffingJob.id);
    expect(rows).toHaveLength(1);
    const [prediction] = rows;
    if (!prediction) throw new Error("Staffing prediction evidence is missing.");
    expect(prediction).toMatchObject({
      branchId: fixture.catalog.branch.id,
      capability: "STAFFING",
      serviceId: fixture.catalog.service.id,
      status: "GENERATED",
      subjectType: "STAFFING_HORIZON",
    });
    expect(prediction.estimate).not.toBeNull();
    expect(prediction.lowerBound).not.toBeNull();
    expect(prediction.upperBound).not.toBeNull();
    expect(["ADD_CAPACITY", "BALANCED", "REVIEW_EXCESS_CAPACITY"]).toContain(
      detailString(prediction.details, "action"),
    );
    expect(detailBoolean(prediction.details, "advisory")).toBe(true);
    expect(detailBoolean(prediction.details, "automaticScheduleMutationAllowed")).toBe(false);
    expect(detailNumber(prediction.details, "availableMinutes")).toBe(60);
    expect(fixture.scheduleAfterStaffing).toEqual(fixture.scheduleBeforeStaffing);
  });

  it("persists valid expiring provider-slot recommendations without creating a booking", async () => {
    const rows = await predictionRows(fixture.organizationA, fixture.recommendationJob.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(10);
    for (const prediction of rows) {
      expect(prediction).toMatchObject({
        branchId: fixture.catalog.branch.id,
        capability: "SERVICE_PROVIDER_RECOMMENDATION",
        providerId: fixture.catalog.provider.id,
        serviceId: fixture.catalog.service.id,
        status: "GENERATED",
        subjectType: "PROVIDER_SLOT",
      });
      expect(detailBoolean(prediction.details, "automaticBookingAllowed")).toBe(false);
      expect(detailBoolean(prediction.details, "requiresCustomerConfirmation")).toBe(true);
      expect(detailBoolean(prediction.details, "requiresStaffConfirmation")).toBe(true);
      expect(detailBoolean(prediction.details, "acceptanceProbability")).toBe(false);
      expect(detailString(prediction.details, "timezone")).toBe(timezone);
      expect(prediction.horizonStartsAt).not.toBeNull();
      if (!prediction.horizonStartsAt) throw new Error("Recommendation slot is missing.");
      expect(prediction.horizonStartsAt.getTime()).toBeGreaterThan(prediction.asOf.getTime());
      expect(prediction.expiresAt.getTime()).toBeGreaterThan(prediction.asOf.getTime());
      expect(prediction.expiresAt.getTime()).toBeLessThanOrEqual(
        prediction.horizonStartsAt.getTime(),
      );
    }
    expect(fixture.bookingCountAfterRecommendation).toBe(fixture.bookingCountBeforeRecommendation);
    expect(fixture.reservationCountAfterRecommendation).toBe(
      fixture.reservationCountBeforeRecommendation,
    );
  });

  it("persists consent-gated earlier reflow candidates with both confirmations and no reschedule", async () => {
    const rows = await predictionRows(fixture.organizationA, fixture.reflowJob.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(10);
    for (const prediction of rows) {
      expect(prediction).toMatchObject({
        branchId: fixture.catalog.branch.id,
        capability: "SCHEDULE_REFLOW",
        providerId: fixture.catalog.provider.id,
        serviceId: fixture.catalog.service.id,
        status: "GENERATED",
        subjectId: fixture.catalog.target.id,
        subjectType: "APPOINTMENT_REFLOW",
      });
      expect(prediction.estimate).toBeGreaterThan(0);
      expect(detailBoolean(prediction.details, "automaticRescheduleAllowed")).toBe(false);
      expect(detailBoolean(prediction.details, "requiresCustomerConfirmation")).toBe(true);
      expect(detailBoolean(prediction.details, "requiresStaffConfirmation")).toBe(true);
      expect(detailString(prediction.details, "timezone")).toBe(timezone);
      expect(prediction.horizonStartsAt).not.toBeNull();
      if (!prediction.horizonStartsAt) throw new Error("Reflow slot is missing.");
      expect(prediction.horizonStartsAt.getTime()).toBeLessThan(
        fixture.targetBeforeReflow.startsAt.getTime(),
      );
      expect(prediction.expiresAt.getTime()).toBeLessThanOrEqual(
        prediction.horizonStartsAt.getTime(),
      );
    }
    expect(fixture.targetAfterReflow).toEqual(fixture.targetBeforeReflow);
  });

  it("uses id-desc ordering for consent records with the same timestamp", async () => {
    expect(fixture.consentTie.higherId.localeCompare(fixture.consentTie.lowerId)).toBeGreaterThan(
      0,
    );
    const latest = await runInTenant(client, fixture.organizationA.access, (transaction) =>
      transaction.consent.findFirstOrThrow({
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
        where: {
          customerId: fixture.catalog.target.customerId,
          organizationId: fixture.organizationA.id,
          purpose: "appointment_slot_offers",
        },
      }),
    );
    expect(latest).toMatchObject({
      id: fixture.consentTie.higherId,
      recordedAt: fixture.consentTie.recordedAt,
      status: ConsentStatus.GRANTED,
    });
    const rows = await predictionRows(fixture.organizationA, fixture.reflowJob.id);
    expect(rows.some(({ status }) => status === "GENERATED")).toBe(true);
  });

  it("refuses demand backtesting without historical configuration evidence and excludes customer data", async () => {
    const evaluation = await runInTenant(client, fixture.organizationA.access, (transaction) =>
      transaction.predictiveEvaluationRun.findFirstOrThrow({
        where: { jobId: fixture.backtestJob.id, organizationId: fixture.organizationA.id },
      }),
    );
    expect(evaluation).toMatchObject({
      branchId: fixture.catalog.branch.id,
      capability: "DEMAND_FORECAST",
      runType: "BACKTEST",
    });
    expect(evaluation.outcome).toBe("INSUFFICIENT");
    expect(evaluation.dataWatermark).toEqual(new Date(fixture.backtestJob.createdAt));
    expect(evaluation.sampleSize).toBe(0);
    expect(detailString(evaluation.metrics, "calendarEvidence")).toBe("PHASE8_FORWARD_ONLY");
    expect(detailString(evaluation.metrics, "holidayEvaluation")).toBe("NOT_EVALUATED");
    expect(detailString(evaluation.metrics, "historicalConfigurationEvaluation")).toBe(
      "NOT_EVALUATED",
    );
    expect(detailString(evaluation.metrics, "reason")).toBe(
      "HISTORICAL_CALENDAR_AND_CONFIGURATION_EVIDENCE_UNAVAILABLE",
    );
    expect(detailString(evaluation.metrics, "sourceScope")).toBe("ORGANIZATION");
    const metrics = JSON.stringify(evaluation.metrics);
    expect(metrics).not.toContain(`Predictive demand evidence ${suffix}`);
    expect(metrics).not.toContain(`Predictive reflow evidence ${suffix}`);
    expect(metrics).not.toContain("@example.invalid");
  });

  it("projects only the provider's own predictions and denies feedback on another provider", async () => {
    const [ownRows, otherRows, overview] = await Promise.all([
      predictionRows(fixture.organizationA, fixture.reflowJob.id),
      predictionRows(fixture.organizationA, fixture.otherReflowJob.id),
      predictive.getOverview(fixture.catalog.provider.selection, fixture.catalog.provider.userId),
    ]);
    expect(ownRows.length).toBeGreaterThan(0);
    expect(otherRows.length).toBeGreaterThan(0);
    const visibleIds = new Set(overview.predictions.map(({ id }) => id));
    expect(ownRows.every(({ id }) => visibleIds.has(id))).toBe(true);
    expect(otherRows.every(({ id }) => !visibleIds.has(id))).toBe(true);
    expect(
      overview.predictions.every(({ providerId }) => providerId === fixture.catalog.provider.id),
    ).toBe(true);
    const ownProjection = overview.predictions.filter(({ id }) =>
      ownRows.some((row) => row.id === id),
    );
    expect(ownProjection.length).toBe(ownRows.length);
    for (const prediction of ownProjection) {
      expect(prediction.sampleSize).toBe(0);
      expect(prediction.required).toBeNull();
      expect(detailBoolean(prediction.details, "evidenceCountsRedacted")).toBe(true);
      expect(prediction.explanation.every(({ code }) => code === "PROVIDER_HISTORY")).toBe(true);
    }
    const ownPrediction = ownRows[0];
    const otherPrediction = otherRows[0];
    if (!ownPrediction || !otherPrediction)
      throw new Error("Provider prediction fixtures are missing.");
    await expect(
      predictive.recordFeedback(fixture.catalog.provider.selection, {
        actorUserId: fixture.catalog.provider.userId,
        feedbackType: "OUTDATED",
        predictionId: otherPrediction.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      predictive.recordFeedback(fixture.catalog.provider.selection, {
        actorUserId: fixture.catalog.provider.userId,
        feedbackType: "HELPFUL",
        predictionId: ownPrediction.id,
      }),
    ).resolves.toMatchObject({ predictionId: ownPrediction.id });
  });

  it("limits a manager's prediction projection to the assigned branch", async () => {
    const [aggregateRows, overview] = await Promise.all([
      predictionRows(fixture.organizationA, fixture.organizationDemandJob.id),
      predictive.getOverview(fixture.catalog.manager.selection, fixture.catalog.manager.userId),
    ]);
    const assignedComponents = aggregateRows.filter(
      ({ branchId, subjectType }) =>
        branchId === fixture.catalog.branch.id && subjectType === "DEMAND_BUCKET",
    );
    const unassignedOrAggregate = aggregateRows.filter(
      ({ branchId }) => branchId !== fixture.catalog.branch.id,
    );
    const visibleIds = new Set(overview.predictions.map(({ id }) => id));
    expect(assignedComponents.length).toBeGreaterThan(0);
    expect(assignedComponents.every(({ id }) => visibleIds.has(id))).toBe(true);
    expect(unassignedOrAggregate.every(({ id }) => !visibleIds.has(id))).toBe(true);
    expect(
      overview.predictions.every(({ branchId }) => branchId === fixture.catalog.branch.id),
    ).toBe(true);
  });

  it("allows assigned-branch manager execution and denies an unassigned branch", async () => {
    await expect(
      predictive.requestJob(fixture.catalog.manager.selection, {
        actorUserId: fixture.catalog.manager.userId,
        branchId: fixture.catalog.branch.id,
        capability: "STAFFING",
        idempotencyKey: `phase8:capability:manager-assigned:${randomUUID()}`,
        jobType: "DATA_AUDIT",
      }),
    ).resolves.toMatchObject({ capability: "STAFFING" });
    await expect(
      predictive.requestJob(fixture.catalog.manager.selection, {
        actorUserId: fixture.catalog.manager.userId,
        branchId: fixture.catalog.otherBranch.id,
        capability: "STAFFING",
        idempotencyKey: `phase8:capability:manager-unassigned:${randomUUID()}`,
        jobType: "DATA_AUDIT",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies cross-tenant references and keeps feedback hidden by both repository scope and RLS", async () => {
    await expect(
      predictive.requestJob(fixture.organizationB.selection, {
        actorUserId: fixture.ownerB.id,
        branchId: fixture.catalog.branch.id,
        capability: "DEMAND_FORECAST",
        idempotencyKey: `phase8:capability:foreign-branch:${randomUUID()}`,
        jobType: "DATA_AUDIT",
        serviceId: fixture.catalog.service.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      predictive.requestJob(fixture.organizationB.selection, {
        actorUserId: fixture.ownerB.id,
        appointmentId: fixture.catalog.target.id,
        capability: "SCHEDULE_REFLOW",
        idempotencyKey: `phase8:capability:foreign-appointment:${randomUUID()}`,
        jobType: "DATA_AUDIT",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [prediction] = await predictionRows(fixture.organizationA, fixture.recommendationJob.id);
    if (!prediction) throw new Error("Feedback prediction fixture is missing.");
    const feedback = await predictive.recordFeedback(fixture.organizationA.selection, {
      actorUserId: fixture.ownerA.id,
      comment: "Deterministic integration evidence",
      feedbackType: "HELPFUL",
      predictionId: prediction.id,
    });
    await expect(
      predictive.recordFeedback(fixture.organizationB.selection, {
        actorUserId: fixture.ownerB.id,
        feedbackType: "HELPFUL",
        predictionId: prediction.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const hidden = await runInTenant(client, fixture.organizationB.access, (transaction) =>
      transaction.predictiveFeedback.findFirst({ where: { id: feedback.id } }),
    );
    expect(hidden).toBeNull();
  });
});
