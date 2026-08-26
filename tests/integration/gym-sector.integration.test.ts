import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@jormall/db/client";
import { CrmAppointmentRepository } from "@jormall/db/crm-appointment-repository";
import { BusinessSector, OrganizationStatus, PlatformRole } from "@jormall/db/generated/enums";
import { GymRepository } from "@jormall/db/gym-repository";
import { IdentityRepository } from "@jormall/db/identity-repository";
import { runInTenant } from "@jormall/db/tenant-context";
import type { TenantAccessSnapshot } from "@jormall/domain/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL or DATABASE_URL is required for PostgreSQL integration tests.",
  );
}

const client = createPrismaClient(databaseUrl);
const identityRepository = new IdentityRepository(client);
const crmRepository = new CrmAppointmentRepository(client);
const gymRepository = new GymRepository(client);
const suffix = randomUUID().slice(0, 8);

type ActiveOrganization = Readonly<{
  access: TenantAccessSnapshot;
  organizationId: string;
}>;

let ownerA: Awaited<ReturnType<typeof createUser>>;
let organizationA: ActiveOrganization;
let organizationB: ActiveOrganization;
let providerAAccess: TenantAccessSnapshot;
let providerAProfileId: string;
let providerBAccess: TenantAccessSnapshot;
let providerBProfileId: string;
let secretaryAccess: TenantAccessSnapshot;

async function createUser(label: string, platformRole = PlatformRole.USER) {
  return client.user.create({
    data: {
      email: `gym-${label}-${suffix}@example.invalid`,
      name: `${label} ${suffix}`,
      platformRole,
    },
  });
}

async function createOrganization(
  superAdminId: string,
  owner: Readonly<{ email: string; id: string }>,
  label: string,
): Promise<ActiveOrganization> {
  const created = await identityRepository.createOrganization(superAdminId, {
    businessSector: BusinessSector.GYM,
    nameAr: `${label} العربية`,
    nameEn: `${label} English`,
    ownerEmail: owner.email,
    slug: `gym-${label.toLowerCase()}-${suffix}`,
  });
  const accepted = await identityRepository.acceptInvitation(
    owner.id,
    owner.email,
    created.invitationToken,
  );
  await identityRepository.setOrganizationStatus(
    superAdminId,
    created.organizationId,
    OrganizationStatus.ACTIVE,
  );
  const access = await identityRepository.loadTenantAccess(
    owner.id,
    {
      activeMembershipId: accepted.membershipId,
      activeOrganizationId: accepted.organizationId,
    },
    {},
  );
  return { access, organizationId: accepted.organizationId };
}

async function invite(
  ownerAccess: TenantAccessSnapshot,
  user: Readonly<{ email: string; id: string }>,
  roleKey: "PROVIDER" | "SECRETARY",
) {
  const role = (await identityRepository.listRoles(ownerAccess)).find(
    ({ systemKey }) => systemKey === roleKey,
  );
  if (!role) throw new Error(`Missing ${roleKey} role.`);
  const token = await identityRepository.createInvitation(ownerAccess, user.email, role.id);
  return identityRepository.acceptInvitation(user.id, user.email, token);
}

beforeAll(async () => {
  const superAdmin = await createUser("super", PlatformRole.JORMALL_SUPER_ADMIN);
  const firstOwner = await createUser("owner-a");
  const secondOwner = await createUser("owner-b");
  const providerA = await createUser("provider-a");
  const providerB = await createUser("provider-b");
  const secretary = await createUser("secretary");
  ownerA = firstOwner;
  organizationA = await createOrganization(superAdmin.id, firstOwner, "Sector-A");
  organizationB = await createOrganization(superAdmin.id, secondOwner, "Sector-B");
  const providerAMembership = await invite(organizationA.access, providerA, "PROVIDER");
  const providerBMembership = await invite(organizationA.access, providerB, "PROVIDER");
  const secretaryMembership = await invite(organizationA.access, secretary, "SECRETARY");
  providerAAccess = await identityRepository.loadTenantAccess(
    providerA.id,
    {
      activeMembershipId: providerAMembership.membershipId,
      activeOrganizationId: organizationA.organizationId,
    },
    {},
  );
  providerBAccess = await identityRepository.loadTenantAccess(
    providerB.id,
    {
      activeMembershipId: providerBMembership.membershipId,
      activeOrganizationId: organizationA.organizationId,
    },
    {},
  );
  secretaryAccess = await identityRepository.loadTenantAccess(
    secretary.id,
    {
      activeMembershipId: secretaryMembership.membershipId,
      activeOrganizationId: organizationA.organizationId,
    },
    {},
  );
  const staff = await identityRepository.listStaff(organizationA.access);
  const profileByMembership = new Map(
    staff.flatMap(({ id, staffProfile }) => (staffProfile ? [[id, staffProfile.id] as const] : [])),
  );
  const firstProviderProfile = profileByMembership.get(providerAMembership.membershipId);
  const secondProviderProfile = profileByMembership.get(providerBMembership.membershipId);
  if (!firstProviderProfile || !secondProviderProfile)
    throw new Error("Provider profiles missing.");
  providerAProfileId = firstProviderProfile;
  providerBProfileId = secondProviderProfile;
});

afterAll(async () => {
  await client.$disconnect();
});

