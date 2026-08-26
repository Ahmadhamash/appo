import { DomainError } from "./errors";
import { localDateTimeToUtc } from "./timezone";

export const weekdays = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

export type WeekdayValue = (typeof weekdays)[number];

export type AvailabilityQuery = Readonly<{
  branchId: string;
  endsOn: string;
  intervalMins?: number | undefined;
  limit?: number | undefined;
  localEndMinute?: number | undefined;
  localStartMinute?: number | undefined;
  providerId?: string | undefined;
  serviceId: string;
  startsOn: string;
}>;

export type RecurringAvailabilityRule = Readonly<{
  effectiveFrom?: string | undefined;
  effectiveUntil?: string | undefined;
  endMinuteLocal: number;
  startMinuteLocal: number;
  weekday: WeekdayValue;
}>;

export type ReservedInterval = Readonly<{ endsAt: Date; startsAt: Date }>;

export type AvailabilityResourceSnapshot = Readonly<{
  id: string;
  reservations: readonly ReservedInterval[];
  rules: readonly RecurringAvailabilityRule[];
}>;

export type AvailabilityProviderSnapshot = Readonly<{
  id: string;
  reservations: readonly ReservedInterval[];
  rules: readonly RecurringAvailabilityRule[];
  timeOff: readonly ReservedInterval[];
}>;

export type AvailabilityRequirementSnapshot = Readonly<{
  groupId: string;
  quantity: number;
  resources: readonly AvailabilityResourceSnapshot[];
}>;

export type AvailabilitySnapshot = Readonly<{
  branchHours: readonly RecurringAvailabilityRule[];
  bufferAfterMins: number;
  bufferBeforeMins: number;
  durationMins: number;
  providers: readonly AvailabilityProviderSnapshot[];
  requirements: readonly AvailabilityRequirementSnapshot[];
  timezone: string;
}>;

export type AvailableSlot = Readonly<{
  endsAt: Date;
  providerId: string;
  resourceIdsByGroup: Readonly<Record<string, readonly string[]>>;
  startsAt: Date;
  startsAtLocal: string;
  timezone: string;
}>;

function parseDate(value: string): Date {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid availability date." });
  }
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  if (date.toISOString().slice(0, 10) !== value) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid availability date." });
  }
  return date;
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function activeRule(rule: RecurringAvailabilityRule, day: string, weekday: WeekdayValue): boolean {
  return (
    rule.weekday === weekday &&
    (!rule.effectiveFrom || rule.effectiveFrom <= day) &&
    (!rule.effectiveUntil || rule.effectiveUntil >= day)
  );
}

function contains(
  rule: RecurringAvailabilityRule,
  day: string,
  weekday: WeekdayValue,
  startsMinute: number,
  endsMinute: number,
): boolean {
  return (
    activeRule(rule, day, weekday) &&
    rule.startMinuteLocal <= startsMinute &&
    rule.endMinuteLocal >= endsMinute
  );
}

export function intervalsOverlap(left: ReservedInterval, right: ReservedInterval): boolean {
  return left.startsAt < right.endsAt && right.startsAt < left.endsAt;
}

