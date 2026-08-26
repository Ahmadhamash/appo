import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages, phaseOneValueLabel } from "../../../../messages/phase-one";
import { identityRepository, requirePagePermission } from "../../../../server/identity";
import { createRoleAction } from "../../actions";

export default async function RolesPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/roles">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "roles.read"),
    searchParams,
  ]);
  const canManage = canAccessResource(access, "roles.manage");
  const [roles, permissions] = await Promise.all([
    identityRepository.listRoles(access),
    canManage ? identityRepository.listPermissions() : Promise.resolve([]),
  ]);
  const messages = phaseOneMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="roles-title">
      <div>
        <p className="eyebrow">{messages.activeOrganization}</p>
        <h1 id="roles-title">{messages.roles}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      {canManage ? (
        <form action={createRoleAction} className="panel form-grid">
          <input name="locale" type="hidden" value={locale} />
          <label className="field">
            <span className="field-label">{messages.roleKey}</span>
            <input className="input" dir="ltr" name="key" pattern="[A-Za-z0-9_]+" required />
          </label>
          <label className="field">
            <span className="field-label">{messages.englishName}</span>
            <input className="input" name="nameEn" required />
          </label>
          <label className="field">
            <span className="field-label">الاسم بالعربية</span>
            <input className="input" dir="rtl" name="nameAr" required />
          </label>
          <fieldset className="permission-grid">
            <legend>{messages.permissions}</legend>
            {permissions.map((permission) => (
              <label className="check-field" key={permission.id}>
                <input name="permissionCodes" type="checkbox" value={permission.code} />
                <span>{locale === "ar" ? permission.nameAr : permission.nameEn}</span>
                <small dir="ltr">{permission.code}</small>
              </label>
            ))}
          </fieldset>
          <div className="form-actions">
            <SubmitButton>{messages.addRole}</SubmitButton>
          </div>
        </form>
      ) : null}
      <div className="card-grid">
        {roles.map((role) => (
          <article className="record-card role-card" key={role.id}>
            <div>
              <span className="status">
                {phaseOneValueLabel(locale, role.isSystem ? "SYSTEM" : "CUSTOM")}
              </span>
              <h2>{locale === "ar" ? role.nameAr : role.nameEn}</h2>
              <p className="muted" dir="ltr">
                {role.key}
              </p>
            </div>
            <ul>
              {role.permissions.map(({ permission, scope }) => (
                <li key={permission.id}>
                  <span>{locale === "ar" ? permission.nameAr : permission.nameEn}</span>
                  <small>{phaseOneValueLabel(locale, scope)}</small>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
