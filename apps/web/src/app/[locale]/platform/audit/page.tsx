import { isSupportedLocale } from "@jormall/contracts/locales";
import Link from "next/link";
import { notFound } from "next/navigation";

import { operationsIntelligenceRepository } from "../../../../server/identity";
import { requireSession } from "../../../../server/session";

export default async function PlatformAuditPage({
  params,
  searchParams,
}: PageProps<"/[locale]/platform/audit">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [session, query] = await Promise.all([requireSession(locale), searchParams]);
  const reason = typeof query.reason === "string" ? query.reason.trim() : "";
  const page = Math.max(1, Number(typeof query.page === "string" ? query.page : "1") || 1);
  const [events, aggregates] = reason
    ? await Promise.all([
        operationsIntelligenceRepository.listPlatformAudit(session.user.id, reason, page),
        operationsIntelligenceRepository.getPlatformAggregates(session.user.id, reason),
      ])
    : [[], null];
  return (
    <div className="platform-shell">
      <header className="app-header">
        <Link className="brand" href={`/${locale}/platform/organizations`}>
          JorMall Admin
        </Link>
      </header>
      <main className="main-content wide-content">
        <section className="page-stack" aria-labelledby="platform-audit-title">
          <div>
            <p className="eyebrow">JorMall</p>
            <h1 id="platform-audit-title">
              {locale === "ar" ? "سجل تدقيق المنصة" : "Platform audit log"}
            </h1>
            <p className="muted">
              {locale === "ar"
                ? "الوصول الشامل يتطلب سبباً ويُسجّل كحدث منصة غير قابل للتعديل."
                : "Platform-wide access requires a reason and creates an immutable platform event."}
            </p>
          </div>
          <form className="panel inline-form" method="get">
            <label className="field-label" htmlFor="reason">
              {locale === "ar" ? "سبب الوصول" : "Access reason"}
            </label>
            <input
              className="input"
              defaultValue={reason}
              id="reason"
              maxLength={500}
              minLength={5}
              name="reason"
              required
            />
            <button className="button" type="submit">
              {locale === "ar" ? "عرض" : "View"}
            </button>
          </form>
          {aggregates ? (
            <div className="grid metrics-grid">
              <article className="panel">
                <strong>{aggregates.appointments}</strong>
                <span>{locale === "ar" ? "إجمالي المواعيد" : "Lifetime appointments"}</span>
              </article>
              <article className="panel">
                <strong>{aggregates.handoffs}</strong>
                <span>{locale === "ar" ? "التحويلات البشرية" : "Human handoffs"}</span>
              </article>
              <article className="panel">
                <strong>{aggregates.usage.estimatedCostMicros ?? 0}</strong>
                <span>
                  {locale === "ar" ? "تكلفة AI التقديرية (مايكرو)" : "Estimated AI cost (micros)"}
                </span>
              </article>
            </div>
          ) : null}
          {reason ? (
            <div className="panel table-wrap">
              <table>
                <caption>{locale === "ar" ? "كل المؤسسات" : "All organizations"}</caption>
                <thead>
                  <tr>
                    <th>{locale === "ar" ? "المؤسسة" : "Organization"}</th>
                    <th>{locale === "ar" ? "الوقت" : "Time"}</th>
                    <th>{locale === "ar" ? "الإجراء" : "Action"}</th>
                    <th>{locale === "ar" ? "الفاعل" : "Actor"}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td>{event.organization.nameEn}</td>
                      <td>{event.createdAt.toLocaleString(locale)}</td>
                      <td>{event.action}</td>
                      <td>{event.actor?.name ?? event.actor?.email ?? "System"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
