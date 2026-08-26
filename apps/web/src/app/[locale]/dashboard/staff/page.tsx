import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { MembershipStatus } from "@jormall/db/generated/enums";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { StaffInvitationForm } from "../../../../components/staff-invitation-form";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages, phaseOneValueLabel } from "../../../../messages/phase-one";
import { identityRepository, requirePagePermission } from "../../../../server/identity";
import {
  replaceMembershipRoleAction,
  revokeInvitationAction,
  setMembershipStatusAction,
} from "../../actions";

export default async function StaffPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/staff">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "staff.read"),
    searchParams,
  ]);
  const canManage = canAccessResource(access, "staff.manage");
  const canManageRoles = canAccessResource(access, "roles.manage");
  const [staff, invitations, roles] = await Promise.all([
    identityRepository.listStaff(access),
    canManage ? identityRepository.listInvitations(access) : Promise.resolve([]),
    canManage ? identityRepository.listRoles(access) : Promise.resolve([]),
  ]);
  const messages = phaseOneMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="staff-title">
      <div>
        <p className="eyebrow">{messages.activeOrganization}</p>
        <h1 id="staff-title">{messages.staff}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      {canManage ? <StaffInvitationForm locale={locale} roles={roles} /> : null}
      <div className="table-wrap">
        <table>
          <caption className="sr-only">{messages.staff}</caption>
          <thead>
            <tr>
              <th>{messages.name}</th>
              <th>{messages.email}</th>
              <th>{messages.roles}</th>
              <th>{messages.status}</th>
              {canManage ? (
                <th>
                  <span className="sr-only">{locale === "ar" ? "الإجراءات" : "Actions"}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => (
              <tr key={member.id}>
                <td>{member.user.name}</td>
                <td dir="ltr">{member.user.email}</td>
                <td>
                  {canManageRoles ? (
                    <form action={replaceMembershipRoleAction} className="row-actions">
                      <input name="locale" type="hidden" value={locale} />
                      <input name="membershipId" type="hidden" value={member.id} />
                      <select
                        aria-label={messages.roles}
                        className="select"
                        defaultValue={member.roles[0]?.roleId ?? ""}
                        name="roleId"
                        required
                      >
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {locale === "ar" ? role.nameAr : role.nameEn}
                          </option>
                        ))}
                      </select>
                      <SubmitButton tone="secondary">{messages.save}</SubmitButton>
                    </form>
                  ) : (
                    member.roles
                      .map(({ role }) => (locale === "ar" ? role.nameAr : role.nameEn))
                      .join(", ")
                  )}
                </td>
                <td>
                  <span className={`status status-${member.status.toLowerCase()}`}>
                    {phaseOneValueLabel(locale, member.status)}
                  </span>
                </td>
                {canManage ? (
                  <td>
                    {access.membershipId !== member.id ? (
                      <form action={setMembershipStatusAction} className="row-actions">
                        <input name="locale" type="hidden" value={locale} />
                        <input name="membershipId" type="hidden" value={member.id} />
                        <input
                          name="status"
                          type="hidden"
                          value={
                            member.status === MembershipStatus.ACTIVE
                              ? MembershipStatus.SUSPENDED
                              : MembershipStatus.ACTIVE
                          }
                        />
                        <SubmitButton
                          tone={member.status === MembershipStatus.ACTIVE ? "danger" : "secondary"}
                        >
                          {member.status === MembershipStatus.ACTIVE
                            ? messages.suspend
                            : messages.activate}
                        </SubmitButton>
                      </form>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage ? (
        <section className="panel" aria-labelledby="invitations-title">
          <h2 id="invitations-title">{messages.invitations}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{messages.email}</th>
                  <th>{messages.invitationRole}</th>
                  <th>{messages.status}</th>
                  <th>
                    <span className="sr-only">{locale === "ar" ? "الإجراءات" : "Actions"}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td dir="ltr">{invitation.email}</td>
                    <td>{locale === "ar" ? invitation.role.nameAr : invitation.role.nameEn}</td>
                    <td>{phaseOneValueLabel(locale, invitation.status)}</td>
                    <td>
                      {invitation.status === "PENDING" ? (
                        <form action={revokeInvitationAction}>
                          <input name="invitationId" type="hidden" value={invitation.id} />
                          <input name="locale" type="hidden" value={locale} />
                          <SubmitButton tone="danger">{messages.revoke}</SubmitButton>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </section>
  );
}
