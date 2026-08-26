import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { phaseFiveALabel, phaseFiveAMessages } from "../../../../messages/phase-five-a";
import { aiFoundationRepository, requirePagePermission } from "../../../../server/identity";

export default async function AIActionAuditPage({
  params,
}: PageProps<"/[locale]/dashboard/ai-actions">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const access = await requirePagePermission(locale, "audit.read");
  const actions = await aiFoundationRepository.listAIActionAudit(access);
  const messages = phaseFiveAMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="ai-actions-title">
      <div>
        <p className="eyebrow">Phase 5A</p>
        <h1 id="ai-actions-title">{messages.actionAudit}</h1>
        <p className="muted">
          {locale === "ar"
            ? "المدخلات المعروضة منقّحة من الحقول الحساسة، وكل سجل مرتبط بقرار صلاحية مدقّق."
            : "Displayed inputs are sensitive-field redacted, and every record is bound to an audited authorization decision."}
        </p>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{messages.actions}</th>
              <th>{messages.outcome}</th>
              <th>{messages.model}</th>
              <th>{messages.latency}</th>
              <th>{locale === "ar" ? "تفاصيل منقّحة" : "Redacted detail"}</th>
            </tr>
          </thead>
          <tbody>
            {actions.map((action) => (
              <tr key={action.id}>
                <td>
                  <strong>{action.actionName}</strong>
                  <br />
                  <small>{action.requiredPermission}</small>
                </td>
                <td>
                  <span className="status">{phaseFiveALabel(locale, action.outcome)}</span>
                  {action.errorCode ? <small> · {action.errorCode}</small> : null}
                </td>
                <td>{action.modelIdentifier}</td>
                <td>{action.latencyMs === null ? "—" : `${action.latencyMs} ms`}</td>
                <td>
                  <details>
                    <summary>{locale === "ar" ? "عرض" : "View"}</summary>
                    <pre className="audit-json" dir="ltr">
                      {JSON.stringify(
                        {
                          approval: action.approval?.status,
                          idempotencyKey: action.idempotencyKey,
                          input: action.validatedInput,
                          result: action.result,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {actions.length === 0 ? <p className="muted">{messages.noData}</p> : null}
    </section>
  );
}
