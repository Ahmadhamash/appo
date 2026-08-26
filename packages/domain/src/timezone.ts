import { DomainError } from "./errors";

export type LocalDateTimeParts = Readonly<{
  day: number;
  hour: number;
  minute: number;
  month: number;
  year: number;
}>;

function datePartsAt(instant: Date, timezone: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return {
    day: Number(values.day),
    hour: Number(values.hour) === 24 ? 0 : Number(values.hour),
    minute: Number(values.minute),
    month: Number(values.month),
    year: Number(values.year),
  };
}

function timezoneOffsetMilliseconds(instant: Date, timezone: string): number {
  const parts = datePartsAt(instant, timezone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant.getTime()
  );
}

function equalParts(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function parseLocalDateTime(value: string): LocalDateTimeParts {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!matched) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid local date/time." });
  }
  const [, year, month, day, hour, minute] = matched;
  const parsed = {
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    month: Number(month),
    year: Number(year),
  };
  const validation = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute),
  );
  if (
    validation.getUTCFullYear() !== parsed.year ||
    validation.getUTCMonth() !== parsed.month - 1 ||
    validation.getUTCDate() !== parsed.day ||
    parsed.hour > 23 ||
    parsed.minute > 59
  ) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Invalid local date/time." });
  }
  return parsed;
}

export function localDateTimeToUtc(value: string, timezone: string): Date {
  const local = parseLocalDateTime(value);
  const guess = new Date(
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute),
  );
  let instant = new Date(guess.getTime() - timezoneOffsetMilliseconds(guess, timezone));
  instant = new Date(guess.getTime() - timezoneOffsetMilliseconds(instant, timezone));
  if (!equalParts(datePartsAt(instant, timezone), local)) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "The local date/time is invalid in the selected timezone.",
    });
  }
  for (const offset of [-60, 60]) {
    const alternative = new Date(instant.getTime() + offset * 60_000);
    if (equalParts(datePartsAt(alternative, timezone), local)) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "The local date/time is ambiguous in the selected timezone.",
      });
    }
  }
  return instant;
}

export function localDateForInstant(instant: Date, timezone: string): string {
  const parts = datePartsAt(instant, timezone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function localDateTimePartsForInstant(instant: Date, timezone: string): LocalDateTimeParts {
  return datePartsAt(instant, timezone);
}

export function utcRangeForLocalDate(
  localDate: string,
  timezone: string,
): Readonly<{ endsAt: Date; startsAt: Date }> {
  const startParts = parseLocalDateTime(`${localDate}T00:00`);
  const nextUtcDate = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day + 1));
  const nextLocalDate = `${nextUtcDate.getUTCFullYear().toString().padStart(4, "0")}-${(
    nextUtcDate.getUTCMonth() + 1
  )
    .toString()
    .padStart(2, "0")}-${nextUtcDate.getUTCDate().toString().padStart(2, "0")}`;
  return {
    endsAt: localDateTimeToUtc(`${nextLocalDate}T00:00`, timezone),
    startsAt: localDateTimeToUtc(`${localDate}T00:00`, timezone),
  };
}
