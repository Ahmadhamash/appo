import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { DashboardPageHero } from "../../../../components/dashboard-page-hero";
import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { ownerWorkspaceMessages } from "../../../../messages/owner-workspace";
import { phaseOneMessages, phaseOneValueLabel } from "../../../../messages/phase-one";
import { sectorPortalProfile } from "../../../../messages/sectors";
import { identityRepository, requirePagePermission } from "../../../../server/identity";
import { configureServiceBranchAction, createServiceAction } from "../../actions";

export default async function ServicesPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/services">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "services.read"),
    searchParams,
  ]);
  const canManage = canAccessResource(access, "services.manage");
  const [services, branches, sector] = await Promise.all([
    identityRepository.listServices(access),
    identityRepository.listBranches(access),
    canAccessResource(access, "organization.read")
      ? identityRepository.getBusinessSector(access)
      : Promise.resolve(null),
  ]);
  const messages = phaseOneMessages[locale];
  const workspace = ownerWorkspaceMessages[locale];
  const sectorProfile = sector ? sectorPortalProfile(locale, sector) : null;
  const enabledConfigurations = services
    .flatMap((service) => service.branches)
    .filter((configuration) => configuration.isEnabled);
  const coveredBranches = new Set(enabledConfigurations.map(({ branchId }) => branchId)).size;
  const averageDuration =
    services.length === 0
      ? 0
      : Math.round(
          services.reduce((total, service) => total + service.defaultDurationMins, 0) /
            services.length,
        );

  return (
    <section className="page-stack" aria-labelledby="services-title">
      <DashboardPageHero
        description={sectorProfile?.servicesDescription ?? workspace.serviceDescription}
        eyebrow={workspace.workspace}
        icon="◇"
        title={sectorProfile?.services ?? messages.services}
        titleId="services-title"
      />
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />

      <dl className="workspace-metrics">
        <div>
          <span aria-hidden="true">◇</span>
          <dt>{workspace.serviceCount}</dt>
          <dd>{services.length}</dd>
        </div>
        <div>
          <span aria-hidden="true">⌂</span>
          <dt>{workspace.branchCoverage}</dt>
          <dd>
            {coveredBranches}/{branches.length}
          </dd>
        </div>
        <div>
          <span aria-hidden="true">✓</span>
          <dt>{workspace.enabledBranches}</dt>
          <dd>{enabledConfigurations.length}</dd>
        </div>
        <div>
          <span aria-hidden="true">◷</span>
          <dt>{workspace.averageDuration}</dt>
          <dd>
            {averageDuration} <small>{workspace.minutesShort}</small>
          </dd>
        </div>
      </dl>

      {canManage ? (
        <details className="panel action-disclosure workspace-action">
          <summary>+ {workspace.addServiceSummary}</summary>
          <div className="disclosure-heading">
            <h2>{workspace.addServiceSummary}</h2>
            <p>{workspace.addServiceDescription}</p>
          </div>
          <form action={createServiceAction} className="form-grid workspace-form">
            <input name="locale" type="hidden" value={locale} />
            <label className="field">
              <span className="field-label">{messages.englishName}</span>
              <input className="input" name="nameEn" required />
            </label>
            <label className="field">
              <span className="field-label">{workspace.arabicName}</span>
              <input className="input" dir="rtl" name="nameAr" required />
            </label>
            <label className="field">
              <span className="field-label">{messages.defaultDuration}</span>
              <input
                className="input"
                min={1}
                max={1440}
                name="defaultDurationMins"
                required
                type="number"
              />
            </label>
            <label className="field">
              <span className="field-label">{workspace.priceMinorLabel}</span>
              <input className="input" min={0} name="defaultPriceMinor" type="number" />
              <small className="field-hint">{workspace.priceMinorHint}</small>
            </label>
            <label className="field">
              <span className="field-label">{messages.currency}</span>
              <input
                className="input"
                defaultValue="JOD"
                dir="ltr"
                maxLength={3}
                name="currency"
                required
              />
            </label>
            <div className="form-actions">
              <SubmitButton>{messages.addService}</SubmitButton>
            </div>
          </form>
        </details>
      ) : null}

      <div className="section-heading workspace-section-heading">
        <div>
          <p className="eyebrow">{workspace.businessSetup}</p>
          <h2>{workspace.allServices}</h2>
        </div>
        <span className="section-count">{services.length}</span>
      </div>

      {services.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            ◇
          </span>
          <h2>{workspace.noServices}</h2>
          <p>{workspace.noServicesDescription}</p>
        </div>
      ) : (
        <div className="service-program-grid">
          {services.map((service) => {
            const enabled = service.branches.filter((configuration) => configuration.isEnabled);
            return (
              <article className="record-card service-program-card" key={service.id}>
                <header className="service-program-heading">
                  <span className="service-program-icon" aria-hidden="true">
                    ◇
                  </span>
                  <div>
                    <h3>{locale === "ar" ? service.nameAr : service.nameEn}</h3>
                    <p>{locale === "ar" ? service.nameEn : service.nameAr}</p>
                  </div>
                  <span
                    className={`status ${enabled.length > 0 ? "status-active" : "status-suspended"}`}
                  >
                    {phaseOneValueLabel(locale, enabled.length > 0 ? "ON" : "OFF")}
                  </span>
                </header>

                <dl className="service-facts">
                  <div>
                    <dt>{workspace.basePrice}</dt>
                    <dd>{formatMoney(locale, service.defaultPriceMinor, service.currency)}</dd>
                  </div>
                  <div>
                    <dt>{workspace.duration}</dt>
                    <dd>
                      {service.defaultDurationMins} {workspace.minutesLong}
                    </dd>
                  </div>
                  <div>
                    <dt>{workspace.enabledBranches}</dt>
                    <dd>
                      {enabled.length}/{branches.length}
                    </dd>
                  </div>
                </dl>

                <ul className="branch-configs service-branch-list">
                  {service.branches.map((configuration) => (
                    <li key={configuration.branchId}>
                      <span>
                        {locale === "ar"
                          ? configuration.branch.nameAr
                          : configuration.branch.nameEn}
                      </span>
                      <small>
                        {phaseOneValueLabel(locale, configuration.isEnabled ? "ON" : "OFF")} ·{" "}
                        {formatMoney(
                          locale,
                          configuration.priceMinor ?? service.defaultPriceMinor,
                          service.currency,
                        )}
                        {" · "}
                        {configuration.durationMins ?? service.defaultDurationMins}{" "}
                        {workspace.minutesLong}
                      </small>
                    </li>
                  ))}
                </ul>

                {canManage && branches.length > 0 ? (
                  <details className="inline-disclosure">
                    <summary>{workspace.branchSettings}</summary>
                    <p className="muted">{workspace.branchSettingsDescription}</p>
                    <form action={configureServiceBranchAction} className="compact-form">
                      <input name="locale" type="hidden" value={locale} />
                      <input name="serviceId" type="hidden" value={service.id} />
                      <label className="field">
                        <span className="field-label">{messages.branch}</span>
                        <select className="select" name="branchId" required>
                          {branches.map((branch) => (
                            <option key={branch.id} value={branch.id}>
                              {locale === "ar" ? branch.nameAr : branch.nameEn}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span className="field-label">{messages.priceOverride}</span>
                        <input className="input" min={0} name="priceMinor" type="number" />
                      </label>
                      <label className="field">
                        <span className="field-label">{messages.durationOverride}</span>
                        <input
                          className="input"
                          min={1}
                          max={1440}
                          name="durationMins"
                          type="number"
                        />
                      </label>
                      <label className="check-field">
                        <input defaultChecked name="isEnabled" type="checkbox" />
                        <span>{messages.enabledAtBranch}</span>
                      </label>
                      <SubmitButton tone="secondary">{messages.configure}</SubmitButton>
                    </form>
                  </details>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatMoney(locale: "ar" | "en", minor: number | null, currency: string): string {
  if (minor === null) return "—";
  try {
    return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
      currency,
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
      style: "currency",
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}
