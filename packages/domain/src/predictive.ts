import { DomainError } from "./errors";

export const predictiveCapabilities = [
  "NO_SHOW",
  "DEMAND_FORECAST",
  "STAFFING",
  "SCHEDULE_REFLOW",
  "SERVICE_PROVIDER_RECOMMENDATION",
] as const;

export const predictionFeedbackTypes = ["HELPFUL", "INCORRECT", "UNSAFE", "OUTDATED"] as const;

export const predictiveRefusalReasons = [
  "CAPABILITY_DISABLED",
  "INSUFFICIENT_SAMPLE",
  "INSUFFICIENT_POSITIVES",
  "INSUFFICIENT_HISTORY_SPAN",
  "MISSING_SCHEDULE_CONFIGURATION",
  "MODEL_DEGRADED",
  "NO_ELIGIBLE_TARGET",
  "NO_VALID_CANDIDATE",
] as const;

export type PredictiveCapability = (typeof predictiveCapabilities)[number];
export type PredictionFeedbackType = (typeof predictionFeedbackTypes)[number];
export type PredictiveRefusalReason = (typeof predictiveRefusalReasons)[number];

export const predictiveMinimums = {
  DEMAND_FORECAST: { appointments: 200, bucketWeeks: 8, historyDays: 182, nonZeroWeeks: 13 },
  DRIFT: { currentSample: 200, referenceSample: 200 },
  NO_SHOW: {
    activeWeeks: 8,
    attended: 100,
    evaluationNegatives: 10,
    evaluationPositives: 10,
    evaluationRows: 50,
    factorNoShows: 5,
    factorObservations: 50,
    historyDays: 90,
    noShows: 20,
    resolvedAppointments: 200,
  },
} as const;

export const predictiveAlgorithmVersions = {
  DEMAND_FORECAST: "jormall-stat-demand-seasonal-v1",
  NO_SHOW: "jormall-stat-no-show-eb-v1",
  SCHEDULE_REFLOW: "jormall-policy-reflow-validity-v1",
  SERVICE_PROVIDER_RECOMMENDATION: "jormall-policy-recommendation-v1",
  STAFFING: "jormall-policy-staffing-capacity-v1",
} as const satisfies Readonly<Record<PredictiveCapability, string>>;

export type PredictionFactor = Readonly<{
  code: string;
  contribution: number;
  direction: "DECREASES_RISK" | "INCREASES_RISK" | "NEUTRAL";
  sampleSize: number;
  value: number;
}>;

export type AttendanceHistoryRow = Readonly<{
  appointmentId: string;
  customerId: string;
  leadTimeDays: number;
  localDate: string;
  localHour: number;
  localWeekday: number;
  maturedAt: string;
  outcome: "ATTENDED" | "NO_SHOW";
  providerId: string;
  resolvedAt: string;
  scheduledAt: string;
  serviceId: string;
  source: string;
}>;

export type NoShowTarget = Readonly<{
  appointmentId: string;
  customerId: string;
  leadTimeDays: number;
  localHour: number;
  localWeekday: number;
  predictedAt: string;
  providerId: string;
  serviceId: string;
  source: string;
}>;

export type RefusedPrediction = Readonly<{
  reason: PredictiveRefusalReason;
  required: number;
  sampleSize: number;
  status: "REFUSED";
}>;

export type NoShowPrediction = Readonly<{
  baselineProbability: number;
  factors: readonly PredictionFactor[];
  probability: number;
  sampleSize: number;
  status: "GENERATED";
}>;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothedRate(rows: readonly AttendanceHistoryRow[], prior: number): number {
  const positives = rows.filter(({ outcome }) => outcome === "NO_SHOW").length;
  const strength = 8;
  return (positives + prior * strength) / (rows.length + strength);
}

