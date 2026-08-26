import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages } from "../../../../messages/phase-one";
import { identityRepository, requirePagePermission } from "../../../../server/identity";
import { createBranchAction, deleteBranchAction } from "../../actions";

export default async function BranchesPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/branches">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "branches.read"),
    searchParams,
  ]);
  const branches = await identityRepository.listBranches(access);
  const canManage = canAccessResource(access, "branches.manage");
  const messages = phaseOneMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="branches-title">
      <div>
        <p className="eyebrow">{messages.activeOrganization}</p>
        <h1 id="branches-title">{messages.branches}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      {canManage ? (
        <form action={createBranchAction} className="panel form-grid">
          <input name="locale" type="hidden" value={locale} />
          <label className="field">
            <span className="field-label">{messages.englishName}</span>
            <input className="input" name="nameEn" required />
          </label>
          <label className="field">
            <span className="field-label">الاسم بالعربية</span>
            <input className="input" dir="rtl" name="nameAr" required />
          </label>
          <label className="field">
            <span className="field-label">{messages.timezone}</span>
            <input className="input" defaultValue="Asia/Amman" dir="ltr" name="timezone" required />
          </label>
          <label className="field">
            <span className="field-label">{messages.phone}</span>
            <input className="input" dir="ltr" name="phone" type="tel" />
          </label>
          <label className="field">
            <span className="field-label">{messages.addressEn}</span>
            <input className="input" name="addressEn" />
          </label>
          <label className="field">
            <span className="field-label">{messages.addressAr}</span>
            <input className="input" dir="rtl" name="addressAr" />
          </label>
          <div className="form-actions">
            <SubmitButton>{messages.addBranch}</SubmitButton>
          </div>
        </form>
      ) : null}
      <div className="card-grid">
        {branches.map((branch) => (
          <article className="record-card" key={branch.id}>
            <div>
              <h2>{locale === "ar" ? branch.nameAr : branch.nameEn}</h2>
              <p className="muted" dir="ltr">
                {branch.timezone}
              </p>
              {branch.phone ? <p dir="ltr">{branch.phone}</p> : null}
            </div>
            {canManage ? (
              <form action={deleteBranchAction}>
                <input name="branchId" type="hidden" value={branch.id} />
                <input name="locale" type="hidden" value={locale} />
                <SubmitButton tone="danger">{messages.delete}</SubmitButton>
              </form>
            ) : null}
          </article>
        ))}
        {branches.length === 0 ? <p className="empty-state">{messages.noRecords}</p> : null}
      </div>
    </section>
  );
}
