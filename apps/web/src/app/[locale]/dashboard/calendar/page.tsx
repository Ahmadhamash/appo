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
import { phaseThreeMessages } from "../../../../messages/phase-three";
import { crmAppointmentRepository, requireTenantAccess } from "../../../../server/identity";
import { createAppointmentAction } from "../../actions";

const statuses = Object.values(AppointmentStatus);

export default async function CalendarPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/calendar">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const query = await searchParams;
  const access = await requireTenantAccess(locale);
  const filter = {
    branchId: stringQuery(query.branchId),
    day: validDay(stringQuery(query.day)),
    providerId: stringQuery(query.providerId),
    serviceId: stringQuery(query.serviceId),
    status: statuses.includes(stringQuery(query.status) as AppointmentStatus)
      ? (stringQuery(query.status) as AppointmentStatus)
      : undefined,
  };
  const canCreate = canAccessResource(access, "appointments.create");
  const [appointments, options] = await Promise.all([
    crmAppointmentRepository.listAppointments(access, filter),
    canCreate ? crmAppointmentRepository.listAppointmentFormOptions(access) : Promise.resolve(null),
  ]);
  const phaseOne = phaseOneMessages[locale];
  const messages = phaseTwoMessages[locale];
  const phaseThree = phaseThreeMessages[locale];
  const distinct = {
    branches: distinctBy(appointments.map((appointment) => appointment.branch)),
    providers: distinctBy(appointments.map((appointment) => appointment.provider)),
    services: distinctBy(appointments.map((appointment) => appointment.service)),
  };
  return (
    <section className="page-stack" aria-labelledby="calendar-title">
      <div>
        <p className="eyebrow">{phaseOne.activeOrganization}</p>
        <h1 id="calendar-title">{messages.calendar}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <form action={`/${locale}/dashboard/calendar`} className="panel form-grid" method="get">
        <label className="field">
          <span className="field-label">{locale === "ar" ? "اليوم" : "Day"}</span>
          <input className="input" defaultValue={filter.day} name="day" type="date" />
        </label>
        <label className="field">
          <span className="field-label">{phaseOne.branch}</span>
          <select className="select" defaultValue={filter.branchId ?? ""} name="branchId">
            <option value="">{locale === "ar" ? "كل الفروع" : "All branches"}</option>
            {distinct.branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {locale === "ar" ? branch.nameAr : branch.nameEn}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{messages.provider}</span>
          <select className="select" defaultValue={filter.providerId ?? ""} name="providerId">
            <option value="">{locale === "ar" ? "كل مقدمي الخدمة" : "All providers"}</option>
            {distinct.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {locale === "ar" ? provider.displayNameAr : provider.displayNameEn}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{phaseOne.service}</span>
          <select className="select" defaultValue={filter.serviceId ?? ""} name="serviceId">
            <option value="">{locale === "ar" ? "كل الخدمات" : "All services"}</option>
            {distinct.services.map((service) => (
              <option key={service.id} value={service.id}>
                {locale === "ar" ? service.nameAr : service.nameEn}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{messages.status}</span>
          <select className="select" defaultValue={filter.status ?? ""} name="status">
            <option value="">{locale === "ar" ? "كل الحالات" : "All statuses"}</option>
            {statuses.map((status) => (
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
      {options ? (
        <section className="panel" aria-labelledby="create-appointment-title">
          <h2 id="create-appointment-title">{messages.createAppointment}</h2>
          <form action={createAppointmentAction} className="form-grid">
            <input name="locale" type="hidden" value={locale} />
            <input name="idempotencyKey" type="hidden" value={randomUUID()} />
            <label className="field">
              <span className="field-label">{messages.customer}</span>
              <select className="select" name="customerId" required>
                {options.customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{phaseOne.branch}</span>
              <select className="select" name="branchId" required>
                {options.branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {locale === "ar" ? branch.nameAr : branch.nameEn}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{phaseOne.service}</span>
              <select className="select" name="serviceId" required>
                {options.services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {locale === "ar" ? service.nameAr : service.nameEn}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{messages.provider}</span>
              <select className="select" name="providerId" required>
                {options.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {locale === "ar" ? provider.displayNameAr : provider.displayNameEn}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{messages.startTime}</span>
              <input className="input" name="startsAtLocal" required type="datetime-local" />
            </label>
            <label className="field">
              <span className="field-label">{messages.status}</span>
              <select className="select" defaultValue={AppointmentStatus.CONFIRMED} name="status">
                <option value={AppointmentStatus.PENDING}>
                  {phaseTwoLabel(locale, AppointmentStatus.PENDING)}
                </option>
                <option value={AppointmentStatus.CONFIRMED}>
                  {phaseTwoLabel(locale, AppointmentStatus.CONFIRMED)}
                </option>
              </select>
            </label>
            <div className="form-actions">
              <SubmitButton>{messages.createAppointment}</SubmitButton>
            </div>
          </form>
        </section>
      ) : null}
      <div className="table-wrap">
        <table>
          <caption className="sr-only">{messages.appointments}</caption>
          <thead>
            <tr>
              <th>{messages.startTime}</th>
              <th>{messages.customer}</th>
              <th>{phaseOne.branch}</th>
              <th>{messages.provider}</th>
              <th>{phaseOne.service}</th>
              <th>{messages.status}</th>
              <th>{locale === "ar" ? "تعارض الموارد" : "Resource conflict"}</th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((appointment) => (
              <tr key={appointment.id}>
                <td>
                  <Link href={`/${locale}/dashboard/appointments/${appointment.id}`}>
                    {appointment.startsAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO", {
                      timeZone: appointment.timezone,
                    })}
                  </Link>
                </td>
                <td>{appointment.customer.displayName}</td>
                <td>{locale === "ar" ? appointment.branch.nameAr : appointment.branch.nameEn}</td>
                <td>
                  {locale === "ar"
                    ? appointment.provider.displayNameAr
                    : appointment.provider.displayNameEn}
                </td>
                <td>{locale === "ar" ? appointment.service.nameAr : appointment.service.nameEn}</td>
                <td>{phaseTwoLabel(locale, appointment.status)}</td>
                <td>
                  <span
                    className={
                      appointment.conflictIndicator === "MISSING_RESOURCE"
                        ? "status status-suspended"
                        : "status status-active"
                    }
                  >
                    {appointment.conflictIndicator === "MISSING_RESOURCE"
                      ? locale === "ar"
                        ? "يلزم ضبط الموارد"
                        : "Resource setup required"
                      : appointment.conflictIndicator === "RELEASED"
                        ? locale === "ar"
                          ? "تم تحرير الحجز"
                          : "Reservation released"
                        : phaseThree.conflictProtected}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function stringQuery(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validDay(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function distinctBy<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}