function historySpanDays(rows: readonly AttendanceHistoryRow[]): number {
  if (rows.length < 2) return 0;
  const timestamps = rows.map(({ scheduledAt }) => new Date(scheduledAt).getTime());
  return (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000;
}

function factor(
  code: string,
  value: number,
  baseline: number,
  sampleSize: number,
  weight: number,
): PredictionFactor {
  const contribution = (value - baseline) * weight;
  return {
    code,
    contribution,
    direction:
      Math.abs(contribution) < 0.005
        ? "NEUTRAL"
        : contribution > 0
          ? "INCREASES_RISK"
          : "DECREASES_RISK",
    sampleSize,
    value,
  };
}

export function predictNoShow(
  allHistory: readonly AttendanceHistoryRow[],
  target: NoShowTarget,
): NoShowPrediction | RefusedPrediction {
  const predictionTime = new Date(target.predictedAt).getTime();
  const history = allHistory.filter(
    ({ appointmentId, maturedAt, resolvedAt }) =>
      appointmentId !== target.appointmentId &&
      new Date(maturedAt).getTime() <= predictionTime &&
      new Date(resolvedAt).getTime() < predictionTime,
  );
  if (history.length < predictiveMinimums.NO_SHOW.resolvedAppointments) {
    return {
      reason: "INSUFFICIENT_SAMPLE",
      required: predictiveMinimums.NO_SHOW.resolvedAppointments,
      sampleSize: history.length,
      status: "REFUSED",
    };
  }
  const noShows = history.filter(({ outcome }) => outcome === "NO_SHOW").length;
  if (noShows < predictiveMinimums.NO_SHOW.noShows) {
    return {
      reason: "INSUFFICIENT_POSITIVES",
      required: predictiveMinimums.NO_SHOW.noShows,
      sampleSize: noShows,
      status: "REFUSED",
    };
  }
  const attended = history.length - noShows;
  if (attended < predictiveMinimums.NO_SHOW.attended) {
    return {
      reason: "INSUFFICIENT_SAMPLE",
      required: predictiveMinimums.NO_SHOW.attended,
      sampleSize: attended,
      status: "REFUSED",
    };
  }
  const activeWeeks = new Set(history.map(({ localDate }) => weekKey(localDate))).size;
  if (activeWeeks < predictiveMinimums.NO_SHOW.activeWeeks) {
    return {
      reason: "INSUFFICIENT_HISTORY_SPAN",
      required: predictiveMinimums.NO_SHOW.activeWeeks,
      sampleSize: activeWeeks,
      status: "REFUSED",
    };
  }
  if (historySpanDays(history) < predictiveMinimums.NO_SHOW.historyDays) {
    return {
      reason: "INSUFFICIENT_HISTORY_SPAN",
      required: predictiveMinimums.NO_SHOW.historyDays,
      sampleSize: Math.floor(historySpanDays(history)),
      status: "REFUSED",
    };
  }
  const baseline = smoothedRate(history, noShows / history.length);
  const serviceRows = history.filter(({ serviceId }) => serviceId === target.serviceId);
  const providerRows = history.filter(({ providerId }) => providerId === target.providerId);
  const customerRows = history.filter(({ customerId }) => customerId === target.customerId);
  const timeRows = history.filter(
    ({ localHour, localWeekday }) =>
      localHour === target.localHour && localWeekday === target.localWeekday,
  );
  const sourceRows = history.filter(({ source }) => source === target.source);
  const factorEligible = (rows: readonly AttendanceHistoryRow[]) =>
    rows.length >= predictiveMinimums.NO_SHOW.factorObservations &&
    rows.filter(({ outcome }) => outcome === "NO_SHOW").length >=
      predictiveMinimums.NO_SHOW.factorNoShows;
  const segmentRate = (rows: readonly AttendanceHistoryRow[]) =>
    factorEligible(rows) ? smoothedRate(rows, baseline) : baseline;
  const service = segmentRate(serviceRows);
  const provider = segmentRate(providerRows);
  const customer = segmentRate(customerRows);
  const timeBucket = segmentRate(timeRows);
  const source = segmentRate(sourceRows);
  const leadTimeAdjustment = clamp((target.leadTimeDays - 7) / 180, -0.08, 0.08);
  const probability = clamp(
    baseline * 0.35 +
      service * 0.18 +
      provider * 0.14 +
      customer * 0.13 +
      timeBucket * 0.1 +
      source * 0.1 +
      leadTimeAdjustment,
  );
  return {
    baselineProbability: baseline,
    factors: [
      ...(factorEligible(serviceRows)
        ? [factor("SERVICE_HISTORY", service, baseline, serviceRows.length, 0.18)]
        : []),
      ...(factorEligible(providerRows)
        ? [factor("PROVIDER_HISTORY", provider, baseline, providerRows.length, 0.14)]
        : []),
      ...(factorEligible(customerRows)
        ? [factor("CUSTOMER_HISTORY", customer, baseline, customerRows.length, 0.13)]
        : []),
      ...(factorEligible(timeRows)
        ? [factor("TIME_BUCKET", timeBucket, baseline, timeRows.length, 0.1)]
        : []),
      ...(factorEligible(sourceRows)
        ? [factor("BOOKING_SOURCE", source, baseline, sourceRows.length, 0.1)]
        : []),
      factor("LEAD_TIME", clamp(baseline + leadTimeAdjustment), baseline, history.length, 1),
    ]
      .toSorted((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution))
      .slice(0, 4),
    probability,
    sampleSize: history.length,
    status: "GENERATED",
  };
}

export type DemandHistoryBucket = Readonly<{
  branchId: string;
  count: number;
  localDate: string;
  localHour: number;
  localWeekday: number;
  serviceId: string;
}>;

export type DemandTargetBucket = Readonly<{
  branchId: string;
  calendarAdjustment?: number | undefined;
  isHoliday: boolean;
  localDate: string;
  localHour: number;
  localWeekday: number;
  serviceId: string;
}>;

export type DemandForecast = Readonly<{
  expectedCount: number;
  fallbackLevel: "BRANCH" | "BRANCH_SERVICE" | "ORGANIZATION";
  lowerBound: number;
  sampleWeeks: number;
  status: "GENERATED";
  target: DemandTargetBucket;
  upperBound: number;
}>;

export type DemandBucketRefusal = RefusedPrediction &
  Readonly<{
    target: DemandTargetBucket;
  }>;

function weekKey(localDate: string): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  const isoWeekday = date.getUTCDay() || 7;
  const thursday = new Date(date.getTime() + (4 - isoWeekday) * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((1 + (thursday.getTime() - yearStart.getTime()) / 86_400_000) / 7);
  return `${isoYear}-${String(week).padStart(2, "0")}`;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[], average: number): number {
  return values.length > 1
    ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
    : average;
}

export function forecastDemand(
  history: readonly DemandHistoryBucket[],
  targets: readonly DemandTargetBucket[],
): readonly (DemandBucketRefusal | DemandForecast)[] | RefusedPrediction {
  const totalAppointments = history.reduce((sum, bucket) => sum + bucket.count, 0);
  if (totalAppointments < predictiveMinimums.DEMAND_FORECAST.appointments) {
    return {
      reason: "INSUFFICIENT_SAMPLE",
      required: predictiveMinimums.DEMAND_FORECAST.appointments,
      sampleSize: totalAppointments,
      status: "REFUSED",
    };
  }
  const dates = history.map(({ localDate }) => new Date(`${localDate}T00:00:00Z`).getTime());
  const span = dates.length ? (Math.max(...dates) - Math.min(...dates)) / 86_400_000 : 0;
  if (span < predictiveMinimums.DEMAND_FORECAST.historyDays) {
    return {
      reason: "INSUFFICIENT_HISTORY_SPAN",
      required: predictiveMinimums.DEMAND_FORECAST.historyDays,
      sampleSize: Math.floor(span),
      status: "REFUSED",
    };
  }
  const nonZeroWeeks = new Set(
    history.filter(({ count }) => count > 0).map(({ localDate }) => weekKey(localDate)),
  ).size;
  if (nonZeroWeeks < predictiveMinimums.DEMAND_FORECAST.nonZeroWeeks) {
    return {
      reason: "INSUFFICIENT_SAMPLE",
      required: predictiveMinimums.DEMAND_FORECAST.nonZeroWeeks,
      sampleSize: nonZeroWeeks,
      status: "REFUSED",
    };
  }
  return targets.map((target) => {
    const candidates: readonly Readonly<{
      fallbackLevel: DemandForecast["fallbackLevel"];
      rows: readonly DemandHistoryBucket[];
    }>[] = [
      {
        fallbackLevel: "BRANCH_SERVICE",
        rows: history.filter(
          (row) =>
            row.branchId === target.branchId &&
            row.serviceId === target.serviceId &&
            row.localWeekday === target.localWeekday &&
            row.localHour === target.localHour,
        ),
      },
      {
        fallbackLevel: "BRANCH",
        rows: history.filter(
          (row) =>
            row.branchId === target.branchId &&
            row.localWeekday === target.localWeekday &&
            row.localHour === target.localHour,
        ),
      },
      {
        fallbackLevel: "ORGANIZATION",
        rows: history.filter(
          (row) => row.localWeekday === target.localWeekday && row.localHour === target.localHour,
        ),
      },
    ];
    const selected = candidates.find(
      ({ rows }) =>
        new Set(rows.map(({ localDate }) => weekKey(localDate))).size >=
        predictiveMinimums.DEMAND_FORECAST.bucketWeeks,
    );
    if (!selected) {
      const organizationCandidate = candidates[2];
      return {
        reason: "INSUFFICIENT_SAMPLE" as const,
        required: predictiveMinimums.DEMAND_FORECAST.bucketWeeks,
        sampleSize: organizationCandidate
          ? new Set(organizationCandidate.rows.map(({ localDate }) => weekKey(localDate))).size
          : 0,
        status: "REFUSED" as const,
        target,
      };
    }
    const values =
      selected.fallbackLevel === "BRANCH_SERVICE"
        ? selected.rows.map(({ count }) => count)
        : [
            ...[...selected.rows]
              .toSorted((left, right) => left.localDate.localeCompare(right.localDate))
              .reduce<Map<string, number>>((counts, row) => {
                counts.set(row.localDate, (counts.get(row.localDate) ?? 0) + row.count);
                return counts;
              }, new Map())
              .values(),
          ];
    const average = mean(values);
    if (
      target.calendarAdjustment !== undefined &&
      (target.calendarAdjustment < 0 || target.calendarAdjustment > 2)
    ) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "Calendar adjustments must be between zero and two.",
      });
    }
    const adjustment = target.calendarAdjustment ?? 1;
    const adjusted = Math.max(0, average * adjustment);
    const fallbackUncertainty = selected.fallbackLevel === "BRANCH_SERVICE" ? 1 : 1.35;
    const holidayUncertainty =
      target.isHoliday && target.calendarAdjustment === undefined ? 1.5 : 1;
    const uncertaintyMultiplier = fallbackUncertainty * holidayUncertainty;
    const width =
      1.96 *
      Math.sqrt(Math.max(variance(values, average), average)) *
      uncertaintyMultiplier *
      adjustment;
    return {
      expectedCount: adjusted,
      fallbackLevel: selected.fallbackLevel,
      lowerBound: Math.max(0, adjusted - width),
      sampleWeeks: new Set(selected.rows.map(({ localDate }) => weekKey(localDate))).size,
      status: "GENERATED" as const,
      target,
      upperBound: Math.max(0, adjusted + width),
    };
  });
}

