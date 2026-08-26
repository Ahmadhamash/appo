import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { phaseFiveALabel, phaseFiveAMessages } from "../../../../messages/phase-five-a";
import { aiFoundationRepository, requirePagePermission } from "../../../../server/identity";

export default async function AIUsagePage({ params }: PageProps<"/[locale]/dashboard/ai-usage">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const access = await requirePagePermission(locale, "reports.read");
  const dashboard = await aiFoundationRepository.usageDashboard(access);
  const messages = phaseFiveAMessages[locale];
  const inputTokens = dashboard.usage.inputTokens ?? 0;
  const outputTokens = dashboard.usage.outputTokens ?? 0;
  const costMicros = dashboard.usage.estimatedCostMicros ?? 0;
  return (
    <section className="page-stack" aria-labelledby="ai-usage-title">
      <div>
        <p className="eyebrow">{messages.currentMonth}</p>
        <h1 id="ai-usage-title">{messages.usage}</h1>
      </div>
      <div className="stats-grid">
        <article className="stat-card">
          <span>{messages.actions}</span>
          <strong>{dashboard.actionCount.toLocaleString(locale)}</strong>
          <small>
            / {dashboard.configuration?.monthlyActionLimit.toLocaleString(locale) ?? "—"}
          </small>
        </article>
        <article className="stat-card">
          <span>{messages.tokens}</span>
          <strong>{(inputTokens + outputTokens).toLocaleString(locale)}</strong>
          <small>
            / {dashboard.configuration?.monthlyTokenLimit.toLocaleString(locale) ?? "—"}
          </small>
        </article>
        <article className="stat-card">
          <span>{messages.cost}</span>
          <strong>
            {(costMicros / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 4 })}
          </strong>
          <small>USD</small>
        </article>
      </div>
      <section className="panel" aria-labelledby="ai-outcomes-title">
        <h2 id="ai-outcomes-title">{messages.outcome}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{messages.outcome}</th>
                <th>{locale === "ar" ? "العدد" : "Count"}</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.outcomeCounts.map((item) => (
                <tr key={item.outcome}>
                  <td>{phaseFiveALabel(locale, item.outcome)}</td>
                  <td>{item._count._all.toLocaleString(locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
