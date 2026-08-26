import { isSupportedLocale } from "@jormall/contracts/locales";
import { semanticMetricKeys } from "@jormall/domain/copilot";
import { notFound, redirect } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseSixKind, phaseSixMessages } from "../../../../messages/phase-six";
import {
  copilotRepository,
  identityRepository,
  requireTenantAccess,
} from "../../../../server/identity";
import { generateCopilotInsightAction, recordCopilotFeedbackAction } from "../../actions";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function CopilotPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/copilot">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const access = await requireTenantAccess(locale);
  if (!access.grants.some(({ code }) => code === "reports.read")) {
    redirect(`/${locale}/dashboard?error=FORBIDDEN`);
  }
  const query = await searchParams;
  const canReviewCalls =
    access.grants.some(({ code }) => code === "recordings.read") &&
    access.grants.some(({ code }) => code === "conversations.read");
  const [insights, branches, calls] = await Promise.all([
    copilotRepository.listInsights(access),
    identityRepository.listBranches(access),
    canReviewCalls ? copilotRepository.listReviewableCalls(access) : [],
  ]);
  const messages = phaseSixMessages[locale];
  const today = new Date();
  const renderedAt = today.getTime();
  const monthAgo = new Date(today.getTime() - 30 * 86_400_000);
  return (
    <section className="page-stack" aria-labelledby="copilot-title">
      <div>
        <p className="eyebrow">{messages.metrics}</p>
        <h1 id="copilot-title">{messages.copilot}</h1>
        <p className="muted">{messages.knownBoundary}</p>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <div className="copilot-actions-grid">
        {(
          [
            ["DAILY_BRIEFING", messages.dailyBriefing],
            ["SCHEDULE_GAPS", messages.gaps],
            ["WAITLIST_MATCHES", messages.waitlist],
          ] as const
        ).map(([insightType, label]) => (
          <form
            action={generateCopilotInsightAction}
            className="panel page-stack"
            key={insightType}
          >
            <input name="locale" type="hidden" value={locale} />
            <input name="insightType" type="hidden" value={insightType} />
            <h2>{label}</h2>
            <SubmitButton>{messages.generate}</SubmitButton>
          </form>
        ))}
      </div>
      <section className="panel page-stack" aria-labelledby="analytics-title">
        <h2 id="analytics-title">{messages.analytics}</h2>
        <form action={generateCopilotInsightAction} className="form-grid">
          <input name="locale" type="hidden" value={locale} />
          <input name="insightType" type="hidden" value="ANALYTICS" />
          <label className="field">
            <span className="field-label">{locale === "ar" ? "المقياس" : "Metric"}</span>
            <select className="select" name="metric" required>
              {semanticMetricKeys
                .filter((metric) => metric !== "WAITLIST_MATCHES_TOTAL")
                .map((metric) => (
                  <option key={metric} value={metric}>
                    {metric.replaceAll("_", " ")}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{locale === "ar" ? "من تاريخ (UTC)" : "From (UTC)"}</span>
            <input
              className="input"
              defaultValue={isoDate(monthAgo)}
              name="startsOn"
              required
              type="date"
            />
          </label>
          <label className="field">
            <span className="field-label">
              {locale === "ar" ? "إلى تاريخ (UTC)" : "Through (UTC)"}
            </span>
            <input
              className="input"
              defaultValue={isoDate(today)}
              name="endsOn"
              required
              type="date"
            />
          </label>
          <label className="field">
            <span className="field-label">
              {locale === "ar" ? "الفرع (اختياري)" : "Branch (optional)"}
            </span>
            <select className="select" name="branchId">
              <option value="">
                {locale === "ar" ? "كل النطاق المصرح" : "All authorized scope"}
              </option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {locale === "ar" ? branch.nameAr : branch.nameEn}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <SubmitButton>{messages.generate}</SubmitButton>
          </div>
        </form>
      </section>
      {canReviewCalls ? (
        <section className="panel page-stack" aria-labelledby="call-quality-title">
          <h2 id="call-quality-title">{messages.callQuality}</h2>
          {calls.length ? (
            <form action={generateCopilotInsightAction} className="inline-form">
              <input name="locale" type="hidden" value={locale} />
              <input name="insightType" type="hidden" value="CALL_QUALITY" />
              <label className="field">
                <span className="field-label">{locale === "ar" ? "المكالمة" : "Call"}</span>
                <select className="select" name="subjectId" required>
                  {calls.map((call) => (
                    <option key={call.id} value={call.id}>
                      {call.startedAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO")} ·{" "}
                      {call.customer?.displayName ?? call.status}
                    </option>
                  ))}
                </select>
              </label>
              <SubmitButton>{messages.generate}</SubmitButton>
            </form>
          ) : (
            <p className="muted">
              {locale === "ar"
                ? "لا توجد مكالمات مصرح بها للمراجعة."
                : "No authorized calls are available for review."}
            </p>
          )}
        </section>
      ) : null}
      <section className="page-stack" aria-labelledby="insights-title">
        <h2 id="insights-title">
          {locale === "ar" ? "النتائج الموثقة" : "Evidence-linked insights"}
        </h2>
        {insights.length ? (
          insights.map((insight) => (
            <article className="panel copilot-insight" key={insight.id}>
              <div className="split-heading">
                <div>
                  <span className="status">{insight.insightType.replaceAll("_", " ")}</span>
                  {new Date(insight.expiresAt).getTime() <= renderedAt ? (
                    <span className="status status-suspended">
                      {locale === "ar" ? "منتهية" : "Expired"}
                    </span>
                  ) : null}
                  <h3>{insight.title}</h3>
                </div>
                <small>
                  {messages.confidence}: {Math.round(insight.confidence * 100)}%
                </small>
              </div>
              <ul className="copilot-statements">
                {insight.statements.map((statement) => (
                  <li key={statement.projectionItemId}>
                    <span className={`statement-kind kind-${statement.kind.toLowerCase()}`}>
                      {phaseSixKind(locale, statement.kind)}
                    </span>
                    <p>{statement.text}</p>
                    <div className="evidence-links" aria-label={messages.evidence}>
                      {statement.evidenceIds.map((evidenceId) => {
                        const source = insight.evidence.find(({ id }) => id === evidenceId);
                        return source ? (
                          <a href={source.href} key={`${statement.projectionItemId}-${evidenceId}`}>
                            {source.label}
                          </a>
                        ) : null;
                      })}
                    </div>
                  </li>
                ))}
              </ul>
              <details>
                <summary>{messages.modelTrace}</summary>
                <dl className="trace-grid">
                  <div>
                    <dt>{locale === "ar" ? "النموذج" : "Model"}</dt>
                    <dd>{insight.modelIdentifier}</dd>
                  </div>
                  <div>
                    <dt>{locale === "ar" ? "نسخة الموجّه" : "Prompt version"}</dt>
                    <dd>{insight.promptVersion}</dd>
                  </div>
                  <div>
                    <dt>{locale === "ar" ? "نسخ المعرفة" : "Knowledge versions"}</dt>
                    <dd>{insight.knowledgeVersionIds.length}</dd>
                  </div>
                  <div>
                    <dt>{messages.dataWatermark}</dt>
                    <dd>
                      {new Date(insight.dataWatermark).toLocaleString(
                        locale === "ar" ? "ar-JO" : "en-JO",
                      )}
                    </dd>
                  </div>
                </dl>
              </details>
              <form action={recordCopilotFeedbackAction} className="feedback-form">
                <input name="locale" type="hidden" value={locale} />
                <input name="insightId" type="hidden" value={insight.id} />
                <label className="field">
                  <span className="field-label">{messages.feedback}</span>
                  <input
                    className="input"
                    maxLength={500}
                    name="comment"
                    placeholder={locale === "ar" ? "ملاحظة اختيارية" : "Optional note"}
                  />
                </label>
                <div className="row-actions">
                  {(["HELPFUL", "INCORRECT", "UNSAFE", "OUTDATED"] as const).map((feedbackType) => (
                    <SubmitButton
                      key={feedbackType}
                      name="feedbackType"
                      tone="secondary"
                      value={feedbackType}
                    >
                      {feedbackType}
                    </SubmitButton>
                  ))}
                </div>
              </form>
            </article>
          ))
        ) : (
          <p className="muted">{messages.noInsights}</p>
        )}
      </section>
    </section>
  );
}
