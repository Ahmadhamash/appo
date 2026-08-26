import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import {
  CommunicationChannel,
  MessageStatus,
  MockProviderBehavior,
} from "@jormall/db/generated/enums";
import { communicationTemplateKeys } from "@jormall/domain/communications";
import { notFound } from "next/navigation";

import { DashboardPageHero } from "../../../../components/dashboard-page-hero";
import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { ownerWorkspaceMessages } from "../../../../messages/owner-workspace";
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
  const workspace = ownerWorkspaceMessages[locale];
  const latestMessages = conversations
    .map(({ messages: conversationMessages }) => conversationMessages[0])
    .filter((message) => message !== undefined);
  const deliveredCount = latestMessages.filter(
    ({ status }) => status === MessageStatus.DELIVERED,
  ).length;
  const attentionCount = latestMessages.filter(
    ({ status }) => status === MessageStatus.FAILED || status === MessageStatus.DEAD_LETTER,
  ).length;
  const activeConnections = configuration.connections.filter(
    ({ status }) => status === "ACTIVE",
  ).length;

  return (
    <section className="page-stack" aria-labelledby="communications-title">
      <DashboardPageHero
        description={workspace.communicationDescription}
        eyebrow={workspace.workspace}
        icon="◌"
        title={messages.communications}
        titleId="communications-title"
      />
      <p className="mock-notice">
        <span aria-hidden="true">i</span>
        {messages.mockNotice}
      </p>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />

      <dl className="workspace-metrics">
        <div>
          <span aria-hidden="true">◌</span>
          <dt>{workspace.totalConversations}</dt>
          <dd>{conversations.length}</dd>
        </div>
        <div>
          <span aria-hidden="true">✓</span>
          <dt>{workspace.completedDelivery}</dt>
          <dd>{deliveredCount}</dd>
        </div>
        <div data-tone={attentionCount > 0 ? "danger" : "default"}>
          <span aria-hidden="true">!</span>
          <dt>{workspace.attentionMessages}</dt>
          <dd>{attentionCount}</dd>
        </div>
        <div>
          <span aria-hidden="true">⌁</span>
          <dt>{workspace.activeChannels}</dt>
          <dd>
            {activeConnections}/{configuration.connections.length}
          </dd>
        </div>
      </dl>

      {canSend ? (
        <details className="panel action-disclosure workspace-action send-message-disclosure">
          <summary>+ {workspace.newMessage}</summary>
          <div className="disclosure-heading">
            <h2>{messages.sendTemplate}</h2>
            <p>{messages.consentNotice}</p>
          </div>
          <form action={sendTemplateMessageAction} className="form-grid workspace-form">
            <input name="locale" type="hidden" value={locale} />
            <label className="field">
              <span className="field-label">{workspace.customer}</span>
              <select className="select" name="customerId" required>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{workspace.appointment}</span>
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
              <span className="field-label">{workspace.messageLanguage}</span>
              <select className="select" defaultValue={locale} name="messageLocale">
                <option value="en">English</option>
                <option value="ar">{workspace.arabicLanguage}</option>
              </select>
            </label>
            <div className="form-actions">
              <SubmitButton>{messages.sendTemplate}</SubmitButton>
            </div>
          </form>
        </details>
      ) : null}

      <section className="inbox-workspace" aria-labelledby="inbox-title">
        <div className="section-heading workspace-section-heading">
          <div>
            <p className="eyebrow">{workspace.communicationOverview}</p>
            <h2 id="inbox-title">{messages.inbox}</h2>
          </div>
          <span className="section-count">{conversations.length}</span>
        </div>

        {conversations.length === 0 ? (
          <div className="empty-state communication-empty">
            <span className="empty-state-icon" aria-hidden="true">
              ◌
            </span>
            <h3>{workspace.noConversations}</h3>
            <p>{workspace.noConversationsDescription}</p>
          </div>
        ) : (
          <div className="conversation-list">
            {conversations.map((conversation) => {
              const latest = conversation.messages[0];
              return (
                <article className="conversation-card" key={conversation.id}>
                  <span className="conversation-avatar" aria-hidden="true">
                    {conversation.customer.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="conversation-main">
                    <div className="conversation-title">
                      <h3>{conversation.customer.displayName}</h3>
                      <span className="channel-badge">{conversation.channel}</span>
                    </div>
                    <p dir="auto">{latest?.body ?? "—"}</p>
                    <small>{workspace.latestMessage}</small>
                  </div>
                  <div className="conversation-delivery">
                    <span
                      className={`status ${latest ? `status-${latest.status.toLowerCase()}` : ""}`}
                    >
                      {latest ? phaseFourLabel(locale, latest.status) : "—"}
                    </span>
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
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <details className="panel action-disclosure advanced-workspace">
        <summary>{workspace.advancedConnections}</summary>
        <div className="disclosure-heading">
          <h2>{messages.providerConnections}</h2>
          <p>{workspace.advancedConnectionsDescription}</p>
        </div>
        <div className="provider-connection-grid">
          {configuration.connections.map((connection) => (
            <article className="provider-connection-card" key={connection.id}>
              <header>
                <div>
                  <h3>{connection.name}</h3>
                  <p>
                    {connection.channel} · {connection.adapterKey}
                  </p>
                </div>
                <span className={`status status-${connection.status.toLowerCase()}`}>
                  {connection.status}
                </span>
              </header>
              <p className="muted">
                {workspace.mockBehavior}: {connection.mockBehavior}
              </p>
              {canManageProviders ? (
                <form action={setMockProviderBehaviorAction} className="form-stack">
                  <input name="locale" type="hidden" value={locale} />
                  <input name="connectionId" type="hidden" value={connection.id} />
                  <label className="field">
                    <span className="field-label">{workspace.localAdapterOutcome}</span>
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
                  <SubmitButton tone="secondary">{workspace.save}</SubmitButton>
                </form>
              ) : null}
            </article>
          ))}
        </div>
      </details>

      <details className="panel action-disclosure advanced-workspace">
        <summary>{workspace.messageTemplates}</summary>
        <div className="template-card-grid">
          {configuration.templates.map((template) => (
            <article className="template-card" key={template.id}>
              <div>
                <strong>{template.key}</strong>
                <span>
                  {template.channel} · {template.locale.toUpperCase()}
                </span>
              </div>
              <p dir="auto">{template.body}</p>
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}
