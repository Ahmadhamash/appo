import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseFiveALabel, phaseFiveAMessages } from "../../../../messages/phase-five-a";
import {
  aiFoundationRepository,
  identityRepository,
  requirePagePermission,
} from "../../../../server/identity";
import { updateHumanHandoffAction } from "../../actions";

export default async function AIHandoffsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/ai-handoffs">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "conversations.handoff"),
    searchParams,
  ]);
  const [handoffs, staff] = await Promise.all([
    aiFoundationRepository.listHumanHandoffs(access),
    canAccessResource(access, "staff.read") ? identityRepository.listStaff(access) : [],
  ]);
  const messages = phaseFiveAMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="handoffs-title">
      <div>
        <p className="eyebrow">Phase 5A</p>
        <h1 id="handoffs-title">{messages.handoffs}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <div className="card-grid">
        {handoffs.map((handoff) => (
          <article className="record-card" key={handoff.id}>
            <div>
              <span className="status">{phaseFiveALabel(locale, handoff.status)}</span>
              <h2>{handoff.customer?.displayName ?? handoff.reasonCode}</h2>
              <p dir="auto">{handoff.summary}</p>
              <p className="muted">
                {handoff.reasonCode} · {locale === "ar" ? "أولوية" : "Urgency"} {handoff.urgency}
              </p>
              <Link
                className="button button-secondary"
                href={`/${locale}/dashboard/ai-conversations/${handoff.conversationId}`}
              >
                {messages.viewer}
              </Link>
            </div>
            {["OPEN", "ASSIGNED"].includes(handoff.status) ? (
              <form action={updateHumanHandoffAction} className="form-stack">
                <input name="locale" type="hidden" value={locale} />
                <input name="handoffId" type="hidden" value={handoff.id} />
                <label className="field">
                  <span className="field-label">{locale === "ar" ? "الموظف" : "Assignee"}</span>
                  <select
                    className="select"
                    defaultValue={handoff.assignedMembershipId ?? ""}
                    name="assignedMembershipId"
                  >
                    <option value="">—</option>
                    {staff
                      .filter((member) => member.status === "ACTIVE")
                      .map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.user.name ?? member.user.email}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">{messages.outcome}</span>
                  <select className="select" name="status" required>
                    <option value="ASSIGNED">{phaseFiveALabel(locale, "ASSIGNED")}</option>
                    <option value="RESOLVED">{phaseFiveALabel(locale, "RESOLVED")}</option>
                    <option value="CLOSED">{phaseFiveALabel(locale, "CLOSED")}</option>
                  </select>
                </label>
                <SubmitButton>{locale === "ar" ? "تحديث التحويل" : "Update handoff"}</SubmitButton>
              </form>
            ) : null}
          </article>
        ))}
      </div>
      {handoffs.length === 0 ? <p className="muted">{messages.noData}</p> : null}
    </section>
  );
}
