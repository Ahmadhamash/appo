import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@jormall/db/client";
import { OrganizationStatus, PlatformRole } from "@jormall/db/generated/enums";
import { IdentityRepository } from "@jormall/db/identity-repository";
import {
  PredictiveRepository,
  type TenantAccessSelection,
} from "@jormall/db/predictive-repository";
import { runInTenant } from "@jormall/db/tenant-context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startPredictiveWorker } from "../../apps/worker/src/predictive-worker";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  throw new Error("PostgreSQL and Redis URLs are required for predictive worker integration.");
}

const client = createPrismaClient(databaseUrl);
const identity = new IdentityRepository(client);
const predictive = new PredictiveRepository(client);
const suffix = randomUUID().slice(0, 8);
let fixture: Awaited<ReturnType<typeof createFixture>>;
let runtime: Awaited<ReturnType<typeof startPredictiveWorker>> | undefined;

async function createFixture() {
  const [admin, owner] = await Promise.all([
    client.user.create({
      data: {
        email: `phase8-redis-admin-${suffix}@example.invalid`,
        name: "Phase 8 Redis Admin",
        platformRole: PlatformRole.JORMALL_SUPER_ADMIN,
      },
    }),
    client.user.create({
      data: {
        email: `phase8-redis-owner-${suffix}@example.invalid`,
        name: "Phase 8 Redis Owner",
      },
    }),
  ]);
  const created = await identity.createOrganization(admin.id, {
    businessSector: "CLINIC",
    nameAr: `عامل تنبؤ ${suffix}`,
    nameEn: `Predictive worker ${suffix}`,
    ownerEmail: owner.email,
    slug: `phase8-predictive-worker-${suffix}`,
  });
  const accepted = await identity.acceptInvitation(owner.id, owner.email, created.invitationToken);
  await identity.setOrganizationStatus(admin.id, created.organizationId, OrganizationStatus.ACTIVE);
  const selection: TenantAccessSelection = {
    activeMembershipId: accepted.membershipId,
    activeOrganizationId: accepted.organizationId,
  };
  const access = await identity.loadTenantAccess(owner.id, selection, {});
  const noShow = (await predictive.getOverview(selection, owner.id)).capabilities.find(
    ({ capability }) => capability === "NO_SHOW",
  );
  if (!noShow) throw new Error("No-show capability setting is missing.");
  await predictive.updateCapability(selection, {
    actorUserId: owner.id,
    capability: "NO_SHOW",
    enabled: true,
    expectedVersion: noShow.version,
  });
  return { access, organizationId: created.organizationId, owner, selection };
}

async function waitForTerminalJob(jobId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await runInTenant(client, fixture.access, (transaction) =>
      transaction.predictiveJob.findFirst({
        where: { id: jobId, organizationId: fixture.organizationId },
      }),
    );
    if (job && ["COMPLETED", "DEAD_LETTER", "FAILED"].includes(job.status)) return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("BullMQ predictive job did not reach a terminal state within 30 seconds.");
}

async function waitForCompletedQueueJob(
  workerRuntime: Awaited<ReturnType<typeof startPredictiveWorker>>,
  queueJobId: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await workerRuntime.queue.getJob(queueJobId);
    if (job && (await job.getState()) === "completed") return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("BullMQ predictive job did not reach completed queue state within 10 seconds.");
}

beforeAll(async () => {
  fixture = await createFixture();
});

afterAll(async () => {
  await runtime?.close();
  await client.$disconnect();
});

describe("Redis/BullMQ predictive worker", () => {
  it("relays and completes one durable sparse feature job with stable queue evidence", async () => {
    const requested = await predictive.requestJob(fixture.selection, {
      actorUserId: fixture.owner.id,
      capability: "NO_SHOW",
      idempotencyKey: `phase8:redis:feature:${randomUUID()}`,
      jobType: "FEATURE_COMPUTE",
    });
    const workerRuntime = await startPredictiveWorker(redisUrl);
    runtime = workerRuntime;
    const completed = await waitForTerminalJob(requested.id);
    expect(completed).toMatchObject({
      attempts: 1,
      processedRows: 1,
      safeErrorCode: null,
      status: "COMPLETED",
      totalRows: 1,
    });
    expect(completed.evaluationAt).not.toBeNull();
    expect(completed.leaseToken).not.toBeNull();
    if (!completed.leaseToken) throw new Error("Predictive worker lease evidence is missing.");

    const [audit, refusal, queueJob] = await Promise.all([
      runInTenant(client, fixture.access, (transaction) =>
        transaction.predictiveDataAudit.findFirstOrThrow({
          where: { jobId: requested.id, organizationId: fixture.organizationId },
        }),
      ),
      runInTenant(client, fixture.access, (transaction) =>
        transaction.prediction.findFirstOrThrow({
          where: { jobId: requested.id, organizationId: fixture.organizationId },
        }),
      ),
      waitForCompletedQueueJob(workerRuntime, `${requested.id}-${completed.leaseToken}`),
    ]);
    expect(audit).toMatchObject({ eligible: false, sampleSize: 0 });
    expect(refusal).toMatchObject({
      estimate: null,
      lowerBound: null,
      refusalReason: "INSUFFICIENT_SAMPLE",
      status: "REFUSED",
      upperBound: null,
    });
    expect(await queueJob.getState()).toBe("completed");
    const evaluationAt = completed.evaluationAt;
    if (!evaluationAt) throw new Error("Evaluation watermark is missing.");
    await expect(
      runInTenant(client, fixture.access, (transaction) =>
        transaction.predictiveJob.update({
          data: { evaluationAt: new Date(evaluationAt.getTime() + 1_000) },
          where: { id: requested.id },
        }),
      ),
    ).rejects.toBeDefined();
  }, 60_000);
});
