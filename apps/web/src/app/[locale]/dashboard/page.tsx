import { isSupportedLocale } from "@jormall/contracts/locales";
import { BusinessSector } from "@jormall/db/generated/enums";
import { DomainError } from "@jormall/domain/errors";
import { assessGymTraineeAttention } from "@jormall/domain/gym";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../components/feedback";
import { GymCommandCenter } from "../../../components/gym-command-center";
import { phaseOneMessages } from "../../../messages/phase-one";
import { phaseTwoMessages } from "../../../messages/phase-two";
import { phaseFourMessages } from "../../../messages/phase-four";
import { phaseSevenMessages } from "../../../messages/phase-seven";
import { sectorMessages, sectorPortalProfile, sectorValueLabel } from "../../../messages/sectors";
import {
  gymRepository,
  identityRepository,
  requireTenantPermission,
} from "../../../server/identity";
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
  const sectors = sectorMessages[locale];
  let overview: Awaited<ReturnType<typeof identityRepository.listTenantOverview>> | null = null;
  let access: Awaited<ReturnType<typeof requireTenantPermission>> | null = null;
  let accessError: string | undefined;
  if (session.session.activeOrganizationId) {
    try {
      access = await requireTenantPermission(locale, "organization.read");
      overview = await identityRepository.listTenantOverview(access);
    } catch (error) {
      accessError = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
    }
  }
  const sector = overview?.organization?.settings?.businessSector ?? null;
  const sectorProfile = sector ? sectorPortalProfile(locale, sector) : null;
  const gymTrainees =
    sector === BusinessSector.GYM &&
    access?.grants.some((grant) => grant.code === "gym.trainees.read")
      ? await gymRepository.listTrainees(access)
      : [];
  const gymCommandTrainees = gymTrainees.map((trainee) => ({
    attention: assessGymTraineeAttention(
      {
        hasActiveNutritionPlan: trainee.nutritionPlans.length > 0,
        hasActivePortalAccess: trainee.portalAccess?.status === "ACTIVE",
        hasActiveWorkoutPlan: trainee.workoutPlans.length > 0,
        hasTrainer: Boolean(trainee.trainer),
        latestMeasurementAt: trainee.progressEntries[0]?.measuredAt,
        recentWorkoutLogs: trainee.workoutLogs.map((log) => ({
          actualReps: log.actualReps,
          ...(log.perceivedEffort === null ? {} : { perceivedEffort: log.perceivedEffort }),
          performedAt: log.performedAt,
          prescribedRepsMaximum: log.exercise.repsMax,
        })),
      },
      new Date(),
    ),
    id: trainee.id,
    name: trainee.customer.displayName,
    ...(trainee.trainer
      ? {
          trainerName:
            locale === "ar" ? trainee.trainer.displayNameAr : trainee.trainer.displayNameEn,
        }
      : {}),
  }));
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
      description: sectorProfile?.customersDescription ?? messages.customersCardDescription,
      href:
        sector === BusinessSector.GYM
          ? `/${locale}/dashboard/gym/trainees`
          : `/${locale}/dashboard/customers`,
      icon: "◎",
      label: sectorProfile?.customers ?? phaseTwo.customers,
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
      description: sectorProfile?.servicesDescription ?? messages.servicesCardDescription,
      href: `/${locale}/dashboard/services`,
      icon: "◇",
      label: sectorProfile?.services ?? messages.services,
      tone: "gold",
    },
    {
      description: sectorProfile?.staffDescription ?? messages.staffCardDescription,
      href: `/${locale}/dashboard/staff`,
      icon: "♙",
      label: sectorProfile?.staff ?? messages.staff,
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
      ) : !sector ? (
        <section className="empty-state" aria-labelledby="sector-title">
          <span aria-hidden="true" className="empty-state-icon">
            ◎
          </span>
          <h2 id="sector-title">{sectors.sectorCanChange}</h2>
          <p>{sectors.sectorLockedDescription}</p>
        </section>
      ) : (
        <section aria-label={messages.businessPortal} className="business-portal">
          {sector === BusinessSector.GYM ? (
            <GymCommandCenter
              activePlanCount={
                gymTrainees.filter(
                  (trainee) => trainee.workoutPlans.length > 0 && trainee.nutritionPlans.length > 0,
                ).length
              }
              locale={locale}
              portalAccessCount={
                gymTrainees.filter((trainee) => trainee.portalAccess?.status === "ACTIVE").length
              }
              trainees={gymCommandTrainees}
            />
          ) : null}
          {sector === BusinessSector.GYM ? (
            <header className="gym-shortcuts-heading">
              <div>
                <p className="eyebrow">{messages.dailyOperations}</p>
                <h2>
                  {sectorProfile?.portalTitle}:{" "}
                  {locale === "ar" ? overview.organization.nameAr : overview.organization.nameEn}
                </h2>
                <p>{sectorProfile?.portalDescription ?? messages.portalDescription}</p>
              </div>
              <dl className="gym-shortcut-summary">
                <div>
                  <dt>{messages.branches}</dt>
                  <dd>{overview.branches}</dd>
                </div>
                <div>
                  <dt>{sectorProfile?.staff ?? messages.staff}</dt>
                  <dd>{overview.staff}</dd>
                </div>
                <div>
                  <dt>{sectorProfile?.services ?? messages.services}</dt>
                  <dd>{overview.services}</dd>
                </div>
              </dl>
            </header>
          ) : (
            <article className="portal-hero">
              <div className="portal-hero-copy">
                <p className="eyebrow">{sectorValueLabel(locale, sector)}</p>
                <h2>
                  {sectorProfile?.portalTitle}:{" "}
                  {locale === "ar" ? overview.organization.nameAr : overview.organization.nameEn}
                </h2>
                <p>{sectorProfile?.portalDescription ?? messages.portalDescription}</p>
                <dl className="portal-summary">
                  <div>
                    <dt>{messages.branches}</dt>
                    <dd>{overview.branches}</dd>
                  </div>
                  <div>
                    <dt>{sectorProfile?.staff ?? messages.staff}</dt>
                    <dd>{overview.staff}</dd>
                  </div>
                  <div>
                    <dt>{sectorProfile?.services ?? messages.services}</dt>
                    <dd>{overview.services}</dd>
                  </div>
                </dl>
              </div>
              <div aria-hidden="true" className="portal-hero-mark">
                JM
              </div>
            </article>
          )}
          <nav
            aria-label={messages.dailyOperations}
            className={`portal-action-grid${sector === BusinessSector.GYM ? " gym-action-grid" : ""}`}
          >
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