export type BinaryEvaluation = Readonly<{
  areaUnderPrecisionRecall: number | null;
  areaUnderRoc: number | null;
  brierScore: number;
  calibrationError: number;
  logLoss: number;
  precisionAtHalf: number | null;
  prevalence: number;
  recallAtHalf: number | null;
  sampleSize: number;
}>;

function rankAreaUnderRoc(
  rows: readonly Readonly<{ actual: 0 | 1; probability: number }>[],
): number | null {
  const positives = rows.filter(({ actual }) => actual === 1);
  const negatives = rows.filter(({ actual }) => actual === 0);
  if (positives.length === 0 || negatives.length === 0) return null;
  const comparisons = positives.reduce(
    (sum, positive) =>
      sum +
      negatives.reduce(
        (inner, negative) =>
          inner +
          (positive.probability > negative.probability
            ? 1
            : positive.probability === negative.probability
              ? 0.5
              : 0),
        0,
      ),
    0,
  );
  return comparisons / (positives.length * negatives.length);
}

function averagePrecision(
  rows: readonly Readonly<{ actual: 0 | 1; probability: number }>[],
): number | null {
  const positiveCount = rows.filter(({ actual }) => actual === 1).length;
  if (positiveCount === 0) return null;
  let truePositives = 0;
  const precisionAtPositiveRanks = rows
    .toSorted((left, right) => right.probability - left.probability)
    .flatMap(({ actual }, index) => {
      if (actual === 0) return [];
      truePositives += 1;
      return [truePositives / (index + 1)];
    });
  return mean(precisionAtPositiveRanks);
}

