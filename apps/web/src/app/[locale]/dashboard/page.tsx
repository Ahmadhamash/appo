import { isSupportedLocale } from "@jormall/contracts/locales";
import { DomainError } from "@jormall/domain/errors";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../components/feedback";
import { phaseOneMessages } from "../../../messages/phase-one";
import { phaseTwoMessages } from "../../../messages/phase-two";
import { phaseFourMessages } from "../../../messages/phase-four";
import { phaseSevenMessages } from "../../../messages/phase-seven";
import { identityRepository, requireTenantPermission } from "../../../server/identity";
import { requireSession } from "../../../server/session";

export default async function DashboardPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [session, query] = await Promise.all([requireSession(locale), searchParams]);
  const messages = phaseOneMessages[locale];
  const phaseTwo = phaseTwoMessages[locale];
  const phaseFour = phaseFourMessages[locale];
  const phaseSeven = phaseSevenMessages[locale];
  let overview: Awaited<ReturnType<typeof identityRepository.listTenantOverview>> | null = null;
  let accessError: string | undefined;
  if (session.session.activeOrganizationId) {
    try {
      const access = await requireTenantPermission(locale, "organization.read");
      overview = await identityRepository.listTenantOverview(access);
    } catch (error) {
      accessError = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
    }
  }
  const portalActions = [
    {
      description: messages.todayCardDescription,
      href: `/${locale}/dashboard/today`,
      icon: "◷",
      label: phaseTwo.operationsToday,
      tone: "gold",
    },
    {
      description: messages.calendarCardDescription,
      href: `/${locale}/dashboard/calendar`,
      icon: "▦",
      label: phaseTwo.calendar,
      tone: "blue",
    },
    {
      description: messages.customersCardDescription,
      href: `/${locale}/dashboard/customers`,
      icon: "◎",
      label: phaseTwo.customers,
      tone: "mint",
    },
    {
      description: messages.communicationsCardDescription,
      href: `/${locale}/dashboard/communications`,
      icon: "◌",
      label: phaseFour.communications,
      tone: "violet",
    },
    {
      description: messages.servicesCardDescription,
      href: `/${locale}/dashboard/services`,
      icon: "◇",
      label: messages.services,
      tone: "gold",
    },
    {
      description: messages.staffCardDescription,
      href: `/${locale}/dashboard/staff`,
      icon: "♙",
      label: messages.staff,
      tone: "mint",
    },
    {
      description: messages.reportsCardDescription,
      href: `/${locale}/dashboard/reports`,
      icon: "▥",
      label: phaseSeven.reports,
      tone: "blue",
    },
    {
      description: messages.settingsCardDescription,
      href: `/${locale}/dashboard/settings`,
      icon: "⚙",
      label: messages.organizationSettings,
      tone: "violet",
    },
  ] as const;

  return (
    <section className="page-stack dashboard-home" aria-labelledby="overview-title">
      {overview?.organization ? (
        <h1 className="sr-only" id="overview-title">
          {messages.dashboard}
        </h1>
      ) : (
        <header className="page-heading">
          <p className="eyebrow">{messages.title}</p>
          <h1 id="overview-title">{messages.dashboard}</h1>
          <p className="page-description">{messages.dashboardDescription}</p>
        </header>
      )}
      <Feedback
        error={accessError ?? (typeof query.error === "string" ? query.error : undefined)}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      {!overview?.organization ? (
        <div className="empty-state">
          <span aria-hidden="true" className="empty-state-icon">
            ⌂
          </span>
          <p>{messages.noActiveOrganization}</p>
        </div>
      ) : (
        <section aria-label={messages.businessPortal} className="business-portal">
          <article className="portal-hero">
            <div className="portal-hero-copy">
              <p className="eyebrow">{messages.businessPortal}</p>
              <h2>
                {locale === "ar" ? overview.organization.nameAr : overview.organization.nameEn}
              </h2>
              <p>{messages.portalDescription}</p>
              <dl className="portal-summary">
                <div>
                  <dt>{messages.branches}</dt>
                  <dd>{overview.branches}</dd>
                </div>
                <div>
                  <dt>{messages.staff}</dt>
                  <dd>{overview.staff}</dd>
                </div>
                <div>
                  <dt>{messages.services}</dt>
                  <dd>{overview.services}</dd>
                </div>
              </dl>
            </div>
            <div aria-hidden="true" className="portal-hero-mark">
              JM
            </div>
          </article>
          <nav aria-label={messages.dailyOperations} className="portal-action-grid">
            {portalActions.map((action) => (
              <Link className="portal-action-card" href={action.href} key={action.href}>
                <span
                  aria-hidden="true"
                  className={`portal-action-icon portal-action-icon-${action.tone}`}
                >
                  {action.icon}
                </span>
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </Link>
            ))}
          </nav>
        </section>
      )}
    </section>
  );
}
