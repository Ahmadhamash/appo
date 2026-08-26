"use server";

import { GymPortalAccessStatus, Weekday } from "@jormall/db/generated/enums";
import { DomainError } from "@jormall/domain/errors";
import { gymExperienceLevels, gymGoals } from "@jormall/domain/gym";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { gymRepository, requireTenantAccess } from "../../../../server/identity";

const localeSchema = z.enum(["en", "ar"]);
const uuidSchema = z.uuid();
const shortText = z.string().trim().min(2).max(160);
const optionalText = z.string().trim().max(4000).optional();
const optionalNumber = (minimum: number, maximum: number) =>
  z.preprocess(
    (input) => (input === "" || input === null ? undefined : input),
    z.coerce.number().min(minimum).max(maximum).optional(),
  );

function value(formData: FormData, name: string): unknown {
  return formData.get(name);
}

function localeFrom(formData: FormData): "en" | "ar" {
  return localeSchema.catch("en").parse(value(formData, "locale"));
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

function destination(path: string, key: "error" | "notice", code: string): string {
  return `${path}?${key}=${encodeURIComponent(code)}`;
}

function traineePath(locale: string, traineeProfileId: string): string {
  return `/${locale}/dashboard/gym/trainees/${traineeProfileId}`;
}

function dateOnly(valueToParse: string): Date {
  return new Date(`${valueToParse}T00:00:00.000Z`);
}

export async function createGymTraineeAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      currency: z.string().trim().toUpperCase().length(3),
      customerId: uuidSchema,
      experienceLevel: z.enum(gymExperienceLevels),
      goal: z.enum(gymGoals),
      heightCm: optionalNumber(80, 250),
      monthlyFoodBudgetMinor: optionalNumber(0, 100_000_000),
      notes: optionalText,
      startingWeightKg: optionalNumber(20, 400),
      targetWeightKg: optionalNumber(20, 400),
      trainerStaffProfileId: uuidSchema.optional(),
    })
    .safeParse({
      currency: value(formData, "currency"),
      customerId: value(formData, "customerId"),
      experienceLevel: value(formData, "experienceLevel"),
      goal: value(formData, "goal"),
      heightCm: value(formData, "heightCm"),
      monthlyFoodBudgetMinor: value(formData, "monthlyFoodBudgetMinor"),
      notes: value(formData, "notes") || undefined,
      startingWeightKg: value(formData, "startingWeightKg"),
      targetWeightKg: value(formData, "targetWeightKg"),
      trainerStaffProfileId: value(formData, "trainerStaffProfileId") || undefined,
    });
  const path = `/${locale}/dashboard/gym/trainees`;
  if (!parsed.success) redirect(destination(path, "error", "VALIDATION_FAILED"));
  let traineeProfileId: string;
  try {
    const profile = await gymRepository.createTrainee(
      await requireTenantAccess(locale),
      parsed.data,
    );
    traineeProfileId = profile.id;
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(traineePath(locale, traineeProfileId), "notice", "GYM_TRAINEE_CREATED"));
}

export async function createWorkoutPlanAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      endsOn: z.iso.date().optional(),
      notesAr: optionalText,
      notesEn: optionalText,
      startsOn: z.iso.date(),
      traineeProfileId: uuidSchema,
      titleAr: shortText,
      titleEn: shortText,
    })
    .safeParse({
      endsOn: value(formData, "endsOn") || undefined,
      notesAr: value(formData, "notesAr") || undefined,
      notesEn: value(formData, "notesEn") || undefined,
      startsOn: value(formData, "startsOn"),
      traineeProfileId: value(formData, "traineeProfileId"),
      titleAr: value(formData, "titleAr"),
      titleEn: value(formData, "titleEn"),
    });
  const fallback = `/${locale}/dashboard/gym/trainees`;
  if (!parsed.success) redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  const path = traineePath(locale, parsed.data.traineeProfileId);
  try {
    await gymRepository.createWorkoutPlan(await requireTenantAccess(locale), {
      ...parsed.data,
      endsOn: parsed.data.endsOn ? dateOnly(parsed.data.endsOn) : undefined,
      startsOn: dateOnly(parsed.data.startsOn),
    });
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_WORKOUT_PLAN_CREATED"));
}

