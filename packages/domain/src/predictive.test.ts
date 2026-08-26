import { describe, expect, it } from "vitest";

import {
  distributionDrift,
  evaluateBinaryPredictions,
  evaluateForecasts,
  forecastDemand,
  predictNoShow,
  predictiveMinimums,
  rankSafeReflowCandidates,
  rankValidRecommendations,
  suggestStaffing,
  type AttendanceHistoryRow,
} from "./predictive";

function history(count: number, noShows: number): AttendanceHistoryRow[] {
  return Array.from({ length: count }, (_, index) => ({
    appointmentId: `appointment-${index}`,
    customerId: `customer-${index % 8}`,
    leadTimeDays: 5 + (index % 12),
    localDate: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    localHour: 9 + (index % 4),
    localWeekday: index % 5,
    maturedAt: new Date(Date.UTC(2026, 0, 9 + index)).toISOString(),
    outcome: index < noShows ? "NO_SHOW" : "ATTENDED",
    providerId: `provider-${index % 3}`,
    resolvedAt: new Date(Date.UTC(2026, 0, 2 + index)).toISOString(),
    scheduledAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    serviceId: `service-${index % 2}`,
    source: index % 2 ? "STAFF" : "PUBLIC_BOOKING",
  }));
}

describe("Phase 8 deterministic predictive baselines", () => {
  it("publishes the documented no-show evidence and evaluation gates", () => {
    expect(predictiveMinimums.NO_SHOW).toMatchObject({
      attended: 100,
      evaluationNegatives: 10,
      evaluationPositives: 10,
      evaluationRows: 50,
      noShows: 20,
      resolvedAppointments: 200,
    });
  });

  it("refuses sparse no-show data and excludes outcomes resolved after prediction time", () => {
    const result = predictNoShow(history(220, 25), {
      appointmentId: "target",
      customerId: "customer-1",
      leadTimeDays: 10,
      localHour: 10,
      localWeekday: 2,
      predictedAt: new Date(Date.UTC(2026, 0, 20)).toISOString(),
      providerId: "provider-1",
      serviceId: "service-1",
      source: "STAFF",
    });
    expect(result).toMatchObject({ reason: "INSUFFICIENT_SAMPLE", status: "REFUSED" });
  });

  it("is reproducible and explains only allowlisted operational factors", () => {
    const target = {
      appointmentId: "target",
      customerId: "customer-1",
      leadTimeDays: 30,
      localHour: 10,
      localWeekday: 2,
      predictedAt: new Date(Date.UTC(2026, 11, 1)).toISOString(),
      providerId: "provider-1",
      serviceId: "service-1",
      source: "STAFF",
    } as const;
    const first = predictNoShow(history(240, 30), target);
    expect(predictNoShow(history(240, 30), target)).toEqual(first);
    expect(first.status).toBe("GENERATED");
    if (first.status === "GENERATED") {
      expect(first.factors.map(({ code }) => code)).not.toContain("PROTECTED_ATTRIBUTE");
      expect(first.probability).toBeGreaterThanOrEqual(0);
      expect(first.probability).toBeLessThanOrEqual(1);
    }
  });

  it("never lets the target appointment leak into its own historical features", () => {
    const target = {
      appointmentId: "appointment-0",
      customerId: "customer-1",
      leadTimeDays: 30,
      localHour: 10,
      localWeekday: 2,
      predictedAt: new Date(Date.UTC(2026, 11, 1)).toISOString(),
      providerId: "provider-1",
      serviceId: "service-1",
      source: "STAFF",
    } as const;
    const withoutTarget = history(240, 30);
    const withTarget: AttendanceHistoryRow[] = [
      ...withoutTarget,
      {
        appointmentId: target.appointmentId,
        customerId: target.customerId,
        leadTimeDays: target.leadTimeDays,
        localDate: "2026-08-31",
        localHour: target.localHour,
        localWeekday: target.localWeekday,
        maturedAt: new Date(Date.UTC(2026, 8, 8)).toISOString(),
        outcome: "NO_SHOW",
        providerId: target.providerId,
        resolvedAt: new Date(Date.UTC(2026, 8, 1)).toISOString(),
        scheduledAt: new Date(Date.UTC(2026, 7, 31)).toISOString(),
        serviceId: target.serviceId,
        source: target.source,
      },
    ];
    expect(predictNoShow(withTarget, target)).toEqual(predictNoShow(withoutTarget, target));
  });

  it("counts active weeks from branch-local ISO weeks across a calendar-year boundary", () => {
    const localDates = [
      "2024-10-01",
      "2024-10-22",
      "2024-11-12",
      "2024-12-03",
      "2024-12-24",
      "2024-12-31",
      "2025-01-01",
      "2025-01-21",
    ] as const;
    const rows: AttendanceHistoryRow[] = Array.from({ length: 220 }, (_, index) => {
      const localDate = localDates[index % localDates.length] ?? localDates[0];
      const scheduledAt = new Date(`${localDate}T09:00:00Z`);
      return {
        appointmentId: `year-boundary-${index}`,
        customerId: `customer-${index % 8}`,
        leadTimeDays: 7,
        localDate,
        localHour: 12,
        localWeekday: scheduledAt.getUTCDay(),
        maturedAt: new Date(scheduledAt.getTime() + 8 * 86_400_000).toISOString(),
        outcome: index < 25 ? "NO_SHOW" : "ATTENDED",
        providerId: "provider",
        resolvedAt: new Date(scheduledAt.getTime() + 86_400_000).toISOString(),
        scheduledAt: scheduledAt.toISOString(),
        serviceId: "service",
        source: "STAFF",
      };
    });
    expect(
      predictNoShow(rows, {
        appointmentId: "target",
        customerId: "customer",
        leadTimeDays: 7,
        localHour: 12,
        localWeekday: 2,
        predictedAt: "2025-03-01T00:00:00Z",
        providerId: "provider",
        serviceId: "service",
        source: "STAFF",
      }),
    ).toMatchObject({
      reason: "INSUFFICIENT_HISTORY_SPAN",
      required: 8,
      sampleSize: 7,
      status: "REFUSED",
    });
  });

  it("excludes outcomes that were recorded but had not matured at the prediction cutoff", () => {
    const rows = history(240, 30).map((row) => ({
      ...row,
      maturedAt: "2026-12-02T00:00:00.000Z",
      resolvedAt: "2026-08-01T00:00:00.000Z",
    }));
    expect(
      predictNoShow(rows, {
        appointmentId: "target",
        customerId: "customer-1",
        leadTimeDays: 14,
        localHour: 10,
        localWeekday: 2,
        predictedAt: "2026-12-01T00:00:00.000Z",
        providerId: "provider-1",
        serviceId: "service-1",
        source: "STAFF",
      }),
    ).toMatchObject({ reason: "INSUFFICIENT_SAMPLE", sampleSize: 0, status: "REFUSED" });
  });

  it("forecasts seasonality with uncertainty and explicit holiday adjustment", () => {
    const historical = Array.from({ length: 30 }, (_, week) => ({
      branchId: "branch",
      count: week % 2 ? 9 : 7,
      localDate: new Date(Date.UTC(2026, 0, 4 + week * 7)).toISOString().slice(0, 10),
      localHour: 10,
      localWeekday: 0,
      serviceId: "service",
    }));
    const result = forecastDemand(historical, [
      {
        branchId: "branch",
        calendarAdjustment: 0,
        isHoliday: true,
        localDate: "2026-04-05",
        localHour: 10,
        localWeekday: 0,
        serviceId: "service",
      },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]).toMatchObject({ expectedCount: 0, fallbackLevel: "BRANCH_SERVICE" });
      expect(result[0]).toMatchObject({ upperBound: 0 });
    }
  });

  it("applies an explicit special-open adjustment even when the date is not a holiday", () => {
    const historical = Array.from({ length: 30 }, (_, week) => ({
      branchId: "branch",
      count: 10,
      localDate: new Date(Date.UTC(2026, 0, 4 + week * 7)).toISOString().slice(0, 10),
      localHour: 10,
      localWeekday: 0,
      serviceId: "service",
    }));
    const result = forecastDemand(historical, [
      {
        branchId: "branch",
        calendarAdjustment: 1.25,
        isHoliday: false,
        localDate: "2026-09-06",
        localHour: 10,
        localWeekday: 0,
        serviceId: "service",
      },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) expect(result[0]).toMatchObject({ expectedCount: 12.5 });
  });

  it("refuses an unsupported demand leaf instead of returning a confident zero", () => {
    const historical = Array.from({ length: 30 }, (_, week) => ({
      branchId: "branch",
      count: week % 2 ? 9 : 7,
      localDate: new Date(Date.UTC(2026, 0, 4 + week * 7)).toISOString().slice(0, 10),
      localHour: 10,
      localWeekday: 0,
      serviceId: "service",
    }));
    const result = forecastDemand(historical, [
      {
        branchId: "other-branch",
        isHoliday: false,
        localDate: "2026-09-01",
        localHour: 3,
        localWeekday: 2,
        serviceId: "other-service",
      },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) expect(result[0]).toMatchObject({ status: "REFUSED" });
  });

  it("backs sparse demand off only through the documented in-tenant hierarchy", () => {
    const historical = Array.from({ length: 30 }, (_, week) => ({
      branchId: "authorized-branch",
      count: 8,
      localDate: new Date(Date.UTC(2026, 0, 4 + week * 7)).toISOString().slice(0, 10),
      localHour: 10,
      localWeekday: 0,
      serviceId: "established-service",
    }));
    const result = forecastDemand(historical, [
      {
        branchId: "authorized-branch",
        isHoliday: false,
        localDate: "2026-09-06",
        localHour: 10,
        localWeekday: 0,
        serviceId: "new-service",
      },
      {
        branchId: "new-authorized-branch",
        isHoliday: false,
        localDate: "2026-09-06",
        localHour: 10,
        localWeekday: 0,
        serviceId: "new-service",
      },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]).toMatchObject({ fallbackLevel: "BRANCH", status: "GENERATED" });
      expect(result[1]).toMatchObject({ fallbackLevel: "ORGANIZATION", status: "GENERATED" });
    }
  });

  it("sums comparable leaf counts by local date before branch and organization fallback statistics", () => {
    const historical = Array.from({ length: 30 }, (_, week) => {
      const localDate = new Date(Date.UTC(2026, 0, 4 + week * 7)).toISOString().slice(0, 10);
      return [
        {
          branchId: "branch-a",
          count: 4,
          localDate,
          localHour: 10,
          localWeekday: 0,
          serviceId: "service-a",
        },
        {
          branchId: "branch-a",
          count: 6,
          localDate,
          localHour: 10,
          localWeekday: 0,
          serviceId: "service-b",
        },
        {
          branchId: "branch-b",
          count: 5,
          localDate,
          localHour: 10,
          localWeekday: 0,
          serviceId: "service-a",
        },
      ];
    }).flat();
    const result = forecastDemand(historical, [
      {
        branchId: "branch-a",
        isHoliday: false,
        localDate: "2026-09-06",
        localHour: 10,
        localWeekday: 0,
        serviceId: "new-service",
      },
      {
        branchId: "new-branch",
        isHoliday: false,
        localDate: "2026-09-06",
        localHour: 10,
        localWeekday: 0,
        serviceId: "new-service",
      },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]).toMatchObject({
        expectedCount: 10,
        fallbackLevel: "BRANCH",
        sampleWeeks: 30,
        status: "GENERATED",
      });
      expect(result[1]).toMatchObject({
        expectedCount: 15,
        fallbackLevel: "ORGANIZATION",
        sampleWeeks: 30,
        status: "GENERATED",
      });
    }
  });

  it("computes evaluation, drift, staffing, valid recommendations and safe reflow", () => {
    const evaluation = evaluateBinaryPredictions([
      { actual: 1, probability: 0.8 },
      { actual: 0, probability: 0.2 },
    ]);
    expect(evaluation.brierScore).toBeCloseTo(0.04);
    expect(evaluation).toMatchObject({
      areaUnderPrecisionRecall: 1,
      areaUnderRoc: 1,
      precisionAtHalf: 1,
      prevalence: 0.5,
      recallAtHalf: 1,
    });
    const forecastEvaluation = evaluateForecasts([
      { actual: 10, expected: 8, lower: 6, seasonalScale: 4, upper: 12 },
      { actual: 4, expected: 5, lower: 3, seasonalScale: 2, upper: 7 },
    ]);
    expect(forecastEvaluation).toMatchObject({
      intervalCoverage: 1,
      mae: 1.5,
      mase: 0.5,
      signedBias: -0.5,
    });
    expect(forecastEvaluation.meanPinballLoss).toBeCloseTo(0.0625);
    expect(evaluateForecasts([{ actual: 3, expected: 2, lower: 1, upper: 4 }]).mase).toBeNull();
    expect(distributionDrift({ STAFF: 90, WEB: 10 }, { STAFF: 50, WEB: 50 }).status).toBe("ALERT");
    expect(distributionDrift({}, { STAFF: 10 }).status).toBe("INSUFFICIENT");
    expect(
      suggestStaffing(
        [{ durationMinutes: 30, expectedCount: 10, lowerBound: 9, upperBound: 12 }],
        200,
      ).action,
    ).toBe("ADD_CAPACITY");
    expect(
      rankValidRecommendations([
        {
          available: true,
          completedCount: 20,
          continuity: true,
          eligible: true,
          preferenceMatch: true,
          providerId: "provider",
          resourceValid: true,
          serviceId: "service",
          slotStartsAt: "2026-08-30T09:00:00Z",
        },
        {
          available: true,
          completedCount: 100,
          continuity: true,
          eligible: true,
          preferenceMatch: true,
          providerId: "invalid",
          resourceValid: false,
          serviceId: "service",
          slotStartsAt: "2026-08-30T08:00:00Z",
        },
      ]),
    ).toHaveLength(1);
    expect(
      rankSafeReflowCandidates([
        {
          bufferValid: true,
          consentAllowsContact: false,
          customerConstraintValid: true,
          improvementMinutes: 60,
          providerValid: true,
          requiresCustomerConfirmation: true,
          requiresStaffConfirmation: true,
          resourceValid: true,
          slotStartsAt: "2026-08-30T08:00:00Z",
          subjectAppointmentId: "appointment",
        },
      ]),
    ).toHaveLength(0);
  });
});
