import { DomainError } from "./errors";

export const businessSectors = ["GYM", "CLINIC", "BEAUTY_CENTER"] as const;
export type BusinessSectorValue = (typeof businessSectors)[number];

export const gymGoals = ["WEIGHT_LOSS", "MUSCLE_GAIN", "FITNESS", "MAINTENANCE"] as const;
export type GymGoalValue = (typeof gymGoals)[number];

export const gymExperienceLevels = ["BEGINNER", "INTERMEDIATE", "ADVANCED"] as const;
export type GymExperienceLevelValue = (typeof gymExperienceLevels)[number];

export type GymTraineeMetrics = Readonly<{
  heightCm?: number | undefined;
  monthlyFoodBudgetMinor?: number | undefined;
  startingWeightKg?: number | undefined;
  targetWeightKg?: number | undefined;
}>;

function validateOptionalRange(
  value: number | undefined,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: `${label} is outside the supported range.`,
    });
  }
}

export function assertGymTraineeMetrics(metrics: GymTraineeMetrics): void {
  validateOptionalRange(metrics.heightCm, 80, 250, "Height");
  validateOptionalRange(metrics.startingWeightKg, 20, 400, "Starting weight");
  validateOptionalRange(metrics.targetWeightKg, 20, 400, "Target weight");
  validateOptionalRange(metrics.monthlyFoodBudgetMinor, 0, 100_000_000, "Food budget");
}

export function assertExercisePrescription(
  input: Readonly<{
    repsMax: number;
    repsMin: number;
    restSeconds: number;
    sets: number;
    targetWeightKg?: number | undefined;
  }>,
): void {
  if (
    !Number.isInteger(input.sets) ||
    input.sets < 1 ||
    input.sets > 20 ||
    !Number.isInteger(input.repsMin) ||
    !Number.isInteger(input.repsMax) ||
    input.repsMin < 1 ||
    input.repsMax > 200 ||
    input.repsMax < input.repsMin ||
    !Number.isInteger(input.restSeconds) ||
    input.restSeconds < 0 ||
    input.restSeconds > 3600
  ) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "The exercise prescription is invalid.",
    });
  }
  validateOptionalRange(input.targetWeightKg, 0, 1000, "Target exercise weight");
}

export function assertWorkoutPerformance(
  input: Readonly<{
    actualReps: number;
    actualSets: number;
    actualWeightKg?: number | undefined;
    perceivedEffort?: number | undefined;
  }>,
): void {
  if (
    !Number.isInteger(input.actualSets) ||
    input.actualSets < 1 ||
    input.actualSets > 30 ||
    !Number.isInteger(input.actualReps) ||
    input.actualReps < 1 ||
    input.actualReps > 500 ||
    (input.perceivedEffort !== undefined &&
      (!Number.isInteger(input.perceivedEffort) ||
        input.perceivedEffort < 1 ||
        input.perceivedEffort > 10))
  ) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "The workout performance values are invalid.",
    });
  }
  validateOptionalRange(input.actualWeightKg, 0, 1000, "Actual exercise weight");
}

export function assertNutritionTargets(
  input: Readonly<{
    carbohydratesGrams: number;
    dailyBudgetMinor: number;
    dailyCalories: number;
    fatGrams: number;
    proteinGrams: number;
  }>,
): void {
  if (
    !Number.isInteger(input.dailyBudgetMinor) ||
    input.dailyBudgetMinor < 0 ||
    input.dailyBudgetMinor > 10_000_000 ||
    !Number.isInteger(input.dailyCalories) ||
    input.dailyCalories < 500 ||
    input.dailyCalories > 10_000 ||
    !Number.isInteger(input.proteinGrams) ||
    input.proteinGrams < 0 ||
    input.proteinGrams > 1000 ||
    !Number.isInteger(input.carbohydratesGrams) ||
    input.carbohydratesGrams < 0 ||
    input.carbohydratesGrams > 2000 ||
    !Number.isInteger(input.fatGrams) ||
    input.fatGrams < 0 ||
    input.fatGrams > 1000
  ) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "The nutrition targets are invalid.",
    });
  }
}