export async function addWorkoutExerciseAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      instructionsAr: optionalText,
      instructionsEn: optionalText,
      nameAr: shortText,
      nameEn: shortText,
      repsMax: z.coerce.number().int().min(1).max(200),
      repsMin: z.coerce.number().int().min(1).max(200),
      restSeconds: z.coerce.number().int().min(0).max(3600),
      sets: z.coerce.number().int().min(1).max(20),
      sortOrder: z.coerce.number().int().min(0).max(1000),
      targetWeightKg: optionalNumber(0, 1000),
      traineeProfileId: uuidSchema,
      weekday: z.enum(Weekday),
      workoutPlanId: uuidSchema,
    })
    .safeParse({
      instructionsAr: value(formData, "instructionsAr") || undefined,
      instructionsEn: value(formData, "instructionsEn") || undefined,
      nameAr: value(formData, "nameAr"),
      nameEn: value(formData, "nameEn"),
      repsMax: value(formData, "repsMax"),
      repsMin: value(formData, "repsMin"),
      restSeconds: value(formData, "restSeconds"),
      sets: value(formData, "sets"),
      sortOrder: value(formData, "sortOrder"),
      targetWeightKg: value(formData, "targetWeightKg"),
      traineeProfileId: value(formData, "traineeProfileId"),
      weekday: value(formData, "weekday"),
      workoutPlanId: value(formData, "workoutPlanId"),
    });
  const fallback = `/${locale}/dashboard/gym/trainees`;
  if (!parsed.success) redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  const path = traineePath(locale, parsed.data.traineeProfileId);
  const input = {
    instructionsAr: parsed.data.instructionsAr,
    instructionsEn: parsed.data.instructionsEn,
    nameAr: parsed.data.nameAr,
    nameEn: parsed.data.nameEn,
    repsMax: parsed.data.repsMax,
    repsMin: parsed.data.repsMin,
    restSeconds: parsed.data.restSeconds,
    sets: parsed.data.sets,
    sortOrder: parsed.data.sortOrder,
    targetWeightKg: parsed.data.targetWeightKg,
    weekday: parsed.data.weekday,
    workoutPlanId: parsed.data.workoutPlanId,
  };
  try {
    await gymRepository.addWorkoutExercise(await requireTenantAccess(locale), input);
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_EXERCISE_ADDED"));
}

export async function recordWorkoutAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      actualReps: z.coerce.number().int().min(1).max(500),
      actualSets: z.coerce.number().int().min(1).max(30),
      actualWeightKg: optionalNumber(0, 1000),
      notes: optionalText,
      perceivedEffort: optionalNumber(1, 10),
      traineeProfileId: uuidSchema,
      workoutExerciseId: uuidSchema,
    })
    .safeParse({
      actualReps: value(formData, "actualReps"),
      actualSets: value(formData, "actualSets"),
      actualWeightKg: value(formData, "actualWeightKg"),
      notes: value(formData, "notes") || undefined,
      perceivedEffort: value(formData, "perceivedEffort"),
      traineeProfileId: value(formData, "traineeProfileId"),
      workoutExerciseId: value(formData, "workoutExerciseId"),
    });
  const fallback = `/${locale}/dashboard/gym/trainees`;
  if (!parsed.success) redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  const path = traineePath(locale, parsed.data.traineeProfileId);
  const input = {
    actualReps: parsed.data.actualReps,
    actualSets: parsed.data.actualSets,
    actualWeightKg: parsed.data.actualWeightKg,
    notes: parsed.data.notes,
    perceivedEffort: parsed.data.perceivedEffort,
    workoutExerciseId: parsed.data.workoutExerciseId,
  };
  try {
    await gymRepository.recordWorkout(await requireTenantAccess(locale), {
      ...input,
      performedAt: new Date(),
    });
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_WORKOUT_RECORDED"));
}

export async function createNutritionPlanAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      carbohydratesGrams: z.coerce.number().int().min(0).max(2000),
      currency: z.string().trim().toUpperCase().length(3),
      dailyBudgetMinor: z.coerce.number().int().min(0).max(10_000_000),
      dailyCalories: z.coerce.number().int().min(500).max(10_000),
      endsOn: z.iso.date().optional(),
      fatGrams: z.coerce.number().int().min(0).max(1000),
      goal: z.enum(gymGoals),
      notesAr: optionalText,
      notesEn: optionalText,
      proteinGrams: z.coerce.number().int().min(0).max(1000),
      startsOn: z.iso.date(),
      traineeProfileId: uuidSchema,
      titleAr: shortText,
      titleEn: shortText,
    })
    .safeParse({
      carbohydratesGrams: value(formData, "carbohydratesGrams"),
      currency: value(formData, "currency"),
      dailyBudgetMinor: value(formData, "dailyBudgetMinor"),
      dailyCalories: value(formData, "dailyCalories"),
      endsOn: value(formData, "endsOn") || undefined,
      fatGrams: value(formData, "fatGrams"),
      goal: value(formData, "goal"),
      notesAr: value(formData, "notesAr") || undefined,
      notesEn: value(formData, "notesEn") || undefined,
      proteinGrams: value(formData, "proteinGrams"),
      startsOn: value(formData, "startsOn"),
      traineeProfileId: value(formData, "traineeProfileId"),
      titleAr: value(formData, "titleAr"),
      titleEn: value(formData, "titleEn"),
    });
  const fallback = `/${locale}/dashboard/gym/trainees`;
  if (!parsed.success) redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  const path = traineePath(locale, parsed.data.traineeProfileId);
  try {
    await gymRepository.createNutritionPlan(await requireTenantAccess(locale), {
      ...parsed.data,
      endsOn: parsed.data.endsOn ? dateOnly(parsed.data.endsOn) : undefined,
      startsOn: dateOnly(parsed.data.startsOn),
    });
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_NUTRITION_PLAN_CREATED"));
}

