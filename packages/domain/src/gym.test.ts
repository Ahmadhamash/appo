import { describe, expect, it } from "vitest";

import {
  assessGymTraineeAttention,
  assertExercisePrescription,
  assertGymAvatarAppearance,
  assertGymTraineeMetrics,
  assertNutritionTargets,
  assertWorkoutPerformance,
} from "./gym";

describe("gym operating rules", () => {
  it("accepts realistic trainee, workout, and nutrition values", () => {
    expect(() =>
      assertGymTraineeMetrics({
        heightCm: 178,
        monthlyFoodBudgetMinor: 180_000,
        startingWeightKg: 91.5,
        targetWeightKg: 82,
      }),
    ).not.toThrow();
    expect(() =>
      assertExercisePrescription({
        repsMax: 12,
        repsMin: 8,
        restSeconds: 90,
        sets: 4,
        targetWeightKg: 60,
      }),
    ).not.toThrow();
    expect(() =>
      assertWorkoutPerformance({
        actualReps: 10,
        actualSets: 4,
        actualWeightKg: 62.5,
        perceivedEffort: 8,
      }),
    ).not.toThrow();
    expect(() =>
      assertNutritionTargets({
        carbohydratesGrams: 230,
        dailyBudgetMinor: 6000,
        dailyCalories: 2200,
        fatGrams: 70,
        proteinGrams: 170,
      }),
    ).not.toThrow();
    expect(() => assertGymAvatarAppearance({ shirtColor: "#d6a63c" })).not.toThrow();
  });

  it("rejects unsafe or internally inconsistent values", () => {
    expect(() => assertGymTraineeMetrics({ startingWeightKg: -2 })).toThrowError(/supported range/);
    expect(() =>
      assertExercisePrescription({ repsMax: 6, repsMin: 12, restSeconds: 90, sets: 4 }),
    ).toThrowError(/prescription/);
    expect(() =>
      assertWorkoutPerformance({ actualReps: 10, actualSets: 4, perceivedEffort: 11 }),
    ).toThrowError(/performance/);
    expect(() =>
      assertNutritionTargets({
        carbohydratesGrams: 200,
        dailyBudgetMinor: 5000,
        dailyCalories: 100,
        fatGrams: 60,
        proteinGrams: 150,
      }),
    ).toThrowError(/nutrition/);
    expect(() => assertGymAvatarAppearance({ shirtColor: "gold" })).toThrowError(/hexadecimal/);
  });

  it("turns authorized workout facts into a deterministic review suggestion without mutation", () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const result = assessGymTraineeAttention(
      {
        hasActiveNutritionPlan: true,
        hasActivePortalAccess: true,
        hasActiveWorkoutPlan: true,
        hasTrainer: true,
        latestMeasurementAt: new Date("2026-08-20T12:00:00.000Z"),
        recentWorkoutLogs: [1, 2, 3].map((day) => ({
          actualReps: 12,
          perceivedEffort: 5,
          performedAt: new Date(`2026-08-2${day}T12:00:00.000Z`),
          prescribedRepsMaximum: 12,
        })),
      },
      now,
    );

    expect(result).toEqual({
      level: "PROGRESSION_REVIEW",
      reasons: ["READY_FOR_PROGRESSION_REVIEW"],
    });
  });

  it("prioritizes incomplete onboarding and stale follow-up evidence", () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    expect(
      assessGymTraineeAttention(
        {
          hasActiveNutritionPlan: false,
          hasActivePortalAccess: false,
          hasActiveWorkoutPlan: false,
          hasTrainer: false,
          recentWorkoutLogs: [],
        },
        now,
      ).level,
    ).toBe("ONBOARDING");
    expect(
      assessGymTraineeAttention(
        {
          hasActiveNutritionPlan: true,
          hasActivePortalAccess: true,
          hasActiveWorkoutPlan: true,
          hasTrainer: true,
          latestMeasurementAt: new Date("2026-08-01T12:00:00.000Z"),
          recentWorkoutLogs: [
            {
              actualReps: 8,
              perceivedEffort: 8,
              performedAt: new Date("2026-08-01T12:00:00.000Z"),
              prescribedRepsMaximum: 12,
            },
          ],
        },
        now,
      ).level,
    ).toBe("FOLLOW_UP");
  });
});
