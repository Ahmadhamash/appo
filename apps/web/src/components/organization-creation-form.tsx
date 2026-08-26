"use client";

import type { SupportedLocale } from "@jormall/contracts/locales";
import { useActionState } from "react";

import { createOrganizationAction } from "../app/[locale]/actions";
import { phaseOneMessages } from "../messages/phase-one";
import { sectorMessages, sectorValueLabel } from "../messages/sectors";
import { Feedback } from "./feedback";
import { SubmitButton } from "./submit-button";

export function OrganizationCreationForm({ locale }: Readonly<{ locale: SupportedLocale }>) {
  const [state, action] = useActionState(createOrganizationAction, {});
  const messages = phaseOneMessages[locale];
  const sectors = sectorMessages[locale];
  const successful = state.code === "ORGANIZATION_CREATED";
  return (
    <div className="page-stack">
      <Feedback
        error={!successful ? state.code : undefined}
        invitation={state.invitationUrl}
        locale={locale}
        notice={successful ? state.code : undefined}
      />
      <form action={action} className="panel form-grid">
        <input name="locale" type="hidden" value={locale} />
        <fieldset className="field field-span sector-create-fieldset">
          <legend className="field-label">{sectors.chooseSectorTitle}</legend>
          <p className="field-hint">{sectors.platformSectorDescription}</p>
          <div className="sector-create-options">
            {["GYM", "CLINIC", "BEAUTY_CENTER"].map((sector) => (
              <label className="sector-create-option" key={sector}>
                <input name="businessSector" required type="radio" value={sector} />
                <span>
                  <strong>{sectorValueLabel(locale, sector)}</strong>
                  <small>
                    {sector === "GYM"
                      ? sectors.gymDescription
                      : sector === "CLINIC"
                        ? sectors.clinicDescription
                        : sectors.beautyCenterDescription}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="field-label">{messages.englishName}</span>
          <input className="input" name="nameEn" required />
        </label>
        <label className="field">
          <span className="field-label">{messages.arabicName}</span>
          <input className="input" dir="rtl" name="nameAr" required />
        </label>
        <label className="field">
          <span className="field-label">{messages.slug}</span>
          <input
            className="input"
            dir="ltr"
            name="slug"
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            required
          />
        </label>
        <label className="field">
          <span className="field-label">{messages.ownerEmail}</span>
          <input className="input" dir="ltr" name="ownerEmail" required type="email" />
        </label>
        <div className="form-actions">
          <SubmitButton>{messages.createOrganization}</SubmitButton>
        </div>
      </form>
    </div>
  );
}