export async function addNutritionMealAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      calories: z.coerce.number().int().min(0).max(10_000),
      carbohydratesGrams: z.coerce.number().int().min(0).max(2000),
      estimatedCostMinor: z.coerce.number().int().min(0).max(10_000_000),
      fatGrams: z.coerce.number().int().min(0).max(1000),
      nameAr: shortText,
      nameEn: shortText,
      nutritionPlanId: uuidSchema,
      proteinGrams: z.coerce.number().int().min(0).max(1000),
      sortOrder: z.coerce.number().int().min(0).max(1000),
      timingLabelAr: z.string().trim().max(120).optional(),
      timingLabelEn: z.string().trim().max(120).optional(),
      traineeProfileId: uuidSchema,
    })
    .safeParse({
      calories: value(formData, "calories"),
      carbohydratesGrams: value(formData, "carbohydratesGrams"),
      estimatedCostMinor: value(formData, "estimatedCostMinor"),
      fatGrams: value(formData, "fatGrams"),
      nameAr: value(formData, "nameAr"),
      nameEn: value(formData, "nameEn"),
      nutritionPlanId: value(formData, "nutritionPlanId"),
      proteinGrams: value(formData, "proteinGrams"),
      sortOrder: value(formData, "sortOrder"),
      timingLabelAr: value(formData, "timingLabelAr") || undefined,
      timingLabelEn: value(formData, "timingLabelEn") || undefined,
      traineeProfileId: value(formData, "traineeProfileId"),
    });
  const fallback = `/${locale}/dashboard/gym/trainees`;
  if (!parsed.success) redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  const path = traineePath(locale, parsed.data.traineeProfileId);
  const input = {
    calories: parsed.data.calories,
    carbohydratesGrams: parsed.data.carbohydratesGrams,
    estimatedCostMinor: parsed.data.estimatedCostMinor,
    fatGrams: parsed.data.fatGrams,
    nameAr: parsed.data.nameAr,
    nameEn: parsed.data.nameEn,
    nutritionPlanId: parsed.data.nutritionPlanId,
    proteinGrams: parsed.data.proteinGrams,
    sortOrder: parsed.data.sortOrder,
    timingLabelAr: parsed.data.timingLabelAr,
    timingLabelEn: parsed.data.timingLabelEn,
  };
  try {
    await gymRepository.addNutritionMeal(await requireTenantAccess(locale), input);
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_NUTRITION_MEAL_ADDED"));
}

export async function recordGymProgressAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      bodyFatPercent: optionalNumber(1, 80),
      bodyWeightKg: z.coerce.number().min(20).max(400),
      notes: optionalText,
      traineeProfileId: uuidSchema,
      waistCm: optionalNumber(20, 300),
    })
    .safeParse({
      bodyFatPercent: value(formData, "bodyFatPercent"),
      bodyWeightKg: value(formData, "bodyWeightKg"),
      notes: value(formData, "notes") || undefined,
      traineeProfileId: value(formData, "traineeProfileId"),
      waistCm: value(formData, "waistCm"),
    });
  const fallback = `/${locale}/dashboard/gym/trainees`;
  if (!parsed.success) redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  const path = traineePath(locale, parsed.data.traineeProfileId);
  try {
    await gymRepository.recordProgress(await requireTenantAccess(locale), {
      ...parsed.data,
      measuredAt: new Date(),
    });
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_PROGRESS_RECORDED"));
}

export type GymPortalInvitationState = Readonly<{
  error?: string;
  invitationUrl?: string;
}>;

export async function createGymPortalInvitationAction(
  _previousState: GymPortalInvitationState,
  formData: FormData,
): Promise<GymPortalInvitationState> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({ email: z.email().trim().toLowerCase(), traineeProfileId: uuidSchema })
    .safeParse({
      email: value(formData, "email"),
      traineeProfileId: value(formData, "traineeProfileId"),
    });
  if (!parsed.success) return { error: "VALIDATION_FAILED" };
  try {
    const token = await gymRepository.createPortalInvitation(
      await requireTenantAccess(locale),
      parsed.data,
    );
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) return { error: "INTERNAL_ERROR" };
    revalidatePath(traineePath(locale, parsed.data.traineeProfileId));
    return { invitationUrl: `${appUrl}/${locale}/trainee-invitations/${token}` };
  } catch (error) {
    return { error: errorCode(error) };
  }
}

export async function setGymPortalAccessStatusAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({ status: z.enum(GymPortalAccessStatus), traineeProfileId: uuidSchema })
    .safeParse({
      status: value(formData, "status"),
      traineeProfileId: value(formData, "traineeProfileId"),
    });
  const fallback = `/${locale}/dashboard/gym/trainees`;
  if (!parsed.success) redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  const path = traineePath(locale, parsed.data.traineeProfileId);
  try {
    await gymRepository.setPortalAccessStatus(
      await requireTenantAccess(locale),
      parsed.data.traineeProfileId,
      parsed.data.status,
    );
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_PORTAL_ACCESS_UPDATED"));
}
