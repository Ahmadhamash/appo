import { randomUUID } from "node:crypto";

import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseSevenMessages } from "../../../../messages/phase-seven";
import {
  operationsIntelligenceRepository,
  requirePagePermission,
} from "../../../../server/identity";
import {
  commitImportAction,
  dryRunImportAction,
  rollbackImportAction,
} from "../../phase-seven-actions";

export default async function ImportsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/imports">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "imports.manage"),
    searchParams,
  ]);
  const batches = await operationsIntelligenceRepository.listImports(access);
  const messages = phaseSevenMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="imports-title">
      <div>
        <p className="eyebrow">Phase 7</p>
        <h1 id="imports-title">{messages.imports}</h1>
        <p className="muted">{messages.importDescription}</p>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <form action={dryRunImportAction} className="panel form-grid">
        <input name="locale" type="hidden" value={locale} />
        <input name="idempotencyKey" type="hidden" value={randomUUID()} />
        <label className="field-label" htmlFor="kind">
          {locale === "ar" ? "نوع البيانات" : "Data type"}
        </label>
        <select className="select" id="kind" name="kind" required>
          <option value="CUSTOMERS">{locale === "ar" ? "العملاء" : "Customers"}</option>
          <option value="STAFF">
            {locale === "ar" ? "الموظفون (دعوات)" : "Staff (invitations)"}
          </option>
          <option value="SERVICES">{locale === "ar" ? "الخدمات" : "Services"}</option>
          <option value="APPOINTMENTS">{locale === "ar" ? "المواعيد" : "Appointments"}</option>
        </select>
        <label className="field-label" htmlFor="file">
          CSV
        </label>
        <input
          accept=".csv,text/csv"
          className="input"
          id="file"
          name="file"
          required
          type="file"
        />
        <p className="muted">
          {locale === "ar"
            ? "الحد 5MB و10,000 صف. يجب أن يكون UTF-8."
            : "Limit: 5 MB and 10,000 rows. UTF-8 is required."}
        </p>
        <SubmitButton>{messages.startDryRun}</SubmitButton>
      </form>
      <div className="panel table-wrap">
        <table>
          <caption>{locale === "ar" ? "دفعات الاستيراد" : "Import batches"}</caption>
          <thead>
            <tr>
              <th>{locale === "ar" ? "الملف" : "File"}</th>
              <th>{locale === "ar" ? "الحالة" : "Status"}</th>
              <th>{locale === "ar" ? "صالح" : "Valid"}</th>
              <th>{locale === "ar" ? "أخطاء/تكرار" : "Errors/duplicates"}</th>
              <th>{locale === "ar" ? "إجراءات" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td>
                  {batch.fileName}
                  <br />
                  <small>{batch.kind}</small>
                </td>
                <td>{batch.status}</td>
                <td>
                  {batch.validRows}/{batch.importedRows}
                </td>
                <td>
                  {batch.invalidRows + batch.failedRows}/{batch.duplicateRows}
                </td>
                <td>
                  <div className="inline-actions">
                    {batch.invalidRows + batch.failedRows + batch.duplicateRows > 0 ? (
                      <a href={`/api/import-errors/${batch.id}`}>{messages.downloadErrors}</a>
                    ) : null}
                    {batch.status === "DRY_RUN_READY" &&
                    batch.invalidRows + batch.duplicateRows === 0 ? (
                      <form action={commitImportAction}>
                        <input name="locale" type="hidden" value={locale} />
                        <input name="batchId" type="hidden" value={batch.id} />
                        <SubmitButton>{messages.commit}</SubmitButton>
                      </form>
                    ) : null}
                    {["COMMITTED", "PARTIAL"].includes(batch.status) ? (
                      <form action={rollbackImportAction}>
                        <input name="locale" type="hidden" value={locale} />
                        <input name="batchId" type="hidden" value={batch.id} />
                        <SubmitButton tone="danger">{messages.rollback}</SubmitButton>
                      </form>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
