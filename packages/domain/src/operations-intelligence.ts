import { DomainError } from "./errors";

export const importKinds = ["CUSTOMERS", "STAFF", "SERVICES", "APPOINTMENTS"] as const;
export const attributionSources = [
  "PUBLIC_BOOKING",
  "WEBSITE_CHATBOT",
  "WHATSAPP_AI",
  "VOICE_AI",
  "STAFF_MANUAL",
  "CAMPAIGN",
  "WAITLIST_CONVERSION",
  "MISSED_CALL_RECOVERY",
] as const;
export const reportMetricKeys = [
  "BOOKINGS",
  "CANCELLATION_RATE",
  "NO_SHOW_RATE",
  "CHANNEL_CONVERSION_RATE",
  "WAITLIST_CONVERSION_RATE",
  "AI_CONTAINMENT_RATE",
  "HUMAN_HANDOFF_RATE",
  "CALL_OUTCOMES",
  "MESSAGE_FAILURE_RATE",
  "SCHEDULE_UTILIZATION_RATE",
  "REVENUE_ESTIMATE",
  "AI_USAGE_AND_COST",
] as const;

export type ImportKind = (typeof importKinds)[number];
export type AttributionSource = (typeof attributionSources)[number];
export type ReportMetricKey = (typeof reportMetricKeys)[number];

export type CsvRecord = Readonly<{ rowNumber: number; values: readonly string[] }>;

const expectedHeaders: Readonly<Record<ImportKind, readonly string[]>> = {
  APPOINTMENTS: [
    "external_key",
    "customer_phone",
    "branch_name",
    "service_name",
    "provider_email",
    "starts_at_local",
    "status",
    "source_detail",
  ],
  CUSTOMERS: ["external_key", "display_name", "phone", "preferred_locale"],
  SERVICES: ["external_key", "name_en", "name_ar", "duration_minutes", "price_minor", "currency"],
  STAFF: ["external_key", "email", "role_key"],
};

export function headersForImport(kind: ImportKind): readonly string[] {
  return expectedHeaders[kind];
}

export function assertCsvHeaders(kind: ImportKind, headers: readonly string[]): void {
  const normalized = headers.map((value, index) =>
    (index === 0 ? value.replace(/^\uFEFF/u, "") : value).trim().toLowerCase(),
  );
  if (JSON.stringify(normalized) !== JSON.stringify(expectedHeaders[kind])) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: `CSV headers must be: ${expectedHeaders[kind].join(",")}.`,
    });
  }
}

export function csvValuesToRecord(
  kind: ImportKind,
  headers: readonly string[],
  row: CsvRecord,
): Readonly<Record<string, string>> {
  assertCsvHeaders(kind, headers);
  if (row.values.length !== headers.length) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "CSV column count is invalid." });
  }
  return Object.fromEntries(headers.map((header, index) => [header, row.values[index] ?? ""]));
}

export async function* parseCsvChunks(
  chunks: AsyncIterable<string>,
  limits: Readonly<{ maxColumns: number; maxRows: number; maxValueLength: number }>,
): AsyncGenerator<CsvRecord> {
  let field = "";
  let inQuotes = false;
  let pendingQuote = false;
  let row: string[] = [];
  let rowNumber = 1;
  let skipNextLf = false;

  const append = (character: string): void => {
    field += character;
    if (field.length > limits.maxValueLength) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "CSV value is too long." });
    }
  };
  const finishField = (): void => {
    row.push(field);
    field = "";
    if (row.length > limits.maxColumns) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "CSV has too many columns." });
    }
  };

  for await (const chunk of chunks) {
    for (const character of chunk) {
      if (skipNextLf) {
        skipNextLf = false;
        if (character === "\n") continue;
      }
      if (inQuotes) {
        if (pendingQuote) {
          if (character === '"') {
            append('"');
            pendingQuote = false;
            continue;
          }
          inQuotes = false;
          pendingQuote = false;
          if (character !== "," && character !== "\n" && character !== "\r") {
            throw new DomainError({
              code: "VALIDATION_FAILED",
              message: "Unexpected character after a quoted CSV value.",
            });
          }
        } else if (character === '"') {
          pendingQuote = true;
          continue;
        } else {
          append(character);
          continue;
        }
      }
      if (character === '"' && field.length === 0) {
        inQuotes = true;
      } else if (character === ",") {
        finishField();
      } else if (character === "\n" || character === "\r") {
        finishField();
        if (row.some((value) => value.length > 0)) {
          if (rowNumber > limits.maxRows) {
            throw new DomainError({ code: "VALIDATION_FAILED", message: "CSV has too many rows." });
          }
          yield { rowNumber, values: row };
          rowNumber += 1;
        }
        row = [];
        skipNextLf = character === "\r";
      } else if (pendingQuote) {
        throw new DomainError({ code: "VALIDATION_FAILED", message: "Unexpected CSV quote." });
      } else {
        append(character);
      }
    }
  }
  if (inQuotes && !pendingQuote) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "CSV quote is not closed." });
  }
  if (field.length > 0 || row.length > 0) {
    finishField();
    if (rowNumber > limits.maxRows) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "CSV has too many rows." });
    }
    yield { rowNumber, values: row };
  }
}

export function spreadsheetSafe(value: string): string {
  return /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
}

export function csvCell(value: string): string {
  const safe = spreadsheetSafe(value.replaceAll("\0", ""));
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function reliableRevenueMinor(
  rows: readonly Readonly<{ priceMinor: number | null; status: string }>[],
): number | null {
  const completed = rows.filter(({ status }) => status === "COMPLETED");
  return completed.length > 0 && completed.every(({ priceMinor }) => priceMinor !== null)
    ? completed.reduce((sum, { priceMinor }) => sum + (priceMinor ?? 0), 0)
    : null;
}
