import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@jormall/db/client";
import type { Prisma } from "@jormall/db/generated/client";
import { MembershipStatus, OrganizationStatus, PlatformRole } from "@jormall/db/generated/enums";
import { IdentityRepository } from "@jormall/db/identity-repository";
import {
  PredictiveRepository,
  type TenantAccessSelection,
} from "@jormall/db/predictive-repository";
import { runInTenant } from "@jormall/db/tenant-context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A PostgreSQL integration-test URL is required.");

const client = createPrismaClient(databaseUrl);
const revocationClient = createPrismaClient(databaseUrl);
const identity = new IdentityRepository(client);
const predictive = new PredictiveRepository(client);
const suffix = randomUUID().slice(0, 8);

const privateCustomerName = `Private Predictive Customer ${suffix}`;
const privatePhone = "+962791234567";
const privateNote = `PRIVATE_PREDICTIVE_NOTE_${suffix}`;
const privateProviderBio = `PRIVATE_PROVIDER_BIO_${suffix}`;

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    resolve() {
      resolve?.();
    },
  };
}

async function waitForForegroundAuthorizationLock(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await client.$queryRaw<Array<{ blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%lock_predictive_foreground_authorization%'
      ) AS blocked
    `;
    if (row?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Foreground authorization did not reach the deterministic lock barrier.");
}

async function waitForBlockedEvaluationUpdate(blockerPid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await client.$queryRaw<Array<{ blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND wait_event_type = 'Lock'
          AND ${blockerPid} = ANY(pg_blocking_pids(pid))
          AND query ILIKE '%UPDATE "predictive_jobs"%'
          AND query ILIKE '%"evaluation_at"%'
      ) AS blocked
    `;
    if (row?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Predictive evaluation update did not reach the deterministic lock barrier.");
}

async function raceForegroundRevocation(
  lock: (transaction: Prisma.TransactionClient) => Promise<unknown>,
  revoke: (transaction: Prisma.TransactionClient) => Promise<unknown>,
  operation: () => Promise<unknown>,
): Promise<void> {
  const locked = deferred();
  const release = deferred();
  const revocation = revocationClient.$transaction(
    async (transaction) => {
      await lock(transaction);
      locked.resolve();
      await release.promise;
      await revoke(transaction);
    },
    { timeout: 10_000 },
  );
  await locked.promise;
  const attemptedOperation = operation();
  await waitForForegroundAuthorizationLock();
  release.resolve();
  await revocation;
  await expect(attemptedOperation).rejects.toMatchObject({ code: "FORBIDDEN" });
}

async function createUser(label: string, platformRole = PlatformRole.USER) {
  return client.user.create({
    data: {
      email: `phase8-worker-${label}-${suffix}@example.invalid`,
      name: `Phase 8 Worker ${label}`,
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
    slug: `phase8-worker-${label.toLowerCase().replaceAll(" ", "-")}-${suffix}`,
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

async function createEligibleHistory(tenant: Tenant, ownerId: string) {
  const membershipId = tenant.access.membershipId;
  if (!membershipId) throw new Error("Owner membership fixture is missing.");
  await identity.createBranch(tenant.access, {
    nameAr: "فرع التنبؤ الآمن",
    nameEn: "Safe Predictive Branch",
    timezone: "Asia/Amman",
  });
  await identity.createService(tenant.access, {
    currency: "JOD",
    defaultDurationMins: 30,
    defaultPriceMinor: 2_000,
    nameAr: "خدمة التنبؤ الآمن",
    nameEn: "Safe Predictive Service",
  });
  const [branch] = await identity.listBranches(tenant.access);
  const [service] = await identity.listServices(tenant.access);
  if (!branch || !service) throw new Error("Predictive worker catalog fixture is missing.");
  await identity.configureServiceBranch(tenant.access, {
    branchId: branch.id,
    durationMins: 30,
    isEnabled: true,
    priceMinor: 2_000,
    serviceId: service.id,
  });

  return runInTenant(client, tenant.access, async (transaction) => {
    const provider = await transaction.staffProfile.create({
      data: {
        bioEn: privateProviderBio,
        displayNameAr: "مزود خاص لا يدخل السمات",
        displayNameEn: `Private Provider ${suffix}`,
        isBookable: true,
        membershipId,
        organizationId: tenant.id,
      },
    });
    await transaction.staffBranchAssignment.create({
      data: {
        branchId: branch.id,
        organizationId: tenant.id,
        staffProfileId: provider.id,
      },
    });
    await transaction.staffService.create({
      data: {
        isEnabled: true,
        organizationId: tenant.id,
        serviceId: service.id,
        staffProfileId: provider.id,
      },
    });
    const customer = await transaction.customer.create({
      data: {
        displayName: privateCustomerName,
        organizationId: tenant.id,
        preferredLocale: "en",
      },
    });
    await transaction.customerContact.create({
      data: {
        customerId: customer.id,
        isPrimary: true,
        kind: "PHONE",
        normalizedPhoneE164: privatePhone,
        organizationId: tenant.id,
        originalValue: "079 123 4567",
      },
    });

    const now = Date.now();
    const history = Array.from({ length: 220 }, (_, index) => {
      const startsAt = new Date(now - (250 - index) * 86_400_000);
      const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
      const status =
        index < 30
          ? ("NO_SHOW" as const)
          : index === 31
            ? ("CONFIRMED" as const)
            : ("COMPLETED" as const);
      return {
        appointment: {
          branchId: branch.id,
          createdAt: new Date(startsAt.getTime() - 14 * 86_400_000),
          customerId: customer.id,
          endsAt,
          id: randomUUID(),
          organizationId: tenant.id,
          providerId: provider.id,
          serviceId: service.id,
          source: "STAFF" as const,
          startsAt,
          status,
          timezone: "Asia/Amman",
        },
        endsAt,
        index,
        status,
        startsAt,
      };
    });
    await transaction.appointment.createMany({
      data: history.map(({ appointment }) => appointment),
    });
    await transaction.appointmentStatusHistory.createMany({
      data: history.flatMap(({ appointment, endsAt, index, startsAt, status }) => {
        const created = {
          appointmentId: appointment.id,
          createdAt: appointment.createdAt,
          endsAt,
          eventType: "CREATED" as const,
          organizationId: tenant.id,
          source: "STAFF" as const,
          startsAt,
          toStatus: "CONFIRMED" as const,
          version: 1,
        };
        return index === 30
          ? [
              created,
              {
                appointmentId: appointment.id,
                createdAt: startsAt,
                endsAt,
                eventType: "STATUS_CHANGED" as const,
                fromStatus: "CONFIRMED" as const,
                organizationId: tenant.id,
                source: "STAFF" as const,
                startsAt,
                toStatus: "CHECKED_IN" as const,
                version: 1,
              },
              {
                appointmentId: appointment.id,
                createdAt: new Date(endsAt.getTime() + 2 * 60 * 60_000),
                endsAt,
                eventType: "STATUS_CHANGED" as const,
                fromStatus: "CHECKED_IN" as const,
                organizationId: tenant.id,
                source: "STAFF" as const,
                startsAt,
                toStatus: "CANCELLED" as const,
                version: 2,
              },
              {
                appointmentId: appointment.id,
                createdAt: new Date(endsAt.getTime() + 8 * 86_400_000),
                endsAt,
                eventType: "STATUS_CHANGED" as const,
                fromStatus: "CANCELLED" as const,
                organizationId: tenant.id,
                source: "STAFF" as const,
                startsAt,
                toStatus: "NO_SHOW" as const,
                version: 3,
              },
            ]
          : [
              created,
              {
                appointmentId: appointment.id,
                createdAt: new Date(endsAt.getTime() + 60 * 60_000),
                endsAt,
                eventType: "STATUS_CHANGED" as const,
                fromStatus: "CONFIRMED" as const,
                organizationId: tenant.id,
                source: "STAFF" as const,
                startsAt,
                toStatus: status,
                version: 1,
              },
            ];
      }),
    });

    const targetStartsAt = new Date(now + 14 * 86_400_000);
    const targetEndsAt = new Date(targetStartsAt.getTime() + 30 * 60_000);
    const target = await transaction.appointment.create({
      data: {
        branchId: branch.id,
        customerId: customer.id,
        endsAt: targetEndsAt,
        organizationId: tenant.id,
        providerId: provider.id,
        serviceId: service.id,
        source: "STAFF",
        startsAt: targetStartsAt,
        status: "CONFIRMED",
        timezone: "Asia/Amman",
      },
    });
    await transaction.appointmentStatusHistory.create({
      data: {
        appointmentId: target.id,
        endsAt: targetEndsAt,
        eventType: "CREATED",
        organizationId: tenant.id,
        source: "STAFF",
        startsAt: targetStartsAt,
        toStatus: "CONFIRMED",
        version: 1,
      },
    });
    await transaction.appointmentNote.create({
      data: {
        appointmentId: target.id,
        authorUserId: ownerId,
        body: privateNote,
        organizationId: tenant.id,
      },
    });
    return { branch, customer, provider, service, target };
  });
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let fixture: Fixture;

async function createFixture() {
  const [admin, sparseOwner, eligibleOwner] = await Promise.all([
    createUser("admin", PlatformRole.JORMALL_SUPER_ADMIN),
    createUser("sparse-owner"),
    createUser("eligible-owner"),
  ]);
  const [sparse, eligible] = await Promise.all([
    createOrganization(admin.id, sparseOwner, "Worker Sparse"),
    createOrganization(admin.id, eligibleOwner, "Worker Eligible"),
  ]);
  const catalog = await createEligibleHistory(eligible, eligibleOwner.id);

  const sparseJob = await predictive.requestJob(sparse.selection, {
    actorUserId: sparseOwner.id,
    capability: "NO_SHOW",
    idempotencyKey: `phase8:worker:sparse:${randomUUID()}`,
    jobType: "DATA_AUDIT",
  });
  await predictive.processJob(sparse.id, sparseJob.id);

  const noShowSetting = (
    await predictive.getOverview(eligible.selection, eligibleOwner.id)
  ).capabilities.find(({ capability }) => capability === "NO_SHOW");
  if (!noShowSetting) throw new Error("No-show capability setting fixture is missing.");
  await predictive.updateCapability(eligible.selection, {
    actorUserId: eligibleOwner.id,
    capability: "NO_SHOW",
    enabled: true,
    expectedVersion: noShowSetting.version,
  });
  const featureJob = await predictive.requestJob(eligible.selection, {
    actorUserId: eligibleOwner.id,
    branchId: catalog.branch.id,
    capability: "NO_SHOW",
    idempotencyKey: `phase8:worker:features:${randomUUID()}`,
    jobType: "FEATURE_COMPUTE",
  });
  await predictive.processJob(eligible.id, featureJob.id);
  const generationJob = await predictive.requestJob(eligible.selection, {
    actorUserId: eligibleOwner.id,
    appointmentId: catalog.target.id,
    capability: "NO_SHOW",
    idempotencyKey: `phase8:worker:generate:${randomUUID()}`,
    jobType: "GENERATE",
  });
  await predictive.processJob(eligible.id, generationJob.id);

  return {
    admin,
    catalog,
    eligible,
    eligibleOwner,
    featureJob,
    generationJob,
    sparse,
    sparseJob,
    sparseOwner,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
});

afterAll(async () => {
  await Promise.all([client.$disconnect(), revocationClient.$disconnect()]);
});

describe("Phase 8 predictive PostgreSQL worker evidence", () => {
  it("refuses sparse history with null estimates and the exact required count", async () => {
    const overview = await predictive.getOverview(fixture.sparse.selection, fixture.sparseOwner.id);
    const [refusal] = overview.predictions;
    expect(refusal).toMatchObject({
      capability: "NO_SHOW",
      estimate: null,
      lowerBound: null,
      refusalReason: "INSUFFICIENT_SAMPLE",
      required: 200,
      sampleSize: 0,
      status: "REFUSED",
      upperBound: null,
    });
    const audit = await runInTenant(client, fixture.sparse.access, (transaction) =>
      transaction.predictiveDataAudit.findFirst({
        where: { jobId: fixture.sparseJob.id, organizationId: fixture.sparse.id },
      }),
    );
    expect(audit).toMatchObject({ eligible: false, sampleSize: 0 });
  });

  it("replays the same tenant job deterministically without duplicating evidence", async () => {
    const before = await runInTenant(client, fixture.eligible.access, async (transaction) => ({
      predictions: await transaction.prediction.findMany({
        orderBy: { id: "asc" },
        where: {
          jobId: fixture.generationJob.id,
          organizationId: fixture.eligible.id,
        },
      }),
      snapshots: await transaction.predictiveFeatureSnapshot.findMany({
        orderBy: { id: "asc" },
        where: {
          jobId: fixture.generationJob.id,
          organizationId: fixture.eligible.id,
        },
      }),
    }));
    expect(before.predictions).toHaveLength(1);
    expect(before.snapshots).toHaveLength(1);

    await predictive.processJob(fixture.eligible.id, fixture.generationJob.id);

    const after = await runInTenant(client, fixture.eligible.access, async (transaction) => ({
      predictions: await transaction.prediction.findMany({
        orderBy: { id: "asc" },
        where: {
          jobId: fixture.generationJob.id,
          organizationId: fixture.eligible.id,
        },
      }),
      snapshots: await transaction.predictiveFeatureSnapshot.findMany({
        orderBy: { id: "asc" },
        where: {
          jobId: fixture.generationJob.id,
          organizationId: fixture.eligible.id,
        },
      }),
    }));
    expect(after).toEqual(before);
  });

  it("captures immutable event dimensions and ignores appointment edits after the cutoff", async () => {
    const original = await runInTenant(client, fixture.eligible.access, async (transaction) => ({
      feature: await transaction.predictiveFeatureSnapshot.findFirstOrThrow({
        where: { jobId: fixture.generationJob.id },
      }),
      job: await transaction.predictiveJob.findFirstOrThrow({
        where: { id: fixture.generationJob.id },
      }),
      prediction: await transaction.prediction.findFirstOrThrow({
        where: { jobId: fixture.generationJob.id },
      }),
    }));

    const forged = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.appointmentStatusHistory.create({
        data: {
          appointmentId: fixture.catalog.target.id,
          branchSnapshotId: randomUUID(),
          createdAt: new Date(original.job.createdAt.getTime() - 1),
          customerSnapshotId: randomUUID(),
          dimensionSnapshotVerifiedAt: new Date(0),
          endsAt: fixture.catalog.target.endsAt,
          eventType: "STATUS_CHANGED",
          fromStatus: "CONFIRMED",
          organizationId: fixture.eligible.id,
          providerSnapshotId: randomUUID(),
          serviceSnapshotId: randomUUID(),
          source: "STAFF",
          startsAt: fixture.catalog.target.startsAt,
          timezoneSnapshot: "Forged/Timezone",
          toStatus: "CONFIRMED",
          version: 2,
        },
      }),
    );
    expect(forged).toMatchObject({
      branchSnapshotId: fixture.catalog.branch.id,
      customerSnapshotId: fixture.catalog.customer.id,
      providerSnapshotId: fixture.catalog.provider.id,
      serviceSnapshotId: fixture.catalog.service.id,
      timezoneSnapshot: "Asia/Amman",
    });
    expect(forged.dimensionSnapshotVerifiedAt?.getTime()).toBeGreaterThan(0);

    const historical = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.appointmentStatusHistory.findFirstOrThrow({
        orderBy: { startsAt: "asc" },
        where: {
          eventType: "CREATED",
          organizationId: fixture.eligible.id,
          startsAt: { lt: original.job.createdAt },
        },
      }),
    );
    expect(historical.timezoneSnapshot).toBe("Asia/Amman");
    await client.appointment.updateMany({
      data: { timezone: "UTC" },
      where: {
        organizationId: fixture.eligible.id,
        startsAt: { lt: original.job.createdAt },
      },
    });
    const immutableHistory = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.appointmentStatusHistory.findFirstOrThrow({
        where: { id: historical.id },
      }),
    );
    expect(immutableHistory.timezoneSnapshot).toBe("Asia/Amman");

    const replay = await predictive.requestJob(fixture.eligible.selection, {
      actorUserId: fixture.eligibleOwner.id,
      appointmentId: fixture.catalog.target.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:worker:immutable-dimensions:${randomUUID()}`,
      jobType: "GENERATE",
    });
    await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.predictiveJob.update({
        data: { createdAt: original.job.createdAt },
        where: { id: replay.id },
      }),
    );
    await predictive.processJob(fixture.eligible.id, replay.id);
    const reproduced = await runInTenant(client, fixture.eligible.access, async (transaction) => ({
      feature: await transaction.predictiveFeatureSnapshot.findFirstOrThrow({
        where: { jobId: replay.id },
      }),
      prediction: await transaction.prediction.findFirstOrThrow({
        where: { jobId: replay.id },
      }),
    }));
    expect(reproduced.feature.features).toEqual(original.feature.features);
    expect(reproduced.prediction.estimate).toBe(original.prediction.estimate);
    expect(reproduced.prediction.explanation).toEqual(original.prediction.explanation);
  });

  it("fails closed on a zero-evidence mutable-input retry but allows a data-audit retry", async () => {
    const mutableJob = await predictive.requestJob(fixture.eligible.selection, {
      actorUserId: fixture.eligibleOwner.id,
      branchId: fixture.catalog.branch.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:worker:zero-evidence-retry:${randomUUID()}`,
      jobType: "FEATURE_COMPUTE",
    });
    const mutableLease = randomUUID();
    await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.predictiveJob.update({
        data: { attempts: 1, leaseToken: mutableLease, status: "ENQUEUED" },
        where: { id: mutableJob.id },
      }),
    );
    await expect(
      predictive.processJob(fixture.eligible.id, mutableJob.id, mutableLease),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      metadata: { reason: "MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB" },
      retryable: false,
    });
    const interrupted = await runInTenant(client, fixture.eligible.access, async (transaction) => ({
      audits: await transaction.predictiveDataAudit.count({ where: { jobId: mutableJob.id } }),
      job: await transaction.predictiveJob.findFirstOrThrow({ where: { id: mutableJob.id } }),
      predictions: await transaction.prediction.count({ where: { jobId: mutableJob.id } }),
      snapshots: await transaction.predictiveFeatureSnapshot.count({
        where: { jobId: mutableJob.id },
      }),
    }));
    expect(interrupted).toMatchObject({ audits: 0, predictions: 0, snapshots: 0 });
    expect(interrupted.job).toMatchObject({ attempts: 2, status: "RUNNING" });
    await predictive.markJobFailure(
      fixture.eligible.id,
      mutableJob.id,
      "MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB",
      true,
      mutableLease,
    );
    const deadLetter = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.predictiveJob.findFirstOrThrow({ where: { id: mutableJob.id } }),
    );
    expect(deadLetter).toMatchObject({
      safeErrorCode: "MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB",
      status: "DEAD_LETTER",
    });

    const mutableAudit = await predictive.requestJob(fixture.eligible.selection, {
      actorUserId: fixture.eligibleOwner.id,
      branchId: fixture.catalog.branch.id,
      capability: "STAFFING",
      idempotencyKey: `phase8:worker:mutable-audit-retry:${randomUUID()}`,
      jobType: "DATA_AUDIT",
    });
    const mutableAuditLease = randomUUID();
    await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.predictiveJob.update({
        data: { attempts: 1, leaseToken: mutableAuditLease, status: "ENQUEUED" },
        where: { id: mutableAudit.id },
      }),
    );
    await expect(
      predictive.processJob(fixture.eligible.id, mutableAudit.id, mutableAuditLease),
    ).rejects.toMatchObject({
      metadata: { reason: "MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB" },
      retryable: false,
    });
    const interruptedAudit = await runInTenant(
      client,
      fixture.eligible.access,
      async (transaction) => ({
        audits: await transaction.predictiveDataAudit.count({
          where: { jobId: mutableAudit.id },
        }),
        job: await transaction.predictiveJob.findFirstOrThrow({
          where: { id: mutableAudit.id },
        }),
      }),
    );
    expect(interruptedAudit.audits).toBe(0);
    expect(interruptedAudit.job).toMatchObject({ attempts: 2, status: "RUNNING" });
    await predictive.markJobFailure(
      fixture.eligible.id,
      mutableAudit.id,
      "MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB",
      true,
      mutableAuditLease,
    );

    const auditJob = await predictive.requestJob(fixture.sparse.selection, {
      actorUserId: fixture.sparseOwner.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:worker:data-audit-retry:${randomUUID()}`,
      jobType: "DATA_AUDIT",
    });
    const auditLease = randomUUID();
    await runInTenant(client, fixture.sparse.access, (transaction) =>
      transaction.predictiveJob.update({
        data: { attempts: 1, leaseToken: auditLease, status: "ENQUEUED" },
        where: { id: auditJob.id },
      }),
    );
    await predictive.processJob(fixture.sparse.id, auditJob.id, auditLease);
    const completedAudit = await runInTenant(client, fixture.sparse.access, (transaction) =>
      transaction.predictiveJob.findFirstOrThrow({ where: { id: auditJob.id } }),
    );
    expect(completedAudit).toMatchObject({ attempts: 2, status: "COMPLETED" });
  });

  it("refuses a historical no-show backtest when dimensions were verified after its origins", async () => {
    const job = await predictive.requestJob(fixture.eligible.selection, {
      actorUserId: fixture.eligibleOwner.id,
      branchId: fixture.catalog.branch.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:worker:historical-verification:${randomUUID()}`,
      jobType: "BACKTEST",
    });
    await predictive.processJob(fixture.eligible.id, job.id);
    const evaluation = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.predictiveEvaluationRun.findFirstOrThrow({
        where: { jobId: job.id },
      }),
    );
    expect(evaluation).toMatchObject({ outcome: "INSUFFICIENT", sampleSize: 0 });
    expect(evaluation.metrics).toMatchObject({
      availableRows: 0,
      reason: "INSUFFICIENT_MATURE_HOLDOUT",
    });
  });

  it("freezes arrival labels at maturity and reports unresolved mature outcomes", async () => {
    const audit = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.predictiveDataAudit.findFirstOrThrow({
        where: { jobId: fixture.featureJob.id, organizationId: fixture.eligible.id },
      }),
    );
    expect(audit.counts).toMatchObject({
      attended: 189,
      noShows: 30,
      resolved: 219,
      unknownMatured: 1,
    });
    expect(audit.warnings).toContain("MATURED_UNKNOWN_OUTCOMES_EXCLUDED");
  });

  it("fences a stale running lease before a reclaimed worker writes evidence", async () => {
    const job = await predictive.requestJob(fixture.sparse.selection, {
      actorUserId: fixture.sparseOwner.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:worker:fencing:${randomUUID()}`,
      jobType: "DATA_AUDIT",
    });
    const firstClaim = (await predictive.claimPendingJobs(`test-first-${suffix}`, 100)).find(
      ({ id }) => id === job.id,
    );
    expect(firstClaim).toBeDefined();
    if (!firstClaim) throw new Error("First predictive lease was not claimed.");
    await predictive.markJobEnqueued(job.id, firstClaim.leaseToken);
    await runInTenant(client, fixture.sparse.access, (transaction) =>
      transaction.predictiveJob.update({
        data: {
          startedAt: new Date(Date.now() - 31 * 60_000),
          status: "RUNNING",
        },
        where: { id: job.id },
      }),
    );
    const replacement = (await predictive.claimPendingJobs(`test-replacement-${suffix}`, 100)).find(
      ({ id }) => id === job.id,
    );
    expect(replacement).toBeDefined();
    if (!replacement) throw new Error("Replacement predictive lease was not claimed.");
    expect(replacement.leaseToken).not.toBe(firstClaim.leaseToken);
    await expect(
      predictive.processJob(fixture.sparse.id, job.id, firstClaim.leaseToken),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await predictive.markJobEnqueued(job.id, replacement.leaseToken);
    await predictive.processJob(fixture.sparse.id, job.id, replacement.leaseToken);
    const completed = await runInTenant(client, fixture.sparse.access, (transaction) =>
      transaction.predictiveJob.findFirstOrThrow({ where: { id: job.id } }),
    );
    expect(completed).toMatchObject({
      leaseToken: replacement.leaseToken,
      status: "COMPLETED",
    });
  });

  it("orders the first evaluation watermark after a concurrently advanced request timestamp", async () => {
    const job = await predictive.requestJob(fixture.sparse.selection, {
      actorUserId: fixture.sparseOwner.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:worker:evaluation-clock:${randomUUID()}`,
      jobType: "DATA_AUDIT",
    });
    const locked = deferred();
    const advanceRequestTimestamp = deferred();
    let blockerPid: number | undefined;
    const blocker = revocationClient.$transaction(
      async (transaction) => {
        const [connection] = await transaction.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid
        `;
        blockerPid = connection?.pid;
        await transaction.$queryRaw`
          SELECT "id"
          FROM "predictive_jobs"
          WHERE "id" = ${job.id}::uuid
          FOR UPDATE
        `;
        locked.resolve();
        await advanceRequestTimestamp.promise;
        await transaction.$executeRaw`
          UPDATE "predictive_jobs"
          SET "created_at" = clock_timestamp(), "updated_at" = clock_timestamp()
          WHERE "id" = ${job.id}::uuid
        `;
      },
      { timeout: 10_000 },
    );
    await locked.promise;
    if (blockerPid === undefined) throw new Error("Predictive lock connection is missing.");
    const processing = predictive.processJob(fixture.sparse.id, job.id);
    try {
      await waitForBlockedEvaluationUpdate(blockerPid);
    } finally {
      advanceRequestTimestamp.resolve();
    }
    await blocker;
    await processing;

    const completed = await runInTenant(client, fixture.sparse.access, (transaction) =>
      transaction.predictiveJob.findFirstOrThrow({ where: { id: job.id } }),
    );
    expect(completed).toMatchObject({ status: "COMPLETED" });
    expect(completed.evaluationAt?.getTime()).toBeGreaterThanOrEqual(completed.createdAt.getTime());
    expect(completed.startedAt?.getTime()).toBeGreaterThanOrEqual(completed.createdAt.getTime());
  });

  it("uses the statement clock for relay reclaimability and enqueue timestamps", async () => {
    const job = await predictive.requestJob(fixture.sparse.selection, {
      actorUserId: fixture.sparseOwner.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:worker:relay-clock:${randomUUID()}`,
      jobType: "DATA_AUDIT",
    });
    const leaseToken = randomUUID();
    await client.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        UPDATE "predictive_jobs"
        SET "status" = 'CLAIMED',
            "claimed_at" = clock_timestamp() - INTERVAL '2 minutes' + INTERVAL '50 milliseconds',
            "claimed_by" = 'relay-clock-fixture',
            "lease_token" = ${leaseToken}::uuid,
            "created_at" = clock_timestamp() + INTERVAL '1 second',
            "updated_at" = clock_timestamp()
        WHERE "id" = ${job.id}::uuid
      `;
      await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_relay"');
      await transaction.$queryRaw`SELECT 1 AS waited FROM pg_sleep(0.1)`;
      const reclaimed = await transaction.$executeRaw`
        UPDATE "predictive_jobs"
        SET "status" = 'CLAIMED',
            "claimed_at" = GREATEST(statement_timestamp(), "created_at"),
            "claimed_by" = 'relay-clock-regression',
            "lease_token" = ${leaseToken}::uuid,
            "updated_at" = GREATEST(statement_timestamp(), "created_at")
        WHERE "id" = ${job.id}::uuid
      `;
      expect(reclaimed).toBe(1);
    });

    await predictive.markJobEnqueued(job.id, leaseToken);
    const enqueued = await runInTenant(client, fixture.sparse.access, (transaction) =>
      transaction.predictiveJob.findFirstOrThrow({ where: { id: job.id } }),
    );
    expect(enqueued).toMatchObject({ leaseToken, status: "ENQUEUED" });
    expect(enqueued.claimedAt?.getTime()).toBeGreaterThanOrEqual(enqueued.createdAt.getTime());
    expect(enqueued.enqueuedAt?.getTime()).toBeGreaterThanOrEqual(enqueued.createdAt.getTime());
  });

  it("freezes evaluation evidence and fails closed after an interrupted partial write", async () => {
    const job = await predictive.requestJob(fixture.sparse.selection, {
      actorUserId: fixture.sparseOwner.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:worker:interrupted:${randomUUID()}`,
      jobType: "DATA_AUDIT",
    });
    const databaseObjectSuffix = randomUUID().replaceAll("-", "");
    const functionName = `phase8_interrupt_completion_${databaseObjectSuffix}`;
    const triggerName = `phase8_interrupt_completion_${databaseObjectSuffix}`;
    await client.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."action" = 'PREDICTIVE_JOB_COMPLETED'
          AND NEW."target_id" = '${job.id}'::uuid THEN
          RAISE EXCEPTION 'injected predictive interruption';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "audit_events"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
    `);
    try {
      await expect(predictive.processJob(fixture.sparse.id, job.id)).rejects.toBeDefined();
    } finally {
      await client.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS "${triggerName}" ON "audit_events";
        DROP FUNCTION IF EXISTS "${functionName}"();
      `);
    }
    const interrupted = await runInTenant(client, fixture.sparse.access, async (transaction) => ({
      audits: await transaction.predictiveDataAudit.count({ where: { jobId: job.id } }),
      job: await transaction.predictiveJob.findFirstOrThrow({ where: { id: job.id } }),
      prediction: await transaction.prediction.findFirst({
        select: { id: true },
        where: { jobId: job.id },
      }),
      predictions: await transaction.prediction.count({ where: { jobId: job.id } }),
      snapshots: await transaction.predictiveFeatureSnapshot.count({ where: { jobId: job.id } }),
    }));
    expect(interrupted).toMatchObject({ audits: 1, predictions: 1, snapshots: 0 });
    if (!interrupted.prediction) throw new Error("Interrupted prediction evidence is missing.");
    expect(interrupted.job.evaluationAt).not.toBeNull();
    expect(interrupted.job.leaseToken).not.toBeNull();
    if (!interrupted.job.evaluationAt || !interrupted.job.leaseToken) {
      throw new Error("Interrupted predictive job did not preserve its evaluation lease.");
    }
    await predictive.markJobFailure(
      fixture.sparse.id,
      job.id,
      "INJECTED_INTERRUPTION",
      false,
      interrupted.job.leaseToken,
    );
    const runningOverview = await predictive.getOverview(
      fixture.sparse.selection,
      fixture.sparseOwner.id,
    );
    expect(
      runningOverview.predictions.some(
        (prediction) => prediction.id === interrupted.prediction?.id,
      ),
    ).toBe(false);
    await client.organizationSettings.update({
      data: { timezone: "UTC" },
      where: { organizationId: fixture.sparse.id },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    try {
      await expect(
        predictive.processJob(fixture.sparse.id, job.id, interrupted.job.leaseToken),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        metadata: { reason: "PARTIAL_EVIDENCE_ON_RETRY" },
        retryable: false,
      });
    } finally {
      await client.organizationSettings.update({
        data: { timezone: "Asia/Amman" },
        where: { organizationId: fixture.sparse.id },
      });
    }
    const retried = await runInTenant(client, fixture.sparse.access, async (transaction) => ({
      audits: await transaction.predictiveDataAudit.count({ where: { jobId: job.id } }),
      job: await transaction.predictiveJob.findFirstOrThrow({ where: { id: job.id } }),
      predictions: await transaction.prediction.count({ where: { jobId: job.id } }),
      snapshots: await transaction.predictiveFeatureSnapshot.count({ where: { jobId: job.id } }),
    }));
    expect(retried).toMatchObject({ audits: 1, predictions: 1, snapshots: 0 });
    expect(retried.job.evaluationAt).toEqual(interrupted.job.evaluationAt);
    expect(retried.job.startedAt?.getTime()).toBeGreaterThan(
      interrupted.job.startedAt?.getTime() ?? 0,
    );
    await predictive.markJobFailure(
      fixture.sparse.id,
      job.id,
      "PARTIAL_EVIDENCE_ON_RETRY",
      true,
      interrupted.job.leaseToken,
    );
    const hidden = await predictive.getOverview(fixture.sparse.selection, fixture.sparseOwner.id);
    expect(
      hidden.predictions.some((prediction) => prediction.id === interrupted.prediction?.id),
    ).toBe(false);
  });

  it("atomically reauthorizes every foreground operation after membership revocation", async () => {
    const membershipId = fixture.eligible.access.membershipId;
    if (!membershipId) throw new Error("Eligible membership fixture is missing.");
    const prediction = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.prediction.findFirstOrThrow({
        where: { jobId: fixture.generationJob.id, organizationId: fixture.eligible.id },
      }),
    );
    const currentSetting = (
      await predictive.getOverview(fixture.eligible.selection, fixture.eligibleOwner.id)
    ).capabilities.find(({ capability }) => capability === "NO_SHOW");
    if (!currentSetting) throw new Error("No-show setting fixture is missing.");
    const operations: readonly (() => Promise<unknown>)[] = [
      () => predictive.getOverview(fixture.eligible.selection, fixture.eligibleOwner.id),
      () =>
        predictive.requestJob(fixture.eligible.selection, {
          actorUserId: fixture.eligibleOwner.id,
          capability: "NO_SHOW",
          idempotencyKey: `phase8:foreground:request:${randomUUID()}`,
          jobType: "DATA_AUDIT",
        }),
      () =>
        predictive.updateCapability(fixture.eligible.selection, {
          actorUserId: fixture.eligibleOwner.id,
          capability: "NO_SHOW",
          enabled: true,
          expectedVersion: currentSetting.version,
        }),
      () =>
        predictive.recordFeedback(fixture.eligible.selection, {
          actorUserId: fixture.eligibleOwner.id,
          feedbackType: "HELPFUL",
          predictionId: prediction.id,
        }),
    ];
    for (const operation of operations) {
      await raceForegroundRevocation(
        (transaction) =>
          transaction.$queryRaw`
            SELECT "id" FROM "organization_memberships"
            WHERE "id" = ${membershipId}::uuid
            FOR UPDATE
          `,
        (transaction) =>
          transaction.organizationMembership.update({
            data: { status: MembershipStatus.SUSPENDED, suspendedAt: new Date() },
            where: { id: membershipId },
          }),
        operation,
      );
      await revocationClient.organizationMembership.update({
        data: { status: MembershipStatus.ACTIVE, suspendedAt: null },
        where: { id: membershipId },
      });
    }
  });

  it("locks organization, support, and permission scope during foreground authorization", async () => {
    await raceForegroundRevocation(
      (transaction) =>
        transaction.$queryRaw`
          SELECT "id" FROM "organizations"
          WHERE "id" = ${fixture.eligible.id}::uuid
          FOR UPDATE
        `,
      (transaction) =>
        transaction.organization.update({
          data: { status: OrganizationStatus.SUSPENDED },
          where: { id: fixture.eligible.id },
        }),
      () => predictive.getOverview(fixture.eligible.selection, fixture.eligibleOwner.id),
    );
    await revocationClient.organization.update({
      data: { status: OrganizationStatus.ACTIVE, suspendedAt: null, suspensionReason: null },
      where: { id: fixture.eligible.id },
    });

    const supportAccessId = await identity.startSupportAccess(
      fixture.admin.id,
      fixture.eligible.id,
      "Verify predictive authorization race handling",
      { ipAddress: "127.0.0.1", userAgent: "vitest" },
    );
    const supportSelection: TenantAccessSelection = {
      activeOrganizationId: fixture.eligible.id,
      activeSupportAccessId: supportAccessId,
    };
    await raceForegroundRevocation(
      (transaction) =>
        transaction.$queryRaw`
          SELECT "id" FROM "platform_support_accesses"
          WHERE "id" = ${supportAccessId}::uuid
          FOR UPDATE
        `,
      (transaction) =>
        transaction.platformSupportAccess.update({
          data: { revokedAt: new Date() },
          where: { id: supportAccessId },
        }),
      () => predictive.getOverview(supportSelection, fixture.admin.id),
    );

    const membershipId = fixture.eligible.access.membershipId;
    if (!membershipId) throw new Error("Eligible membership fixture is missing.");
    const runPermission = await client.rolePermission.findFirstOrThrow({
      where: {
        organizationId: fixture.eligible.id,
        permission: { code: "predictions.run" },
        role: { memberships: { some: { membershipId } } },
      },
    });
    await raceForegroundRevocation(
      (transaction) =>
        transaction.$queryRaw`
          SELECT "permission_id" FROM "role_permissions"
          WHERE "organization_id" = ${fixture.eligible.id}::uuid
            AND "role_id" = ${runPermission.roleId}::uuid
            AND "permission_id" = ${runPermission.permissionId}::uuid
          FOR UPDATE
        `,
      (transaction) =>
        transaction.rolePermission.update({
          data: { scope: "ASSIGNED_BRANCHES" },
          where: {
            organizationId_roleId_permissionId: {
              organizationId: fixture.eligible.id,
              permissionId: runPermission.permissionId,
              roleId: runPermission.roleId,
            },
          },
        }),
      () =>
        predictive.requestJob(fixture.eligible.selection, {
          actorUserId: fixture.eligibleOwner.id,
          capability: "NO_SHOW",
          idempotencyKey: `phase8:foreground:scope:${randomUUID()}`,
          jobType: "DATA_AUDIT",
        }),
    );
    await revocationClient.rolePermission.update({
      data: { scope: "ORGANIZATION" },
      where: {
        organizationId_roleId_permissionId: {
          organizationId: fixture.eligible.id,
          permissionId: runPermission.permissionId,
          roleId: runPermission.roleId,
        },
      },
    });
  });

  it("limits the relay role to the predictive lifecycle envelope", async () => {
    const job = await predictive.requestJob(fixture.sparse.selection, {
      actorUserId: fixture.sparseOwner.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:relay:envelope:${randomUUID()}`,
      jobType: "DATA_AUDIT",
    });
    await expect(
      client.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_relay"');
        await transaction.$executeRaw`
          UPDATE "predictive_jobs"
          SET "actor_user_id" = ${fixture.eligibleOwner.id}::uuid
          WHERE "id" = ${job.id}::uuid
        `;
      }),
    ).rejects.toBeDefined();
    await expect(
      client.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_relay"');
        await transaction.$executeRaw`
          UPDATE "predictive_jobs"
          SET "status" = 'COMPLETED'
          WHERE "id" = ${job.id}::uuid
        `;
      }),
    ).rejects.toBeDefined();
    await predictive.processJob(fixture.sparse.id, job.id);
  });

  it("keeps other-tenant history from influencing samples and enforces RLS", async () => {
    const sparseAudit = await runInTenant(client, fixture.sparse.access, (transaction) =>
      transaction.predictiveDataAudit.findFirstOrThrow({
        where: { jobId: fixture.sparseJob.id, organizationId: fixture.sparse.id },
      }),
    );
    expect(sparseAudit.sampleSize).toBe(0);

    const eligiblePrediction = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.prediction.findFirstOrThrow({
        where: {
          jobId: fixture.generationJob.id,
          organizationId: fixture.eligible.id,
        },
      }),
    );
    const [hiddenPrediction, hiddenSnapshot] = await runInTenant(
      client,
      fixture.sparse.access,
      (transaction) =>
        Promise.all([
          transaction.prediction.findFirst({ where: { id: eligiblePrediction.id } }),
          transaction.predictiveFeatureSnapshot.findFirst({
            where: { jobId: fixture.generationJob.id },
          }),
        ]),
    );
    expect(hiddenPrediction).toBeNull();
    expect(hiddenSnapshot).toBeNull();
  });

  it("keeps prediction evidence append-only in PostgreSQL", async () => {
    const prediction = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.prediction.findFirstOrThrow({
        where: {
          jobId: fixture.generationJob.id,
          organizationId: fixture.eligible.id,
        },
      }),
    );
    await expect(
      runInTenant(client, fixture.eligible.access, (transaction) =>
        transaction.prediction.update({
          data: { expiresAt: new Date(Date.now() + 60 * 60_000) },
          where: { id: prediction.id },
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      runInTenant(client, fixture.eligible.access, (transaction) =>
        transaction.prediction.delete({ where: { id: prediction.id } }),
      ),
    ).rejects.toBeDefined();
    const unchanged = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.prediction.findFirstOrThrow({
        where: { id: prediction.id, organizationId: fixture.eligible.id },
      }),
    );
    expect(unchanged).toEqual(prediction);
  });

  it("stores allowlisted feature JSON without names, phones, bios, or notes", async () => {
    const snapshot = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.predictiveFeatureSnapshot.findFirstOrThrow({
        where: {
          jobId: fixture.generationJob.id,
          organizationId: fixture.eligible.id,
        },
      }),
    );
    const serialized = JSON.stringify(snapshot.features).toLowerCase();
    for (const prohibited of [
      privateCustomerName,
      privatePhone,
      "079 123 4567",
      privateNote,
      privateProviderBio,
      `Private Provider ${suffix}`,
    ]) {
      expect(serialized).not.toContain(prohibited.toLowerCase());
    }
  });

  it("excludes verified import origins from no-show and demand history", async () => {
    const startsAt = new Date(Date.now() - 30 * 86_400_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    await runInTenant(client, fixture.eligible.access, async (transaction) => {
      const imported = await transaction.appointment.create({
        data: {
          branchId: fixture.catalog.branch.id,
          createdAt: new Date(startsAt.getTime() - 10 * 86_400_000),
          customerId: fixture.catalog.customer.id,
          endsAt,
          organizationId: fixture.eligible.id,
          providerId: fixture.catalog.provider.id,
          serviceId: fixture.catalog.service.id,
          source: "IMPORT",
          startsAt,
          status: "COMPLETED",
          timezone: "Asia/Amman",
        },
      });
      await transaction.appointmentStatusHistory.createMany({
        data: [
          {
            appointmentId: imported.id,
            createdAt: imported.createdAt,
            endsAt,
            eventType: "CREATED",
            organizationId: fixture.eligible.id,
            source: "IMPORT",
            startsAt,
            toStatus: "CONFIRMED",
            version: 1,
          },
          {
            appointmentId: imported.id,
            createdAt: new Date(endsAt.getTime() + 60 * 60_000),
            endsAt,
            eventType: "STATUS_CHANGED",
            fromStatus: "CONFIRMED",
            organizationId: fixture.eligible.id,
            source: "IMPORT",
            startsAt,
            toStatus: "COMPLETED",
            version: 2,
          },
        ],
      });
    });
    const jobs = await Promise.all(
      (["DEMAND_FORECAST", "NO_SHOW"] as const).map((capability) =>
        predictive.requestJob(fixture.eligible.selection, {
          actorUserId: fixture.eligibleOwner.id,
          branchId: fixture.catalog.branch.id,
          capability,
          idempotencyKey: `phase8:worker:import-exclusion:${capability}:${randomUUID()}`,
          jobType: "DATA_AUDIT",
        }),
      ),
    );
    for (const job of jobs) await predictive.processJob(fixture.eligible.id, job.id);
    const audits = await runInTenant(client, fixture.eligible.access, (transaction) =>
      transaction.predictiveDataAudit.findMany({
        where: { jobId: { in: jobs.map(({ id }) => id) } },
      }),
    );
    const noShow = audits.find(({ capability }) => capability === "NO_SHOW");
    const demand = audits.find(({ capability }) => capability === "DEMAND_FORECAST");
    expect(noShow?.counts).toMatchObject({ resolved: 219 });
    expect(demand?.counts).toMatchObject({ appointments: 220 });
    expect(noShow?.warnings).toContain("IMPORTED_ROWS_EXCLUDED");
    expect(demand?.warnings).toContain("BOOKED_DEMAND_ONLY");
  });

  it("refuses legacy history whose dimensional snapshot cannot be verified", async () => {
    const historical = await client.appointment.findFirstOrThrow({
      orderBy: { startsAt: "asc" },
      where: {
        endsAt: { lt: new Date(Date.now() - 8 * 86_400_000) },
        organizationId: fixture.eligible.id,
      },
    });
    await client.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe(
          'LOCK TABLE "appointment_status_history" IN ACCESS EXCLUSIVE MODE',
        );
        await transaction.$executeRawUnsafe(
          'ALTER TABLE "appointment_status_history" DISABLE TRIGGER "appointment_status_history_capture_dimensions"',
        );
        await transaction.appointmentStatusHistory.create({
          data: {
            appointmentId: historical.id,
            branchSnapshotId: historical.branchId,
            createdAt: new Date(historical.createdAt.getTime() + 1),
            customerSnapshotId: historical.customerId,
            endsAt: historical.endsAt,
            eventType: "CREATED",
            organizationId: fixture.eligible.id,
            providerSnapshotId: historical.providerId,
            serviceSnapshotId: historical.serviceId,
            source: historical.source,
            startsAt: historical.startsAt,
            timezoneSnapshot: historical.timezone,
            toStatus: "CONFIRMED",
            version: 1,
          },
        });
        await transaction.$executeRawUnsafe(
          'ALTER TABLE "appointment_status_history" ENABLE TRIGGER "appointment_status_history_capture_dimensions"',
        );
      },
      { timeout: 10_000 },
    );

    const jobs = await Promise.all(
      (["DEMAND_FORECAST", "NO_SHOW"] as const).map((capability) =>
        predictive.requestJob(fixture.eligible.selection, {
          actorUserId: fixture.eligibleOwner.id,
          branchId: fixture.catalog.branch.id,
          capability,
          idempotencyKey: `phase8:worker:legacy-dimensions:${capability}:${randomUUID()}`,
          jobType: "DATA_AUDIT",
        }),
      ),
    );
    for (const job of jobs) await predictive.processJob(fixture.eligible.id, job.id);

    const evidence = await runInTenant(client, fixture.eligible.access, (transaction) =>
      Promise.all(
        jobs.map(async (job) => ({
          audit: await transaction.predictiveDataAudit.findFirstOrThrow({
            where: { jobId: job.id },
          }),
          refusal: await transaction.prediction.findFirstOrThrow({
            where: { jobId: job.id },
          }),
        })),
      ),
    );
    for (const { audit, refusal } of evidence) {
      expect(audit).toMatchObject({ eligible: false, refusalReason: "MODEL_DEGRADED" });
      expect(audit.counts).toMatchObject({ unverifiedDimensions: 1 });
      expect(audit.warnings).toContain("UNVERIFIED_HISTORICAL_DIMENSIONS_EXCLUDED");
      expect(refusal).toMatchObject({
        estimate: null,
        lowerBound: null,
        refusalReason: "MODEL_DEGRADED",
        status: "REFUSED",
        upperBound: null,
      });
    }
  });
});
