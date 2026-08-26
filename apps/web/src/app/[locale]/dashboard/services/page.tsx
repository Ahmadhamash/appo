import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages, phaseOneValueLabel } from "../../../../messages/phase-one";
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
  const [services, branches] = await Promise.all([
    identityRepository.listServices(access),
    identityRepository.listBranches(access),
  ]);
  const messages = phaseOneMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="services-title">
      <div>
        <p className="eyebrow">{messages.activeOrganization}</p>
        <h1 id="services-title">{messages.services}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      {canManage ? (
        <form action={createServiceAction} className="panel form-grid">
          <input name="locale" type="hidden" value={locale} />
          <label className="field">
            <span className="field-label">{messages.englishName}</span>
            <input className="input" name="nameEn" required />
          </label>
          <label className="field">
            <span className="field-label">الاسم بالعربية</span>
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
            <span className="field-label">{messages.defaultPrice}</span>
            <input className="input" min={0} name="defaultPriceMinor" type="number" />
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
      ) : null}
      <div className="card-grid">
        {services.map((service) => (
          <article className="record-card service-card" key={service.id}>
            <div>
              <h2>{locale === "ar" ? service.nameAr : service.nameEn}</h2>
              <p className="muted">
                {service.defaultDurationMins} {locale === "ar" ? "دقيقة" : "min"} ·{" "}
                {service.defaultPriceMinor ?? "—"} {service.currency}
              </p>
            </div>
            {canManage && branches.length > 0 ? (
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
                  <input className="input" min={1} max={1440} name="durationMins" type="number" />
                </label>
                <label className="check-field">
                  <input defaultChecked name="isEnabled" type="checkbox" />
                  <span>{messages.enabledAtBranch}</span>
                </label>
                <SubmitButton tone="secondary">{messages.configure}</SubmitButton>
              </form>
            ) : null}
            <ul className="branch-configs">
              {service.branches.map((configuration) => (
                <li key={configuration.branchId}>
                  <span>
                    {locale === "ar" ? configuration.branch.nameAr : configuration.branch.nameEn}
                  </span>
                  <small>
                    {phaseOneValueLabel(locale, configuration.isEnabled ? "ON" : "OFF")} ·{" "}
                    {configuration.priceMinor ?? service.defaultPriceMinor ?? "—"}{" "}
                    {service.currency} · {configuration.durationMins ?? service.defaultDurationMins}{" "}
                    {locale === "ar" ? "دقيقة" : "min"}
                  </small>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
