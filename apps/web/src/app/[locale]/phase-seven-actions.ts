"use server";

import { createHash } from "node:crypto";

import { DomainError } from "@jormall/domain/errors";
import {
  assertCsvHeaders,
  csvValuesToRecord,
  importKinds,
  parseCsvChunks,
} from "@jormall/domain/operations-intelligence";
import { redirect } from "next/navigation";
import { z } from "zod";

import { operationsIntelligenceRepository, requireTenantAccess } from "../../server/identity";

const localeSchema = z.enum(["en", "ar"]);
const uuid = z.uuid();
const rowBoundary = z.record(z.string(), z.string());

function value(formData: FormData, name: string): string {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry : "";
}

function destination(locale: string, path: string, key: "error" | "notice", code: string): string {
  return `/${locale}/dashboard/${path}?${key}=${encodeURIComponent(code)}`;
}

function code(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

async function hashFile(file: File): Promise<string> {
  const hash = createHash("sha256");
  const reader = file.stream().getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    hash.update(result.value);
  }
  return hash.digest("hex");
}

async function* decodedChunks(file: File): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = file.stream().getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    yield decoder.decode(result.value, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

export async function dryRunImportAction(formData: FormData): Promise<never> {
  const locale = localeSchema.catch("en").parse(value(formData, "locale"));
  const kind = z.enum(importKinds).safeParse(value(formData, "kind"));
  const idempotencyKey = z.string().min(16).max(160).safeParse(value(formData, "idempotencyKey"));
  const entry = formData.get("file");
  if (
    !kind.success ||
    !idempotencyKey.success ||
    !(entry instanceof File) ||
    entry.size < 1 ||
    entry.size > 5_000_000 ||
    !entry.name.toLowerCase().endsWith(".csv")
  ) {
    redirect(destination(locale, "imports", "error", "VALIDATION_FAILED"));
  }
  let failedBatch:
    Readonly<{ access: Awaited<ReturnType<typeof requireTenantAccess>>; id: string }> | undefined;
  try {
    const access = await requireTenantAccess(locale);
    const batch = await operationsIntelligenceRepository.startImport(access, {
      fileDigest: await hashFile(entry),
      fileName: entry.name,
      idempotencyKey: idempotencyKey.data,
      kind: kind.data,
    });
    failedBatch = { access, id: batch.id };
    if (batch.stageRequired) {
      let headers: readonly string[] | undefined;
      for await (const row of parseCsvChunks(decodedChunks(entry), {
        maxColumns: 16,
        maxRows: 10_001,
        maxValueLength: 2_000,
      })) {
        if (!headers) {
          headers = row.values.map((cell, index) =>
            (index === 0 ? cell.replace(/^\uFEFF/u, "") : cell).trim().toLowerCase(),
          );
          assertCsvHeaders(kind.data, headers);
        } else {
          const record = rowBoundary.parse(csvValuesToRecord(kind.data, headers, row));
          await operationsIntelligenceRepository.stageImportRow(
            access,
            batch.id,
            row.rowNumber,
            record,
          );
        }
      }
      if (!headers) throw new DomainError({ code: "VALIDATION_FAILED", message: "CSV is empty." });
      await operationsIntelligenceRepository.finishDryRun(access, batch.id);
    }
  } catch (error) {
    if (failedBatch)
      await operationsIntelligenceRepository.failImport(failedBatch.access, failedBatch.id);
    redirect(destination(locale, "imports", "error", code(error)));
  }
  redirect(destination(locale, "imports", "notice", "IMPORT_DRY_RUN_READY"));
}

export async function commitImportAction(formData: FormData): Promise<never> {
  const locale = localeSchema.catch("en").parse(value(formData, "locale"));
  const batchId = uuid.safeParse(value(formData, "batchId"));
  if (!batchId.success) redirect(destination(locale, "imports", "error", "VALIDATION_FAILED"));
  try {
    await operationsIntelligenceRepository.commitImport(
      await requireTenantAccess(locale),
      batchId.data,
    );
  } catch (error) {
    redirect(destination(locale, "imports", "error", code(error)));
  }
  redirect(destination(locale, "imports", "notice", "IMPORT_COMMITTED"));
}

export async function rollbackImportAction(formData: FormData): Promise<never> {
  const locale = localeSchema.catch("en").parse(value(formData, "locale"));
  const batchId = uuid.safeParse(value(formData, "batchId"));
  if (!batchId.success) redirect(destination(locale, "imports", "error", "VALIDATION_FAILED"));
  try {
    await operationsIntelligenceRepository.rollbackImport(
      await requireTenantAccess(locale),
      batchId.data,
    );
  } catch (error) {
    redirect(destination(locale, "imports", "error", code(error)));
  }
  redirect(destination(locale, "imports", "notice", "IMPORT_ROLLED_BACK"));
}

export async function createExportAction(formData: FormData): Promise<never> {
  const locale = localeSchema.catch("en").parse(value(formData, "locale"));
  const type = z
    .enum(["CUSTOMERS", "APPOINTMENTS", "AUDIT_LOG", "REPORT"])
    .safeParse(value(formData, "type"));
  if (!type.success) redirect(destination(locale, "reports", "error", "VALIDATION_FAILED"));
  try {
    await operationsIntelligenceRepository.createExportJob(
      await requireTenantAccess(locale),
      type.data,
    );
  } catch (error) {
    redirect(destination(locale, "reports", "error", code(error)));
  }
  redirect(destination(locale, "reports", "notice", "EXPORT_READY"));
}

export async function runReportAction(formData: FormData): Promise<never> {
  const locale = localeSchema.catch("en").parse(value(formData, "locale"));
  const parsed = z
    .object({ endsOn: z.iso.date(), startsOn: z.iso.date() })
    .safeParse({ endsOn: value(formData, "endsOn"), startsOn: value(formData, "startsOn") });
  if (!parsed.success) redirect(destination(locale, "reports", "error", "VALIDATION_FAILED"));
  try {
    await operationsIntelligenceRepository.runOperationalReport(
      await requireTenantAccess(locale),
      parsed.data.startsOn,
      parsed.data.endsOn,
    );
  } catch (error) {
    redirect(destination(locale, "reports", "error", code(error)));
  }
  redirect(destination(locale, "reports", "notice", "REPORT_READY"));
}
