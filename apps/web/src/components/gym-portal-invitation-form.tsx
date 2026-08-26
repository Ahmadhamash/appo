"use client";

import { useActionState, useState } from "react";

import {
  createGymPortalInvitationAction,
  type GymPortalInvitationState,
} from "../app/[locale]/dashboard/gym/actions";
import { SubmitButton } from "./submit-button";

const initialState: GymPortalInvitationState = {};

export function GymPortalInvitationForm({
  locale,
  traineeProfileId,
}: Readonly<{ locale: "ar" | "en"; traineeProfileId: string }>) {
  const [state, action] = useActionState(createGymPortalInvitationAction, initialState);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!state.invitationUrl) return;
    await navigator.clipboard.writeText(state.invitationUrl);
    setCopied(true);
  };
  return (
    <div className="portal-invite-workspace">
      <form action={action} className="portal-invite-form">
        <input name="locale" type="hidden" value={locale} />
        <input name="traineeProfileId" type="hidden" value={traineeProfileId} />
        <label className="field">
          <span className="field-label">{locale === "ar" ? "بريد المتدرّب" : "Trainee email"}</span>
          <input
            autoComplete="email"
            className="input"
            dir="ltr"
            name="email"
            required
            type="email"
          />
        </label>
        <SubmitButton>
          {locale === "ar" ? "إنشاء رابط الدعوة" : "Create invitation link"}
        </SubmitButton>
      </form>
      {state.error ? (
        <p className="feedback feedback-error" role="alert">
          {locale === "ar"
            ? "تعذّر إنشاء الدعوة. تأكد من البريد وحالة الحساب."
            : "The invitation could not be created. Check the email and account status."}
        </p>
      ) : null}
      {state.invitationUrl ? (
        <div className="copy-invitation" role="status">
          <label className="field">
            <span className="field-label">
              {locale === "ar" ? "الرابط صالح 7 أيام" : "Link valid for 7 days"}
            </span>
            <input className="input" dir="ltr" readOnly value={state.invitationUrl} />
          </label>
          <button className="button button-secondary" onClick={copy} type="button">
            {copied
              ? locale === "ar"
                ? "تم النسخ"
                : "Copied"
              : locale === "ar"
                ? "نسخ الرابط"
                : "Copy link"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
