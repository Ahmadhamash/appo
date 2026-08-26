import { isSupportedLocale } from "@jormall/contracts/locales";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Feedback } from "../../../components/feedback";
import { SubmitButton } from "../../../components/submit-button";
import { phaseOneMessages } from "../../../messages/phase-one";
import { getSession } from "../../../server/session";
import { loginAction } from "../actions";

export default async function LoginPage({ params, searchParams }: PageProps<"/[locale]/login">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) {
    notFound();
  }
  if (await getSession()) {
    redirect(`/${locale}/dashboard`);
  }
  const query = await searchParams;
  const messages = phaseOneMessages[locale];
  const returnTo = typeof query.returnTo === "string" ? query.returnTo : "";
  return (
    <main className="auth-shell login-shell">
      <section aria-label={messages.appName} className="auth-visual">
        <div className="auth-visual-brand">
          <div className="brand-mark" aria-hidden="true">
            J
          </div>
          <strong>{messages.appName}</strong>
        </div>
        <div className="auth-visual-copy">
          <p className="eyebrow">{messages.appDescription}</p>
          <h2>{messages.loginWelcome}</h2>
          <ul className="auth-feature-list">
            <li>{messages.loginFeatureClear}</li>
            <li>{messages.loginFeatureSecure}</li>
            <li>{messages.loginFeatureBilingual}</li>
          </ul>
        </div>
        <span className="auth-visual-orbit" aria-hidden="true" />
      </section>
      <section aria-labelledby="login-title" className="auth-card login-card">
        <div className="auth-card-brand">
          <div className="brand-mark" aria-hidden="true">
            J
          </div>
          <strong>{messages.appName}</strong>
        </div>
        <div>
          <p className="eyebrow">{messages.appName}</p>
          <h1 id="login-title">{messages.login}</h1>
          <p className="muted">{messages.appDescription}</p>
        </div>
        <Feedback
          error={typeof query.error === "string" ? query.error : undefined}
          locale={locale}
          notice={typeof query.notice === "string" ? query.notice : undefined}
        />
        <form action={loginAction} className="form-stack">
          <input name="locale" type="hidden" value={locale} />
          <input name="returnTo" type="hidden" value={returnTo} />
          <label className="field">
            <span className="field-label">{messages.email}</span>
            <input
              autoComplete="email"
              className="input"
              dir="ltr"
              name="email"
              required
              type="email"
            />
          </label>
          <label className="field">
            <span className="field-label">{messages.password}</span>
            <input
              autoComplete="current-password"
              className="input"
              dir="ltr"
              maxLength={128}
              name="password"
              required
              type="password"
            />
          </label>
          <SubmitButton>{messages.login}</SubmitButton>
        </form>
        <Link
          className="locale-link"
          href={`/${locale === "en" ? "ar" : "en"}/login`}
          hrefLang={locale === "en" ? "ar" : "en"}
        >
          <span aria-hidden="true">文</span>
          {locale === "en" ? "العربية" : "English"}
        </Link>
      </section>
    </main>
  );
}
