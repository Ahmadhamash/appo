import { isSupportedLocale } from "@jormall/contracts/locales";
import { BusinessSector } from "@jormall/db/generated/enums";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages } from "../../../../messages/phase-one";
import { sectorMessages, sectorValueLabel } from "../../../../messages/sectors";
import { identityRepository, requirePagePermission } from "../../../../server/identity";
import { setBusinessSectorAction, updateSettingsAction } from "../../actions";

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
  return (
    <section className="page-stack" aria-labelledby="settings-title">
      <div>
        <p className="eyebrow">{messages.activeOrganization}</p>
        <h1 id="settings-title">{messages.organizationSettings}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <form action={setBusinessSectorAction} className="panel form-grid">
        <input name="locale" type="hidden" value={locale} />
        <input name="returnTo" type="hidden" value={`/${locale}/dashboard/settings`} />
        <label className="field field-span">
          <span className="field-label">{sectors.sectorSettings}</span>
          <select
            className="select"
            defaultValue={settings.businessSector ?? ""}
            name="businessSector"
            required
          >
            <option disabled value="">
              {sectors.chooseSectorTitle}
            </option>
            {Object.values(BusinessSector).map((sector) => (
              <option key={sector} value={sector}>
                {sectorValueLabel(locale, sector)}
              </option>
            ))}
          </select>
          <small className="field-hint">{sectors.sectorCanChange}</small>
        </label>
        <div className="form-actions field-span">
          <SubmitButton>{sectors.chooseSector}</SubmitButton>
        </div>
      </form>
      <form action={updateSettingsAction} className="panel form-grid">
        <input name="locale" type="hidden" value={locale} />
        <label className="field">
          <span className="field-label">{messages.defaultLocale}</span>
          <select className="select" defaultValue={settings.defaultLocale} name="defaultLocale">
            <option value="en">English</option>
            <option value="ar">العربية</option>
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
        </label>
        <div className="form-actions">
          <SubmitButton>{messages.save}</SubmitButton>
        </div>
      </form>
    </section>
  );
}
