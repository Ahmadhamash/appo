import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import {
  CommunicationChannel,
  MessageStatus,
  MockProviderBehavior,
} from "@jormall/db/generated/enums";
import { communicationTemplateKeys } from "@jormall/domain/communications";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseFourLabel, phaseFourMessages } from "../../../../messages/phase-four";
import {
  communicationRepository,
  crmAppointmentRepository,
  requirePagePermission,
} from "../../../../server/identity";
import {
  retryMessageAction,
  sendTemplateMessageAction,
  setMockProviderBehaviorAction,
} from "../../actions";

export default async function CommunicationsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/communications">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "messages.read"),
    searchParams,
  ]);
  const [conversations, configuration] = await Promise.all([
    communicationRepository.listInbox(access),
    communicationRepository.listConfiguration(access),
  ]);
  const canSend =
    canAccessResource(access, "messages.send") && canAccessResource(access, "customers.read");
  const canRetry = canAccessResource(access, "messages.retry");
  const canManageProviders = canAccessResource(access, "provider_credentials.manage");
  const [customers, appointments] = canSend
    ? await Promise.all([
        crmAppointmentRepository.listCustomers(access),
        crmAppointmentRepository.listAppointments(access),
      ])
    : [[], []];
  const messages = phaseFourMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="communications-title">
      <div>
        <p className="eyebrow">{messages.inbox}</p>
        <h1 id="communications-title">{messages.communications}</h1>
        <p className="muted">{messages.mockNotice}</p>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      {canSend ? (
        <form action={sendTemplateMessageAction} className="panel form-grid">
          <input name="locale" type="hidden" value={locale} />
          <h2 className="form-title">{messages.sendTemplate}</h2>
          <p className="muted form-title">{messages.consentNotice}</p>
          <label className="field">
            <span className="field-label">{locale === "ar" ? "العميل" : "Customer"}</span>
            <select className="select" name="customerId" required>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{locale === "ar" ? "الموعد" : "Appointment"}</span>
            <select className="select" name="appointmentId">
              <option value="">—</option>
              {appointments.map((appointment) => (
                <option key={appointment.id} value={appointment.id}>
                  {appointment.customer.displayName} ·{" "}
                  {appointment.startsAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO", {
                    timeZone: appointment.timezone,
                  })}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{messages.template}</span>
            <select className="select" name="templateKey">
              {communicationTemplateKeys.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{messages.channel}</span>
            <select className="select" name="channel">
              <option value={CommunicationChannel.SMS}>SMS</option>
              <option value={CommunicationChannel.WHATSAPP}>WhatsApp</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">
              {locale === "ar" ? "لغة الرسالة" : "Message language"}
            </span>
            <select className="select" defaultValue={locale} name="messageLocale">
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          <div className="form-actions">
            <SubmitButton>{messages.sendTemplate}</SubmitButton>
          </div>
        </form>
      ) : null}
      <section className="panel" aria-labelledby="inbox-title">
        <h2 id="inbox-title">{messages.inbox}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{locale === "ar" ? "العميل" : "Customer"}</th>
                <th>{messages.channel}</th>
                <th>{locale === "ar" ? "آخر رسالة" : "Latest message"}</th>
                <th>{messages.delivery}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {conversations.map((conversation) => {
                const latest = conversation.messages[0];
                return (
                  <tr key={conversation.id}>
                    <td>{conversation.customer.displayName}</td>
                    <td>{conversation.channel}</td>
                    <td dir="auto">{latest?.body ?? "—"}</td>
                    <td>{latest ? phaseFourLabel(locale, latest.status) : "—"}</td>
                    <td>
                      {canRetry &&
                      latest &&
                      (latest.status === MessageStatus.FAILED ||
                        latest.status === MessageStatus.DEAD_LETTER) ? (
                        <form action={retryMessageAction}>
                          <input name="locale" type="hidden" value={locale} />
                          <input name="messageId" type="hidden" value={latest.id} />
                          <SubmitButton tone="secondary">{messages.retry}</SubmitButton>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel" aria-labelledby="connections-title">
        <h2 id="connections-title">{messages.providerConnections}</h2>
        <div className="card-grid">
          {configuration.connections.map((connection) => (
            <article className="record-card" key={connection.id}>
              <h3>{connection.name}</h3>
              <p>
                {connection.channel} · {connection.adapterKey}
              </p>
              <span className={`status status-${connection.status.toLowerCase()}`}>
                {connection.status}
              </span>
              <p className="muted">
                {locale === "ar" ? "سلوك تجريبي" : "Mock behavior"}: {connection.mockBehavior}
              </p>
              {canManageProviders ? (
                <form action={setMockProviderBehaviorAction} className="form-stack">
                  <input name="locale" type="hidden" value={locale} />
                  <input name="connectionId" type="hidden" value={connection.id} />
                  <label className="field">
                    <span className="field-label">
                      {locale === "ar" ? "نتيجة المحول المحلي" : "Local adapter outcome"}
                    </span>
                    <select
                      className="select"
                      defaultValue={connection.mockBehavior}
                      name="behavior"
                    >
                      {Object.values(MockProviderBehavior).map((behavior) => (
                        <option key={behavior} value={behavior}>
                          {behavior}
                        </option>
                      ))}
                    </select>
                  </label>
                  <SubmitButton tone="secondary">{locale === "ar" ? "حفظ" : "Save"}</SubmitButton>
                </form>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <details className="panel">
        <summary>{messages.template}</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{messages.template}</th>
                <th>{messages.channel}</th>
                <th>{locale === "ar" ? "اللغة" : "Locale"}</th>
                <th>{locale === "ar" ? "النص" : "Body"}</th>
              </tr>
            </thead>
            <tbody>
              {configuration.templates.map((template) => (
                <tr key={template.id}>
                  <td>{template.key}</td>
                  <td>{template.channel}</td>
                  <td>{template.locale}</td>
                  <td dir="auto">{template.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
