import { DomainError } from "@jormall/domain/errors";
import {
  assertExercisePrescription,
  assertGymTraineeMetrics,
  assertNutritionTargets,
  assertWorkoutPerformance,
  type GymExperienceLevelValue,
  type GymGoalValue,
} from "@jormall/domain/gym";
import type {
  PermissionCode,
  PermissionScope,
  TenantAccessSnapshot,
} from "@jormall/domain/identity";

import {
  BusinessSector,
  MembershipStatus,
  OrganizationStatus,
  PlatformRole,
  type GymGoal,
  type PrismaClient,
  type Weekday,
} from "./generated/prisma/client";
import { runInTenant, type TenantTransaction } from "./tenant-context";

type GymPermission = Extract<
  PermissionCode,
  "gym.plans.manage" | "gym.progress.write" | "gym.trainees.manage" | "gym.trainees.read"
>;

function permissionScope(access: TenantAccessSnapshot, permission: GymPermission): PermissionScope {
  const rank: Readonly<Record<PermissionScope, number>> = {
    ASSIGNED_BRANCHES: 2,
    ORGANIZATION: 3,
    SELF: 1,
  };
  const scope = access.grants
    .filter((grant) => grant.code === permission)
    .toSorted((left, right) => rank[right.scope] - rank[left.scope])[0]?.scope;
  if (!scope) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "The active tenant context does not grant this gym permission.",
      metadata: { permission },
    });
  }
  return scope;
}

function trainerFilter(
  access: TenantAccessSnapshot,
  permission: GymPermission,
): Readonly<{ trainerStaffProfileId?: string }> {
  if (permissionScope(access, permission) !== "SELF") return {};
  if (!access.staffProfileId) {
    throw new DomainError({ code: "FORBIDDEN", message: "A trainer profile is required." });
  }
  return { trainerStaffProfileId: access.staffProfileId };
}

function trimmed(value: string, label: string, maximum = 160): string {
  const result = value.trim();
  if (!result || result.length > maximum) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: `Invalid ${label}.` });
  }
  return result;
}

function optionalTrimmed(value: string | undefined, maximum = 4000): string | undefined {
  const result = value?.trim();
  if (!result) return undefined;
  if (result.length > maximum) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Text is too long." });
  }
  return result;
}

function gymGoal(value: GymGoalValue): GymGoal {
  return value as GymGoal;
}

async function audit(
  transaction: TenantTransaction,
  access: TenantAccessSnapshot,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      action,
      actorUserId: access.actorUserId,
      organizationId: access.organizationId,
      supportAccessId: access.supportAccessId ?? null,
      targetId,
      targetType,
    },
  });
}

export type CreateGymTraineeInput = Readonly<{
  currency: string;
  customerId: string;
  experienceLevel: GymExperienceLevelValue;
  goal: GymGoalValue;
  heightCm?: number | undefined;
  monthlyFoodBudgetMinor?: number | undefined;
  notes?: string | undefined;
  startingWeightKg?: number | undefined;
  targetWeightKg?: number | undefined;
  trainerStaffProfileId?: string | undefined;
}>;

