import { isSupportedLocale } from "@jormall/contracts/locales";
import { OrganizationStatus } from "@jormall/db/generated/enums";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { OrganizationCreationForm } from "../../../../components/organization-creation-form";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages, phaseOneValueLabel } from "../../../../messages/phase-one";
import { phaseFourMessages } from "../../../../messages/phase-four";
import { communicationRepository, identityRepository } from "../../../../server/identity";
import { requireSession } from "../../../../server/session";
import { logoutAction, setOrganizationStatusAction, startSupportAccessAction } from "../../actions";

export default async function OrganizationsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/platform/organizations">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [session, query] = await Promise.all([requireSession(locale), searchParams]);
  await identityRepository.assertSuperAdmin(session.user.id);
  const [organizations, workers] = await Promise.all([
    identityRepository.listOrganizations(session.user.id),
    communicationRepository.listWorkerHealth(session.user.id),
  ]);
  const messages = phaseOneMessages[locale];
  const phaseFour = phaseFourMessages[locale];
  return (
    <div className="platform-shell">
      <header className="app-header">
        <Link className="brand" href={`/${locale}/platform/organizations`}>
          <span className="brand-mark" aria-hidden="true">
            J
          </span>
          <span>
            <strong>{messages.platformAdmin}</strong>
            <small>{messages.jormallOrganizations}</small>
          </span>
        </Link>
        <div className="header-actions">
          <Link className="button button-secondary" href={`/${locale}/platform/audit`}>
            {locale === "ar" ? "سجل المنصة" : "Platform audit"}
          </Link>
          <Link className="button button-secondary" href={`/${locale}/dashboard`}>
            {messages.dashboard}
          </Link>
          <form action={logoutAction}>
            <input name="locale" type="hidden" value={locale} />
            <SubmitButton tone="secondary">{messages.logout}</SubmitButton>
          </form>
        </div>
      </header>
      <main className="main-content wide-content">
        <section className="page-stack" aria-labelledby="organizations-title">
          <div>
            <p className="eyebrow">{messages.platformAdmin}</p>
            <h1 id="organizations-title">{messages.organizations}</h1>
          </div>
          <Feedback
            error={typeof query.error === "string" ? query.error : undefined}
            locale={locale}
            notice={typeof query.notice === "string" ? query.notice : undefined}
          />
          <OrganizationCreationForm locale={locale} />
          <section className="panel" aria-labelledby="worker-health-title">
            <h2 id="worker-health-title">{phaseFour.workerHealth}</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{locale === "ar" ? "العامل" : "Worker"}</th>
                    <th>{messages.status}</th>
                    <th>{locale === "ar" ? "آخر نبضة" : "Last heartbeat"}</th>
                    <th>{locale === "ar" ? "تمت المعالجة" : "Processed"}</th>
                    <th>{locale === "ar" ? "فشل" : "Failed"}</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((worker) => (
                    <tr key={worker.workerId}>
                      <td dir="ltr">{worker.workerId}</td>
                      <td>{worker.status}</td>
                      <td>
                        {worker.lastSeenAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO")}
                      </td>
                      <td>{worker.processedCount}</td>
                      <td>{worker.failedCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {workers.length === 0 ? (
              <p className="muted">
                {locale === "ar"
                  ? "لم يسجل أي عامل نبضة بعد."
                  : "No worker heartbeat recorded yet."}
              </p>
            ) : null}
          </section>
          <div className="card-grid">
            {organizations.map((organization) => (
              <article className="record-card organization-card" key={organization.id}>
                <div>
                  <span className={`status status-${organization.status.toLowerCase()}`}>
                    {phaseOneValueLabel(locale, organization.status)}
                  </span>
                  <h2>{locale === "ar" ? organization.nameAr : organization.nameEn}</h2>
                  <p className="muted" dir="ltr">
                    {organization.slug}
                  </p>
                  {organization.suspensionReason ? <p>{organization.suspensionReason}</p> : null}
                </div>
                <div className="organization-actions">
                  <form action={setOrganizationStatusAction} className="compact-form">
                    <input name="locale" type="hidden" value={locale} />
                    <input name="organizationId" type="hidden" value={organization.id} />
                    <input
                      name="status"
                      type="hidden"
                      value={
                        organization.status === OrganizationStatus.ACTIVE
                          ? OrganizationStatus.SUSPENDED
                          : OrganizationStatus.ACTIVE
                      }
                    />
                    {organization.status === OrganizationStatus.ACTIVE ? (
                      <label className="field">
                        <span className="field-label">{messages.suspensionReason}</span>
                        <input className="input" minLength={10} name="reason" required />
                      </label>
                    ) : null}
                    <SubmitButton
                      tone={
                        organization.status === OrganizationStatus.ACTIVE ? "danger" : "secondary"
                      }
                    >
                      {organization.status === OrganizationStatus.ACTIVE
                        ? messages.suspend
                        : messages.activate}
                    </SubmitButton>
                  </form>
                  {organization.status === OrganizationStatus.ACTIVE ? (
                    <form action={startSupportAccessAction} className="compact-form">
                      <input name="locale" type="hidden" value={locale} />
                      <input name="organizationId" type="hidden" value={organization.id} />
                      <label className="field">
                        <span className="field-label">{messages.supportReason}</span>
                        <input className="input" minLength={10} name="reason" required />
                      </label>
                      <SubmitButton tone="secondary">{messages.startSupport}</SubmitButton>
                    </form>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
