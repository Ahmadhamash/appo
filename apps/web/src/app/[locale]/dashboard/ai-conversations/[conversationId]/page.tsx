import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { phaseFiveALabel, phaseFiveAMessages } from "../../../../../messages/phase-five-a";
import { aiFoundationRepository, requirePagePermission } from "../../../../../server/identity";

export default async function AIConversationPage({
  params,
}: PageProps<"/[locale]/dashboard/ai-conversations/[conversationId]">) {
  const { conversationId, locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const access = await requirePagePermission(locale, "conversations.read");
  const conversation = await aiFoundationRepository.getAIConversation(access, conversationId);
  const messages = phaseFiveAMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="ai-conversation-title">
      <div>
        <p className="eyebrow">{messages.viewer}</p>
        <h1 id="ai-conversation-title">{conversation.customer?.displayName ?? conversation.id}</h1>
        <p className="muted">
          {conversation.modelIdentifier} · {phaseFiveALabel(locale, conversation.status)} ·{" "}
          {conversation.locale}
        </p>
      </div>
      <section className="panel" aria-labelledby="messages-title">
        <h2 id="messages-title">{messages.messages}</h2>
        <ol className="history-list">
          {conversation.messages.map((message) => (
            <li key={message.id}>
              <div>
                <strong>{message.role}</strong>{" "}
                <span className="status">{phaseFiveALabel(locale, message.safetyStatus)}</span>
              </div>
              <p dir="auto">{message.content}</p>
              <small>{message.createdAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO")}</small>
            </li>
          ))}
        </ol>
        {conversation.messages.length === 0 ? <p className="muted">{messages.noData}</p> : null}
      </section>
      <section className="panel" aria-labelledby="conversation-actions-title">
        <h2 id="conversation-actions-title">{messages.actions}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{messages.actions}</th>
                <th>{messages.outcome}</th>
                <th>{messages.latency}</th>
                <th>{locale === "ar" ? "التأكيد" : "Approval"}</th>
              </tr>
            </thead>
            <tbody>
              {conversation.actions.map((action) => (
                <tr key={action.id}>
                  <td>{action.actionName}</td>
                  <td>{phaseFiveALabel(locale, action.outcome)}</td>
                  <td>{action.latencyMs === null ? "—" : `${action.latencyMs} ms`}</td>
                  <td>{action.approval ? phaseFiveALabel(locale, action.approval.status) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {conversation.handoffs.length > 0 ? (
        <section className="panel" aria-labelledby="conversation-handoff-title">
          <h2 id="conversation-handoff-title">{messages.handoffs}</h2>
          {conversation.handoffs.map((handoff) => (
            <article className="record-card" key={handoff.id}>
              <span className="status">{phaseFiveALabel(locale, handoff.status)}</span>
              <strong>{handoff.reasonCode}</strong>
              <p dir="auto">{handoff.summary}</p>
            </article>
          ))}
        </section>
      ) : null}
    </section>
  );
}
