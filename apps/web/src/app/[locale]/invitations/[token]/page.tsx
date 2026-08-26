import { isSupportedLocale } from "@jormall/contracts/locales";
import { InvitationStatus } from "@jormall/db/generated/enums";
import { DomainError } from "@jormall/domain/errors";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages } from "../../../../messages/phase-one";
import { identityRepository } from "../../../../server/identity";
import { getSession } from "../../../../server/session";
import { acceptInvitationAction, registerFromInvitationAction } from "../../actions";

export default async function InvitationPage({
  params,
  searchParams,
}: PageProps<"/[locale]/invitations/[token]">) {
  const { locale, token } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [query, session] = await Promise.all([searchParams, getSession()]);
  let preview: Awaited<ReturnType<typeof identityRepository.previewInvitation>> | null = null;
  let previewError: string | undefined;
  try {
    preview = await identityRepository.previewInvitation(token);
    if (preview.expiresAt <= new Date()) previewError = "INVITATION_EXPIRED";
    if (preview.status !== InvitationStatus.PENDING) previewError = "INVITATION_ALREADY_USED";
  } catch (error) {
    previewError = error instanceof DomainError ? error.code : "INVITATION_INVALID";
  }
  const messages = phaseOneMessages[locale];
  const namesMatch =
    session && preview ? session.user.email.toLowerCase() === preview.email.toLowerCase() : false;
  return (
    <main className="auth-shell">
      <section aria-labelledby="invitation-title" className="auth-card invitation-card">
        <div className="brand-mark" aria-hidden="true">
          J
        </div>
        <p className="eyebrow">{messages.appName}</p>
        <h1 id="invitation-title">{messages.accept}</h1>
        <Feedback
          error={previewError ?? (typeof query.error === "string" ? query.error : undefined)}
          locale={locale}
        />
        {preview && !previewError ? (
          <>
            <article className="invitation-summary">
              <h2>{locale === "ar" ? preview.organizationNameAr : preview.organizationNameEn}</h2>
              <p>{locale === "ar" ? preview.roleNameAr : preview.roleNameEn}</p>
              <p dir="ltr">{preview.email}</p>
            </article>
            {session ? (
              namesMatch ? (
                <form action={acceptInvitationAction} className="form-stack">
                  <input name="locale" type="hidden" value={locale} />
                  <input name="token" type="hidden" value={token} />
                  <SubmitButton>{messages.accept}</SubmitButton>
                </form>
              ) : (
                <p className="feedback feedback-error">
                  {locale === "ar"
                    ? "سجّل الدخول بالبريد المدعو لقبول الدعوة."
                    : "Sign in with the invited email address to accept this invitation."}
                </p>
              )
            ) : (
              <>
                <form action={registerFromInvitationAction} className="form-stack">
                  <input name="locale" type="hidden" value={locale} />
                  <input name="token" type="hidden" value={token} />
                  <label className="field">
                    <span className="field-label">{messages.name}</span>
                    <input autoComplete="name" className="input" name="name" required />
                  </label>
                  <label className="field">
                    <span className="field-label">{messages.password}</span>
                    <input
                      aria-describedby="password-hint"
                      autoComplete="new-password"
                      className="input"
                      dir="ltr"
                      minLength={12}
                      name="password"
                      required
                      type="password"
                    />
                    <small className="muted" id="password-hint">
                      {messages.passwordHint}
                    </small>
                  </label>
                  <SubmitButton>{messages.register}</SubmitButton>
                </form>
                <Link
                  className="button button-secondary"
                  href={`/${locale}/login?returnTo=${encodeURIComponent(`/${locale}/invitations/${token}`)}`}
                >
                  {messages.login}
                </Link>
              </>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}
