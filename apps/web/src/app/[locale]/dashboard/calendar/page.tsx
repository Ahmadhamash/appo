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
    day: validDay(stringQuery(query.day)) ?? ammanDay(new Date()),
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
  const week = weekAround(filter.day);
  return (
    <section className="page-stack calendar-workspace" aria-labelledby="calendar-title">
      <header className="page-heading calendar-heading">
        <div>
          <p className="eyebrow">{phaseOne.activeOrganization}</p>
          <h1 id="calendar-title">{messages.calendar}</h1>
          <p className="page-description">
            {new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
              dateStyle: "long",
              timeZone: "UTC",
            }).format(new Date(`${filter.day}T00:00:00Z`))}
          </p>
        </div>
        <Link className="button button-secondary" href={`/${locale}/dashboard/today`}>
          {locale === "ar" ? "عمليات اليوم" : "Today operations"}
        </Link>
      </header>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <nav
        className="calendar-week-strip"
        aria-label={locale === "ar" ? "اختيار يوم" : "Choose day"}
      >
        {week.map((day) => (
          <Link
            aria-current={day.value === filter.day ? "date" : undefined}
            href={calendarHref(locale, day.value, filter)}
            key={day.value}
          >
            <small>
              {new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
                weekday: "short",
                timeZone: "UTC",
              }).format(day.date)}
            </small>
            <strong>
              {new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
                day: "numeric",
                timeZone: "UTC",
              }).format(day.date)}
            </strong>
          </Link>
        ))}
      </nav>
      <details
        className="panel calendar-filters"
        open={Boolean(filter.branchId || filter.providerId || filter.serviceId || filter.status)}
      >
        <summary>{locale === "ar" ? "فلترة التقويم" : "Filter calendar"}</summary>
        <form action={`/${locale}/dashboard/calendar`} className="form-grid" method="get">
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
      </details>
      {options ? (
        <details className="panel action-disclosure calendar-create">
          <summary id="create-appointment-title">+ {messages.createAppointment}</summary>
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
        </details>
      ) : null}
      {appointments.length === 0 ? (
        <div className="empty-state calendar-empty">
          <span className="empty-state-icon" aria-hidden="true">
            ▦
          </span>
          <h2>{locale === "ar" ? "اليوم فاضي" : "This day is clear"}</h2>
          <p>
            {locale === "ar"
              ? "ما في مواعيد حسب الفلاتر الحالية."
              : "No appointments match the current filters."}
          </p>
        </div>
      ) : (
        <ol className="calendar-agenda" aria-label={messages.appointments}>
          {appointments.map((appointment) => (
            <li key={appointment.id}>
              <time>
                {appointment.startsAt.toLocaleTimeString(locale === "ar" ? "ar-JO" : "en-JO", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: appointment.timezone,
                })}
              </time>
              <article
                className="calendar-appointment"
                data-status={appointment.status.toLowerCase()}
              >
                <div className="calendar-appointment-main">
                  <span className="status">{phaseTwoLabel(locale, appointment.status)}</span>
                  <h2>
                    <Link href={`/${locale}/dashboard/appointments/${appointment.id}`}>
                      {appointment.customer.displayName}
                    </Link>
                  </h2>
                  <p>{locale === "ar" ? appointment.service.nameAr : appointment.service.nameEn}</p>
                </div>
                <dl>
                  <div>
                    <dt>{phaseOne.branch}</dt>
                    <dd>
                      {locale === "ar" ? appointment.branch.nameAr : appointment.branch.nameEn}
                    </dd>
                  </div>
                  <div>
                    <dt>{messages.provider}</dt>
                    <dd>
                      {locale === "ar"
                        ? appointment.provider.displayNameAr
                        : appointment.provider.displayNameEn}
                    </dd>
                  </div>
                </dl>
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
              </article>
            </li>
          ))}
        </ol>
      )}
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

function ammanDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Amman",
    year: "numeric",
  }).format(date);
}

function weekAround(day: string): readonly Readonly<{ date: Date; value: string }>[] {
  const selected = new Date(`${day}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(selected);
    date.setUTCDate(selected.getUTCDate() + index - 3);
    return { date, value: date.toISOString().slice(0, 10) };
  });
}

function calendarHref(
  locale: "ar" | "en",
  day: string,
  filter: Readonly<{
    branchId?: string | undefined;
    providerId?: string | undefined;
    serviceId?: string | undefined;
    status?: AppointmentStatus | undefined;
  }>,
): string {
  const query = new URLSearchParams({ day });
  if (filter.branchId) query.set("branchId", filter.branchId);
  if (filter.providerId) query.set("providerId", filter.providerId);
  if (filter.serviceId) query.set("serviceId", filter.serviceId);
  if (filter.status) query.set("status", filter.status);
  return `/${locale}/dashboard/calendar?${query.toString()}`;
}
