import { randomUUID } from "node:crypto";

import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { AppointmentStatus } from "@jormall/db/generated/enums";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages } from "../../../../messages/phase-one";
import { phaseTwoLabel, phaseTwoMessages } from "../../../../messages/phase-two";
import { crmAppointmentRepository, requireTenantAccess } from "../../../../server/identity";
import { transitionAppointmentAction } from "../../actions";

export default async function TodayPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/today">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([requireTenantAccess(locale), searchParams]);
  const filters = {
    branchId: text(query.branchId),
    providerId: text(query.providerId),
    serviceId: text(query.serviceId),
    status: Object.values(AppointmentStatus).includes(text(query.status) as AppointmentStatus)
      ? (text(query.status) as AppointmentStatus)
      : undefined,
  };
  const appointments = await crmAppointmentRepository.listTodayOperations(access, filters);
  const phaseOne = phaseOneMessages[locale];
  const messages = phaseTwoMessages[locale];
  const branches = distinct(appointments.map((appointment) => appointment.branch));
  const providers = distinct(appointments.map((appointment) => appointment.provider));
  const services = distinct(appointments.map((appointment) => appointment.service));
  return (
    <section className="page-stack" aria-labelledby="today-title">
      <div>
        <p className="eyebrow">Asia/Amman</p>
        <h1 id="today-title">{messages.operationsToday}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <form action={`/${locale}/dashboard/today`} className="panel form-grid" method="get">
        <label className="field">
          <span className="field-label">{phaseOne.branch}</span>
          <select className="select" defaultValue={filters.branchId ?? ""} name="branchId">
            <option value="">{locale === "ar" ? "كل الفروع" : "All branches"}</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {locale === "ar" ? branch.nameAr : branch.nameEn}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{messages.provider}</span>
          <select className="select" defaultValue={filters.providerId ?? ""} name="providerId">
            <option value="">{locale === "ar" ? "الكل" : "All"}</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {locale === "ar" ? provider.displayNameAr : provider.displayNameEn}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{phaseOne.service}</span>
          <select className="select" defaultValue={filters.serviceId ?? ""} name="serviceId">
            <option value="">{locale === "ar" ? "الكل" : "All"}</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {locale === "ar" ? service.nameAr : service.nameEn}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{messages.status}</span>
          <select className="select" defaultValue={filters.status ?? ""} name="status">
            <option value="">{locale === "ar" ? "الكل" : "All"}</option>
            {Object.values(AppointmentStatus).map((status) => (
              <option key={status} value={status}>
                {phaseTwoLabel(locale, status)}
              </option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <SubmitButton tone="secondary">{messages.filters}</SubmitButton>
        </div>
      </form>
      <div className="card-grid">
        {appointments.map((appointment) => {
          const resource = {
            branchId: appointment.branchId,
            staffProfileId: appointment.providerId,
          };
          const canTransition = canAccessResource(
            access,
            "appointments.status.transition",
            resource,
          );
          return (
            <article className="record-card" key={appointment.id}>
              <div>
                <h2>
                  <Link href={`/${locale}/dashboard/appointments/${appointment.id}`}>
                    {appointment.customer.displayName}
                  </Link>
                </h2>
                <p>
                  {appointment.startsAt.toLocaleTimeString(locale === "ar" ? "ar-JO" : "en-JO", {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: appointment.timezone,
                  })}{" "}
                  · {locale === "ar" ? appointment.service.nameAr : appointment.service.nameEn}
                </p>
                <span className="status">{phaseTwoLabel(locale, appointment.status)}</span>
              </div>
              {canTransition ? (
                <div className="row-actions">
                  {appointment.status === AppointmentStatus.CONFIRMED ? (
                    <Transition
                      form={{
                        appointmentId: appointment.id,
                        expectedVersion: appointment.version,
                        status: AppointmentStatus.CHECKED_IN,
                      }}
                      label={messages.checkIn}
                      locale={locale}
                    />
                  ) : null}
                  {appointment.status === AppointmentStatus.CONFIRMED ||
                  appointment.status === AppointmentStatus.CHECKED_IN ? (
                    <Transition
                      form={{
                        appointmentId: appointment.id,
                        expectedVersion: appointment.version,
                        status: AppointmentStatus.IN_PROGRESS,
                      }}
                      label={messages.start}
                      locale={locale}
                    />
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Transition({
  form,
  label,
  locale,
}: Readonly<{
  form: { appointmentId: string; expectedVersion: number; status: AppointmentStatus };
  label: string;
  locale: "ar" | "en";
}>) {
  return (
    <form action={transitionAppointmentAction}>
      <input name="locale" type="hidden" value={locale} />
      <input name="appointmentId" type="hidden" value={form.appointmentId} />
      <input name="expectedVersion" type="hidden" value={form.expectedVersion} />
      <input name="idempotencyKey" type="hidden" value={randomUUID()} />
      <input name="toStatus" type="hidden" value={form.status} />
      <SubmitButton tone="secondary">{label}</SubmitButton>
    </form>
  );
}

function text(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
function distinct<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}
