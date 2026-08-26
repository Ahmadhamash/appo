import { randomUUID } from "node:crypto";

import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { AppointmentStatus } from "@jormall/db/generated/enums";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../../components/feedback";
import { SubmitButton } from "../../../../../components/submit-button";
import { MessageTimeline } from "../../../../../components/message-timeline";
import { phaseOneMessages } from "../../../../../messages/phase-one";
import { phaseTwoLabel, phaseTwoMessages } from "../../../../../messages/phase-two";
import {
  communicationRepository,
  crmAppointmentRepository,
  requireTenantAccess,
} from "../../../../../server/identity";
import {
  addAppointmentNoteAction,
  rescheduleAppointmentAction,
  transitionAppointmentAction,
} from "../../../actions";

export default async function AppointmentPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/appointments/[appointmentId]">) {
  const { appointmentId, locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([requireTenantAccess(locale), searchParams]);
  const appointment = await crmAppointmentRepository.getAppointment(access, appointmentId);
  const resource = { branchId: appointment.branchId, staffProfileId: appointment.providerId };
  const canReschedule = canAccessResource(access, "appointments.reschedule", resource);
  const canCancel = canAccessResource(access, "appointments.cancel", resource);
  const canTransition = canAccessResource(access, "appointments.status.transition", resource);
  const canReadOperational = canAccessResource(access, "appointment_records.read", resource);
  const canWriteOperational = canAccessResource(access, "appointment_records.write", resource);
  const canReadMessages = canAccessResource(access, "messages.read", resource);
  const messageTimeline = canReadMessages
    ? await communicationRepository.listAppointmentMessages(access, appointment.id)
    : [];
  const operational = canReadOperational
    ? await crmAppointmentRepository.getAppointmentOperationalDetail(access, appointment.id)
    : null;
  const phaseOne = phaseOneMessages[locale];
  const messages = phaseTwoMessages[locale];
  const localStart = localInputValue(appointment.startsAt, appointment.timezone);
  return (
    <section className="page-stack" aria-labelledby="appointment-title">
      <div>
        <p className="eyebrow">{messages.appointment}</p>
        <h1 id="appointment-title">{appointment.customer.displayName}</h1>
        <p className="muted">
          {phaseTwoLabel(locale, appointment.status)} ·{" "}
          {appointment.startsAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO", {
            timeZone: appointment.timezone,
          })}
        </p>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <section className="panel" aria-label={messages.appointment}>
        <dl className="details-list">
          <div>
            <dt>{phaseOne.branch}</dt>
            <dd>{locale === "ar" ? appointment.branch.nameAr : appointment.branch.nameEn}</dd>
          </div>
          <div>
            <dt>{phaseOne.service}</dt>
            <dd>{locale === "ar" ? appointment.service.nameAr : appointment.service.nameEn}</dd>
          </div>
          <div>
            <dt>{messages.provider}</dt>
            <dd>
              {locale === "ar"
                ? appointment.provider.displayNameAr
                : appointment.provider.displayNameEn}
            </dd>
          </div>
          <div>
            <dt>{messages.endTime}</dt>
            <dd>
              {appointment.endsAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO", {
                timeZone: appointment.timezone,
              })}
            </dd>
          </div>
        </dl>
      </section>
      {canReschedule &&
      (appointment.status === AppointmentStatus.PENDING ||
        appointment.status === AppointmentStatus.CONFIRMED) ? (
        <form action={rescheduleAppointmentAction} className="panel inline-form">
          <input name="locale" type="hidden" value={locale} />
          <input name="appointmentId" type="hidden" value={appointment.id} />
          <input name="expectedVersion" type="hidden" value={appointment.version} />
          <input name="idempotencyKey" type="hidden" value={randomUUID()} />
          <label className="field">
            <span className="field-label">{messages.reschedule}</span>
            <input
              className="input"
              defaultValue={localStart}
              name="startsAtLocal"
              required
              type="datetime-local"
            />
          </label>
          <SubmitButton tone="secondary">{messages.reschedule}</SubmitButton>
        </form>
      ) : null}
      <section className="panel page-stack" aria-labelledby="appointment-actions-title">
        <h2 id="appointment-actions-title">
          {locale === "ar" ? "إجراءات الموعد" : "Appointment actions"}
        </h2>
        <div className="row-actions">
          {appointment.status === AppointmentStatus.PENDING && canTransition ? (
            <TransitionButton
              appointment={appointment}
              label={locale === "ar" ? "تأكيد" : "Confirm"}
              locale={locale}
              status={AppointmentStatus.CONFIRMED}
            />
          ) : null}
          {appointment.status === AppointmentStatus.CONFIRMED && canTransition ? (
            <TransitionButton
              appointment={appointment}
              label={messages.checkIn}
              locale={locale}
              status={AppointmentStatus.CHECKED_IN}
            />
          ) : null}
          {(appointment.status === AppointmentStatus.CONFIRMED ||
            appointment.status === AppointmentStatus.CHECKED_IN) &&
          canTransition ? (
            <TransitionButton
              appointment={appointment}
              label={messages.start}
              locale={locale}
              status={AppointmentStatus.IN_PROGRESS}
            />
          ) : null}
          {appointment.status === AppointmentStatus.CONFIRMED && canTransition ? (
            <TransitionButton
              appointment={appointment}
              label={messages.markNoShow}
              locale={locale}
              reasonRequired
              status={AppointmentStatus.NO_SHOW}
            />
          ) : null}
        </div>
        {appointment.status === AppointmentStatus.IN_PROGRESS && canTransition ? (
          <form action={transitionAppointmentAction} className="form-grid">
            <TransitionHidden
              appointment={appointment}
              locale={locale}
              status={AppointmentStatus.COMPLETED}
            />
            <label className="field">
              <span className="field-label">{messages.recordSummary}</span>
              <input className="input" name="recordSummary" required />
            </label>
            <label className="field">
              <span className="field-label">{messages.recordDetails}</span>
              <textarea className="input textarea" name="recordDetails" />
            </label>
            <div className="form-actions">
              <SubmitButton>{messages.complete}</SubmitButton>
            </div>
          </form>
        ) : null}
        {canCancel &&
        (appointment.status === AppointmentStatus.PENDING ||
          appointment.status === AppointmentStatus.CONFIRMED ||
          appointment.status === AppointmentStatus.CHECKED_IN) ? (
          <form action={transitionAppointmentAction} className="inline-form">
            <TransitionHidden
              appointment={appointment}
              locale={locale}
              status={AppointmentStatus.CANCELLED}
            />
            <label className="field">
              <span className="field-label">
                {locale === "ar" ? "سبب الإلغاء" : "Cancellation reason"}
              </span>
              <input className="input" name="reason" required />
            </label>
            <SubmitButton tone="danger">{messages.cancel}</SubmitButton>
          </form>
        ) : null}
      </section>
      {operational ? (
        <section className="panel page-stack" aria-labelledby="operations-title">
          <h2 id="operations-title">
            {locale === "ar" ? "التشغيل الداخلي" : "Internal operations"}
          </h2>
          {operational.record ? (
            <article>
              <h3>{messages.recordSummary}</h3>
              <p>{operational.record.summary}</p>
              {operational.record.details ? (
                <p className="muted">{operational.record.details}</p>
              ) : null}
            </article>
          ) : null}
          <div>
            <h3>{messages.internalNote}</h3>
            <ul className="note-list">
              {operational.notes.map((note) => (
                <li key={note.id}>
                  <strong>{note.author.name}</strong>
                  <span>{note.body}</span>
                </li>
              ))}
            </ul>
          </div>
          {canWriteOperational ? (
            <form action={addAppointmentNoteAction} className="form-stack">
              <input name="locale" type="hidden" value={locale} />
              <input name="appointmentId" type="hidden" value={appointment.id} />
              <label className="field">
                <span className="field-label">{messages.internalNote}</span>
                <textarea className="input textarea" name="body" required />
              </label>
              <div>
                <SubmitButton tone="secondary">
                  {locale === "ar" ? "إضافة ملاحظة" : "Add note"}
                </SubmitButton>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}
      <section className="panel" aria-labelledby="history-title">
        <h2 id="history-title">{locale === "ar" ? "سجل الحالة" : "Status history"}</h2>
        <ul className="history-list">
          {appointment.history.map((entry) => (
            <li key={entry.id}>
              {entry.fromStatus ? `${phaseTwoLabel(locale, entry.fromStatus)} → ` : ""}
              {phaseTwoLabel(locale, entry.toStatus)}{" "}
              <small>{entry.createdAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO")}</small>
            </li>
          ))}
        </ul>
      </section>
      {canReadMessages ? <MessageTimeline locale={locale} messages={messageTimeline} /> : null}
    </section>
  );
}

function TransitionButton({
  appointment,
  label,
  locale,
  reasonRequired,
  status,
}: Readonly<{
  appointment: { id: string; version: number };
  label: string;
  locale: "ar" | "en";
  reasonRequired?: boolean;
  status: AppointmentStatus;
}>) {
  if (reasonRequired) {
    return (
      <form action={transitionAppointmentAction} className="inline-form">
        <TransitionHidden appointment={appointment} locale={locale} status={status} />
        <label className="sr-only" htmlFor={`reason-${status}`}>
          {locale === "ar" ? "السبب" : "Reason"}
        </label>
        <input
          className="input"
          id={`reason-${status}`}
          name="reason"
          placeholder={locale === "ar" ? "السبب" : "Reason"}
          required
        />
        <SubmitButton tone="secondary">{label}</SubmitButton>
      </form>
    );
  }
  return (
    <form action={transitionAppointmentAction}>
      <TransitionHidden appointment={appointment} locale={locale} status={status} />
      <SubmitButton tone="secondary">{label}</SubmitButton>
    </form>
  );
}

function TransitionHidden({
  appointment,
  locale,
  status,
}: Readonly<{
  appointment: { id: string; version: number };
  locale: "ar" | "en";
  status: AppointmentStatus;
}>) {
  return (
    <>
      <input name="locale" type="hidden" value={locale} />
      <input name="appointmentId" type="hidden" value={appointment.id} />
      <input name="expectedVersion" type="hidden" value={appointment.version} />
      <input name="idempotencyKey" type="hidden" value={randomUUID()} />
      <input name="toStatus" type="hidden" value={status} />
    </>
  );
}

function localInputValue(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  })
    .formatToParts(date)
    .filter((part) => part.type !== "literal");
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour === "24" ? "00" : value.hour}:${value.minute}`;
}