export function evaluateBinaryPredictions(
  rows: readonly Readonly<{ actual: 0 | 1; probability: number }>[],
): BinaryEvaluation {
  if (rows.length === 0) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "Evaluation requires observations.",
    });
  }
  const epsilon = 1e-9;
  const predictedPositive = rows.filter(({ probability }) => probability >= 0.5);
  const actualPositive = rows.filter(({ actual }) => actual === 1);
  const truePositive = predictedPositive.filter(({ actual }) => actual === 1).length;
  const bins = Array.from({ length: 5 }, (_, index) => {
    const lower = index / 5;
    const upper = (index + 1) / 5;
    const entries = rows.filter(
      ({ probability }) =>
        probability >= lower && (index === 4 ? probability <= upper : probability < upper),
    );
    return entries.length
      ? Math.abs(
          mean(entries.map(({ probability }) => probability)) -
            mean(entries.map(({ actual }) => actual)),
        ) *
          (entries.length / rows.length)
      : 0;
  });
  return {
    areaUnderPrecisionRecall: averagePrecision(rows),
    areaUnderRoc: rankAreaUnderRoc(rows),
    brierScore: mean(rows.map(({ actual, probability }) => (probability - actual) ** 2)),
    calibrationError: bins.reduce((sum, value) => sum + value, 0),
    logLoss: -mean(
      rows.map(({ actual, probability }) => {
        const safe = clamp(probability, epsilon, 1 - epsilon);
        return actual * Math.log(safe) + (1 - actual) * Math.log(1 - safe);
      }),
    ),
    precisionAtHalf: predictedPositive.length ? truePositive / predictedPositive.length : null,
    prevalence: actualPositive.length / rows.length,
    recallAtHalf: actualPositive.length ? truePositive / actualPositive.length : null,
    sampleSize: rows.length,
  };
}

