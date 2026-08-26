import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { phaseSevenMessages } from "../../../../messages/phase-seven";
import {
  operationsIntelligenceRepository,
  requirePagePermission,
} from "../../../../server/identity";

export default async function AuditPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/audit">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const query = await searchParams;
  const page = Math.max(1, Number(typeof query.page === "string" ? query.page : "1") || 1);
  const access = await requirePagePermission(locale, "audit.read");
  const events = await operationsIntelligenceRepository.listAudit(access, page);
  const messages = phaseSevenMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="audit-title">
      <div>
        <p className="eyebrow">Phase 7</p>
        <h1 id="audit-title">{messages.audit}</h1>
        <p className="muted">{messages.auditDescription}</p>
      </div>
      <div className="panel table-wrap">
        <table>
          <caption>{messages.audit}</caption>
          <thead>
            <tr>
              <th>{locale === "ar" ? "الوقت" : "Time"}</th>
              <th>{locale === "ar" ? "الفاعل" : "Actor"}</th>
              <th>{locale === "ar" ? "الإجراء" : "Action"}</th>
              <th>{locale === "ar" ? "الهدف" : "Target"}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{event.createdAt.toLocaleString(locale)}</td>
                <td>
                  {event.actor?.name ??
                    event.actor?.email ??
                    (locale === "ar" ? "النظام" : "System")}
                </td>
                <td>{event.action}</td>
                <td>{event.targetType ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav aria-label={locale === "ar" ? "صفحات التدقيق" : "Audit pages"}>
        <a href={`?page=${Math.max(1, page - 1)}`}>{locale === "ar" ? "السابق" : "Previous"}</a> ·{" "}
        <a href={`?page=${page + 1}`}>{locale === "ar" ? "التالي" : "Next"}</a>
      </nav>
    </section>
  );
}
