import { randomUUID } from "node:crypto";

import { DomainError } from "@jormall/domain/errors";
import {
  defaultRolePermissions,
  isPermissionCode,
  permissionCodes,
  type PermissionCode,
  type PermissionScope,
  type TenantAccessSnapshot,
  type TenantRoleKey,
} from "@jormall/domain/identity";

import {
  InvitationStatus,
  MembershipStatus,
  OrganizationStatus,
  PlatformRole,
  type BusinessSector,
  type Prisma,
  type PrismaClient,
  type SupportedLocale,
} from "./generated/prisma/client";
import { createCommunicationDefaults } from "./communication-defaults";
import { createAIFoundationDefaults } from "./ai-defaults";
import { createInvitationToken, hashInvitationToken } from "./invitation-token";
import { createPredictiveDefaults } from "./predictive-defaults";
import { runInTenant, type TenantTransaction } from "./tenant-context";

const permissionLabels: Readonly<Record<PermissionCode, readonly [string, string]>> = {
  "ai.actions.execute": ["Execute AI gateway actions", "تنفيذ إجراءات بوابة الذكاء الاصطناعي"],
  "ai.configure": ["Configure safe AI", "إعداد الذكاء الاصطناعي الآمن"],
  "audit.read": ["Read audit history", "عرض سجل التدقيق"],
  "appointment_records.read": ["Read appointment records", "عرض سجلات المواعيد"],
  "appointment_records.write": ["Record appointment fulfillment", "تسجيل تنفيذ الموعد"],
  "appointments.availability.read": [
    "Find available appointment slots",
    "البحث عن المواعيد المتاحة",
  ],
  "appointments.cancel": ["Cancel appointments", "إلغاء المواعيد"],
  "appointments.create": ["Create appointments", "إنشاء المواعيد"],
  "appointments.read": ["Read appointments", "عرض المواعيد"],
  "appointments.reschedule": ["Reschedule appointments", "إعادة جدولة المواعيد"],
  "appointments.status.correct": ["Correct appointment status", "تصحيح حالة الموعد"],
  "appointments.status.transition": ["Transition appointment status", "تحديث حالة الموعد"],
  "branches.manage": ["Manage branches", "إدارة الفروع"],
  "branches.read": ["Read branches", "عرض الفروع"],
  "consent.read": ["Read consent history", "عرض سجل الموافقات"],
  "consent.record": ["Record consent", "تسجيل الموافقة"],
  "customers.read": ["Read customers", "عرض العملاء"],
  "customers.write": ["Manage customers", "إدارة العملاء"],
  "communication_preferences.manage": ["Manage communication preferences", "إدارة تفضيلات الاتصال"],
  "conversations.handoff": ["Manage human handoffs", "إدارة التحويل إلى موظف"],
  "conversations.read": ["Read AI conversations", "عرض محادثات الذكاء الاصطناعي"],
  "message_templates.manage": ["Manage message templates", "إدارة قوالب الرسائل"],
  "messages.read": ["Read communications", "عرض الاتصالات"],
  "messages.retry": ["Retry failed communications", "إعادة محاولة الاتصالات الفاشلة"],
  "messages.send": ["Send communications", "إرسال الاتصالات"],
  "knowledge.manage": ["Manage knowledge base", "إدارة قاعدة المعرفة"],
  "knowledge.read": ["Read knowledge base", "عرض قاعدة المعرفة"],
  "imports.manage": ["Manage safe data imports", "إدارة استيراد البيانات الآمن"],
  "exports.manage": ["Create protected data exports", "إنشاء تصدير بيانات محمي"],
  "gym.plans.manage": ["Manage workout and nutrition plans", "إدارة خطط التمرين والتغذية"],
  "gym.progress.write": ["Record gym progress", "تسجيل تقدم المتدرب"],
  "gym.trainees.manage": ["Manage gym trainees", "إدارة متدربي النادي"],
  "gym.trainees.read": ["Read gym trainees", "عرض متدربي النادي"],
  "organization.billing.manage": ["Manage organization billing", "إدارة فوترة المؤسسة"],
  "organization.read": ["Read organization", "عرض المؤسسة"],
  "organization.settings.manage": ["Manage organization settings", "إدارة إعدادات المؤسسة"],
  "provider_credentials.manage": ["Manage provider connections", "إدارة اتصالات مزودي الخدمة"],
  "predictions.configure": ["Configure predictive capabilities", "إعداد قدرات التنبؤ"],
  "predictions.feedback": ["Record prediction feedback", "تسجيل ملاحظات التنبؤ"],
  "predictions.read": ["Read predictive insights", "عرض الرؤى التنبؤية"],
  "predictions.run": ["Run predictive jobs", "تشغيل مهام التنبؤ"],
  "recordings.read": ["Read consented call records", "عرض سجلات المكالمات المصرح بها"],
  "reports.read": ["Read operational reports", "عرض التقارير التشغيلية"],
  "roles.manage": ["Manage roles and permissions", "إدارة الأدوار والصلاحيات"],
  "roles.read": ["Read roles and permissions", "عرض الأدوار والصلاحيات"],
  "resources.manage": ["Manage scheduling resources", "إدارة موارد الجدولة"],
  "resources.read": ["Read scheduling resources", "عرض موارد الجدولة"],
  "schedules.manage": ["Manage schedules", "إدارة الجداول"],
  "schedules.read": ["Read schedules", "عرض الجداول"],
  "services.manage": ["Manage services", "إدارة الخدمات"],
  "services.read": ["Read services", "عرض الخدمات"],
  "staff.manage": ["Manage staff and invitations", "إدارة الموظفين والدعوات"],
  "staff.read": ["Read staff", "عرض الموظفين"],
  "slot_offers.manage": ["Manage mocked slot offers", "إدارة عروض المواعيد التجريبية"],
  "waitlist.manage": ["Manage waitlist", "إدارة قائمة الانتظار"],
  "waitlist.read": ["Read waitlist", "عرض قائمة الانتظار"],
};

