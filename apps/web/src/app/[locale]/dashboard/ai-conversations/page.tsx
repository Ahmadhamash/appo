import { isSupportedLocale } from "@jormall/contracts/locales";
import Link from "next/link";
import { notFound } from "next/navigation";

import { phaseFiveALabel, phaseFiveAMessages } from "../../../../messages/phase-five-a";
import { aiFoundationRepository, requirePagePermission } from "../../../../server/identity";

export default async function AIConversationsPage({
  params,
}: PageProps<"/[locale]/dashboard/ai-conversations">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const access = await requirePagePermission(locale, "conversations.read");
  const conversations = await aiFoundationRepository.listAIConversations(access);
  const messages = phaseFiveAMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="ai-conversations-title">
      <div>
        <p className="eyebrow">Phase 5A</p>
        <h1 id="ai-conversations-title">{messages.conversations}</h1>
        <p className="muted">{messages.mockNotice}</p>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{messages.customer}</th>
              <th>{messages.outcome}</th>
              <th>{messages.model}</th>
              <th>{messages.messages}</th>
              <th>{messages.actions}</th>
            </tr>
          </thead>
          <tbody>
            {conversations.map((conversation) => (
              <tr key={conversation.id}>
                <td>{conversation.customer?.displayName ?? "—"}</td>
                <td>{phaseFiveALabel(locale, conversation.status)}</td>
                <td>{conversation.modelIdentifier}</td>
                <td>{conversation._count.messages}</td>
                <td>
                  <Link
                    className="button button-secondary"
                    href={`/${locale}/dashboard/ai-conversations/${conversation.id}`}
                  >
                    {messages.viewer}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {conversations.length === 0 ? <p className="muted">{messages.noData}</p> : null}
    </section>
  );
}
