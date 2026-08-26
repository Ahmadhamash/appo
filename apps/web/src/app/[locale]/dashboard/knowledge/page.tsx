import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseFiveALabel, phaseFiveAMessages } from "../../../../messages/phase-five-a";
import { aiFoundationRepository, requirePagePermission } from "../../../../server/identity";
import { activateKnowledgeVersionAction, ingestKnowledgeAction } from "../../actions";

export default async function KnowledgePage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/knowledge">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "knowledge.read"),
    searchParams,
  ]);
  const sources = await aiFoundationRepository.listKnowledgeSources(access);
  const canManage = canAccessResource(access, "knowledge.manage");
  const messages = phaseFiveAMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="knowledge-title">
      <div>
        <p className="eyebrow">Phase 5A</p>
        <h1 id="knowledge-title">{messages.knowledge}</h1>
        <p className="muted">{messages.mockNotice}</p>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      {canManage ? (
        <form action={ingestKnowledgeAction} className="panel form-grid">
          <input name="locale" type="hidden" value={locale} />
          <h2 className="form-title">{messages.ingest}</h2>
          <label className="field">
            <span className="field-label">{messages.source}</span>
            <select className="select" defaultValue="" name="sourceId">
              <option value="">{messages.newSource}</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{locale === "ar" ? "اسم المصدر" : "Source name"}</span>
            <input className="input" maxLength={180} minLength={2} name="name" required />
          </label>
          <label className="field">
            <span className="field-label">{messages.title}</span>
            <input className="input" maxLength={220} minLength={2} name="title" required />
          </label>
          <label className="field">
            <span className="field-label">{messages.upload}</span>
            <input
              className="input"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              name="upload"
              type="file"
            />
          </label>
          <label className="field form-title">
            <span className="field-label">{messages.textContent}</span>
            <textarea
              className="input textarea"
              dir="auto"
              maxLength={200000}
              name="textContent"
              rows={8}
            />
          </label>
          <p className="muted form-title">
            {locale === "ar"
              ? "أدخل نصًا أو اختر ملفًا حتى 200 كيلوبايت. تُعزل المقاطع المشبوهة تلقائيًا."
              : "Enter text or choose a file up to 200 KB. Suspicious chunks are quarantined automatically."}
          </p>
          <div className="form-actions">
            <SubmitButton>{messages.ingest}</SubmitButton>
          </div>
        </form>
      ) : null}
      <div className="card-grid">
        {sources.map((source) => (
          <article className="record-card" key={source.id}>
            <div>
              <span className="status">{phaseFiveALabel(locale, source.ingestionStatus)}</span>
              <h2>{source.name}</h2>
              <p className="muted">{source.originalFilename ?? source.sourceType}</p>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{messages.version}</th>
                    <th>{messages.outcome}</th>
                    <th>{locale === "ar" ? "المستندات / المقاطع" : "Documents / chunks"}</th>
                    <th>{messages.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {source.versions.map((version) => (
                    <tr key={version.id}>
                      <td>v{version.versionNumber}</td>
                      <td>
                        <span className={`status status-${version.status.toLowerCase()}`}>
                          {phaseFiveALabel(locale, version.status)}
                        </span>
                      </td>
                      <td>
                        {version._count.documents} / {version._count.chunks}
                      </td>
                      <td>
                        {canManage && source.activeVersionId !== version.id ? (
                          <form action={activateKnowledgeVersionAction}>
                            <input name="locale" type="hidden" value={locale} />
                            <input name="sourceId" type="hidden" value={source.id} />
                            <input name="versionId" type="hidden" value={version.id} />
                            <SubmitButton tone="secondary">
                              {version.status === "DRAFT" ? messages.activate : messages.rollback}
                            </SubmitButton>
                          </form>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        ))}
      </div>
      {sources.length === 0 ? <p className="muted">{messages.noData}</p> : null}
    </section>
  );
}