describe("sector selection and gym operations", () => {
  it("provisions the selected sector at creation and limits reclassification to Super Admin", async () => {
    await expect(identityRepository.getBusinessSector(organizationA.access)).resolves.toBe(
      BusinessSector.GYM,
    );
    await expect(
      identityRepository.reclassifyOrganizationBusinessSector(
        secretaryAccess.actorUserId,
        organizationA.organizationId,
        BusinessSector.CLINIC,
        "Unauthorized sector change attempt",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const audit = await runInTenant(
      client,
      { actorUserId: ownerA.id, organizationId: organizationA.organizationId },
      (transaction) =>
        transaction.auditEvent.findFirst({
          where: {
            action: "ORGANIZATION_CREATED",
            organizationId: organizationA.organizationId,
          },
        }),
    );
    expect(audit?.metadata).toMatchObject({ businessSector: BusinessSector.GYM });
  });

  it("enforces tenant isolation and trainer self scope for trainee profiles", async () => {
    const customerA = await crmRepository.createCustomer(organizationA.access, {
      displayName: `Trainee A ${suffix}`,
      phoneOriginal: "0791111111",
      preferredLocale: "ar",
    });
    const customerA2 = await crmRepository.createCustomer(organizationA.access, {
      displayName: `Trainee A2 ${suffix}`,
      phoneOriginal: "0792222222",
      preferredLocale: "en",
    });
    const customerB = await crmRepository.createCustomer(organizationB.access, {
      displayName: `Trainee B ${suffix}`,
      phoneOriginal: "0793333333",
      preferredLocale: "ar",
    });
    const profileA = await gymRepository.createTrainee(organizationA.access, {
      currency: "JOD",
      customerId: customerA.customer.id,
      experienceLevel: "BEGINNER",
      goal: "MUSCLE_GAIN",
      heightCm: 178,
      monthlyFoodBudgetMinor: 18_000,
      startingWeightKg: 82,
      targetWeightKg: 88,
      trainerStaffProfileId: providerAProfileId,
    });
    const profileA2 = await gymRepository.createTrainee(organizationA.access, {
      currency: "JOD",
      customerId: customerA2.customer.id,
      experienceLevel: "INTERMEDIATE",
      goal: "FITNESS",
      trainerStaffProfileId: providerBProfileId,
    });
    const profileB = await gymRepository.createTrainee(organizationB.access, {
      currency: "JOD",
      customerId: customerB.customer.id,
      experienceLevel: "BEGINNER",
      goal: "WEIGHT_LOSS",
    });

    await expect(gymRepository.getTrainee(organizationA.access, profileB.id)).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );
    await expect(gymRepository.getTrainee(providerAAccess, profileA2.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(gymRepository.listTrainees(providerAAccess)).resolves.toEqual([
      expect.objectContaining({ id: profileA.id }),
    ]);
    await expect(gymRepository.listTrainees(providerBAccess)).resolves.toEqual([
      expect.objectContaining({ id: profileA2.id }),
    ]);

    const workoutPlan = await gymRepository.createWorkoutPlan(providerAAccess, {
      startsOn: new Date("2026-09-01T00:00:00.000Z"),
      traineeProfileId: profileA.id,
      titleAr: "برنامج القوة",
      titleEn: "Strength program",
    });
    const exercise = await gymRepository.addWorkoutExercise(providerAAccess, {
      nameAr: "سكوات",
      nameEn: "Squat",
      repsMax: 12,
      repsMin: 8,
      restSeconds: 90,
      sets: 4,
      sortOrder: 0,
      targetWeightKg: 60,
      weekday: "MONDAY",
      workoutPlanId: workoutPlan.id,
    });
    await gymRepository.recordWorkout(providerAAccess, {
      actualReps: 10,
      actualSets: 4,
      actualWeightKg: 62.5,
      perceivedEffort: 8,
      performedAt: new Date("2026-09-01T15:00:00.000Z"),
      workoutExerciseId: exercise.id,
    });
    const nutritionPlan = await gymRepository.createNutritionPlan(providerAAccess, {
      carbohydratesGrams: 230,
      currency: "JOD",
      dailyBudgetMinor: 600,
      dailyCalories: 2200,
      fatGrams: 70,
      goal: "MUSCLE_GAIN",
      proteinGrams: 150,
      startsOn: new Date("2026-09-01T00:00:00.000Z"),
      traineeProfileId: profileA.id,
      titleAr: "غذاء ضمن الميزانية",
      titleEn: "Budget nutrition",
    });
    await gymRepository.addNutritionMeal(providerAAccess, {
      calories: 650,
      carbohydratesGrams: 80,
      estimatedCostMinor: 175,
      fatGrams: 18,
      nameAr: "أرز ودجاج",
      nameEn: "Rice and chicken",
      nutritionPlanId: nutritionPlan.id,
      proteinGrams: 45,
      sortOrder: 0,
    });
    await gymRepository.recordProgress(providerAAccess, {
      bodyFatPercent: 18.5,
      bodyWeightKg: 83,
      measuredAt: new Date("2026-09-08T15:00:00.000Z"),
      traineeProfileId: profileA.id,
      waistCm: 86,
    });

    const detail = await gymRepository.getTrainee(providerAAccess, profileA.id);
    expect(detail.workoutPlans[0]?.exercises).toHaveLength(1);
    expect(detail.workoutLogs).toHaveLength(1);
    expect(detail.nutritionPlans[0]?.meals).toHaveLength(1);
    expect(detail.progressEntries).toHaveLength(1);
  });

  it("enables and forces tenant RLS on every gym table", async () => {
    const rows = await client.$queryRaw<
      Array<{ relforcerowsecurity: boolean; relname: string; relrowsecurity: boolean }>
    >`SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN (
        'gym_trainee_profiles', 'gym_workout_plans', 'gym_workout_exercises',
        'gym_workout_logs', 'gym_nutrition_plans', 'gym_nutrition_meals',
        'gym_progress_entries'
      )`;
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });
});
