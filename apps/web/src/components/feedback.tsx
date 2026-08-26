import type { SupportedLocale } from "@jormall/contracts/locales";

import { feedbackMessages, phaseOneMessages } from "../messages/phase-one";

type FeedbackProperties = Readonly<{
  error?: string | undefined;
  invitation?: string | undefined;
  locale: SupportedLocale;
  notice?: string | undefined;
}>;

export function Feedback({ error, invitation, locale, notice }: FeedbackProperties) {
  const code = error ?? notice;
  if (!code && !invitation) {
    return null;
  }
  const message = code
    ? (feedbackMessages[locale][code] ?? feedbackMessages[locale].INTERNAL_ERROR)
    : "";
  return (
    <div className="grid gap-3" role={error ? "alert" : "status"}>
      {message ? (
        <p className={error ? "feedback feedback-error" : "feedback feedback-success"}>{message}</p>
      ) : null}
      {invitation ? (
        <div className="feedback feedback-info">
          <label className="field-label" htmlFor="invitation-link">
            {phaseOneMessages[locale].invitationLink}
          </label>
          <input className="input" dir="ltr" id="invitation-link" readOnly value={invitation} />
        </div>
      ) : null}
    </div>
  );
}
