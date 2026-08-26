import { phaseFourLabel, phaseFourMessages } from "../messages/phase-four";

type TimelineMessage = Readonly<{
  body: string;
  channel: string;
  createdAt: Date;
  direction: string;
  id: string;
  status: string;
  attempts: readonly Readonly<{
    errorCode: string | null;
    safeErrorMessage: string | null;
    status: string;
  }>[];
}>;

export function MessageTimeline({
  locale,
  messages,
}: Readonly<{ locale: "ar" | "en"; messages: readonly TimelineMessage[] }>) {
  const copy = phaseFourMessages[locale];
  return (
    <section className="panel page-stack" aria-labelledby="message-timeline-title">
      <h2 id="message-timeline-title">{copy.messageTimeline}</h2>
      {messages.length === 0 ? (
        <p className="muted">{locale === "ar" ? "لا توجد رسائل بعد." : "No messages yet."}</p>
      ) : null}
      <ol className="history-list">
        {messages.map((message) => {
          const latestAttempt = message.attempts.at(-1);
          return (
            <li key={message.id}>
              <div className="row-actions">
                <span className={`status status-${message.status.toLowerCase()}`}>
                  {phaseFourLabel(locale, message.status)}
                </span>
                <small>
                  {message.channel} · {message.direction}
                </small>
              </div>
              <p dir="auto">{message.body}</p>
              <small>{message.createdAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO")}</small>
              {latestAttempt?.errorCode ? (
                <p className="feedback feedback-error">
                  {latestAttempt.errorCode}: {latestAttempt.safeErrorMessage}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
