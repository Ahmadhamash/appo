import { isSupportedLocale } from "@jormall/contracts/locales";
import { DomainError } from "@jormall/domain/errors";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { SubmitButton } from "../../../components/submit-button";
import { gymPortalMessages } from "../../../messages/gym-portal";
import { gymRepository } from "../../../server/identity";
import { requireSession } from "../../../server/session";
import { logoutAction } from "../actions";

export default async function TraineeLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const session = await requireSession(locale);
  let portal: Awaited<ReturnType<typeof gymRepository.getOwnPortal>>;
  try {
    portal = await gymRepository.getOwnPortal(session.user.id);
  } catch (error) {
    const code = error instanceof DomainError ? error.code : "FORBIDDEN";
    redirect(`/${locale}/login?error=${encodeURIComponent(code)}`);
  }
  const messages = gymPortalMessages[locale];
  const gymName = locale === "ar" ? portal.organization.nameAr : portal.organization.nameEn;
  return (
    <div className="trainee-shell">
      <a className="skip-link" href="#trainee-content">
        {locale === "ar" ? "انتقل إلى المحتوى" : "Skip to content"}
      </a>
      <header className="trainee-header">
        <Link className="trainee-brand" href={`/${locale}/trainee`}>
          <span aria-hidden="true">JM</span>
          <span>
            <strong>{gymName}</strong>
            <small>{messages.dashboard}</small>
          </span>
        </Link>
        <nav aria-label={locale === "ar" ? "حساب المتدرّب" : "Trainee account"}>
          <Link
            className="button button-secondary"
            href={`/${locale === "ar" ? "en" : "ar"}/trainee`}
          >
            {locale === "ar" ? "English" : "العربية"}
          </Link>
          <form action={logoutAction}>
            <input name="locale" type="hidden" value={locale} />
            <SubmitButton tone="secondary">{messages.logout}</SubmitButton>
          </form>
        </nav>
      </header>
      <main id="trainee-content">{children}</main>
    </div>
  );
}
