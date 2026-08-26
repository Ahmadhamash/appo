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

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A PostgreSQL integration-test URL is required.");

const client = createPrismaClient(databaseUrl);
const identity = new IdentityRepository(client);
const predictive = new PredictiveRepository(client);
const suffix = randomUUID().slice(0, 8);

async function createUser(label: string, platformRole = PlatformRole.USER) {
  return client.user.create({
    data: {
      email: `phase8-${label}-${suffix}@example.invalid`,
      name: `Phase 8 ${label}`,
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
    businessSector: "CLINIC",
    nameAr: `${label} العربية`,
    nameEn: label,
    ownerEmail: owner.email,
    slug: `phase8-${label.toLowerCase().replaceAll(" ", "-")}-${suffix}`,
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

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let fixture: Fixture;

async function createFixture() {
  const [admin, ownerA, ownerB, secretary] = await Promise.all([
    createUser("admin", PlatformRole.JORMALL_SUPER_ADMIN),
    createUser("owner-a"),
    createUser("owner-b"),
    createUser("secretary"),
  ]);
  const [organizationA, organizationB] = await Promise.all([
    createOrganization(admin.id, ownerA, "Predictive A"),
    createOrganization(admin.id, ownerB, "Predictive B"),
  ]);
  await identity.createBranch(organizationA.access, {
    nameAr: "فرع التنبؤ",
    nameEn: "Predictive Branch",
    timezone: "Asia/Amman",
  });
  const [branch] = await identity.listBranches(organizationA.access);
  if (!branch) throw new Error("Predictive branch fixture is missing.");
  const roles = await identity.listRoles(organizationA.access);
  const secretaryRole = roles.find(({ systemKey }) => systemKey === "SECRETARY");
  if (!secretaryRole) throw new Error("Secretary role fixture is missing.");
  const invitation = await identity.createInvitation(
    organizationA.access,
    secretary.email,
    secretaryRole.id,
  );
  const acceptedSecretary = await identity.acceptInvitation(
    secretary.id,
    secretary.email,
    invitation,
  );
  await runInTenant(client, organizationA.access, async (transaction) => {
    const profile = await transaction.staffProfile.create({
      data: {
        displayNameAr: "سكرتير التنبؤ",
        displayNameEn: "Predictive Secretary",
        isBookable: false,
        membershipId: acceptedSecretary.membershipId,
        organizationId: organizationA.id,
      },
    });
    await transaction.staffBranchAssignment.create({
      data: {
        branchId: branch.id,
        organizationId: organizationA.id,
        staffProfileId: profile.id,
      },
    });
  });
  const secretarySelection: TenantAccessSelection = {
    activeMembershipId: acceptedSecretary.membershipId,
    activeOrganizationId: organizationA.id,
  };
  return {
    admin,
    branch,
    organizationA,
    organizationB,
    ownerA,
    ownerB,
    secretary,
    secretaryMembershipId: acceptedSecretary.membershipId,
    secretarySelection,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
});

afterAll(async () => {
  await client.$disconnect();
});

describe("Phase 8 predictive persistence and authorization", () => {
  it("creates every capability disabled and applies optimistic organization configuration", async () => {
    const initial = await predictive.getOverview(
      fixture.organizationA.selection,
      fixture.ownerA.id,
    );
    expect(initial.capabilities).toHaveLength(5);
    expect(initial.capabilities.every(({ enabled }) => !enabled)).toBe(true);
    const noShow = initial.capabilities.find(({ capability }) => capability === "NO_SHOW");
    if (!noShow) throw new Error("No-show capability fixture is missing.");
    const enabled = await predictive.updateCapability(fixture.organizationA.selection, {
      actorUserId: fixture.ownerA.id,
      capability: "NO_SHOW",
      enabled: true,
      expectedVersion: noShow.version,
    });
    expect(enabled).toMatchObject({ enabled: true, version: noShow.version + 1 });
    await expect(
      predictive.updateCapability(fixture.organizationA.selection, {
        actorUserId: fixture.ownerA.id,
        capability: "NO_SHOW",
        enabled: false,
        expectedVersion: noShow.version,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("creates one durable idempotent audit job and rejects changed input", async () => {
    const idempotencyKey = `phase8:audit:${randomUUID()}`;
    const first = await predictive.requestJob(fixture.organizationA.selection, {
      actorUserId: fixture.ownerA.id,
      capability: "NO_SHOW",
      idempotencyKey,
      jobType: "DATA_AUDIT",
    });
    const duplicate = await predictive.requestJob(fixture.organizationA.selection, {
      actorUserId: fixture.ownerA.id,
      capability: "NO_SHOW",
      idempotencyKey,
      jobType: "DATA_AUDIT",
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.reused).toBe(true);
    await expect(
      predictive.requestJob(fixture.organizationA.selection, {
        actorUserId: fixture.ownerA.id,
        branchId: fixture.branch.id,
        capability: "NO_SHOW",
        idempotencyKey,
        jobType: "DATA_AUDIT",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("does not disclose jobs through repository predicates or PostgreSQL RLS", async () => {
    const job = await predictive.requestJob(fixture.organizationA.selection, {
      actorUserId: fixture.ownerA.id,
      capability: "DEMAND_FORECAST",
      idempotencyKey: `phase8:isolation:${randomUUID()}`,
      jobType: "DATA_AUDIT",
    });
    const otherOverview = await predictive.getOverview(
      fixture.organizationB.selection,
      fixture.ownerB.id,
    );
    expect(otherOverview.jobs.some(({ id }) => id === job.id)).toBe(false);
    const leaked = await runInTenant(client, fixture.organizationB.access, (transaction) =>
      transaction.predictiveJob.findFirst({ where: { id: job.id } }),
    );
    expect(leaked).toBeNull();
    await expect(
      predictive.requestJob(fixture.organizationB.selection, {
        actorUserId: fixture.ownerB.id,
        branchId: fixture.branch.id,
        capability: "DEMAND_FORECAST",
        idempotencyKey: `phase8:foreign:${randomUUID()}`,
        jobType: "DATA_AUDIT",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("denies secretary configuration and execution and rechecks suspension immediately", async () => {
    await expect(
      predictive.updateCapability(fixture.secretarySelection, {
        actorUserId: fixture.secretary.id,
        capability: "NO_SHOW",
        enabled: true,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      predictive.requestJob(fixture.secretarySelection, {
        actorUserId: fixture.secretary.id,
        branchId: fixture.branch.id,
        capability: "NO_SHOW",
        idempotencyKey: `phase8:secretary:${randomUUID()}`,
        jobType: "DATA_AUDIT",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await identity.setMembershipStatus(
      fixture.organizationA.access,
      fixture.secretaryMembershipId,
      "SUSPENDED",
    );
    await expect(
      predictive.getOverview(fixture.secretarySelection, fixture.secretary.id),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_SUSPENDED" });
  });
});
