import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardPageHero } from "../../../../components/dashboard-page-hero";
import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { ownerWorkspaceMessages } from "../../../../messages/owner-workspace";
import { phaseOneMessages } from "../../../../messages/phase-one";
import { sectorMessages, sectorValueLabel } from "../../../../messages/sectors";
import { identityRepository, requirePagePermission } from "../../../../server/identity";
import { updateSettingsAction } from "../../actions";

export default async function SettingsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/settings">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "organization.settings.manage"),
    searchParams,
  ]);
  const settings = await identityRepository.getSettings(access);
  if (!settings) notFound();
  const messages = phaseOneMessages[locale];
  const sectors = sectorMessages[locale];
  const workspace = ownerWorkspaceMessages[locale];
  const setupLinks = [
    canAccessResource(access, "branches.read")
      ? { href: `/${locale}/dashboard/branches`, icon: "⌂", label: workspace.manageBranches }
      : null,
    canAccessResource(access, "services.read")
      ? { href: `/${locale}/dashboard/services`, icon: "◇", label: workspace.manageServices }
      : null,
    canAccessResource(access, "staff.read")
      ? { href: `/${locale}/dashboard/staff`, icon: "♙", label: messages.staff }
      : null,
    canAccessResource(access, "roles.read")
      ? { href: `/${locale}/dashboard/roles`, icon: "⚿", label: workspace.manageRoles }
      : null,
    canAccessResource(access, "messages.read")
      ? {
          href: `/${locale}/dashboard/communications`,
          icon: "◌",
          label: workspace.manageConnections,
        }
      : null,
  ].filter((item) => item !== null);

  return (
    <section className="page-stack" aria-labelledby="settings-title">
      <DashboardPageHero
        description={workspace.settingsDescription}
        eyebrow={workspace.workspace}
        icon="⚙"
        title={messages.organizationSettings}
        titleId="settings-title"
      />
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />

      <dl className="workspace-metrics settings-metrics">
        <div>
          <span aria-hidden="true">◎</span>
          <dt>{sectors.sectorSettings}</dt>
          <dd>
            {settings.businessSector ? sectorValueLabel(locale, settings.businessSector) : "—"}
          </dd>
        </div>
        <div>
          <span aria-hidden="true">◷</span>
          <dt>{messages.timezone}</dt>
          <dd className="metric-text" dir="ltr">
            {settings.timezone}
          </dd>
        </div>
        <div>
          <span aria-hidden="true">¤</span>
          <dt>{messages.currency}</dt>
          <dd className="metric-text">{settings.currency}</dd>
        </div>
        <div>
          <span aria-hidden="true">▦</span>
          <dt>{messages.bookingWindow}</dt>
          <dd>
            {settings.bookingWindowDays} <small>{workspace.days}</small>
          </dd>
        </div>
      </dl>

      <div className="settings-workspace-grid">
        <form action={updateSettingsAction} className="panel settings-main-form">
          <input name="locale" type="hidden" value={locale} />
          <div className="settings-section-heading">
            <span aria-hidden="true">⚙</span>
            <div>
              <h2>{workspace.generalSettings}</h2>
              <p>{workspace.generalSettingsDescription}</p>
            </div>
          </div>
          <div className="form-grid workspace-form">
            <label className="field">
              <span className="field-label">{messages.defaultLocale}</span>
              <select className="select" defaultValue={settings.defaultLocale} name="defaultLocale">
                <option value="en">English</option>
                <option value="ar">{workspace.arabicLanguage}</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">{messages.timezone}</span>
              <input
                className="input"
                defaultValue={settings.timezone}
                dir="ltr"
                name="timezone"
                required
              />
            </label>
            <label className="field">
              <span className="field-label">{messages.currency}</span>
              <input
                className="input"
                defaultValue={settings.currency}
                dir="ltr"
                maxLength={3}
                name="currency"
                required
              />
            </label>
            <label className="field">
              <span className="field-label">{messages.bookingWindow}</span>
              <input
                className="input"
                defaultValue={settings.bookingWindowDays}
                min={1}
                max={730}
                name="bookingWindowDays"
                required
                type="number"
              />
              <small className="field-hint">{workspace.bookingWindowHint}</small>
            </label>
            <div className="form-actions">
              <SubmitButton>{messages.save}</SubmitButton>
            </div>
          </div>
        </form>

        <aside className="panel setup-links" aria-labelledby="setup-links-title">
          <div className="settings-section-heading">
            <span aria-hidden="true">✓</span>
            <div>
              <h2 id="setup-links-title">{workspace.configurationLinks}</h2>
              <p>{workspace.configurationLinksDescription}</p>
            </div>
          </div>
          <nav aria-label={workspace.configurationLinks}>
            {setupLinks.map((item) => (
              <Link href={item.href} key={item.href}>
                <span aria-hidden="true">{item.icon}</span>
                <strong>{item.label}</strong>
                <b aria-hidden="true">›</b>
              </Link>
            ))}
          </nav>
        </aside>
      </div>

      <aside className="panel sector-lock-note" aria-label={sectors.sectorSettings}>
        <strong>{sectors.sectorCanChange}</strong>
        <p>{sectors.sectorLockedDescription}</p>
      </aside>
    </section>
  );
}
