import { randomUUID } from "node:crypto";

import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages } from "../../../../messages/phase-one";
import { phaseTwoMessages } from "../../../../messages/phase-two";
import { phaseThreeLabel, phaseThreeMessages } from "../../../../messages/phase-three";
import { requireTenantAccess, schedulingRepository } from "../../../../server/identity";
import {
  acceptSlotOfferAction,
  cancelWaitlistEntryAction,
  createWaitlistEntryAction,
  declineSlotOfferAction,
  expireSlotOfferAction,
  sendMockSlotOfferAction,
} from "../../actions";

export default async function WaitlistPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/waitlist">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const query = await searchParams;
  const access = await requireTenantAccess(locale);
  const canRead = canAccessResource(access, "waitlist.read", {
    ...(access.staffProfileId ? { staffProfileId: access.staffProfileId } : {}),
  });
  if (!canRead) notFound();
  const canManage = canAccessResource(access, "waitlist.manage");
  const [entries, options] = await Promise.all([
    schedulingRepository.listWaitlist(access),
    canManage ? schedulingRepository.listWaitlistFormOptions(access) : Promise.resolve(null),
  ]);
  const selectedEntry = entries.find(({ id }) => id === stringQuery(query.entryId));
  const selectedBranchId = stringQuery(query.branchId) ?? selectedEntry?.branches[0]?.branchId;
  const selectedProviderId =
    stringQuery(query.providerId) ?? selectedEntry?.providers[0]?.providerId;
  const startsOn =
    validDate(stringQuery(query.startsOn)) ??
    selectedEntry?.preferredStartDate.toISOString().slice(0, 10);
  const endsOn =
    validDate(stringQuery(query.endsOn)) ??
    selectedEntry?.preferredEndDate.toISOString().slice(0, 10);
  const shouldFind = query.find === "1";
  const slots =
    shouldFind && selectedEntry && selectedBranchId && startsOn && endsOn
      ? await schedulingRepository.findAvailableSlots(access, {
          branchId: selectedBranchId,
          endsOn,
          limit: 24,
          localEndMinute: selectedEntry.preferredEndMinute,
          localStartMinute: selectedEntry.preferredStartMinute,
          ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
          serviceId: selectedEntry.serviceId,
          startsOn,
        })
      : [];
  const messages = phaseThreeMessages[locale];
  const phaseOne = phaseOneMessages[locale];
  const phaseTwo = phaseTwoMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="waitlist-title">
      <div>
        <p className="eyebrow">{phaseOne.activeOrganization}</p>
        <h1 id="waitlist-title">{messages.waitlist}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      {options ? (
        <section className="panel" aria-labelledby="waitlist-form-title">
          <h2 id="waitlist-form-title">{messages.addToWaitlist}</h2>
          <form action={createWaitlistEntryAction} className="form-grid">
            <input name="locale" type="hidden" value={locale} />
            <label className="field">
              <span className="field-label">{phaseTwo.customer}</span>
              <select className="select" name="customerId" required>
                {options.customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.displayName}
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
              <span className="field-label">
                {locale === "ar" ? "الفروع المفضلة" : "Preferred branches"}
              </span>
              <select
                className="select"
                multiple
                name="branchIds"
                required
                size={Math.min(4, options.branches.length)}
              >
                {options.branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {locale === "ar" ? branch.nameAr : branch.nameEn}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">
                {locale === "ar"
                  ? "مقدمو الخدمة المفضلون (اختياري)"
                  : "Preferred providers (optional)"}
              </span>
              <select
                className="select"
                multiple
                name="providerIds"
                size={Math.min(4, options.providers.length)}
              >
                {options.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {locale === "ar" ? provider.displayNameAr : provider.displayNameEn}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{locale === "ar" ? "من تاريخ" : "From date"}</span>
              <input className="input" name="preferredStartDate" required type="date" />
            </label>
            <label className="field">
              <span className="field-label">{locale === "ar" ? "إلى تاريخ" : "To date"}</span>
              <input className="input" name="preferredEndDate" required type="date" />
            </label>
            <label className="field">
              <span className="field-label">
                {locale === "ar" ? "دقيقة بدء الفترة" : "Window start minute"}
              </span>
              <input
                className="input"
                defaultValue="540"
                max="1439"
                min="0"
                name="preferredStartMinute"
                required
                type="number"
              />
            </label>
            <label className="field">
              <span className="field-label">
                {locale === "ar" ? "دقيقة نهاية الفترة" : "Window end minute"}
              </span>
              <input
                className="input"
                defaultValue="1020"
                max="1440"
                min="1"
                name="preferredEndMinute"
                required
                type="number"
              />
            </label>
            <label className="field">
              <span className="field-label">{messages.priority}</span>
              <input
                className="input"
                defaultValue="0"
                max="100"
                min="-100"
                name="priority"
                required
                type="number"
              />
            </label>
            <label className="field">
              <span className="field-label">
                {locale === "ar"
                  ? "معرّف موعد لإعادة الجدولة (اختياري)"
                  : "Appointment ID to reschedule (optional)"}
              </span>
              <input className="input" dir="ltr" name="appointmentId" />
            </label>
            <label className="field">
              <span className="field-label">
                {locale === "ar" ? "ملاحظات التفضيل" : "Preference notes"}
              </span>
              <textarea className="input textarea" maxLength={500} name="notes" />
            </label>
            <div className="form-actions">
              <SubmitButton>{messages.addToWaitlist}</SubmitButton>
            </div>
          </form>
        </section>
      ) : null}
      <div className="card-grid">
        {entries.map((entry) => (
          <article className="record-card" key={entry.id}>
            <div>
              <span className="status">{phaseThreeLabel(locale, entry.status)}</span>
              <h2>{entry.customer.displayName}</h2>
              <p>{locale === "ar" ? entry.service.nameAr : entry.service.nameEn}</p>
              <p className="muted">
                {entry.preferredStartDate.toLocaleDateString(locale === "ar" ? "ar-JO" : "en-JO", {
                  timeZone: "UTC",
                })}
                {" — "}
                {entry.preferredEndDate.toLocaleDateString(locale === "ar" ? "ar-JO" : "en-JO", {
                  timeZone: "UTC",
                })}
                {` · ${entry.preferredStartMinute}–${entry.preferredEndMinute}`}
              </p>
            </div>
            {canManage && ["ACTIVE", "OFFERED"].includes(entry.status) ? (
              <div className="inline-form">
                <form action={`/${locale}/dashboard/waitlist`} method="get">
                  <input name="entryId" type="hidden" value={entry.id} />
                  <input name="find" type="hidden" value="1" />
                  <label className="field">
                    <span className="field-label">{phaseOne.branch}</span>
                    <select className="select" name="branchId" required>
                      {entry.branches.map(({ branch }) => (
                        <option key={branch.id} value={branch.id}>
                          {locale === "ar" ? branch.nameAr : branch.nameEn}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">{phaseTwo.provider}</span>
                    <select className="select" name="providerId">
                      <option value="">{locale === "ar" ? "أي مقدم" : "Any provider"}</option>
                      {(entry.providers.length > 0
                        ? entry.providers.map(({ provider }) => provider)
                        : (options?.providers ?? [])
                      ).map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {locale === "ar" ? provider.displayNameAr : provider.displayNameEn}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    name="startsOn"
                    type="hidden"
                    value={entry.preferredStartDate.toISOString().slice(0, 10)}
                  />
                  <input
                    name="endsOn"
                    type="hidden"
                    value={entry.preferredEndDate.toISOString().slice(0, 10)}
                  />
                  <SubmitButton tone="secondary">{messages.findSlots}</SubmitButton>
                </form>
                <form action={cancelWaitlistEntryAction}>
                  <input name="locale" type="hidden" value={locale} />
                  <input name="entryId" type="hidden" value={entry.id} />
                  <input name="expectedVersion" type="hidden" value={entry.version} />
                  <SubmitButton tone="danger">{phaseTwo.cancel}</SubmitButton>
                </form>
              </div>
            ) : null}
            {entry.offers.length > 0 ? (
              <div>
                <h3>{messages.slotOffers}</h3>
                <ul className="history-list">
                  {entry.offers.map((offer) => (
                    <li key={offer.id}>
                      <span className="status">{phaseThreeLabel(locale, offer.status)}</span>
                      <span>
                        {offer.startsAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO", {
                          timeZone: offer.timezone,
                        })}
                      </span>
                      <small>
                        {messages.expires}:{" "}
                        {offer.expiresAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO", {
                          timeZone: offer.timezone,
                        })}
                      </small>
                      {canManage && offer.status === "PENDING" ? (
                        <div className="inline-form">
                          <OfferAction
                            action={acceptSlotOfferAction}
                            label={messages.acceptOffer}
                            locale={locale}
                            offerId={offer.id}
                          />
                          <OfferAction
                            action={declineSlotOfferAction}
                            label={messages.declineOffer}
                            locale={locale}
                            offerId={offer.id}
                            tone="danger"
                          />
                          {offer.expiresAt <= new Date() ? (
                            <OfferAction
                              action={expireSlotOfferAction}
                              label={messages.expireOffer}
                              locale={locale}
                              offerId={offer.id}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {shouldFind && selectedEntry ? (
        <section className="panel" aria-labelledby="slots-title">
          <h2 id="slots-title">{messages.availability}</h2>
          <p className="feedback feedback-info">{messages.mockedDelivery}</p>
          {slots.length === 0 ? (
            <p>{phaseOne.noRecords}</p>
          ) : (
            <div className="card-grid">
              {slots.map((slot) => (
                <article
                  className="record-card"
                  key={`${slot.providerId}-${slot.startsAt.toISOString()}`}
                >
                  <strong>
                    {slot.startsAt.toLocaleString(locale === "ar" ? "ar-JO" : "en-JO", {
                      timeZone: slot.timezone,
                    })}
                  </strong>
                  <span className="status">{messages.conflictProtected}</span>
                  <form action={sendMockSlotOfferAction}>
                    <input name="locale" type="hidden" value={locale} />
                    <input name="waitlistEntryId" type="hidden" value={selectedEntry.id} />
                    <input name="branchId" type="hidden" value={selectedBranchId} />
                    <input name="providerId" type="hidden" value={slot.providerId} />
                    <input name="startsAtLocal" type="hidden" value={slot.startsAtLocal} />
                    <input name="expiresInHours" type="hidden" value="24" />
                    <SubmitButton>{messages.sendMockOffer}</SubmitButton>
                  </form>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}

function OfferAction({
  action,
  label,
  locale,
  offerId,
  tone = "secondary",
}: Readonly<{
  action: (formData: FormData) => Promise<never>;
  label: string;
  locale: "ar" | "en";
  offerId: string;
  tone?: "danger" | "secondary";
}>) {
  return (
    <form action={action}>
      <input name="locale" type="hidden" value={locale} />
      <input name="offerId" type="hidden" value={offerId} />
      <input name="requestKey" type="hidden" value={randomUUID()} />
      <SubmitButton tone={tone}>{label}</SubmitButton>
    </form>
  );
}

function stringQuery(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validDate(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}