function minuteTime(minute: number): string {
  const hour = Math.floor(minute / 60);
  const remainder = minute % 60;
  return `${hour.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

function assertQuery(query: AvailabilityQuery): Readonly<{
  end: Date;
  intervalMins: number;
  limit: number;
  localEndMinute: number;
  localStartMinute: number;
  start: Date;
}> {
  const start = parseDate(query.startsOn);
  const end = parseDate(query.endsOn);
  const dayCount = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const intervalMins = query.intervalMins ?? 15;
  const limit = query.limit ?? 50;
  const localStartMinute = query.localStartMinute ?? 0;
  const localEndMinute = query.localEndMinute ?? 1440;
  if (
    dayCount < 1 ||
    dayCount > 31 ||
    !Number.isInteger(intervalMins) ||
    intervalMins < 5 ||
    intervalMins > 120 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(localStartMinute) ||
    !Number.isInteger(localEndMinute) ||
    localStartMinute < 0 ||
    localStartMinute >= localEndMinute ||
    localEndMinute > 1440
  ) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "The availability range is outside supported bounds.",
    });
  }
  return { end, intervalMins, limit, localEndMinute, localStartMinute, start };
}

export function findAvailableSlots(
  query: AvailabilityQuery,
  snapshot: AvailabilitySnapshot,
): AvailableSlot[] {
  const bounds = assertQuery(query);
  if (snapshot.durationMins <= 0 || snapshot.bufferBeforeMins < 0 || snapshot.bufferAfterMins < 0) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "The service scheduling configuration is invalid.",
    });
  }
  const providers = query.providerId
    ? snapshot.providers.filter(({ id }) => id === query.providerId)
    : snapshot.providers;
  const slots: AvailableSlot[] = [];
  for (
    let cursor = new Date(bounds.start);
    cursor <= bounds.end && slots.length < bounds.limit;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    const day = dateString(cursor);
    const weekday = weekdays[cursor.getUTCDay()] ?? "SUNDAY";
    const hours = snapshot.branchHours.filter((rule) => activeRule(rule, day, weekday));
    for (const branchWindow of hours) {
      const firstMinute = Math.max(
        branchWindow.startMinuteLocal + snapshot.bufferBeforeMins,
        bounds.localStartMinute,
      );
      const lastStart = Math.min(
        branchWindow.endMinuteLocal - snapshot.durationMins - snapshot.bufferAfterMins,
        bounds.localEndMinute - snapshot.durationMins,
      );
      const alignedFirst = Math.ceil(firstMinute / bounds.intervalMins) * bounds.intervalMins;
      for (
        let startMinute = alignedFirst;
        startMinute <= lastStart && slots.length < bounds.limit;
        startMinute += bounds.intervalMins
      ) {
        const startsAtLocal = `${day}T${minuteTime(startMinute)}`;
        let startsAt: Date;
        try {
          startsAt = localDateTimeToUtc(startsAtLocal, snapshot.timezone);
        } catch (error) {
          if (error instanceof DomainError && error.code === "VALIDATION_FAILED") continue;
          throw error;
        }
        const endsAt = new Date(startsAt.getTime() + snapshot.durationMins * 60_000);
        const occupied = {
          endsAt: new Date(endsAt.getTime() + snapshot.bufferAfterMins * 60_000),
          startsAt: new Date(startsAt.getTime() - snapshot.bufferBeforeMins * 60_000),
        };
        for (const provider of providers) {
          const endMinute = startMinute + snapshot.durationMins + snapshot.bufferAfterMins;
          const providerAvailable = provider.rules.some((rule) =>
            contains(rule, day, weekday, startMinute - snapshot.bufferBeforeMins, endMinute),
          );
          if (
            !providerAvailable ||
            provider.timeOff.some((interval) => intervalsOverlap(interval, occupied)) ||
            provider.reservations.some((interval) => intervalsOverlap(interval, occupied))
          ) {
            continue;
          }
          const resourceIdsByGroup: Record<string, readonly string[]> = {};
          let resourcesAvailable = true;
          for (const requirement of snapshot.requirements) {
            const available = requirement.resources.filter((resource) => {
              const followsRules =
                resource.rules.length === 0 ||
                resource.rules.some((rule) =>
                  contains(rule, day, weekday, startMinute - snapshot.bufferBeforeMins, endMinute),
                );
              return (
                followsRules &&
                !resource.reservations.some((interval) => intervalsOverlap(interval, occupied))
              );
            });
            if (available.length < requirement.quantity) {
              resourcesAvailable = false;
              break;
            }
            resourceIdsByGroup[requirement.groupId] = available
              .slice(0, requirement.quantity)
              .map(({ id }) => id);
          }
          if (resourcesAvailable) {
            slots.push({
              endsAt,
              providerId: provider.id,
              resourceIdsByGroup,
              startsAt,
              startsAtLocal,
              timezone: snapshot.timezone,
            });
          }
        }
      }
    }
  }
  return slots.toSorted(
    (left, right) =>
      left.startsAt.getTime() - right.startsAt.getTime() ||
      left.providerId.localeCompare(right.providerId),
  );
}
