import { isSupportedLocale } from "@jormall/contracts/locales";
import { DomainError } from "@jormall/domain/errors";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { gymPortalMessages } from "../../../../messages/gym-portal";
import { phaseOneMessages } from "../../../../messages/phase-one";
import { gymRepository } from "../../../../server/identity";
import { getSession } from "../../../../server/session";
import {
  acceptTraineeInvitationAction,
  registerTraineeInvitationAction,
} from "../../trainee/actions";

export default async function TraineeInvitationPage({
  params,
  searchParams,
}: PageProps<"/[locale]/trainee-invitations/[token]">) {
  const [{ locale, token }, query] = await Promise.all([params, searchParams]);
  if (!isSupportedLocale(locale)) notFound();
  const session = await getSession();
  let preview: Awaited<ReturnType<typeof gymRepository.previewPortalInvitation>> | null = null;
  let previewError: string | undefined;
  try {
    preview = await gymRepository.previewPortalInvitation(token);
  } catch (error) {
    previewError = error instanceof DomainError ? error.code : "INVITATION_INVALID";
  }
  const messages = gymPortalMessages[locale];
  const identity = phaseOneMessages[locale];
  const emailMatches =
    session && preview ? session.user.email.toLowerCase() === preview.email : false;
  return (
    <main className="auth-shell trainee-invitation-shell">
      <section className="auth-card invitation-card" aria-labelledby="trainee-invitation-title">
        <div className="brand-mark" aria-hidden="true">
          JM
        </div>
        <p className="eyebrow">{messages.accountInvitation}</p>
        <h1 id="trainee-invitation-title">{messages.invitationTitle}</h1>
        <p className="muted">{messages.invitationExplanation}</p>
        <Feedback
          error={previewError ?? (typeof query.error === "string" ? query.error : undefined)}
          locale={locale}
        />
        {preview && !previewError ? (
          <>
            <article className="invitation-summary trainee-invitation-summary">
              <strong>
                {locale === "ar" ? preview.organizationNameAr : preview.organizationNameEn}
              </strong>
              <span>{preview.traineeName}</span>
              <small dir="ltr">{preview.email}</small>
            </article>
            {session ? (
              emailMatches ? (
                <form action={acceptTraineeInvitationAction} className="form-stack">
                  <input name="locale" type="hidden" value={locale} />
                  <input name="token" type="hidden" value={token} />
                  <SubmitButton>{identity.accept}</SubmitButton>
                </form>
              ) : (
                <p className="feedback feedback-error">
                  {locale === "ar"
                    ? "سجّل الدخول بالبريد الموجود في الدعوة."
                    : "Sign in with the invited email address."}
                </p>
              )
            ) : (
              <>
                <form action={registerTraineeInvitationAction} className="form-stack">
                  <input name="locale" type="hidden" value={locale} />
                  <input name="token" type="hidden" value={token} />
                  <label className="field">
                    <span className="field-label">{identity.name}</span>
                    <input autoComplete="name" className="input" name="name" required />
                  </label>
                  <label className="field">
                    <span className="field-label">{identity.password}</span>
                    <input
                      autoComplete="new-password"
                      className="input"
                      dir="ltr"
                      minLength={12}
                      name="password"
                      required
                      type="password"
                    />
                    <small className="muted">{identity.passwordHint}</small>
                  </label>
                  <SubmitButton>{identity.register}</SubmitButton>
                </form>
                <Link
                  className="button button-secondary"
                  href={`/${locale}/login?returnTo=${encodeURIComponent(`/${locale}/trainee-invitations/${token}`)}`}
                >
                  {identity.login}
                </Link>
              </>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}
