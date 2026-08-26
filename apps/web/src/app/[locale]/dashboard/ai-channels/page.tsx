import { parsePublicApplicationUrl } from "@jormall/config/environment";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { CopyInstallationButton } from "../../../../components/copy-installation-button";
import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseFiveBMessages } from "../../../../messages/phase-five-b";
import { aiChannelRepository, requirePagePermission } from "../../../../server/identity";
import { issueWidgetConfigurationToken } from "../../../../server/widget-capability";
import { createWidgetConfigurationAction } from "../../actions";

export default async function AIChannelsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/ai-channels">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "ai.configure"),
    searchParams,
  ]);
  const overview = await aiChannelRepository.listChannelOverview(access);
  const messages = phaseFiveBMessages[locale];
  let applicationUrl: string | null = null;
  try {
    applicationUrl = parsePublicApplicationUrl(process.env.NEXT_PUBLIC_APP_URL);
  } catch {
    applicationUrl = null;
  }
  return (
    <section aria-labelledby="ai-channels-title" className="page-stack wide-content">
      <div>
        <p className="eyebrow">Phase 5B</p>
        <h1 id="ai-channels-title">{messages.channels}</h1>
        <p className="muted">{messages.mockNotice}</p>
        <p className="muted">{messages.realtimeNotice}</p>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <form action={createWidgetConfigurationAction} className="panel form-grid">
        <input name="locale" type="hidden" value={locale} />
        <h2 className="form-title">{messages.createWidget}</h2>
        <label className="field">
          <span className="field-label">{messages.name}</span>
          <input className="input" maxLength={120} name="name" required />
        </label>
        <label className="field">
          <span className="field-label">{messages.displayNameEn}</span>
          <input className="input" maxLength={160} name="displayNameEn" required />
        </label>
        <label className="field">
          <span className="field-label">{messages.displayNameAr}</span>
          <input className="input" dir="rtl" maxLength={160} name="displayNameAr" required />
        </label>
        <label className="field form-title">
          <span className="field-label">{messages.allowedOrigins}</span>
          <textarea
            className="input textarea"
            defaultValue="http://localhost:3000"
            name="allowedOrigins"
            required
            rows={4}
          />
        </label>
        <label className="field">
          <span className="field-label">{messages.primaryColor}</span>
          <input className="input" defaultValue="#125e46" name="primaryColor" type="color" />
        </label>
        <label className="field">
          <span className="field-label">{messages.accentColor}</span>
          <input className="input" defaultValue="#d7f265" name="accentColor" type="color" />
        </label>
        <label className="field">
          <span className="field-label">{messages.defaultLocale}</span>
          <select className="select" defaultValue={locale} name="defaultLocale">
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </select>
        </label>
        <div className="form-actions">
          <SubmitButton>{messages.createWidget}</SubmitButton>
        </div>
      </form>
      <section aria-labelledby="installations-title" className="page-stack">
        <div>
          <h2 id="installations-title">{messages.installation}</h2>
          <p className="muted">{messages.widgetInstructions}</p>
        </div>
        {overview.widgets.map((widget) => {
          let snippet: string | null = null;
          if (applicationUrl) {
            try {
              const token = issueWidgetConfigurationToken(widget);
              snippet = `<script async src="${applicationUrl}/ai-widget.js" data-jormall-config="${token}" data-locale="${widget.defaultLocale}"></script>`;
            } catch {
              snippet = null;
            }
          }
          return (
            <article className="panel page-stack" key={widget.id}>
              <h3>{widget.name}</h3>
              <p className="muted">
                {widget.allowedOrigins.join(", ")} · v{widget.version}
              </p>
              <textarea
                aria-label={messages.installation}
                className="input textarea code-field"
                readOnly
                rows={5}
                value={snippet ?? "WIDGET_SIGNING_SECRET / NEXT_PUBLIC_APP_URL not configured"}
              />
              {snippet ? (
                <CopyInstallationButton
                  copiedLabel={messages.copied}
                  label={messages.copy}
                  value={snippet}
                />
              ) : null}
            </article>
          );
        })}
      </section>
      <section aria-labelledby="connections-title" className="panel">
        <h2 id="connections-title">{messages.providerConnections}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{locale === "ar" ? "القناة" : "Channel"}</th>
                <th>{locale === "ar" ? "المحول" : "Adapter"}</th>
                <th>{locale === "ar" ? "الحالة" : "Status"}</th>
                <th>{locale === "ar" ? "المعرّف الموجّه" : "Routed identifier"}</th>
              </tr>
            </thead>
            <tbody>
              {overview.connections.map((connection) => (
                <tr key={connection.id}>
                  <td>{connection.channel}</td>
                  <td>{connection.adapterKey} (MOCK)</td>
                  <td>{connection.status}</td>
                  <td>{connection.providerAccountId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="calls-title" className="panel">
        <h2 id="calls-title">{messages.calls}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{locale === "ar" ? "الوقت" : "Time"}</th>
                <th>{locale === "ar" ? "الحالة" : "Status"}</th>
                <th>{locale === "ar" ? "موافقة التسجيل" : "Recording consent"}</th>
                <th>{locale === "ar" ? "النتيجة" : "Outcome"}</th>
              </tr>
            </thead>
            <tbody>
              {overview.calls.map((call) => (
                <tr key={call.id}>
                  <td>{call.startedAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO")}</td>
                  <td>{call.status}</td>
                  <td>{call.recordingConsentStatus}</td>
                  <td>{call.summary?.outcome ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
