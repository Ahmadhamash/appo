import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseSevenMessages } from "../../../../messages/phase-seven";
import {
  operationsIntelligenceRepository,
  requirePagePermission,
} from "../../../../server/identity";
import { createExportAction, runReportAction } from "../../phase-seven-actions";

export default async function ReportsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/reports">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "reports.read"),
    searchParams,
  ]);
  const canExport = access.grants.some(({ code }) => code === "exports.manage");
  const [runs, exports] = await Promise.all([
    operationsIntelligenceRepository.listReportRuns(access),
    canExport ? operationsIntelligenceRepository.listExportJobs(access) : [],
  ]);
  const messages = phaseSevenMessages[locale];
  const currentDate = new Date();
  const startDate = new Date(currentDate);
  startDate.setUTCDate(startDate.getUTCDate() - 30);
  const end = currentDate.toISOString().slice(0, 10);
  const start = startDate.toISOString().slice(0, 10);
  return (
    <section className="page-stack" aria-labelledby="reports-title">
      <div>
        <p className="eyebrow">Phase 7</p>
        <h1 id="reports-title">{messages.reports}</h1>
        <p className="muted">{messages.reportsDescription}</p>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <form action={runReportAction} className="panel form-grid">
        <input name="locale" type="hidden" value={locale} />
        <label className="field-label" htmlFor="startsOn">
          {locale === "ar" ? "من" : "From"}
        </label>
        <input
          className="input"
          defaultValue={start}
          id="startsOn"
          name="startsOn"
          required
          type="date"
        />
        <label className="field-label" htmlFor="endsOn">
          {locale === "ar" ? "إلى" : "Through"}
        </label>
        <input
          className="input"
          defaultValue={end}
          id="endsOn"
          name="endsOn"
          required
          type="date"
        />
        <SubmitButton>{messages.runReport}</SubmitButton>
      </form>
      {canExport ? (
        <form action={createExportAction} className="panel inline-form">
          <input name="locale" type="hidden" value={locale} />
          <label className="field-label" htmlFor="type">
            {messages.exportData}
          </label>
          <select className="select" id="type" name="type">
            <option value="CUSTOMERS">Customers</option>
            <option value="APPOINTMENTS">Appointments</option>
            <option value="AUDIT_LOG">Audit log</option>
            <option value="REPORT">Reports</option>
          </select>
          <SubmitButton>{messages.exportData}</SubmitButton>
        </form>
      ) : null}
      <div className="grid two-column">
        {runs.map((run) => (
          <article className="panel" key={run.id}>
            <h2>{run.metricKey}</h2>
            <p>
              {run.startsAt.toLocaleDateString(locale)}–{run.endsAt.toLocaleDateString(locale)} ·{" "}
              {run.timezone}
            </p>
            <pre className="code-block">{JSON.stringify(run.result, null, 2)}</pre>
            <small>
              v{run.definitionVersion} · {run.dataWatermark.toISOString()}
            </small>
          </article>
        ))}
      </div>
      {canExport ? (
        <div className="panel">
          <h2>{messages.exports}</h2>
          <ul>
            {exports.map((job) => (
              <li key={job.id}>
                <a href={`/api/data-exports/${job.id}`}>
                  {job.type} · {job.createdAt.toLocaleString(locale)}
                </a>{" "}
                — {job.status}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