export type ForecastEvaluation = Readonly<{
  intervalCoverage: number;
  mae: number;
  mase: number | null;
  meanIntervalWidth: number;
  meanPinballLoss: number;
  rmse: number;
  sampleSize: number;
  signedBias: number;
  wape: number | null;
}>;

export type ForecastEvaluationRow = Readonly<{
  actual: number;
  expected: number;
  lower: number;
  seasonalScale?: number | undefined;
  upper: number;
}>;

export function evaluateForecasts(rows: readonly ForecastEvaluationRow[]): ForecastEvaluation {
  if (rows.length === 0) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "Evaluation requires observations.",
    });
  }
  if (
    rows.some(
      ({ seasonalScale }) =>
        seasonalScale !== undefined && (!Number.isFinite(seasonalScale) || seasonalScale <= 0),
    )
  ) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "Seasonal scales must be finite positive values.",
    });
  }
  const absolute = rows.map(({ actual, expected }) => Math.abs(actual - expected));
  const actualTotal = rows.reduce((sum, { actual }) => sum + actual, 0);
  const scaledErrors = rows.flatMap(({ actual, expected, seasonalScale }) =>
    seasonalScale === undefined ? [] : [Math.abs(actual - expected) / seasonalScale],
  );
  const pinball = (actual: number, quantile: number, estimate: number) =>
    actual >= estimate ? quantile * (actual - estimate) : (1 - quantile) * (estimate - actual);
  return {
    intervalCoverage:
      rows.filter(({ actual, lower, upper }) => actual >= lower && actual <= upper).length /
      rows.length,
    mae: mean(absolute),
    mase: scaledErrors.length === rows.length ? mean(scaledErrors) : null,
    meanIntervalWidth: mean(rows.map(({ lower, upper }) => Math.max(0, upper - lower))),
    meanPinballLoss: mean(
      rows.map(
        ({ actual, lower, upper }) =>
          (pinball(actual, 0.025, lower) + pinball(actual, 0.975, upper)) / 2,
      ),
    ),
    rmse: Math.sqrt(mean(rows.map(({ actual, expected }) => (actual - expected) ** 2))),
    sampleSize: rows.length,
    signedBias: mean(rows.map(({ actual, expected }) => expected - actual)),
    wape: actualTotal > 0 ? absolute.reduce((sum, value) => sum + value, 0) / actualTotal : null,
  };
}

