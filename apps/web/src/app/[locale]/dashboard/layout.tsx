import { isSupportedLocale } from "@jormall/contracts/locales";
import { PlatformRole } from "@jormall/db/generated/enums";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import {
  DashboardNavigation,
  type DashboardNavigationGroup,
} from "../../../components/dashboard-navigation";
import { SubmitButton } from "../../../components/submit-button";
import { phaseOneMessages } from "../../../messages/phase-one";
import { phaseTwoMessages } from "../../../messages/phase-two";
import { phaseThreeMessages } from "../../../messages/phase-three";
import { phaseFourMessages } from "../../../messages/phase-four";
import { phaseFiveAMessages } from "../../../messages/phase-five-a";
import { phaseFiveBMessages } from "../../../messages/phase-five-b";
import { phaseSixMessages } from "../../../messages/phase-six";
import { phaseSevenMessages } from "../../../messages/phase-seven";
import { phaseEightMessages } from "../../../messages/phase-eight";
import { sectorPortalProfile } from "../../../messages/sectors";
import { identityRepository, requireTenantAccess } from "../../../server/identity";
import { requireSession } from "../../../server/session";
import { endSupportAccessAction, logoutAction, switchOrganizationAction } from "../actions";

export default async function DashboardLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ locale: string }> }>) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const session = await requireSession(locale);
  const [memberships, user] = await Promise.all([
    identityRepository.listMembershipChoices(session.user.id),
    identityRepository.client.user.findUnique({
      select: { platformRole: true },
      where: { id: session.user.id },
    }),
  ]);
  const messages = phaseOneMessages[locale];
  const phaseTwo = phaseTwoMessages[locale];
  const phaseThree = phaseThreeMessages[locale];
  const phaseFour = phaseFourMessages[locale];
  const phaseFiveA = phaseFiveAMessages[locale];
  const phaseFiveB = phaseFiveBMessages[locale];
  const phaseSix = phaseSixMessages[locale];
  const phaseSeven = phaseSevenMessages[locale];
  const phaseEight = phaseEightMessages[locale];
  const activeMembership = memberships.find(
    (membership) =>
      membership.id === session.session.activeMembershipId ||
      membership.organization.id === session.session.activeOrganizationId,
  );
  const availableMemberships = memberships.filter(
    (membership) => membership.status === "ACTIVE" && membership.organization.status === "ACTIVE",
  );
  const activeOrganizationName = activeMembership
    ? locale === "ar"
      ? activeMembership.organization.nameAr
      : activeMembership.organization.nameEn
    : messages.activeOrganization;
  let businessSector: Awaited<ReturnType<typeof identityRepository.getBusinessSector>> = null;
  if (session.session.activeOrganizationId) {
    try {
      businessSector = await identityRepository.getBusinessSector(
        await requireTenantAccess(locale),
      );
    } catch {
      businessSector = null;
    }
  }
  const sectorProfile = businessSector ? sectorPortalProfile(locale, businessSector) : null;
  const root = `/${locale}/dashboard`;
  const navigationGroups: readonly DashboardNavigationGroup[] = [
    {
      label: messages.dailyOperations,
      items: [
        { href: root, icon: "⌂", label: messages.dashboard },
        { href: `${root}/today`, icon: "◷", label: phaseTwo.operationsToday },
        { href: `${root}/calendar`, icon: "▦", label: phaseTwo.calendar },
        {
          href: businessSector === "GYM" ? `${root}/gym/trainees` : `${root}/customers`,
          icon: "◎",
          label: sectorProfile?.customers ?? phaseTwo.customers,
        },
        { href: `${root}/waitlist`, icon: "≋", label: phaseThree.waitlist },
        { href: `${root}/communications`, icon: "◌", label: phaseFour.communications },
      ],
    },
    {
      label: messages.manageBusiness,
      items: [
        {
          href: `${root}/services`,
          icon: "◇",
          label: sectorProfile?.services ?? messages.services,
        },
        {
          href: `${root}/resources`,
          icon: "▤",
          label: sectorProfile?.resources ?? phaseThree.resources,
        },
        { href: `${root}/branches`, icon: "⌑", label: messages.branches },
        { href: `${root}/staff`, icon: "♙", label: sectorProfile?.staff ?? messages.staff },
        { href: `${root}/roles`, icon: "◆", label: messages.roles },
      ],
    },
    {
      label: messages.smartInsights,
      items: [
        { href: `${root}/copilot`, icon: "✦", label: phaseSix.copilot },
        {
          href: `${root}/predictions`,
          icon: "↗",
          label: phaseEight.predictiveIntelligence,
        },
        { href: `${root}/reports`, icon: "▥", label: phaseSeven.reports },
      ],
    },
    {
      label: messages.aiWorkspace,
      items: [
        { href: `${root}/knowledge`, icon: "▧", label: phaseFiveA.knowledge },
        { href: `${root}/ai-conversations`, icon: "◉", label: phaseFiveA.conversations },
        { href: `${root}/ai-handoffs`, icon: "↪", label: phaseFiveA.handoffs },
        { href: `${root}/ai-channels`, icon: "⌁", label: phaseFiveB.channels },
        { href: `${root}/ai-settings`, icon: "⚙", label: phaseFiveA.configuration },
        { href: `${root}/ai-actions`, icon: "✓", label: phaseFiveA.actionAudit },
        { href: `${root}/ai-usage`, icon: "◫", label: phaseFiveA.usage },
      ],
    },
    {
      label: messages.administration,
      items: [
        {
          href: `${root}/settings`,
          icon: "⚙",
          label: messages.organizationSettings,
        },
        { href: `${root}/imports`, icon: "⇧", label: phaseSeven.imports },
        { href: `${root}/audit`, icon: "≡", label: phaseSeven.audit },
        ...(user?.platformRole === PlatformRole.JORMALL_SUPER_ADMIN
          ? [
              {
                href: `/${locale}/platform/organizations`,
                icon: "♛",
                label: messages.platformAdmin,
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {locale === "ar" ? "انتقل إلى المحتوى" : "Skip to content"}
      </a>
      {session.session.activeSupportAccessId ? (
        <div className="support-banner" role="status">
          {locale === "ar"
            ? "وضع دعم جورمول المدقّق نشط"
            : "Audited JorMall support mode is active"}
        </div>
      ) : null}
      <div className="workspace">
        <header className="app-header">
          <div className="header-branding">
            <Link className="brand header-brand" href={root}>
              <span className="brand-mark" aria-hidden="true">
                J
              </span>
              <span>
                <strong>{messages.appName}</strong>
                <small>{messages.appDescription}</small>
              </span>
            </Link>
            <DashboardNavigation
              ariaLabel={locale === "ar" ? "التنقل الرئيسي" : "Primary navigation"}
              groups={navigationGroups}
              menuLabel={messages.navigationMenu}
            />
          </div>
          <div className="workspace-context">
            <small>{messages.activeOrganization}</small>
            <strong>{activeOrganizationName}</strong>
          </div>
          <div className="header-actions">
            {session.session.activeSupportAccessId ? (
              <form action={endSupportAccessAction}>
                <input name="locale" type="hidden" value={locale} />
                <SubmitButton tone="danger">{messages.endSupport}</SubmitButton>
              </form>
            ) : availableMemberships.length > 1 ? (
              <form action={switchOrganizationAction} className="switcher">
                <input name="locale" type="hidden" value={locale} />
                <label className="sr-only" htmlFor="membershipId">
                  {messages.switchOrganization}
                </label>
                <select
                  className="select"
                  defaultValue={activeMembership?.id ?? ""}
                  id="membershipId"
                  name="membershipId"
                  required
                >
                  <option disabled value="">
                    {messages.activeOrganization}
                  </option>
                  {memberships.map((membership) => (
                    <option
                      disabled={
                        membership.status !== "ACTIVE" ||
                        membership.organization.status !== "ACTIVE"
                      }
                      key={membership.id}
                      value={membership.id}
                    >
                      {locale === "ar"
                        ? membership.organization.nameAr
                        : membership.organization.nameEn}
                    </option>
                  ))}
                </select>
                <SubmitButton tone="secondary">{messages.switchOrganization}</SubmitButton>
              </form>
            ) : null}
            <Link
              aria-label={messages.changeLanguage}
              className="locale-switch"
              href={`/${locale === "en" ? "ar" : "en"}/dashboard`}
              hrefLang={locale === "en" ? "ar" : "en"}
            >
              <span aria-hidden="true">文</span>
              {locale === "en" ? "العربية" : "English"}
            </Link>
            <form action={logoutAction}>
              <input name="locale" type="hidden" value={locale} />
              <SubmitButton tone="secondary">{messages.logout}</SubmitButton>
            </form>
          </div>
        </header>
        <main className="main-content" id="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
