import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@jormall/db/client";
import { CrmAppointmentRepository } from "@jormall/db/crm-appointment-repository";
import {
  GymPortalAccessStatus,
  OrganizationStatus,
  PlatformRole,
} from "@jormall/db/generated/enums";
import { GymRepository } from "@jormall/db/gym-repository";
import { IdentityRepository } from "@jormall/db/identity-repository";
import { runInTenant } from "@jormall/db/tenant-context";
import type { TenantAccessSnapshot } from "@jormall/domain/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required.");

const client = createPrismaClient(databaseUrl);
const identity = new IdentityRepository(client);
const crm = new CrmAppointmentRepository(client);
const gym = new GymRepository(client);
const suffix = randomUUID().slice(0, 8);

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let fixture: Fixture;

async function user(label: string, platformRole = PlatformRole.USER) {
  return client.user.create({
    data: {
      email: `${label}-${suffix}@example.invalid`,
      name: `${label} ${suffix}`,
      platformRole,
    },
  });
}

async function gymOrganization(
  superAdminId: string,
  owner: Readonly<{ email: string; id: string }>,
  label: string,
) {
  const created = await identity.createOrganization(superAdminId, {
    businessSector: "GYM",
    nameAr: `${label} العربية`,
    nameEn: `${label} English`,
    ownerEmail: owner.email,
    slug: `${label.toLowerCase()}-${suffix}`,
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
  return { access, organizationId: accepted.organizationId };
}

async function createProfile(access: TenantAccessSnapshot, name: string) {
  const created = await crm.createCustomer(access, { displayName: name, preferredLocale: "en" });
  return gym.createTrainee(access, {
    currency: "JOD",
    customerId: created.customer.id,
    experienceLevel: "BEGINNER",
    goal: "FITNESS",
    startingWeightKg: 80,
    targetWeightKg: 75,
  });
}

async function createFixture() {
  const [superAdmin, ownerA, ownerB, traineeA] = await Promise.all([
    user("gym-portal-super", PlatformRole.JORMALL_SUPER_ADMIN),
    user("gym-portal-owner-a"),
    user("gym-portal-owner-b"),
    user("gym-portal-trainee-a"),
  ]);
  const organizationA = await gymOrganization(superAdmin.id, ownerA, "Portal-A");
  const organizationB = await gymOrganization(superAdmin.id, ownerB, "Portal-B");
  const [profileA, staffTargetProfile, profileB] = await Promise.all([
    createProfile(organizationA.access, `Trainee A ${suffix}`),
    createProfile(organizationA.access, `Staff target ${suffix}`),
    createProfile(organizationB.access, `Trainee B ${suffix}`),
  ]);
  const planA = await gym.createWorkoutPlan(organizationA.access, {
    startsOn: new Date("2026-01-01T00:00:00.000Z"),
    traineeProfileId: profileA.id,
    titleAr: "خطة أ",
    titleEn: "Plan A",
  });
  const planB = await gym.createWorkoutPlan(organizationB.access, {
    startsOn: new Date("2026-01-01T00:00:00.000Z"),
    traineeProfileId: profileB.id,
    titleAr: "خطة ب",
    titleEn: "Plan B",
  });
  const exerciseA = await gym.addWorkoutExercise(organizationA.access, {
    nameAr: "تمرين أ",
    nameEn: "Exercise A",
    repsMax: 12,
    repsMin: 8,
    restSeconds: 60,
    sets: 3,
    sortOrder: 0,
    weekday: "WEDNESDAY",
    workoutPlanId: planA.id,
  });
  const exerciseB = await gym.addWorkoutExercise(organizationB.access, {
    nameAr: "تمرين ب",
    nameEn: "Exercise B",
    repsMax: 12,
    repsMin: 8,
    restSeconds: 60,
    sets: 3,
    sortOrder: 0,
    weekday: "WEDNESDAY",
    workoutPlanId: planB.id,
  });
  return {
    exerciseA,
    exerciseB,
    organizationA,
    organizationB,
    ownerA,
    profileA,
    staffTargetProfile,
    superAdmin,
    traineeA,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
});

afterAll(async () => {
  await client.$disconnect();
});

describe("gym trainee portal PostgreSQL boundaries", () => {
  it("accepts a matching single-use invitation and rejects staff identity reuse", async () => {
    const token = await gym.createPortalInvitation(fixture.organizationA.access, {
      email: fixture.traineeA.email,
      traineeProfileId: fixture.profileA.id,
    });
    const preview = await gym.previewPortalInvitation(token);
    expect(preview.traineeName).toBe(`Trainee A ${suffix}`);
    await gym.acceptPortalInvitation(fixture.traineeA.id, fixture.traineeA.email, token);
    await expect(
      gym.acceptPortalInvitation(fixture.traineeA.id, fixture.traineeA.email, token),
    ).rejects.toMatchObject({ code: "INVITATION_ALREADY_USED" });

    const staffToken = await gym.createPortalInvitation(fixture.organizationA.access, {
      email: fixture.ownerA.email,
      traineeProfileId: fixture.staffTargetProfile.id,
    });
    await expect(
      gym.acceptPortalInvitation(fixture.ownerA.id, fixture.ownerA.email, staffToken),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("derives tenant and trainee context from the authenticated user", async () => {
    const portal = await gym.getOwnPortal(fixture.traineeA.id);
    expect(portal.trainee.id).toBe(fixture.profileA.id);
    expect(portal.trainee).not.toHaveProperty("notes");
    expect(portal.trainee.customer).not.toHaveProperty("contacts");

    await expect(
      gym.recordOwnWorkout(fixture.traineeA.id, {
        actualReps: 10,
        actualSets: 3,
        actualWeightKg: 30,
        workoutExerciseId: fixture.exerciseB.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await gym.recordOwnWorkout(fixture.traineeA.id, {
      actualReps: 10,
      actualSets: 3,
      actualWeightKg: 30,
      workoutExerciseId: fixture.exerciseA.id,
    });

    const portalAccess = await client.gymTraineePortalAccess.findUnique({
      where: { userId: fixture.traineeA.id },
    });
    if (!portalAccess) throw new Error("Portal access fixture is missing.");
    const crossTenantRead = await runInTenant(
      client,
      { actorUserId: fixture.ownerA.id, organizationId: fixture.organizationB.organizationId },
      (transaction) =>
        transaction.gymTraineePortalAccess.findFirst({ where: { id: portalAccess.id } }),
    );
    expect(crossTenantRead).toBeNull();
  });

  it("removes access immediately when the portal or organization is suspended", async () => {
    await gym.setPortalAccessStatus(
      fixture.organizationA.access,
      fixture.profileA.id,
      GymPortalAccessStatus.SUSPENDED,
    );
    await expect(gym.getOwnPortal(fixture.traineeA.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await gym.setPortalAccessStatus(
      fixture.organizationA.access,
      fixture.profileA.id,
      GymPortalAccessStatus.ACTIVE,
    );
    await identity.setOrganizationStatus(
      fixture.superAdmin.id,
      fixture.organizationA.organizationId,
      OrganizationStatus.SUSPENDED,
      "Portal suspension regression test",
    );
    await expect(gym.getOwnPortal(fixture.traineeA.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