export function distributionDrift(
  baseline: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): Readonly<{ score: number; status: "ALERT" | "INSUFFICIENT" | "STABLE" | "WATCH" }> {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const baselineTotal = Object.values(baseline).reduce((sum, value) => sum + value, 0);
  const currentTotal = Object.values(current).reduce((sum, value) => sum + value, 0);
  if (baselineTotal === 0 || currentTotal === 0) return { score: 0, status: "INSUFFICIENT" };
  const score =
    [...keys].reduce(
      (sum, key) =>
        sum + Math.abs((baseline[key] ?? 0) / baselineTotal - (current[key] ?? 0) / currentTotal),
      0,
    ) / 2;
  return { score, status: score >= 0.25 ? "ALERT" : score >= 0.1 ? "WATCH" : "STABLE" };
}

export type StaffingSuggestion = Readonly<{
  action: "ADD_CAPACITY" | "BALANCED" | "REVIEW_EXCESS_CAPACITY";
  availableMinutes: number;
  expectedLoadMinutes: number;
  lowerLoadMinutes: number;
  upperLoadMinutes: number;
}>;

export function suggestStaffing(
  forecasts: readonly Readonly<{
    durationMinutes: number;
    expectedCount: number;
    lowerBound: number;
    upperBound: number;
  }>[],
  availableMinutes: number,
): StaffingSuggestion {
  const expectedLoadMinutes = forecasts.reduce(
    (sum, forecast) => sum + forecast.expectedCount * forecast.durationMinutes,
    0,
  );
  const lowerLoadMinutes = forecasts.reduce(
    (sum, forecast) => sum + forecast.lowerBound * forecast.durationMinutes,
    0,
  );
  const upperLoadMinutes = forecasts.reduce(
    (sum, forecast) => sum + forecast.upperBound * forecast.durationMinutes,
    0,
  );
  return {
    action:
      lowerLoadMinutes > availableMinutes
        ? "ADD_CAPACITY"
        : upperLoadMinutes < availableMinutes * 0.6
          ? "REVIEW_EXCESS_CAPACITY"
          : "BALANCED",
    availableMinutes,
    expectedLoadMinutes,
    lowerLoadMinutes,
    upperLoadMinutes,
  };
}

export type ValidRecommendationCandidate = Readonly<{
  available: boolean;
  completedCount: number;
  continuity: boolean;
  eligible: boolean;
  preferenceMatch: boolean;
  providerId: string;
  resourceValid: boolean;
  serviceId: string;
  slotStartsAt: string;
}>;

export function rankValidRecommendations(
  candidates: readonly ValidRecommendationCandidate[],
): readonly Readonly<ValidRecommendationCandidate & { score: number }>[] {
  return candidates
    .filter(({ available, eligible, resourceValid }) => available && eligible && resourceValid)
    .map((candidate) => ({
      ...candidate,
      score:
        (candidate.preferenceMatch ? 0.35 : 0) +
        (candidate.continuity ? 0.25 : 0) +
        Math.min(candidate.completedCount / 100, 0.4),
    }))
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        left.slotStartsAt.localeCompare(right.slotStartsAt) ||
        left.providerId.localeCompare(right.providerId),
    );
}

export type ReflowCandidate = Readonly<{
  bufferValid: boolean;
  consentAllowsContact: boolean;
  customerConstraintValid: boolean;
  improvementMinutes: number;
  providerValid: boolean;
  requiresCustomerConfirmation: true;
  requiresStaffConfirmation: true;
  resourceValid: boolean;
  slotStartsAt: string;
  subjectAppointmentId: string;
}>;

export function rankSafeReflowCandidates(
  candidates: readonly ReflowCandidate[],
): readonly ReflowCandidate[] {
  return candidates
    .filter(
      ({
        bufferValid,
        consentAllowsContact,
        customerConstraintValid,
        providerValid,
        resourceValid,
      }) =>
        bufferValid &&
        consentAllowsContact &&
        customerConstraintValid &&
        providerValid &&
        resourceValid,
    )
    .toSorted(
      (left, right) =>
        right.improvementMinutes - left.improvementMinutes ||
        left.slotStartsAt.localeCompare(right.slotStartsAt),
    );
}