const roleLabels: Readonly<Record<TenantRoleKey, readonly [string, string]>> = {
  ORGANIZATION_MANAGER: ["Organization Manager", "مدير المؤسسة"],
  ORGANIZATION_OWNER: ["Organization Owner", "مالك المؤسسة"],
  PROVIDER: ["Provider", "مقدم الخدمة"],
  SECRETARY: ["Secretary", "سكرتير"],
};

const allWeekdays = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

export type SessionTenantSelection = Readonly<{
  activeMembershipId?: string;
  activeOrganizationId?: string;
  activeSupportAccessId?: string;
}>;

export type RequestAuditDetails = Readonly<{
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}>;

export type OrganizationCreation = Readonly<{
  nameAr: string;
  nameEn: string;
  ownerEmail: string;
  slug: string;
}>;

export type InvitationPreview = Readonly<{
  email: string;
  expiresAt: Date;
  organizationId: string;
  organizationNameAr: string;
  organizationNameEn: string;
  roleNameAr: string;
  roleNameEn: string;
  status: InvitationStatus;
}>;

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertActiveOrganization(status: OrganizationStatus): void {
  if (status === OrganizationStatus.SUSPENDED) {
    throw new DomainError({
      code: "ORGANIZATION_SUSPENDED",
      message: "The organization is suspended.",
    });
  }
  if (status !== OrganizationStatus.ACTIVE) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "The organization is not active.",
    });
  }
}

const permissionScopeRank: Readonly<Record<PermissionScope, number>> = {
  ASSIGNED_BRANCHES: 2,
  ORGANIZATION: 3,
  SELF: 1,
};

function requireAccessPermission(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
): PermissionScope {
  const scope = access.grants
    .filter((grant) => grant.code === permission)
    .toSorted(
      (left, right) => permissionScopeRank[right.scope] - permissionScopeRank[left.scope],
    )[0]?.scope;
  if (!scope) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "The active tenant context does not grant this permission.",
      metadata: { permission },
    });
  }
  return scope;
}

async function createAuditEvent(
  transaction: TenantTransaction,
  input: Readonly<{
    action: string;
    actorUserId: string;
    details?: RequestAuditDetails | undefined;
    metadata?: Prisma.InputJsonValue | undefined;
    organizationId: string;
    reason?: string | undefined;
    supportAccessId?: string | undefined;
    targetId?: string | undefined;
    targetType?: string | undefined;
  }>,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      action: input.action,
      actorUserId: input.actorUserId,
      ipAddress: input.details?.ipAddress ?? null,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      organizationId: input.organizationId,
      reason: input.reason ?? null,
      supportAccessId: input.supportAccessId ?? null,
      targetId: input.targetId ?? null,
      targetType: input.targetType ?? null,
      userAgent: input.details?.userAgent ?? null,
    },
  });
}

export class IdentityRepository {
  readonly client: PrismaClient;

  constructor(client: PrismaClient) {
    this.client = client;
  }

