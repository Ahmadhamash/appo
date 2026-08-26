import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { MembershipStatus } from "@jormall/db/generated/enums";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardPageHero } from "../../../../components/dashboard-page-hero";
import { Feedback } from "../../../../components/feedback";
import { StaffInvitationForm } from "../../../../components/staff-invitation-form";
import { SubmitButton } from "../../../../components/submit-button";
import { ownerWorkspaceMessages } from "../../../../messages/owner-workspace";
import { phaseOneMessages, phaseOneValueLabel } from "../../../../messages/phase-one";
import { sectorPortalProfile } from "../../../../messages/sectors";
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
  const [staff, invitations, roles, sector] = await Promise.all([
    identityRepository.listStaff(access),
    canManage ? identityRepository.listInvitations(access) : Promise.resolve([]),
    canManage ? identityRepository.listRoles(access) : Promise.resolve([]),
    canAccessResource(access, "organization.read")
      ? identityRepository.getBusinessSector(access)
      : Promise.resolve(null),
  ]);
  const messages = phaseOneMessages[locale];
  const workspace = ownerWorkspaceMessages[locale];
  const sectorProfile = sector ? sectorPortalProfile(locale, sector) : null;
  const activeCount = staff.filter(({ status }) => status === MembershipStatus.ACTIVE).length;
  const providerCount = staff.filter(({ roles: memberRoles }) =>
    memberRoles.some(({ role }) => role.key === "PROVIDER"),
  ).length;
  const pendingInvitations = invitations.filter(({ status }) => status === "PENDING").length;

  return (
    <section className="page-stack" aria-labelledby="staff-title">
      <DashboardPageHero
        description={sectorProfile?.staffDescription ?? workspace.staffDescription}
        eyebrow={workspace.workspace}
        icon="♙"
        title={sectorProfile?.staff ?? messages.staff}
        titleId="staff-title"
      />
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />

      <dl className="workspace-metrics">
        <div>
          <span aria-hidden="true">◎</span>
          <dt>{workspace.teamSize}</dt>
          <dd>{staff.length}</dd>
        </div>
        <div>
          <span aria-hidden="true">✓</span>
          <dt>{workspace.activeStaff}</dt>
          <dd>{activeCount}</dd>
        </div>
        <div>
          <span aria-hidden="true">♙</span>
          <dt>{workspace.providerTeam}</dt>
          <dd>{providerCount}</dd>
        </div>
        <div>
          <span aria-hidden="true">✉</span>
          <dt>{workspace.pendingInvitations}</dt>
          <dd>{pendingInvitations}</dd>
        </div>
      </dl>

      {canManage ? (
        <details className="panel action-disclosure workspace-action">
          <summary>+ {workspace.inviteSummary}</summary>
          <div className="disclosure-heading">
            <h2>{workspace.inviteSummary}</h2>
            <p>{workspace.inviteDescription}</p>
          </div>
          <StaffInvitationForm embedded locale={locale} roles={roles} />
        </details>
      ) : null}

      <div className="section-heading workspace-section-heading">
        <div>
          <p className="eyebrow">{workspace.businessSetup}</p>
          <h2>{workspace.staffDirectory}</h2>
        </div>
        {canManageRoles ? (
          <Link className="button button-secondary" href={`/${locale}/dashboard/roles`}>
            {workspace.manageRoles}
          </Link>
        ) : null}
      </div>

      <div className="team-directory-grid">
        {staff.map((member) => (
          <article className="record-card team-member-card" key={member.id}>
            <header className="team-member-heading">
              <span className="team-avatar" aria-hidden="true">
                {initials(member.user.name)}
              </span>
              <div>
                <div className="team-member-name">
                  <h3>{member.user.name}</h3>
                  {access.membershipId === member.id ? (
                    <span className="current-user-badge">{workspace.you}</span>
                  ) : null}
                </div>
                <p dir="ltr">{member.user.email}</p>
              </div>
              <span className={`status status-${member.status.toLowerCase()}`}>
                {phaseOneValueLabel(locale, member.status)}
              </span>
            </header>

            <div className="team-role-summary">
              <span>{messages.roles}</span>
              <strong>
                {member.roles
                  .map(({ role }) => (locale === "ar" ? role.nameAr : role.nameEn))
                  .join(", ")}
              </strong>
            </div>

            {canManage ? (
              <details className="inline-disclosure team-access-disclosure">
                <summary>{workspace.updateMember}</summary>
                {canManageRoles ? (
                  <form action={replaceMembershipRoleAction} className="form-stack">
                    <input name="locale" type="hidden" value={locale} />
                    <input name="membershipId" type="hidden" value={member.id} />
                    <label className="field">
                      <span className="field-label">{messages.roles}</span>
                      <select
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
                    </label>
                    <SubmitButton tone="secondary">{messages.save}</SubmitButton>
                  </form>
                ) : null}
                {access.membershipId !== member.id ? (
                  <form action={setMembershipStatusAction} className="team-status-action">
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
              </details>
            ) : null}
          </article>
        ))}
      </div>

      {canManage ? (
        <details className="panel action-disclosure invitation-history">
          <summary>
            {workspace.invitationHistory} <span>{invitations.length}</span>
          </summary>
          {invitations.length === 0 ? (
            <p className="muted">{workspace.noInvitations}</p>
          ) : (
            <ul className="invitation-list">
              {invitations.map((invitation) => (
                <li key={invitation.id}>
                  <div>
                    <strong dir="ltr">{invitation.email}</strong>
                    <span>{locale === "ar" ? invitation.role.nameAr : invitation.role.nameEn}</span>
                  </div>
                  <span className={`status status-${invitation.status.toLowerCase()}`}>
                    {phaseOneValueLabel(locale, invitation.status)}
                  </span>
                  {invitation.status === "PENDING" ? (
                    <form action={revokeInvitationAction}>
                      <input name="invitationId" type="hidden" value={invitation.id} />
                      <input name="locale" type="hidden" value={locale} />
                      <SubmitButton tone="danger">{messages.revoke}</SubmitButton>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </details>
      ) : null}
    </section>
  );
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}