export class GymRepository {
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
        throw new DomainError({ code: "FORBIDDEN", message: "Support access is invalid." });
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
      if (organization.status === OrganizationStatus.SUSPENDED) {
        throw new DomainError({
          code: "ORGANIZATION_SUSPENDED",
          message: "The organization is suspended.",
        });
      }
      if (organization.status !== OrganizationStatus.ACTIVE) {
        throw new DomainError({ code: "FORBIDDEN", message: "The organization is not active." });
      }
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
      } else if (!access.supportAccessId) {
        throw new DomainError({
          code: "TENANT_CONTEXT_REQUIRED",
          message: "An active membership or support access is required.",
        });
      }
      const settings = await transaction.organizationSettings.findUnique({
        select: { businessSector: true },
        where: { organizationId: access.organizationId },
      });
      if (settings?.businessSector !== BusinessSector.GYM) {
        throw new DomainError({
          code: "BUSINESS_SECTOR_REQUIRED",
          message: "This operation is available only to gym organizations.",
        });
      }
      return operation(transaction);
    });
  }

  async listTrainees(access: TenantAccessSnapshot) {
    const scope = trainerFilter(access, "gym.trainees.read");
    return this.runWithAccess(access, (transaction) =>
      transaction.gymTraineeProfile.findMany({
        include: {
          customer: {
            include: {
              contacts: {
                orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                take: 1,
              },
            },
          },
          nutritionPlans: {
            orderBy: { startsOn: "desc" },
            take: 1,
            where: { status: "ACTIVE" },
          },
          progressEntries: { orderBy: { measuredAt: "desc" }, take: 1 },
          trainer: { select: { displayNameAr: true, displayNameEn: true, id: true } },
          workoutPlans: {
            orderBy: { startsOn: "desc" },
            take: 1,
            where: { status: "ACTIVE" },
          },
        },
        orderBy: { customer: { displayName: "asc" } },
        take: 100,
        where: { organizationId: access.organizationId, ...scope },
      }),
    );
  }

  async listAvailableCustomers(access: TenantAccessSnapshot) {
    permissionScope(access, "gym.trainees.manage");
    return this.runWithAccess(access, (transaction) =>
      transaction.customer.findMany({
        include: { contacts: { orderBy: { isPrimary: "desc" }, take: 1 } },
        orderBy: { displayName: "asc" },
        take: 100,
        where: {
          gymTraineeProfile: null,
          isArchived: false,
          organizationId: access.organizationId,
        },
      }),
    );
  }

  async getTrainee(access: TenantAccessSnapshot, traineeProfileId: string) {
    const scope = trainerFilter(access, "gym.trainees.read");
    return this.runWithAccess(access, async (transaction) => {
      const trainee = await transaction.gymTraineeProfile.findFirst({
        include: {
          customer: { include: { contacts: { orderBy: { isPrimary: "desc" } } } },
          nutritionPlans: {
            include: { meals: { orderBy: { sortOrder: "asc" } } },
            orderBy: { startsOn: "desc" },
            take: 12,
          },
          progressEntries: { orderBy: { measuredAt: "desc" }, take: 24 },
          trainer: { select: { displayNameAr: true, displayNameEn: true, id: true } },
          workoutLogs: {
            include: { exercise: { select: { nameAr: true, nameEn: true } } },
            orderBy: { performedAt: "desc" },
            take: 50,
          },
          workoutPlans: {
            include: {
              exercises: { orderBy: [{ weekday: "asc" }, { sortOrder: "asc" }] },
            },
            orderBy: { startsOn: "desc" },
            take: 12,
          },
        },
        where: { id: traineeProfileId, organizationId: access.organizationId, ...scope },
      });
      if (!trainee) {
        throw new DomainError({ code: "NOT_FOUND", message: "Gym trainee not found." });
      }
      return trainee;
    });
  }

  async createTrainee(access: TenantAccessSnapshot, input: CreateGymTraineeInput) {
    permissionScope(access, "gym.trainees.manage");
    assertGymTraineeMetrics(input);
    const notes = optionalTrimmed(input.notes);
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid currency." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const customer = await transaction.customer.findFirst({
        select: { id: true },
        where: {
          gymTraineeProfile: null,
          id: input.customerId,
          isArchived: false,
          organizationId: access.organizationId,
        },
      });
      const trainer = input.trainerStaffProfileId
        ? await transaction.staffProfile.findFirst({
            select: { id: true },
            where: {
              id: input.trainerStaffProfileId,
              organizationId: access.organizationId,
            },
          })
        : null;
      if (!customer || (input.trainerStaffProfileId && !trainer)) {
        throw new DomainError({ code: "NOT_FOUND", message: "Customer or trainer not found." });
      }
      const profile = await transaction.gymTraineeProfile.create({
        data: {
          currency,
          customerId: customer.id,
          experienceLevel: input.experienceLevel,
          goal: gymGoal(input.goal),
          heightCm: input.heightCm ?? null,
          monthlyFoodBudgetMinor: input.monthlyFoodBudgetMinor ?? null,
          notes: notes ?? null,
          organizationId: access.organizationId,
          startingWeightKg: input.startingWeightKg ?? null,
          targetWeightKg: input.targetWeightKg ?? null,
          trainerStaffProfileId: trainer?.id ?? null,
        },
      });
      await audit(transaction, access, "GYM_TRAINEE_CREATED", "GymTraineeProfile", profile.id);
      return profile;
    });
  }

  async createWorkoutPlan(
    access: TenantAccessSnapshot,
    input: Readonly<{
      endsOn?: Date | undefined;
      notesAr?: string | undefined;
      notesEn?: string | undefined;
      startsOn: Date;
      traineeProfileId: string;
      titleAr: string;
      titleEn: string;
    }>,
  ) {
    const scope = trainerFilter(access, "gym.plans.manage");
    if (input.endsOn && input.endsOn < input.startsOn) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid plan window." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const trainee = await transaction.gymTraineeProfile.findFirst({
        select: { id: true },
        where: {
          id: input.traineeProfileId,
          organizationId: access.organizationId,
          ...scope,
        },
      });
      if (!trainee) {
        throw new DomainError({ code: "NOT_FOUND", message: "Gym trainee not found." });
      }
      const plan = await transaction.gymWorkoutPlan.create({
        data: {
          endsOn: input.endsOn ?? null,
          notesAr: optionalTrimmed(input.notesAr) ?? null,
          notesEn: optionalTrimmed(input.notesEn) ?? null,
          organizationId: access.organizationId,
          startsOn: input.startsOn,
          traineeProfileId: trainee.id,
          titleAr: trimmed(input.titleAr, "Arabic workout title"),
          titleEn: trimmed(input.titleEn, "English workout title"),
        },
      });
      await audit(transaction, access, "GYM_WORKOUT_PLAN_CREATED", "GymWorkoutPlan", plan.id);
      return plan;
    });
  }

  async addWorkoutExercise(
    access: TenantAccessSnapshot,
    input: Readonly<{
      instructionsAr?: string | undefined;
      instructionsEn?: string | undefined;
      nameAr: string;
      nameEn: string;
      repsMax: number;
      repsMin: number;
      restSeconds: number;
      sets: number;
      sortOrder: number;
      targetWeightKg?: number | undefined;
      weekday: Weekday;
      workoutPlanId: string;
    }>,
  ) {
    const scope = trainerFilter(access, "gym.plans.manage");
    assertExercisePrescription(input);
    return this.runWithAccess(access, async (transaction) => {
      const plan = await transaction.gymWorkoutPlan.findFirst({
        select: { id: true },
        where: {
          id: input.workoutPlanId,
          organizationId: access.organizationId,
          trainee: scope,
        },
      });
      if (!plan) {
        throw new DomainError({ code: "NOT_FOUND", message: "Workout plan not found." });
      }
      const exercise = await transaction.gymWorkoutExercise.create({
        data: {
          instructionsAr: optionalTrimmed(input.instructionsAr) ?? null,
          instructionsEn: optionalTrimmed(input.instructionsEn) ?? null,
          nameAr: trimmed(input.nameAr, "Arabic exercise name"),
          nameEn: trimmed(input.nameEn, "English exercise name"),
          organizationId: access.organizationId,
          repsMax: input.repsMax,
          repsMin: input.repsMin,
          restSeconds: input.restSeconds,
          sets: input.sets,
          sortOrder: input.sortOrder,
          targetWeightKg: input.targetWeightKg ?? null,
          weekday: input.weekday,
          workoutPlanId: plan.id,
        },
      });
      await audit(transaction, access, "GYM_EXERCISE_ADDED", "GymWorkoutExercise", exercise.id);
      return exercise;
    });
  }

  async recordWorkout(
    access: TenantAccessSnapshot,
    input: Readonly<{
      actualReps: number;
      actualSets: number;
      actualWeightKg?: number | undefined;
      notes?: string | undefined;
      perceivedEffort?: number | undefined;
      performedAt: Date;
      workoutExerciseId: string;
    }>,
  ) {
    const scope = trainerFilter(access, "gym.progress.write");
    assertWorkoutPerformance(input);
    return this.runWithAccess(access, async (transaction) => {
      const exercise = await transaction.gymWorkoutExercise.findFirst({
        select: { id: true, workoutPlan: { select: { traineeProfileId: true } } },
        where: {
          id: input.workoutExerciseId,
          organizationId: access.organizationId,
          workoutPlan: { trainee: scope },
        },
      });
      if (!exercise) {
        throw new DomainError({ code: "NOT_FOUND", message: "Workout exercise not found." });
      }
      const log = await transaction.gymWorkoutLog.create({
        data: {
          actualReps: input.actualReps,
          actualSets: input.actualSets,
          actualWeightKg: input.actualWeightKg ?? null,
          notes: optionalTrimmed(input.notes) ?? null,
          organizationId: access.organizationId,
          perceivedEffort: input.perceivedEffort ?? null,
          performedAt: input.performedAt,
          traineeProfileId: exercise.workoutPlan.traineeProfileId,
          workoutExerciseId: exercise.id,
        },
      });
      await audit(transaction, access, "GYM_WORKOUT_RECORDED", "GymWorkoutLog", log.id);
      return log;
    });
  }

  async createNutritionPlan(
    access: TenantAccessSnapshot,
    input: Readonly<{
      carbohydratesGrams: number;
      currency: string;
      dailyBudgetMinor: number;
      dailyCalories: number;
      endsOn?: Date | undefined;
      fatGrams: number;
      goal: GymGoalValue;
      notesAr?: string | undefined;
      notesEn?: string | undefined;
      proteinGrams: number;
      startsOn: Date;
      traineeProfileId: string;
      titleAr: string;
      titleEn: string;
    }>,
  ) {
    const scope = trainerFilter(access, "gym.plans.manage");
    assertNutritionTargets(input);
    if (input.endsOn && input.endsOn < input.startsOn) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid plan window." });
    }
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid currency." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const trainee = await transaction.gymTraineeProfile.findFirst({
        select: { id: true },
        where: {
          id: input.traineeProfileId,
          organizationId: access.organizationId,
          ...scope,
        },
      });
      if (!trainee) {
        throw new DomainError({ code: "NOT_FOUND", message: "Gym trainee not found." });
      }
      const plan = await transaction.gymNutritionPlan.create({
        data: {
          carbohydratesGrams: input.carbohydratesGrams,
          currency,
          dailyBudgetMinor: input.dailyBudgetMinor,
          dailyCalories: input.dailyCalories,
          endsOn: input.endsOn ?? null,
          fatGrams: input.fatGrams,
          goal: gymGoal(input.goal),
          notesAr: optionalTrimmed(input.notesAr) ?? null,
          notesEn: optionalTrimmed(input.notesEn) ?? null,
          organizationId: access.organizationId,
          proteinGrams: input.proteinGrams,
          startsOn: input.startsOn,
          traineeProfileId: trainee.id,
          titleAr: trimmed(input.titleAr, "Arabic nutrition title"),
          titleEn: trimmed(input.titleEn, "English nutrition title"),
        },
      });
      await audit(transaction, access, "GYM_NUTRITION_PLAN_CREATED", "GymNutritionPlan", plan.id);
      return plan;
    });
  }

  async addNutritionMeal(
    access: TenantAccessSnapshot,
    input: Readonly<{
      calories: number;
      carbohydratesGrams: number;
      estimatedCostMinor: number;
      fatGrams: number;
      nameAr: string;
      nameEn: string;
      nutritionPlanId: string;
      proteinGrams: number;
      sortOrder: number;
      timingLabelAr?: string | undefined;
      timingLabelEn?: string | undefined;
    }>,
  ) {
    const scope = trainerFilter(access, "gym.plans.manage");
    if (
      !Number.isInteger(input.estimatedCostMinor) ||
      input.estimatedCostMinor < 0 ||
      !Number.isInteger(input.calories) ||
      input.calories < 0 ||
      !Number.isInteger(input.proteinGrams) ||
      input.proteinGrams < 0 ||
      !Number.isInteger(input.carbohydratesGrams) ||
      input.carbohydratesGrams < 0 ||
      !Number.isInteger(input.fatGrams) ||
      input.fatGrams < 0 ||
      !Number.isInteger(input.sortOrder) ||
      input.sortOrder < 0
    ) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid meal values." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const plan = await transaction.gymNutritionPlan.findFirst({
        select: { id: true },
        where: {
          id: input.nutritionPlanId,
          organizationId: access.organizationId,
          trainee: scope,
        },
      });
      if (!plan) {
        throw new DomainError({ code: "NOT_FOUND", message: "Nutrition plan not found." });
      }
      const meal = await transaction.gymNutritionMeal.create({
        data: {
          calories: input.calories,
          carbohydratesGrams: input.carbohydratesGrams,
          estimatedCostMinor: input.estimatedCostMinor,
          fatGrams: input.fatGrams,
          nameAr: trimmed(input.nameAr, "Arabic meal name"),
          nameEn: trimmed(input.nameEn, "English meal name"),
          nutritionPlanId: plan.id,
          organizationId: access.organizationId,
          proteinGrams: input.proteinGrams,
          sortOrder: input.sortOrder,
          timingLabelAr: optionalTrimmed(input.timingLabelAr, 120) ?? null,
          timingLabelEn: optionalTrimmed(input.timingLabelEn, 120) ?? null,
        },
      });
      await audit(transaction, access, "GYM_NUTRITION_MEAL_ADDED", "GymNutritionMeal", meal.id);
      return meal;
    });
  }

  async recordProgress(
    access: TenantAccessSnapshot,
    input: Readonly<{
      bodyFatPercent?: number | undefined;
      bodyWeightKg: number;
      measuredAt: Date;
      notes?: string | undefined;
      traineeProfileId: string;
      waistCm?: number | undefined;
    }>,
  ) {
    const scope = trainerFilter(access, "gym.progress.write");
    if (
      !Number.isFinite(input.bodyWeightKg) ||
      input.bodyWeightKg < 20 ||
      input.bodyWeightKg > 400 ||
      (input.bodyFatPercent !== undefined &&
        (input.bodyFatPercent < 1 || input.bodyFatPercent > 80)) ||
      (input.waistCm !== undefined && (input.waistCm < 20 || input.waistCm > 300))
    ) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid progress values." });
    }
    return this.runWithAccess(access, async (transaction) => {
      const trainee = await transaction.gymTraineeProfile.findFirst({
        select: { id: true },
        where: {
          id: input.traineeProfileId,
          organizationId: access.organizationId,
          ...scope,
        },
      });
      if (!trainee) {
        throw new DomainError({ code: "NOT_FOUND", message: "Gym trainee not found." });
      }
      const progress = await transaction.gymProgressEntry.create({
        data: {
          bodyFatPercent: input.bodyFatPercent ?? null,
          bodyWeightKg: input.bodyWeightKg,
          measuredAt: input.measuredAt,
          notes: optionalTrimmed(input.notes) ?? null,
          organizationId: access.organizationId,
          traineeProfileId: trainee.id,
          waistCm: input.waistCm ?? null,
        },
      });
      await audit(transaction, access, "GYM_PROGRESS_RECORDED", "GymProgressEntry", progress.id);
      return progress;
    });
  }
}