  private async runWithAccess<T>(
    access: TenantAccessSnapshot,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    if (access.supportAccessId) {
      await this.assertSuperAdmin(access.actorUserId);
      const supportAccess = await this.client.platformSupportAccess.findFirst({
        select: { id: true },
        where: {
          expiresAt: { gt: new Date() },
          id: access.supportAccessId,
          organizationId: access.organizationId,
          revokedAt: null,
          userId: access.actorUserId,
        },
      });
      if (!supportAccess) {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "Support access is invalid or expired.",
        });
      }
    }
    return runInTenant(this.client, access, async (transaction) => {
      const organization = await transaction.organization.findUnique({
        select: { status: true },
        where: { id: access.organizationId },
      });
      if (!organization) {
        throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
      }
      assertActiveOrganization(organization.status);
      if (access.membershipId) {
        const membership = await transaction.organizationMembership.findFirst({
          select: { status: true },
          where: {
            id: access.membershipId,
            organizationId: access.organizationId,
            userId: access.actorUserId,
          },
        });
        if (!membership) {
          throw new DomainError({ code: "NOT_FOUND", message: "Membership not found." });
        }
        if (membership.status !== MembershipStatus.ACTIVE) {
          throw new DomainError({
            code: "MEMBERSHIP_SUSPENDED",
            message: "The membership is not active.",
          });
        }
      } else if (!access.supportAccessId) {
        throw new DomainError({
          code: "TENANT_CONTEXT_REQUIRED",
          message: "An active membership or support access is required.",
        });
      }
      return operation(transaction);
    });
  }

  async ensurePermissionRegistry(): Promise<void> {
    await this.client.$transaction(
      permissionCodes.map((code) => {
        const labels = permissionLabels[code];
        return this.client.permission.upsert({
          create: { code, nameAr: labels[1], nameEn: labels[0] },
          update: { nameAr: labels[1], nameEn: labels[0] },
          where: { code },
        });
      }),
    );
  }

  async assertSuperAdmin(userId: string): Promise<void> {
    const user = await this.client.user.findUnique({
      select: { platformRole: true },
      where: { id: userId },
    });
    if (user?.platformRole !== PlatformRole.JORMALL_SUPER_ADMIN) {
      throw new DomainError({ code: "FORBIDDEN", message: "Super Admin access is required." });
    }
  }

  async listOrganizations(actorUserId: string) {
    await this.assertSuperAdmin(actorUserId);
    return this.client.organization.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        createdAt: true,
        id: true,
        nameAr: true,
        nameEn: true,
        slug: true,
        status: true,
        suspendedAt: true,
        suspensionReason: true,
      },
    });
  }

  async createOrganization(
    actorUserId: string,
    input: OrganizationCreation,
  ): Promise<Readonly<{ invitationToken: string; organizationId: string }>> {
    await this.assertSuperAdmin(actorUserId);
    await this.ensurePermissionRegistry();
    const organizationId = randomUUID();
    const invitationToken = createInvitationToken();
    const permissionRows = await this.client.permission.findMany({
      where: { code: { in: [...permissionCodes] } },
    });

    await this.client.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: {
          createdByUserId: actorUserId,
          id: organizationId,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          settings: { create: {} },
          slug: input.slug,
        },
      });

      const roles: Array<{ id: string; systemKey: TenantRoleKey | null }> = [];
      for (const roleKey of Object.keys(roleLabels) as TenantRoleKey[]) {
        const labels = roleLabels[roleKey];
        roles.push(
          await transaction.role.create({
            data: {
              isSystem: true,
              key: roleKey,
              nameAr: labels[1],
              nameEn: labels[0],
              organizationId,
              systemKey: roleKey,
            },
          }),
        );
      }

      for (const role of roles) {
        const roleKey = role.systemKey;
        if (!roleKey) {
          continue;
        }
        const grants = defaultRolePermissions[roleKey];
        for (const grant of grants) {
          const permission = permissionRows.find((row) => row.code === grant.code);
          if (!permission) {
            throw new DomainError({
              code: "INTERNAL_ERROR",
              message: `Permission ${grant.code} is missing from the registry.`,
            });
          }
          await transaction.rolePermission.create({
            data: {
              organizationId,
              permissionId: permission.id,
              roleId: role.id,
              scope: grant.scope,
            },
          });
        }
      }

      await createCommunicationDefaults(transaction, organizationId);
      await createAIFoundationDefaults(transaction, organizationId);
      await createPredictiveDefaults(transaction, organizationId, actorUserId);

      const ownerRole = roles.find((role) => role.systemKey === "ORGANIZATION_OWNER");
      if (!ownerRole) {
        throw new DomainError({ code: "INTERNAL_ERROR", message: "Owner role was not created." });
      }
      await transaction.organizationInvitation.create({
        data: {
          email: normalizedEmail(input.ownerEmail),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          invitedByUserId: actorUserId,
          organizationId,
          roleId: ownerRole.id,
          tokenHash: hashInvitationToken(invitationToken),
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: "ORGANIZATION_CREATED",
          actorUserId,
          organizationId,
          targetId: organizationId,
          targetType: "Organization",
        },
      });
    });

    return { invitationToken, organizationId };
  }

  async setOrganizationStatus(
    actorUserId: string,
    organizationId: string,
    status: OrganizationStatus,
    reason?: string,
  ): Promise<void> {
    await this.assertSuperAdmin(actorUserId);
    if (status === OrganizationStatus.SUSPENDED && (!reason || reason.trim().length < 10)) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "A suspension reason of at least 10 characters is required.",
      });
    }
    await this.client.organization.update({
      data: {
        status,
        suspendedAt: status === OrganizationStatus.SUSPENDED ? new Date() : null,
        suspensionReason: status === OrganizationStatus.SUSPENDED ? (reason?.trim() ?? null) : null,
      },
      where: { id: organizationId },
    });
    await runInTenant(this.client, { actorUserId, organizationId }, async (transaction) => {
      await createAuditEvent(transaction, {
        action: `ORGANIZATION_${status}`,
        actorUserId,
        organizationId,
        reason,
        targetId: organizationId,
        targetType: "Organization",
      });
    });
  }

  async startSupportAccess(
    actorUserId: string,
    organizationId: string,
    reason: string,
    details: RequestAuditDetails,
  ): Promise<string> {
    await this.assertSuperAdmin(actorUserId);
    if (reason.trim().length < 10) {
      throw new DomainError({
        code: "VALIDATION_FAILED",
        message: "A support-access reason of at least 10 characters is required.",
      });
    }
    const organization = await this.client.organization.findUnique({
      select: { status: true },
      where: { id: organizationId },
    });
    if (!organization) {
      throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
    }
    assertActiveOrganization(organization.status);
    const access = await this.client.platformSupportAccess.create({
      data: {
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        organizationId,
        permissionCodes: [...permissionCodes],
        reason: reason.trim(),
        userId: actorUserId,
      },
    });
    try {
      await runInTenant(
        this.client,
        { actorUserId, organizationId, supportAccessId: access.id },
        async (transaction) => {
          const currentOrganization = await transaction.organization.findUnique({
            select: { id: true, status: true },
            where: { id: organizationId },
          });
          if (!currentOrganization) {
            throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
          }
          assertActiveOrganization(currentOrganization.status);
          await createAuditEvent(transaction, {
            action: "SUPER_ADMIN_SUPPORT_STARTED",
            actorUserId,
            details,
            organizationId,
            reason: reason.trim(),
            supportAccessId: access.id,
            targetId: organizationId,
            targetType: "Organization",
          });
        },
      );
    } catch (error) {
      await this.client.platformSupportAccess.delete({ where: { id: access.id } });
      throw error;
    }
    return access.id;
  }

  async revokeSupportAccess(
    actorUserId: string,
    supportAccessId: string,
    details: RequestAuditDetails,
  ): Promise<void> {
    await this.assertSuperAdmin(actorUserId);
    const access = await this.client.platformSupportAccess.findFirst({
      where: { id: supportAccessId, userId: actorUserId },
    });
    if (!access) {
      return;
    }
    await this.client.platformSupportAccess.update({
      data: { revokedAt: new Date() },
      where: { id: access.id },
    });
    await runInTenant(
      this.client,
      {
        actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.id,
      },
      async (transaction) => {
        await createAuditEvent(transaction, {
          action: "SUPER_ADMIN_SUPPORT_ENDED",
          actorUserId,
          details,
          organizationId: access.organizationId,
          reason: access.reason,
          supportAccessId: access.id,
          targetId: access.organizationId,
          targetType: "Organization",
        });
      },
    );
  }

  async listMembershipChoices(userId: string) {
    return this.client.organizationMembership.findMany({
      orderBy: { organization: { nameEn: "asc" } },
      select: {
        id: true,
        organization: { select: { id: true, nameAr: true, nameEn: true, status: true } },
        roles: { select: { role: { select: { nameAr: true, nameEn: true, systemKey: true } } } },
        status: true,
      },
      where: { userId },
    });
  }

  async resolveMembershipForSwitch(userId: string, membershipId: string) {
    const membership = await this.client.organizationMembership.findFirst({
      select: { id: true, organizationId: true, status: true },
      where: { id: membershipId, userId },
    });
    if (!membership) {
      throw new DomainError({ code: "NOT_FOUND", message: "Membership not found." });
    }
    if (membership.status !== MembershipStatus.ACTIVE) {
      throw new DomainError({
        code: "MEMBERSHIP_SUSPENDED",
        message: "The membership is not active.",
      });
    }
    const organization = await runInTenant(
      this.client,
      { actorUserId: userId, organizationId: membership.organizationId },
      (transaction) =>
        transaction.organization.findUnique({
          select: { status: true },
          where: { id: membership.organizationId },
        }),
    );
    if (!organization) {
      throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
    }
    assertActiveOrganization(organization.status);
    return membership;
  }

  async loadTenantAccess(
    userId: string,
    selection: SessionTenantSelection,
    details: RequestAuditDetails,
  ): Promise<TenantAccessSnapshot> {
    if (!selection.activeOrganizationId) {
      throw new DomainError({
        code: "TENANT_CONTEXT_REQUIRED",
        message: "Select an organization before continuing.",
      });
    }
    const organizationId = selection.activeOrganizationId;

    if (selection.activeSupportAccessId) {
      return this.loadSupportAccess(
        userId,
        organizationId,
        selection.activeSupportAccessId,
        details,
      );
    }
    if (!selection.activeMembershipId) {
      throw new DomainError({
        code: "TENANT_CONTEXT_REQUIRED",
        message: "An active membership is required.",
      });
    }
    return this.loadMemberAccess(userId, organizationId, selection.activeMembershipId);
  }

  private async loadMemberAccess(
    userId: string,
    organizationId: string,
    membershipId: string,
  ): Promise<TenantAccessSnapshot> {
    return runInTenant(
      this.client,
      { actorUserId: userId, organizationId },
      async (transaction) => {
        const organization = await transaction.organization.findUnique({
          select: { status: true },
          where: { id: organizationId },
        });
        if (!organization) {
          throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
        }
        assertActiveOrganization(organization.status);

        const membership = await transaction.organizationMembership.findFirst({
          include: {
            roles: {
              include: {
                role: {
                  include: { permissions: { include: { permission: true } } },
                },
              },
            },
            staffProfile: { include: { branchAssignments: true } },
          },
          where: { id: membershipId, organizationId, userId },
        });
        if (!membership) {
          throw new DomainError({ code: "NOT_FOUND", message: "Membership not found." });
        }
        if (membership.status !== MembershipStatus.ACTIVE) {
          throw new DomainError({
            code: "MEMBERSHIP_SUSPENDED",
            message: "The membership is not active.",
          });
        }

        const grants = membership.roles.flatMap(({ role }) =>
          role.permissions.flatMap(({ permission, scope }) =>
            isPermissionCode(permission.code) ? [{ code: permission.code, scope }] : [],
          ),
        );
        return {
          actorUserId: userId,
          assignedBranchIds:
            membership.staffProfile?.branchAssignments.map(({ branchId }) => branchId) ?? [],
          grants,
          membershipId: membership.id,
          organizationId,
          ...(membership.staffProfile ? { staffProfileId: membership.staffProfile.id } : {}),
        };
      },
    );
  }

  private async loadSupportAccess(
    userId: string,
    organizationId: string,
    supportAccessId: string,
    details: RequestAuditDetails,
  ): Promise<TenantAccessSnapshot> {
    await this.assertSuperAdmin(userId);
    const supportAccess = await this.client.platformSupportAccess.findFirst({
      where: {
        expiresAt: { gt: new Date() },
        id: supportAccessId,
        organizationId,
        revokedAt: null,
        userId,
      },
    });
    if (!supportAccess) {
      throw new DomainError({
        code: "FORBIDDEN",
        message: "Support access is invalid or expired.",
      });
    }

    return runInTenant(
      this.client,
      { actorUserId: userId, organizationId, supportAccessId },
      async (transaction) => {
        const organization = await transaction.organization.findUnique({
          select: { status: true },
          where: { id: organizationId },
        });
        if (!organization) {
          throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
        }
        if (organization.status === OrganizationStatus.SUSPENDED) {
          throw new DomainError({
            code: "ORGANIZATION_SUSPENDED",
            message: "Support access to a suspended organization is blocked.",
          });
        }
        await createAuditEvent(transaction, {
          action: "SUPER_ADMIN_TENANT_ACCESS",
          actorUserId: userId,
          details,
          organizationId,
          reason: supportAccess.reason,
          supportAccessId,
          targetId: organizationId,
          targetType: "Organization",
        });
        return {
          actorUserId: userId,
          assignedBranchIds: [],
          grants: supportAccess.permissionCodes.flatMap((code) =>
            isPermissionCode(code) ? [{ code, scope: "ORGANIZATION" as const }] : [],
          ),
          organizationId,
          supportAccessId,
        };
      },
    );
  }

  async listTenantOverview(access: TenantAccessSnapshot) {
    requireAccessPermission(access, "organization.read");
    return this.runWithAccess(access, async (transaction) => {
      const organization = await transaction.organization.findUnique({
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          settings: { select: { businessSector: true, currency: true } },
          slug: true,
          status: true,
        },
        where: { id: access.organizationId },
      });
      const branches = await transaction.branch.count({
        where: { organizationId: access.organizationId },
      });
      const staff = await transaction.organizationMembership.count({
        where: { organizationId: access.organizationId, status: MembershipStatus.ACTIVE },
      });
      const services = await transaction.service.count({
        where: { organizationId: access.organizationId },
      });
      return { branches, organization, services, staff };
    });
  }

  async getSettings(access: TenantAccessSnapshot) {
    requireAccessPermission(access, "organization.settings.manage");
    return this.runWithAccess(access, (transaction) =>
      transaction.organizationSettings.findUnique({
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async getBusinessSector(access: TenantAccessSnapshot): Promise<BusinessSector | null> {
    requireAccessPermission(access, "organization.read");
    return this.runWithAccess(access, async (transaction) => {
      const settings = await transaction.organizationSettings.findUnique({
        select: { businessSector: true },
        where: { organizationId: access.organizationId },
      });
      return settings?.businessSector ?? null;
    });
  }

  async setBusinessSector(
    access: TenantAccessSnapshot,
    businessSector: BusinessSector,
  ): Promise<void> {
    requireAccessPermission(access, "organization.settings.manage");
    await this.runWithAccess(access, async (transaction) => {
      await transaction.organizationSettings.update({
        data: { businessSector },
        where: { organizationId: access.organizationId },
      });
      await createAuditEvent(transaction, {
        action: "ORGANIZATION_BUSINESS_SECTOR_UPDATED",
        actorUserId: access.actorUserId,
        metadata: { businessSector },
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
        targetId: access.organizationId,
        targetType: "Organization",
      });
    });
  }

  async updateSettings(
    access: TenantAccessSnapshot,
    input: Readonly<{
      bookingWindowDays: number;
      currency: string;
      defaultLocale: SupportedLocale;
      timezone: string;
    }>,
  ): Promise<void> {
    requireAccessPermission(access, "organization.settings.manage");
    await this.runWithAccess(access, async (transaction) => {
      await transaction.organizationSettings.update({
        data: input,
        where: { organizationId: access.organizationId },
      });
      await createAuditEvent(transaction, {
        action: "ORGANIZATION_SETTINGS_UPDATED",
        actorUserId: access.actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
      });
    });
  }

  async listBranches(access: TenantAccessSnapshot) {
    const scope = requireAccessPermission(access, "branches.read");
    return this.runWithAccess(access, (transaction) =>
      transaction.branch.findMany({
        orderBy: { nameEn: "asc" },
        where: {
          organizationId: access.organizationId,
          ...(scope === "ORGANIZATION" ? {} : { id: { in: [...access.assignedBranchIds] } }),
        },
      }),
    );
  }

  async createBranch(
    access: TenantAccessSnapshot,
    input: Readonly<{
      addressAr?: string | undefined;
      addressEn?: string | undefined;
      nameAr: string;
      nameEn: string;
      phone?: string | undefined;
      timezone: string;
    }>,
  ): Promise<void> {
    requireAccessPermission(access, "branches.manage");
    await this.runWithAccess(access, async (transaction) => {
      const branch = await transaction.branch.create({
        data: {
          addressAr: input.addressAr ?? null,
          addressEn: input.addressEn ?? null,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          organizationId: access.organizationId,
          phone: input.phone ?? null,
          timezone: input.timezone,
        },
      });
      await transaction.branchHoursRule.createMany({
        data: allWeekdays.map((weekday) => ({
          branchId: branch.id,
          endMinuteLocal: 1440,
          organizationId: access.organizationId,
          startMinuteLocal: 0,
          weekday,
        })),
      });
      await createAuditEvent(transaction, {
        action: "BRANCH_CREATED",
        actorUserId: access.actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
        targetId: branch.id,
        targetType: "Branch",
      });
    });
  }

  async deleteBranch(access: TenantAccessSnapshot, branchId: string): Promise<boolean> {
    requireAccessPermission(access, "branches.manage");
    return this.runWithAccess(access, async (transaction) => {
      const result = await transaction.branch.deleteMany({
        where: { id: branchId, organizationId: access.organizationId },
      });
      if (result.count > 0) {
        await createAuditEvent(transaction, {
          action: "BRANCH_DELETED",
          actorUserId: access.actorUserId,
          organizationId: access.organizationId,
          supportAccessId: access.supportAccessId,
          targetId: branchId,
          targetType: "Branch",
        });
      }
      return result.count === 1;
    });
  }

  async listRoles(access: TenantAccessSnapshot) {
    requireAccessPermission(access, "roles.read");
    return this.runWithAccess(access, (transaction) =>
      transaction.role.findMany({
        include: { permissions: { include: { permission: true } } },
        orderBy: { nameEn: "asc" },
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async listPermissions() {
    return this.client.permission.findMany({ orderBy: { code: "asc" } });
  }

  async createRole(
    access: TenantAccessSnapshot,
    input: Readonly<{
      key: string;
      nameAr: string;
      nameEn: string;
      permissionCodes: readonly string[];
    }>,
  ): Promise<void> {
    requireAccessPermission(access, "roles.manage");
    const selected = await this.client.permission.findMany({
      where: { code: { in: [...input.permissionCodes] } },
    });
    if (selected.length !== new Set(input.permissionCodes).size) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Unknown permission selected." });
    }
    await this.runWithAccess(access, async (transaction) => {
      const role = await transaction.role.create({
        data: {
          key: input.key,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          organizationId: access.organizationId,
        },
      });
      await transaction.rolePermission.createMany({
        data: selected.map((permission) => {
          if (!isPermissionCode(permission.code)) {
            throw new DomainError({
              code: "VALIDATION_FAILED",
              message: "Unknown permission selected.",
            });
          }
          return {
            organizationId: access.organizationId,
            permissionId: permission.id,
            roleId: role.id,
            scope: requireAccessPermission(access, permission.code),
          };
        }),
      });
      await createAuditEvent(transaction, {
        action: "ROLE_CREATED",
        actorUserId: access.actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
        targetId: role.id,
        targetType: "Role",
      });
    });
  }

  async listStaff(access: TenantAccessSnapshot) {
    requireAccessPermission(access, "staff.read");
    return this.runWithAccess(access, (transaction) =>
      transaction.organizationMembership.findMany({
        include: {
          roles: { include: { role: true } },
          staffProfile: { include: { branchAssignments: { include: { branch: true } } } },
          user: { select: { email: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async listInvitations(access: TenantAccessSnapshot) {
    requireAccessPermission(access, "staff.manage");
    return this.runWithAccess(access, (transaction) =>
      transaction.organizationInvitation.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          createdAt: true,
          email: true,
          expiresAt: true,
          id: true,
          role: { select: { nameAr: true, nameEn: true } },
          status: true,
        },
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async createInvitation(
    access: TenantAccessSnapshot,
    email: string,
    roleId: string,
  ): Promise<string> {
    requireAccessPermission(access, "staff.manage");
    const token = createInvitationToken();
    await this.runWithAccess(access, async (transaction) => {
      const role = await transaction.role.findFirst({
        select: { id: true, systemKey: true },
        where: { id: roleId, organizationId: access.organizationId },
      });
      if (!role) {
        throw new DomainError({ code: "NOT_FOUND", message: "Role not found." });
      }
      if (role.systemKey === "ORGANIZATION_OWNER") {
        throw new DomainError({
          code: "FORBIDDEN",
          message: "Owner access must be assigned explicitly to an existing member.",
        });
      }
      if (role.systemKey !== "SECRETARY" && role.systemKey !== "PROVIDER") {
        requireAccessPermission(access, "roles.manage");
      }
      await transaction.organizationInvitation.updateMany({
        data: { status: InvitationStatus.EXPIRED },
        where: {
          email: normalizedEmail(email),
          expiresAt: { lte: new Date() },
          organizationId: access.organizationId,
          status: InvitationStatus.PENDING,
        },
      });
      const invitation = await transaction.organizationInvitation.create({
        data: {
          email: normalizedEmail(email),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          invitedByUserId: access.actorUserId,
          organizationId: access.organizationId,
          roleId,
          tokenHash: hashInvitationToken(token),
        },
      });
      await createAuditEvent(transaction, {
        action: "STAFF_INVITED",
        actorUserId: access.actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
        targetId: invitation.id,
        targetType: "OrganizationInvitation",
      });
    });
    return token;
  }

  async revokeInvitation(access: TenantAccessSnapshot, invitationId: string): Promise<void> {
    requireAccessPermission(access, "staff.manage");
    await this.runWithAccess(access, async (transaction) => {
      await transaction.organizationInvitation.updateMany({
        data: { status: InvitationStatus.REVOKED },
        where: {
          id: invitationId,
          organizationId: access.organizationId,
          status: InvitationStatus.PENDING,
        },
      });
      await createAuditEvent(transaction, {
        action: "INVITATION_REVOKED",
        actorUserId: access.actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
        targetId: invitationId,
        targetType: "OrganizationInvitation",
      });
    });
  }

  async previewInvitation(token: string): Promise<InvitationPreview> {
    const invitation = await this.client.organizationInvitation.findUnique({
      include: { organization: true, role: true },
      where: { tokenHash: hashInvitationToken(token) },
    });
    if (!invitation) {
      throw new DomainError({ code: "INVITATION_INVALID", message: "Invitation is invalid." });
    }
    if (invitation.status !== InvitationStatus.PENDING) {
      throw new DomainError({
        code: "INVITATION_ALREADY_USED",
        message: "Invitation has already been used or revoked.",
      });
    }
    if (invitation.expiresAt <= new Date()) {
      throw new DomainError({ code: "INVITATION_EXPIRED", message: "Invitation has expired." });
    }
    if (invitation.organization.status === OrganizationStatus.SUSPENDED) {
      throw new DomainError({
        code: "ORGANIZATION_SUSPENDED",
        message: "The organization is suspended.",
      });
    }
    return {
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      organizationId: invitation.organizationId,
      organizationNameAr: invitation.organization.nameAr,
      organizationNameEn: invitation.organization.nameEn,
      roleNameAr: invitation.role.nameAr,
      roleNameEn: invitation.role.nameEn,
      status: invitation.status,
    };
  }

  async acceptInvitation(
    userId: string,
    userEmail: string,
    token: string,
  ): Promise<Readonly<{ membershipId: string; organizationId: string }>> {
    const tokenHash = hashInvitationToken(token);
    const invitation = await this.client.organizationInvitation.findUnique({
      include: { role: true },
      where: { tokenHash },
    });
    if (!invitation || invitation.email !== normalizedEmail(userEmail)) {
      throw new DomainError({ code: "INVITATION_INVALID", message: "Invitation is invalid." });
    }
    if (invitation.status !== InvitationStatus.PENDING) {
      throw new DomainError({
        code: "INVITATION_ALREADY_USED",
        message: "Invitation has already been used or revoked.",
      });
    }
    if (invitation.expiresAt <= new Date()) {
      throw new DomainError({ code: "INVITATION_EXPIRED", message: "Invitation has expired." });
    }

    return runInTenant(
      this.client,
      { actorUserId: userId, organizationId: invitation.organizationId },
      async (transaction) => {
        const organization = await transaction.organization.findUnique({
          select: { status: true },
          where: { id: invitation.organizationId },
        });
        if (!organization) {
          throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
        }
        if (organization.status === OrganizationStatus.SUSPENDED) {
          throw new DomainError({
            code: "ORGANIZATION_SUSPENDED",
            message: "The organization is suspended.",
          });
        }
        const consumed = await transaction.organizationInvitation.updateMany({
          data: {
            acceptedAt: new Date(),
            acceptedByUserId: userId,
            status: InvitationStatus.ACCEPTED,
          },
          where: {
            expiresAt: { gt: new Date() },
            id: invitation.id,
            organizationId: invitation.organizationId,
            status: InvitationStatus.PENDING,
            tokenHash,
          },
        });
        if (consumed.count !== 1) {
          throw new DomainError({
            code: "INVITATION_ALREADY_USED",
            message: "Invitation has already been used.",
          });
        }

        const existing = await transaction.organizationMembership.findUnique({
          where: {
            organizationId_userId: { organizationId: invitation.organizationId, userId },
          },
        });
        if (existing && existing.status !== MembershipStatus.ACTIVE) {
          throw new DomainError({
            code: "MEMBERSHIP_SUSPENDED",
            message: "A suspended or revoked membership cannot be restored by invitation.",
          });
        }
        const membership =
          existing ??
          (await transaction.organizationMembership.create({
            data: { organizationId: invitation.organizationId, userId },
          }));
        await transaction.membershipRole.upsert({
          create: {
            membershipId: membership.id,
            organizationId: invitation.organizationId,
            roleId: invitation.roleId,
          },
          update: {},
          where: {
            organizationId_membershipId_roleId: {
              membershipId: membership.id,
              organizationId: invitation.organizationId,
              roleId: invitation.roleId,
            },
          },
        });
        if (invitation.role.systemKey === "PROVIDER") {
          const user = await this.client.user.findUnique({ where: { id: userId } });
          if (!user) {
            throw new DomainError({ code: "NOT_FOUND", message: "User not found." });
          }
          await transaction.staffProfile.upsert({
            create: {
              displayNameAr: user.name,
              displayNameEn: user.name,
              isBookable: true,
              membershipId: membership.id,
              organizationId: invitation.organizationId,
            },
            update: {},
            where: { membershipId: membership.id },
          });
        }
        await createAuditEvent(transaction, {
          action: "INVITATION_ACCEPTED",
          actorUserId: userId,
          organizationId: invitation.organizationId,
          targetId: invitation.id,
          targetType: "OrganizationInvitation",
        });
        return { membershipId: membership.id, organizationId: invitation.organizationId };
      },
    );
  }

  async setMembershipStatus(
    access: TenantAccessSnapshot,
    membershipId: string,
    status: MembershipStatus,
  ): Promise<void> {
    requireAccessPermission(access, "staff.manage");
    if (membershipId === access.membershipId && status !== MembershipStatus.ACTIVE) {
      throw new DomainError({ code: "CONFLICT", message: "You cannot suspend yourself." });
    }
    await this.runWithAccess(access, async (transaction) => {
      const target = await transaction.organizationMembership.findFirst({
        include: { roles: { include: { role: true } } },
        where: { id: membershipId, organizationId: access.organizationId },
      });
      if (!target) {
        throw new DomainError({ code: "NOT_FOUND", message: "Membership not found." });
      }
      const isOwner = target.roles.some(({ role }) => role.systemKey === "ORGANIZATION_OWNER");
      if (isOwner) {
        requireAccessPermission(access, "roles.manage");
        if (status !== MembershipStatus.ACTIVE) {
          const otherOwners = await transaction.organizationMembership.count({
            where: {
              id: { not: membershipId },
              organizationId: access.organizationId,
              roles: { some: { role: { systemKey: "ORGANIZATION_OWNER" } } },
              status: MembershipStatus.ACTIVE,
            },
          });
          if (otherOwners === 0) {
            throw new DomainError({
              code: "CONFLICT",
              message: "The organization must retain at least one active owner.",
            });
          }
        }
      }
      const updated = await transaction.organizationMembership.updateMany({
        data: {
          status,
          suspendedAt: status === MembershipStatus.SUSPENDED ? new Date() : null,
        },
        where: { id: membershipId, organizationId: access.organizationId },
      });
      if (updated.count !== 1) {
        throw new DomainError({ code: "NOT_FOUND", message: "Membership not found." });
      }
      await createAuditEvent(transaction, {
        action: `MEMBERSHIP_${status}`,
        actorUserId: access.actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
        targetId: membershipId,
        targetType: "OrganizationMembership",
      });
    });
  }

  async replaceMembershipRole(
    access: TenantAccessSnapshot,
    membershipId: string,
    roleId: string,
  ): Promise<void> {
    requireAccessPermission(access, "roles.manage");
    await this.runWithAccess(access, async (transaction) => {
      const [membership, role] = await Promise.all([
        transaction.organizationMembership.findFirst({
          include: { roles: { include: { role: true } } },
          where: { id: membershipId, organizationId: access.organizationId },
        }),
        transaction.role.findFirst({
          where: { id: roleId, organizationId: access.organizationId },
        }),
      ]);
      if (!membership || !role) {
        throw new DomainError({ code: "NOT_FOUND", message: "Membership or role not found." });
      }
      const wasOwner = membership.roles.some(
        ({ role: currentRole }) => currentRole.systemKey === "ORGANIZATION_OWNER",
      );
      if (wasOwner && role.systemKey !== "ORGANIZATION_OWNER") {
        const otherOwners = await transaction.organizationMembership.count({
          where: {
            id: { not: membershipId },
            organizationId: access.organizationId,
            roles: { some: { role: { systemKey: "ORGANIZATION_OWNER" } } },
            status: MembershipStatus.ACTIVE,
          },
        });
        if (otherOwners === 0) {
          throw new DomainError({
            code: "CONFLICT",
            message: "The organization must retain at least one active owner.",
          });
        }
      }
      await transaction.membershipRole.deleteMany({
        where: { membershipId, organizationId: access.organizationId },
      });
      await transaction.membershipRole.create({
        data: { membershipId, organizationId: access.organizationId, roleId },
      });
      await createAuditEvent(transaction, {
        action: "MEMBERSHIP_ROLE_REPLACED",
        actorUserId: access.actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
        targetId: membershipId,
        targetType: "OrganizationMembership",
      });
    });
  }

  async listServices(access: TenantAccessSnapshot) {
    requireAccessPermission(access, "services.read");
    return this.runWithAccess(access, (transaction) =>
      transaction.service.findMany({
        include: { branches: { include: { branch: true } } },
        orderBy: { nameEn: "asc" },
        where: { organizationId: access.organizationId },
      }),
    );
  }

  async createService(
    access: TenantAccessSnapshot,
    input: Readonly<{
      currency: string;
      defaultDurationMins: number;
      defaultPriceMinor?: number | undefined;
      nameAr: string;
      nameEn: string;
    }>,
  ): Promise<void> {
    requireAccessPermission(access, "services.manage");
    await this.runWithAccess(access, async (transaction) => {
      const service = await transaction.service.create({
        data: {
          currency: input.currency,
          defaultDurationMins: input.defaultDurationMins,
          defaultPriceMinor: input.defaultPriceMinor ?? null,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          organizationId: access.organizationId,
        },
      });
      await createAuditEvent(transaction, {
        action: "SERVICE_CREATED",
        actorUserId: access.actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
        targetId: service.id,
        targetType: "Service",
      });
    });
  }

  async configureServiceBranch(
    access: TenantAccessSnapshot,
    input: Readonly<{
      branchId: string;
      durationMins?: number | undefined;
      isEnabled: boolean;
      priceMinor?: number | undefined;
      serviceId: string;
    }>,
  ): Promise<void> {
    requireAccessPermission(access, "services.manage");
    await this.runWithAccess(access, async (transaction) => {
      const [branch, service] = await Promise.all([
        transaction.branch.findFirst({
          where: { id: input.branchId, organizationId: access.organizationId },
        }),
        transaction.service.findFirst({
          where: { id: input.serviceId, organizationId: access.organizationId },
        }),
      ]);
      if (!branch || !service) {
        throw new DomainError({ code: "NOT_FOUND", message: "Branch or service not found." });
      }
      await transaction.serviceBranch.upsert({
        create: {
          branchId: input.branchId,
          durationMins: input.durationMins ?? null,
          isEnabled: input.isEnabled,
          organizationId: access.organizationId,
          priceMinor: input.priceMinor ?? null,
          serviceId: input.serviceId,
        },
        update: {
          durationMins: input.durationMins ?? null,
          isEnabled: input.isEnabled,
          priceMinor: input.priceMinor ?? null,
        },
        where: {
          organizationId_serviceId_branchId: {
            branchId: input.branchId,
            organizationId: access.organizationId,
            serviceId: input.serviceId,
          },
        },
      });
      await createAuditEvent(transaction, {
        action: "SERVICE_BRANCH_CONFIGURED",
        actorUserId: access.actorUserId,
        organizationId: access.organizationId,
        supportAccessId: access.supportAccessId,
        targetId: input.serviceId,
        targetType: "Service",
      });
    });
  }

  async listAvailabilityRules(access: TenantAccessSnapshot, staffProfileId?: string) {
    const scope = requireAccessPermission(access, "schedules.read");
    if (scope === "SELF" && staffProfileId && staffProfileId !== access.staffProfileId) {
      throw new DomainError({ code: "FORBIDDEN", message: "Schedule access is self-scoped." });
    }
    const effectiveStaffProfileId = scope === "SELF" ? access.staffProfileId : staffProfileId;
    if (scope === "SELF" && !effectiveStaffProfileId) {
      throw new DomainError({ code: "FORBIDDEN", message: "A staff profile is required." });
    }
    return this.runWithAccess(access, (transaction) =>
      transaction.availabilityRule.findMany({
        include: { branch: true, staffProfile: true },
        orderBy: [{ staffProfileId: "asc" }, { weekday: "asc" }, { startMinuteLocal: "asc" }],
        where: {
          organizationId: access.organizationId,
          ...(effectiveStaffProfileId ? { staffProfileId: effectiveStaffProfileId } : {}),
          ...(scope === "ASSIGNED_BRANCHES"
            ? { branchId: { in: [...access.assignedBranchIds] } }
            : {}),
        },
      }),
    );
  }

  async createAvailabilityRule(
    access: TenantAccessSnapshot,
    input: Readonly<{
      branchId?: string;
      endMinuteLocal: number;
      staffProfileId: string;
      startMinuteLocal: number;
      weekday: Prisma.AvailabilityRuleCreateInput["weekday"];
    }>,
  ): Promise<void> {
    const scope = requireAccessPermission(access, "schedules.manage");
    if (scope === "SELF" && input.staffProfileId !== access.staffProfileId) {
      throw new DomainError({ code: "FORBIDDEN", message: "Schedule access is self-scoped." });
    }
    if (
      scope !== "ORGANIZATION" &&
      (!input.branchId || !access.assignedBranchIds.includes(input.branchId))
    ) {
      throw new DomainError({
        code: "FORBIDDEN",
        message: "Schedule access is limited to assigned branches.",
      });
    }
    await this.runWithAccess(access, async (transaction) => {
      await transaction.availabilityRule.create({
        data: { ...input, organizationId: access.organizationId },
      });
    });
  }
}
