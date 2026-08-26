import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { DashboardPageHero } from "../../../../components/dashboard-page-hero";
import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import {
  ownerExportStatusLabel,
  ownerExportTypeLabel,
  ownerReportSourceLabel,
  ownerWorkspaceMessages,
} from "../../../../messages/owner-workspace";
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
  const workspace = ownerWorkspaceMessages[locale];
  const currentDate = new Date();
  const startDate = new Date(currentDate);
  startDate.setUTCDate(startDate.getUTCDate() - 30);
  const end = currentDate.toISOString().slice(0, 10);
  const start = startDate.toISOString().slice(0, 10);
  const latest = runs[0];
  const result = recordValue(latest?.result);
  const bookingRows = arrayRecords(result?.bookings);
  const conversionRows = arrayRecords(result?.conversionsByChannel);
  const totalBookings = bookingRows.reduce(
    (total, row) => total + (numberValue(row.bookings) ?? 0),
    0,
  );
  const cancellationRate = numberValue(result?.cancellationRate);
  const noShowRate = numberValue(result?.noShowRate);
  const utilizationRate = numberValue(result?.scheduleUtilizationRate);
  const waitlistRate = numberValue(result?.waitlistConversionRate);
  const messageFailureRate = numberValue(result?.messageFailureRate);
  const revenueMinor = numberValue(result?.revenueEstimateMinor);
  const ai = recordValue(result?.ai);
  const aiContainmentRate = numberValue(ai?.containmentRate);
  const aiHandoffRate = numberValue(ai?.handoffRate);
  const callCount = Array.isArray(result?.calls) ? result.calls.length : 0;
  const currency = stringValue(result?.currency) === "—" ? "JOD" : stringValue(result?.currency);

  return (
    <section className="page-stack" aria-labelledby="reports-title">
      <DashboardPageHero
        description={workspace.reportDescription}
        eyebrow={workspace.workspace}
        icon="▥"
        title={messages.reports}
        titleId="reports-title"
      />
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />

      <dl className="workspace-metrics">
        <div>
          <span aria-hidden="true">▦</span>
          <dt>{workspace.bookings}</dt>
          <dd>{latest ? totalBookings : "—"}</dd>
        </div>
        <div>
          <span aria-hidden="true">↶</span>
          <dt>{workspace.cancellationRate}</dt>
          <dd>{formatPercent(locale, cancellationRate)}</dd>
        </div>
        <div>
          <span aria-hidden="true">×</span>
          <dt>{workspace.noShowRate}</dt>
          <dd>{formatPercent(locale, noShowRate)}</dd>
        </div>
        <div>
          <span aria-hidden="true">◷</span>
          <dt>{workspace.scheduleUtilization}</dt>
          <dd>{formatPercent(locale, utilizationRate)}</dd>
        </div>
      </dl>

      <div className={`report-control-grid ${canExport ? "" : "report-control-single"}`}>
        <form action={runReportAction} className="panel report-control-card">
          <div className="report-control-heading">
            <span aria-hidden="true">▥</span>
            <div>
              <h2>{workspace.reportPeriod}</h2>
              <p>{workspace.runReportDescription}</p>
            </div>
          </div>
          <div className="date-range-fields">
            <label className="field" htmlFor="startsOn">
              <span className="field-label">{workspace.reportPeriodFrom}</span>
              <input
                className="input"
                defaultValue={start}
                id="startsOn"
                name="startsOn"
                required
                type="date"
              />
            </label>
            <label className="field" htmlFor="endsOn">
              <span className="field-label">{workspace.reportPeriodThrough}</span>
              <input
                className="input"
                defaultValue={end}
                id="endsOn"
                name="endsOn"
                required
                type="date"
              />
            </label>
          </div>
          <SubmitButton>{messages.runReport}</SubmitButton>
        </form>

        {canExport ? (
          <form action={createExportAction} className="panel report-control-card">
            <div className="report-control-heading">
              <span aria-hidden="true">⇩</span>
              <div>
                <h2>{messages.exportData}</h2>
                <p>{workspace.exportDescription}</p>
              </div>
            </div>
            <label className="field" htmlFor="type">
              <span className="field-label">{messages.exportData}</span>
              <select className="select" id="type" name="type">
                <option value="CUSTOMERS">{workspace.customersExport}</option>
                <option value="APPOINTMENTS">{workspace.appointmentsExport}</option>
                <option value="AUDIT_LOG">{workspace.exportAuditLog}</option>
                <option value="REPORT">{workspace.exportReports}</option>
              </select>
            </label>
            <SubmitButton>{messages.exportData}</SubmitButton>
          </form>
        ) : null}
      </div>

      {latest ? (
        <article className="report-overview-card">
          <header className="report-overview-heading">
            <div>
              <p className="eyebrow">{workspace.latestReport}</p>
              <h2>{formatDateRange(locale, latest.startsAt, latest.endsAt)}</h2>
              <p>{latest.timezone}</p>
            </div>
            <div className="report-watermark">
              <span>{workspace.dataFreshness}</span>
              <strong>{formatDateTime(locale, latest.dataWatermark)}</strong>
              <small>v{latest.definitionVersion}</small>
            </div>
          </header>

          <dl className="report-kpi-grid">
            <div>
              <dt>{workspace.revenueEstimate}</dt>
              <dd>{formatMoney(locale, revenueMinor, currency)}</dd>
            </div>
            <div>
              <dt>{workspace.waitlistConversion}</dt>
              <dd>{formatPercent(locale, waitlistRate)}</dd>
            </div>
            <div>
              <dt>{workspace.failedDelivery}</dt>
              <dd>{formatPercent(locale, messageFailureRate)}</dd>
            </div>
            <div>
              <dt>{workspace.aiContainment}</dt>
              <dd>{formatPercent(locale, aiContainmentRate)}</dd>
            </div>
            <div>
              <dt>{workspace.aiHandoff}</dt>
              <dd>{formatPercent(locale, aiHandoffRate)}</dd>
            </div>
            <div>
              <dt>{workspace.callOutcomes}</dt>
              <dd>{callCount}</dd>
            </div>
          </dl>

          <div className="report-detail-grid">
            <section aria-labelledby="booking-segments-title">
              <div className="section-heading compact-section-heading">
                <h3 id="booking-segments-title">{workspace.bookingsBySegment}</h3>
                <span className="section-count">{bookingRows.length}</span>
              </div>
              {bookingRows.length === 0 ? (
                <p className="report-no-data">{workspace.noReportData}</p>
              ) : (
                <ul className="booking-segment-list">
                  {bookingRows.map((row, index) => (
                    <li key={`${stringValue(row.branch)}:${stringValue(row.service)}:${index}`}>
                      <div>
                        <strong>{stringValue(row.service)}</strong>
                        <span>
                          {stringValue(row.branch)} · {stringValue(row.provider)}
                        </span>
                        <small>{ownerReportSourceLabel(locale, stringValue(row.source))}</small>
                      </div>
                      <b>{numberValue(row.bookings) ?? 0}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="channel-conversion-title">
              <div className="section-heading compact-section-heading">
                <h3 id="channel-conversion-title">{workspace.conversionByChannel}</h3>
                <span className="section-count">{conversionRows.length}</span>
              </div>
              {conversionRows.length === 0 ? (
                <p className="report-no-data">{workspace.noReportData}</p>
              ) : (
                <ul className="channel-conversion-list">
                  {conversionRows.map((row, index) => {
                    const rate = numberValue(row.rate);
                    return (
                      <li key={`${stringValue(row.source)}:${index}`}>
                        <div>
                          <strong>{ownerReportSourceLabel(locale, stringValue(row.source))}</strong>
                          <span>
                            {numberValue(row.conversions) ?? 0}/{numberValue(row.touches) ?? 0}
                          </span>
                        </div>
                        <progress max={1} value={rate ?? 0}>
                          {formatPercent(locale, rate)}
                        </progress>
                        <b>{formatPercent(locale, rate)}</b>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </article>
      ) : (
        <div className="empty-state report-empty">
          <span className="empty-state-icon" aria-hidden="true">
            ▥
          </span>
          <p>{workspace.noReportData}</p>
        </div>
      )}

      {canExport ? (
        <section className="panel export-history" aria-labelledby="export-history-title">
          <div className="section-heading compact-section-heading">
            <h2 id="export-history-title">{workspace.exportHistory}</h2>
            <span className="section-count">{exports.length}</span>
          </div>
          {exports.length === 0 ? (
            <p className="muted">{workspace.noExports}</p>
          ) : (
            <ul>
              {exports.map((job) => (
                <li key={job.id}>
                  <span aria-hidden="true">⇩</span>
                  <div>
                    <strong>{ownerExportTypeLabel(locale, job.type)}</strong>
                    <small>{formatDateTime(locale, job.createdAt)}</small>
                  </div>
                  <span className={`status status-${job.status.toLowerCase()}`}>
                    {ownerExportStatusLabel(locale, job.status)}
                  </span>
                  <a className="button button-secondary" href={`/api/data-exports/${job.id}`}>
                    {workspace.download}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </section>
  );
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function arrayRecords(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "—";
}

function formatPercent(locale: "ar" | "en", value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(value);
}

function formatMoney(locale: "ar" | "en", minor: number | null, currency: string): string {
  if (minor === null) return "—";
  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
      currency,
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
      style: "currency",
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function formatDateRange(locale: "ar" | "en", start: Date, end: Date): string {
  const formatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

function formatDateTime(locale: "ar" | "en", date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Amman",
  }).format(date);
}
