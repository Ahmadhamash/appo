"use server";

import { requirePermission } from "@jormall/auth/tenant-policy";
import { prisma } from "@jormall/db/client";
import {
  AppointmentStatus,
  BusinessSector,
  CommunicationChannel,
  ConsentChannel,
  ConsentSource,
  ConsentStatus,
  MembershipStatus,
  MockProviderBehavior,
  OrganizationStatus,
  ResourceKind,
  ResourceStatus,
  SupportedLocale,
  Weekday,
} from "@jormall/db/generated/enums";
import { type AppointmentSource } from "@jormall/db/generated/enums";
import { DomainError } from "@jormall/domain/errors";
import { aiActionNames } from "@jormall/domain/ai-foundation";
import {
  copilotFeedbackTypes,
  copilotInsightTypes,
  semanticMetricKeys,
} from "@jormall/domain/copilot";
import { communicationTemplateKeys } from "@jormall/domain/communications";
import { isPermissionCode } from "@jormall/domain/identity";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "../../server/auth";
import {
  aiFoundationRepository,
  aiChannelRepository,
  crmAppointmentRepository,
  communicationRepository,
  copilotRepository,
  gymRepository,
  identityRepository,
  requireTenantAccess,
  requireTenantPermission,
  schedulingRepository,
} from "../../server/identity";
import { staffCopilotService } from "../../server/copilot";
import { requestAuditDetails } from "../../server/request-context";
import { requireSession } from "../../server/session";

const localeSchema = z.enum(["en", "ar"]);
const uuidSchema = z.uuid();
const shortText = z.string().trim().min(2).max(160);
const optionalText = z.string().trim().max(500).optional();

function value(formData: FormData, name: string): unknown {
  return formData.get(name);
}

function localeFrom(formData: FormData): "en" | "ar" {
  return localeSchema.catch("en").parse(value(formData, "locale"));
}

function errorCode(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }
  return "INTERNAL_ERROR";
}

function destination(path: string, key: "error" | "notice", code: string): string {
  return `${path}?${key}=${encodeURIComponent(code)}`;
}

export async function loginAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const requestedReturnTo = z.string().max(500).catch("").parse(value(formData, "returnTo"));
  const returnTo =
    requestedReturnTo.startsWith(`/${locale}/`) && !requestedReturnTo.startsWith(`/${locale}//`)
      ? requestedReturnTo
      : `/${locale}/dashboard`;
  const result = z
    .object({ email: z.email().trim().toLowerCase(), password: z.string().min(1).max(128) })
    .safeParse({ email: value(formData, "email"), password: value(formData, "password") });
  if (!result.success) {
    redirect(destination(`/${locale}/login`, "error", "INVALID_CREDENTIALS"));
  }
  let resolvedReturnTo = returnTo;
  try {
    const signedIn = await auth.api.signInEmail({ body: result.data, headers: await headers() });
    const memberships = await identityRepository.listMembershipChoices(signedIn.user.id);
    const activeMemberships = memberships.filter(
      (membership) =>
        membership.status === MembershipStatus.ACTIVE &&
        membership.organization.status === OrganizationStatus.ACTIVE,
    );
    const onlyMembership = activeMemberships.length === 1 ? activeMemberships[0] : undefined;
    if (onlyMembership) {
      const resolvedMembership = await identityRepository.resolveMembershipForSwitch(
        signedIn.user.id,
        onlyMembership.id,
      );
      await prisma.session.updateMany({
        data: {
          activeMembershipId: resolvedMembership.id,
          activeOrganizationId: resolvedMembership.organizationId,
          activeSupportAccessId: null,
        },
        where: { token: signedIn.token, userId: signedIn.user.id },
      });
    } else if (
      activeMemberships.length === 0 &&
      returnTo === `/${locale}/dashboard` &&
      (await gymRepository.hasActivePortalAccess(signedIn.user.id))
    ) {
      resolvedReturnTo = `/${locale}/trainee`;
    }
  } catch {
    redirect(destination(`/${locale}/login`, "error", "INVALID_CREDENTIALS"));
  }
  redirect(resolvedReturnTo);
}

export async function logoutAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  await auth.api.signOut({ headers: await headers() });
  redirect(destination(`/${locale}/login`, "notice", "SIGNED_OUT"));
}

export async function switchOrganizationAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = uuidSchema.safeParse(value(formData, "membershipId"));
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard`, "error", "VALIDATION_FAILED"));
  }
  const session = await requireSession(locale);
  try {
    const membership = await identityRepository.resolveMembershipForSwitch(
      session.user.id,
      parsed.data,
    );
    await prisma.session.update({
      data: {
        activeMembershipId: membership.id,
        activeOrganizationId: membership.organizationId,
        activeSupportAccessId: null,
      },
      where: { id: session.session.id },
    });
    revalidatePath(`/${locale}/dashboard`, "layout");
  } catch (error) {
    redirect(destination(`/${locale}/dashboard`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard`, "notice", "ORGANIZATION_SWITCHED"));
}

export type InvitationCreationState = Readonly<{
  code?: string | undefined;
  invitationUrl?: string | undefined;
}>;

export async function createOrganizationAction(
  _previousState: InvitationCreationState,
  formData: FormData,
): Promise<InvitationCreationState> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      nameAr: shortText,
      nameEn: shortText,
      ownerEmail: z.email().trim().toLowerCase(),
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(80),
    })
    .safeParse({
      nameAr: value(formData, "nameAr"),
      nameEn: value(formData, "nameEn"),
      ownerEmail: value(formData, "ownerEmail"),
      slug: value(formData, "slug"),
    });
  if (!parsed.success) {
    return { code: "VALIDATION_FAILED" };
  }
  const session = await requireSession(locale);
  try {
    await identityRepository.assertSuperAdmin(session.user.id);
    const created = await identityRepository.createOrganization(session.user.id, parsed.data);
    revalidatePath(`/${locale}/platform/organizations`);
    return {
      code: "ORGANIZATION_CREATED",
      invitationUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/${locale}/invitations/${created.invitationToken}`,
    };
  } catch (error) {
    return { code: errorCode(error) };
  }
}

export async function setOrganizationStatusAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      organizationId: uuidSchema,
      reason: optionalText,
      status: z.enum([OrganizationStatus.ACTIVE, OrganizationStatus.SUSPENDED]),
    })
    .safeParse({
      organizationId: value(formData, "organizationId"),
      reason: value(formData, "reason") || undefined,
      status: value(formData, "status"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/platform/organizations`, "error", "VALIDATION_FAILED"));
  }
  const session = await requireSession(locale);
  try {
    await identityRepository.assertSuperAdmin(session.user.id);
    await identityRepository.setOrganizationStatus(
      session.user.id,
      parsed.data.organizationId,
      parsed.data.status,
      parsed.data.reason,
    );
  } catch (error) {
    redirect(destination(`/${locale}/platform/organizations`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/platform/organizations`, "notice", "STATUS_UPDATED"));
}

export async function startSupportAccessAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({ organizationId: uuidSchema, reason: z.string().trim().min(10).max(500) })
    .safeParse({
      organizationId: value(formData, "organizationId"),
      reason: value(formData, "reason"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/platform/organizations`, "error", "VALIDATION_FAILED"));
  }
  const session = await requireSession(locale);
  try {
    const supportAccessId = await identityRepository.startSupportAccess(
      session.user.id,
      parsed.data.organizationId,
      parsed.data.reason,
      await requestAuditDetails(),
    );
    await prisma.session.update({
      data: {
        activeMembershipId: null,
        activeOrganizationId: parsed.data.organizationId,
        activeSupportAccessId: supportAccessId,
      },
      where: { id: session.session.id },
    });
  } catch (error) {
    redirect(destination(`/${locale}/platform/organizations`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard`, "notice", "SUPPORT_STARTED"));
}

export async function endSupportAccessAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const session = await requireSession(locale);
  if (session.session.activeSupportAccessId) {
    await identityRepository.revokeSupportAccess(
      session.user.id,
      session.session.activeSupportAccessId,
      await requestAuditDetails(),
    );
  }
  await prisma.session.update({
    data: { activeMembershipId: null, activeOrganizationId: null, activeSupportAccessId: null },
    where: { id: session.session.id },
  });
  redirect(destination(`/${locale}/platform/organizations`, "notice", "SUPPORT_ENDED"));
}

export async function updateSettingsAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      bookingWindowDays: z.coerce.number().int().min(1).max(730),
      currency: z.string().trim().toUpperCase().length(3),
      defaultLocale: z.enum([SupportedLocale.en, SupportedLocale.ar]),
      timezone: z.string().trim().min(3).max(100),
    })
    .safeParse({
      bookingWindowDays: value(formData, "bookingWindowDays"),
      currency: value(formData, "currency"),
      defaultLocale: value(formData, "defaultLocale"),
      timezone: value(formData, "timezone"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/settings`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "organization.settings.manage");
    await identityRepository.updateSettings(access, parsed.data);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/settings`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/settings`, "notice", "SETTINGS_UPDATED"));
}

export async function setBusinessSectorAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .enum([BusinessSector.GYM, BusinessSector.CLINIC, BusinessSector.BEAUTY_CENTER])
    .safeParse(value(formData, "businessSector"));
  const returnTo = z
    .string()
    .max(200)
    .catch(`/${locale}/dashboard`)
    .parse(value(formData, "returnTo"));
  const safeReturnTo = returnTo.startsWith(`/${locale}/dashboard`)
    ? returnTo
    : `/${locale}/dashboard`;
  if (!parsed.success) {
    redirect(destination(safeReturnTo, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "organization.settings.manage");
    await identityRepository.setBusinessSector(access, parsed.data);
    revalidatePath(`/${locale}/dashboard`, "layout");
  } catch (error) {
    redirect(destination(safeReturnTo, "error", errorCode(error)));
  }
  redirect(destination(safeReturnTo, "notice", "BUSINESS_SECTOR_UPDATED"));
}

export async function createBranchAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      addressAr: optionalText,
      addressEn: optionalText,
      nameAr: shortText,
      nameEn: shortText,
      phone: z.string().trim().max(40).optional(),
      timezone: z.string().trim().min(3).max(100),
    })
    .safeParse({
      addressAr: value(formData, "addressAr") || undefined,
      addressEn: value(formData, "addressEn") || undefined,
      nameAr: value(formData, "nameAr"),
      nameEn: value(formData, "nameEn"),
      phone: value(formData, "phone") || undefined,
      timezone: value(formData, "timezone"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/branches`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "branches.manage");
    await identityRepository.createBranch(access, parsed.data);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/branches`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/branches`, "notice", "BRANCH_CREATED"));
}

export async function deleteBranchAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const branchId = uuidSchema.safeParse(value(formData, "branchId"));
  if (!branchId.success) {
    redirect(destination(`/${locale}/dashboard/branches`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "branches.manage");
    const deleted = await identityRepository.deleteBranch(access, branchId.data);
    if (!deleted) {
      throw new DomainError({ code: "NOT_FOUND", message: "Branch not found." });
    }
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/branches`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/branches`, "notice", "BRANCH_DELETED"));
}

export async function createInvitationAction(
  _previousState: InvitationCreationState,
  formData: FormData,
): Promise<InvitationCreationState> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({ email: z.email().trim().toLowerCase(), roleId: uuidSchema })
    .safeParse({ email: value(formData, "email"), roleId: value(formData, "roleId") });
  if (!parsed.success) {
    return { code: "VALIDATION_FAILED" };
  }
  try {
    const access = await requireTenantPermission(locale, "staff.manage");
    const targetRole = (await identityRepository.listRoles(access)).find(
      (role) => role.id === parsed.data.roleId,
    );
    if (!targetRole) {
      throw new DomainError({ code: "NOT_FOUND", message: "Role not found." });
    }
    if (targetRole.systemKey !== "SECRETARY" && targetRole.systemKey !== "PROVIDER") {
      requirePermission(access, "roles.manage");
    }
    const token = await identityRepository.createInvitation(
      access,
      parsed.data.email,
      parsed.data.roleId,
    );
    revalidatePath(`/${locale}/dashboard/staff`);
    return {
      code: "INVITATION_CREATED",
      invitationUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/${locale}/invitations/${token}`,
    };
  } catch (error) {
    return { code: errorCode(error) };
  }
}

export async function revokeInvitationAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const invitationId = uuidSchema.safeParse(value(formData, "invitationId"));
  if (!invitationId.success) {
    redirect(destination(`/${locale}/dashboard/staff`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "staff.manage");
    await identityRepository.revokeInvitation(access, invitationId.data);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/staff`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/staff`, "notice", "INVITATION_REVOKED"));
}

export async function setMembershipStatusAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      membershipId: uuidSchema,
      status: z.enum([
        MembershipStatus.ACTIVE,
        MembershipStatus.SUSPENDED,
        MembershipStatus.REVOKED,
      ]),
    })
    .safeParse({
      membershipId: value(formData, "membershipId"),
      status: value(formData, "status"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/staff`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "staff.manage");
    if (access.membershipId === parsed.data.membershipId) {
      throw new DomainError({ code: "CONFLICT", message: "You cannot suspend yourself." });
    }
    const target = (await identityRepository.listStaff(access)).find(
      (membership) => membership.id === parsed.data.membershipId,
    );
    if (!target) {
      throw new DomainError({ code: "NOT_FOUND", message: "Membership not found." });
    }
    if (target.roles.some(({ role }) => role.systemKey === "ORGANIZATION_OWNER")) {
      requirePermission(access, "roles.manage");
    }
    await identityRepository.setMembershipStatus(
      access,
      parsed.data.membershipId,
      parsed.data.status,
    );
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/staff`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/staff`, "notice", "MEMBERSHIP_UPDATED"));
}

export async function replaceMembershipRoleAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z.object({ membershipId: uuidSchema, roleId: uuidSchema }).safeParse({
    membershipId: value(formData, "membershipId"),
    roleId: value(formData, "roleId"),
  });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/staff`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "roles.manage");
    await identityRepository.replaceMembershipRole(
      access,
      parsed.data.membershipId,
      parsed.data.roleId,
    );
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/staff`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/staff`, "notice", "MEMBERSHIP_UPDATED"));
}

export async function createRoleAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      key: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9_]+$/)
        .max(80),
      nameAr: shortText,
      nameEn: shortText,
      permissionCodes: z.array(z.string()).min(1),
    })
    .safeParse({
      key: value(formData, "key"),
      nameAr: value(formData, "nameAr"),
      nameEn: value(formData, "nameEn"),
      permissionCodes: formData.getAll("permissionCodes"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/roles`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "roles.manage");
    for (const permission of parsed.data.permissionCodes) {
      if (!isPermissionCode(permission)) {
        throw new DomainError({ code: "VALIDATION_FAILED", message: "Unknown permission." });
      }
      requirePermission(access, permission);
    }
    await identityRepository.createRole(access, parsed.data);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/roles`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/roles`, "notice", "ROLE_CREATED"));
}

export async function createServiceAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      currency: z.string().trim().toUpperCase().length(3),
      defaultDurationMins: z.coerce.number().int().min(1).max(1440),
      defaultPriceMinor: z.coerce.number().int().min(0).optional(),
      nameAr: shortText,
      nameEn: shortText,
    })
    .safeParse({
      currency: value(formData, "currency"),
      defaultDurationMins: value(formData, "defaultDurationMins"),
      defaultPriceMinor: value(formData, "defaultPriceMinor") || undefined,
      nameAr: value(formData, "nameAr"),
      nameEn: value(formData, "nameEn"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/services`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "services.manage");
    await identityRepository.createService(access, parsed.data);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/services`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/services`, "notice", "SERVICE_CREATED"));
}

export async function configureServiceBranchAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      branchId: uuidSchema,
      durationMins: z.coerce.number().int().min(1).max(1440).optional(),
      isEnabled: z.boolean(),
      priceMinor: z.coerce.number().int().min(0).optional(),
      serviceId: uuidSchema,
    })
    .safeParse({
      branchId: value(formData, "branchId"),
      durationMins: value(formData, "durationMins") || undefined,
      isEnabled: value(formData, "isEnabled") === "on",
      priceMinor: value(formData, "priceMinor") || undefined,
      serviceId: value(formData, "serviceId"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/services`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "services.manage");
    await identityRepository.configureServiceBranch(access, parsed.data);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/services`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/services`, "notice", "SERVICE_CONFIGURED"));
}

export async function acceptInvitationAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const token = z.string().min(20).max(200).safeParse(value(formData, "token"));
  if (!token.success) {
    redirect(destination(`/${locale}/login`, "error", "INVITATION_INVALID"));
  }
  const session = await requireSession(locale);
  try {
    const accepted = await identityRepository.acceptInvitation(
      session.user.id,
      session.user.email,
      token.data,
    );
    await prisma.session.update({
      data: {
        activeMembershipId: accepted.membershipId,
        activeOrganizationId: accepted.organizationId,
        activeSupportAccessId: null,
      },
      where: { id: session.session.id },
    });
  } catch (error) {
    redirect(destination(`/${locale}/invitations/${token.data}`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard`, "notice", "INVITATION_ACCEPTED"));
}

export async function registerFromInvitationAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      name: shortText,
      password: z.string().min(12).max(128),
      token: z.string().min(20).max(200),
    })
    .safeParse({
      name: value(formData, "name"),
      password: value(formData, "password"),
      token: value(formData, "token"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/login`, "error", "VALIDATION_FAILED"));
  }
  let registeredUserId: string | undefined;
  try {
    const preview = await identityRepository.previewInvitation(parsed.data.token);
    const existing = await prisma.user.findUnique({ where: { email: preview.email } });
    if (existing) {
      throw new DomainError({
        code: "CONFLICT",
        message: "This email already has an account. Sign in to accept the invitation.",
      });
    }
    const registration = await auth.api.signUpEmail({
      body: { email: preview.email, name: parsed.data.name, password: parsed.data.password },
      headers: await headers(),
    });
    registeredUserId = registration.user.id;
    const accepted = await identityRepository.acceptInvitation(
      registration.user.id,
      registration.user.email,
      parsed.data.token,
    );
    if (!registration.token) {
      throw new DomainError({ code: "INTERNAL_ERROR", message: "Session was not created." });
    }
    await prisma.session.updateMany({
      data: {
        activeMembershipId: accepted.membershipId,
        activeOrganizationId: accepted.organizationId,
        activeSupportAccessId: null,
      },
      where: { token: registration.token, userId: registration.user.id },
    });
  } catch (error) {
    if (registeredUserId) {
      await prisma.user.deleteMany({
        where: { id: registeredUserId, memberships: { none: {} } },
      });
    }
    redirect(destination(`/${locale}/invitations/${parsed.data.token}`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard`, "notice", "INVITATION_ACCEPTED"));
}

export async function createCustomerAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      displayName: shortText,
      phoneOriginal: z.string().trim().max(80).optional(),
      preferredLocale: z.enum([SupportedLocale.en, SupportedLocale.ar]),
    })
    .safeParse({
      displayName: value(formData, "displayName"),
      phoneOriginal: value(formData, "phoneOriginal") || undefined,
      preferredLocale: value(formData, "preferredLocale"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/customers`, "error", "VALIDATION_FAILED"));
  }
  let customerId: string;
  let duplicateCount = 0;
  try {
    const access = await requireTenantAccess(locale);
    const created = await crmAppointmentRepository.createCustomer(
      access,
      parsed.data,
      await requestAuditDetails(),
    );
    customerId = created.customer.id;
    duplicateCount = created.likelyDuplicates.length;
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/customers`, "error", errorCode(error)));
  }
  redirect(
    `${destination(`/${locale}/dashboard/customers/${customerId}`, "notice", "CUSTOMER_CREATED")}&duplicates=${duplicateCount}`,
  );
}

export async function updateCustomerAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      customerId: uuidSchema,
      displayName: shortText,
      expectedVersion: z.coerce.number().int().positive(),
      phoneOriginal: z.string().trim().max(80).optional(),
      preferredLocale: z.enum([SupportedLocale.en, SupportedLocale.ar]),
    })
    .safeParse({
      customerId: value(formData, "customerId"),
      displayName: value(formData, "displayName"),
      expectedVersion: value(formData, "expectedVersion"),
      phoneOriginal: value(formData, "phoneOriginal") || undefined,
      preferredLocale: value(formData, "preferredLocale"),
    });
  const fallback = parsed.success
    ? `/${locale}/dashboard/customers/${parsed.data.customerId}`
    : `/${locale}/dashboard/customers`;
  if (!parsed.success) {
    redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  }
  let duplicateCount = 0;
  try {
    const access = await requireTenantAccess(locale);
    const updated = await crmAppointmentRepository.updateCustomer(
      access,
      parsed.data,
      await requestAuditDetails(),
    );
    duplicateCount = updated.likelyDuplicates.length;
  } catch (error) {
    redirect(destination(fallback, "error", errorCode(error)));
  }
  redirect(`${destination(fallback, "notice", "CUSTOMER_UPDATED")}&duplicates=${duplicateCount}`);
}

export async function recordConsentAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      customerId: uuidSchema,
      evidence: z.string().trim().max(2_000).optional(),
      purpose: z.string().trim().min(2).max(120),
      revokesConsentId: uuidSchema.optional(),
      status: z.enum([ConsentStatus.GRANTED, ConsentStatus.REVOKED]),
      textVersion: z.string().trim().min(1).max(80),
    })
    .safeParse({
      customerId: value(formData, "customerId"),
      evidence: value(formData, "evidence") || undefined,
      purpose: value(formData, "purpose"),
      revokesConsentId: value(formData, "revokesConsentId") || undefined,
      status: value(formData, "status"),
      textVersion: value(formData, "textVersion"),
    });
  const fallback = parsed.success
    ? `/${locale}/dashboard/customers/${parsed.data.customerId}`
    : `/${locale}/dashboard/customers`;
  if (!parsed.success) {
    redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await crmAppointmentRepository.recordConsent(
      access,
      {
        ...parsed.data,
        channel: ConsentChannel.STAFF,
        source: ConsentSource.STAFF,
      },
      await requestAuditDetails(),
    );
  } catch (error) {
    redirect(destination(fallback, "error", errorCode(error)));
  }
  redirect(destination(fallback, "notice", "CONSENT_RECORDED"));
}

export async function createAppointmentAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      branchId: uuidSchema,
      customerId: uuidSchema,
      idempotencyKey: uuidSchema.optional(),
      providerId: uuidSchema,
      serviceId: uuidSchema,
      startsAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
      status: z.enum([AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED]),
    })
    .safeParse({
      branchId: value(formData, "branchId"),
      customerId: value(formData, "customerId"),
      idempotencyKey: value(formData, "idempotencyKey") || undefined,
      providerId: value(formData, "providerId"),
      serviceId: value(formData, "serviceId"),
      startsAtLocal: value(formData, "startsAtLocal"),
      status: value(formData, "status"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/calendar`, "error", "VALIDATION_FAILED"));
  }
  let appointmentId: string;
  try {
    const access = await requireTenantAccess(locale);
    const appointment = await crmAppointmentRepository.createAppointment(
      access,
      { ...parsed.data, source: "STAFF" as AppointmentSource },
      await requestAuditDetails(),
    );
    appointmentId = appointment.id;
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/calendar`, "error", errorCode(error)));
  }
  redirect(
    destination(
      `/${locale}/dashboard/appointments/${appointmentId}`,
      "notice",
      "APPOINTMENT_CREATED",
    ),
  );
}

export async function rescheduleAppointmentAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      appointmentId: uuidSchema,
      expectedVersion: z.coerce.number().int().positive(),
      idempotencyKey: uuidSchema.optional(),
      startsAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    })
    .safeParse({
      appointmentId: value(formData, "appointmentId"),
      expectedVersion: value(formData, "expectedVersion"),
      idempotencyKey: value(formData, "idempotencyKey") || undefined,
      startsAtLocal: value(formData, "startsAtLocal"),
    });
  const fallback = parsed.success
    ? `/${locale}/dashboard/appointments/${parsed.data.appointmentId}`
    : `/${locale}/dashboard/calendar`;
  if (!parsed.success) {
    redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await crmAppointmentRepository.rescheduleAppointment(
      access,
      parsed.data,
      await requestAuditDetails(),
    );
  } catch (error) {
    redirect(destination(fallback, "error", errorCode(error)));
  }
  redirect(destination(fallback, "notice", "APPOINTMENT_RESCHEDULED"));
}

export async function transitionAppointmentAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      appointmentId: uuidSchema,
      expectedVersion: z.coerce.number().int().positive(),
      idempotencyKey: uuidSchema.optional(),
      reason: z.string().trim().max(500).optional(),
      recordDetails: z.string().trim().max(10_000).optional(),
      recordSummary: z.string().trim().max(5_000).optional(),
      toStatus: z.enum([
        AppointmentStatus.CONFIRMED,
        AppointmentStatus.CHECKED_IN,
        AppointmentStatus.IN_PROGRESS,
        AppointmentStatus.COMPLETED,
        AppointmentStatus.CANCELLED,
        AppointmentStatus.NO_SHOW,
      ]),
    })
    .safeParse({
      appointmentId: value(formData, "appointmentId"),
      expectedVersion: value(formData, "expectedVersion"),
      idempotencyKey: value(formData, "idempotencyKey") || undefined,
      reason: value(formData, "reason") || undefined,
      recordDetails: value(formData, "recordDetails") || undefined,
      recordSummary: value(formData, "recordSummary") || undefined,
      toStatus: value(formData, "toStatus"),
    });
  const fallback = parsed.success
    ? `/${locale}/dashboard/appointments/${parsed.data.appointmentId}`
    : `/${locale}/dashboard/today`;
  if (!parsed.success) {
    redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await crmAppointmentRepository.transitionAppointment(
      access,
      parsed.data,
      await requestAuditDetails(),
    );
  } catch (error) {
    redirect(destination(fallback, "error", errorCode(error)));
  }
  redirect(destination(fallback, "notice", "APPOINTMENT_UPDATED"));
}

export async function addAppointmentNoteAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({ appointmentId: uuidSchema, body: z.string().trim().min(1).max(10_000) })
    .safeParse({ appointmentId: value(formData, "appointmentId"), body: value(formData, "body") });
  const fallback = parsed.success
    ? `/${locale}/dashboard/appointments/${parsed.data.appointmentId}`
    : `/${locale}/dashboard/today`;
  if (!parsed.success) {
    redirect(destination(fallback, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await crmAppointmentRepository.addInternalNote(
      access,
      parsed.data,
      await requestAuditDetails(),
    );
  } catch (error) {
    redirect(destination(fallback, "error", errorCode(error)));
  }
  redirect(destination(fallback, "notice", "NOTE_ADDED"));
}

const resourceKinds = z.enum(ResourceKind);
const resourceStatuses = z.enum(ResourceStatus);
const weekdays = z.enum(Weekday);

export async function createResourceGroupAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({ branchId: uuidSchema, kind: resourceKinds, nameAr: shortText, nameEn: shortText })
    .safeParse({
      branchId: value(formData, "branchId"),
      kind: value(formData, "kind"),
      nameAr: value(formData, "nameAr"),
      nameEn: value(formData, "nameEn"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await schedulingRepository.createResourceGroup(
      access,
      parsed.data,
      await requestAuditDetails(),
    );
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/resources`, "notice", "RESOURCE_GROUP_CREATED"));
}

export async function createResourceAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      groupId: uuidSchema,
      nameAr: shortText,
      nameEn: shortText,
      staffProfileId: uuidSchema.optional(),
    })
    .safeParse({
      groupId: value(formData, "groupId"),
      nameAr: value(formData, "nameAr"),
      nameEn: value(formData, "nameEn"),
      staffProfileId: value(formData, "staffProfileId") || undefined,
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await schedulingRepository.createResource(access, parsed.data, await requestAuditDetails());
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/resources`, "notice", "RESOURCE_CREATED"));
}

export async function setResourceStatusAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({ resourceId: uuidSchema, status: resourceStatuses })
    .safeParse({ resourceId: value(formData, "resourceId"), status: value(formData, "status") });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await schedulingRepository.setResourceStatus(access, parsed.data, await requestAuditDetails());
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/resources`, "notice", "RESOURCE_UPDATED"));
}

export async function createBranchHoursRuleAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      branchId: uuidSchema,
      endMinuteLocal: z.coerce.number().int().min(1).max(1440),
      startMinuteLocal: z.coerce.number().int().min(0).max(1439),
      weekday: weekdays,
    })
    .safeParse({
      branchId: value(formData, "branchId"),
      endMinuteLocal: value(formData, "endMinuteLocal"),
      startMinuteLocal: value(formData, "startMinuteLocal"),
      weekday: value(formData, "weekday"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await schedulingRepository.createBranchHoursRule(access, parsed.data);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/resources`, "notice", "HOURS_ADDED"));
}

export async function createResourceAvailabilityRuleAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      endMinuteLocal: z.coerce.number().int().min(1).max(1440),
      resourceId: uuidSchema,
      startMinuteLocal: z.coerce.number().int().min(0).max(1439),
      weekday: weekdays,
    })
    .safeParse({
      endMinuteLocal: value(formData, "endMinuteLocal"),
      resourceId: value(formData, "resourceId"),
      startMinuteLocal: value(formData, "startMinuteLocal"),
      weekday: value(formData, "weekday"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await schedulingRepository.createResourceAvailabilityRule(access, parsed.data);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/resources`, "notice", "HOURS_ADDED"));
}

export async function setServiceResourceRequirementAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      branchId: uuidSchema,
      quantity: z.coerce.number().int().min(1).max(20),
      resourceGroupId: uuidSchema,
      serviceId: uuidSchema,
    })
    .safeParse({
      branchId: value(formData, "branchId"),
      quantity: value(formData, "quantity"),
      resourceGroupId: value(formData, "resourceGroupId"),
      serviceId: value(formData, "serviceId"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await schedulingRepository.setServiceResourceRequirement(
      access,
      parsed.data,
      await requestAuditDetails(),
    );
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/resources`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/resources`, "notice", "REQUIREMENT_SAVED"));
}

export async function createWaitlistEntryAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      appointmentId: uuidSchema.optional(),
      branchIds: z.array(uuidSchema).min(1).max(10),
      customerId: uuidSchema,
      notes: z.string().trim().max(500).optional(),
      preferredEndDate: z.iso.date(),
      preferredEndMinute: z.coerce.number().int().min(1).max(1440),
      preferredStartDate: z.iso.date(),
      preferredStartMinute: z.coerce.number().int().min(0).max(1439),
      priority: z.coerce.number().int().min(-100).max(100),
      providerIds: z.array(uuidSchema).max(20),
      serviceId: uuidSchema,
    })
    .safeParse({
      appointmentId: value(formData, "appointmentId") || undefined,
      branchIds: formData.getAll("branchIds"),
      customerId: value(formData, "customerId"),
      notes: value(formData, "notes") || undefined,
      preferredEndDate: value(formData, "preferredEndDate"),
      preferredEndMinute: value(formData, "preferredEndMinute"),
      preferredStartDate: value(formData, "preferredStartDate"),
      preferredStartMinute: value(formData, "preferredStartMinute"),
      priority: value(formData, "priority"),
      providerIds: formData.getAll("providerIds"),
      serviceId: value(formData, "serviceId"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/waitlist`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await schedulingRepository.createWaitlistEntry(
      access,
      parsed.data,
      await requestAuditDetails(),
    );
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/waitlist`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/waitlist`, "notice", "WAITLIST_ADDED"));
}

export async function cancelWaitlistEntryAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({ entryId: uuidSchema, expectedVersion: z.coerce.number().int().positive() })
    .safeParse({
      entryId: value(formData, "entryId"),
      expectedVersion: value(formData, "expectedVersion"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/waitlist`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await schedulingRepository.cancelWaitlistEntry(
      access,
      parsed.data,
      await requestAuditDetails(),
    );
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/waitlist`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/waitlist`, "notice", "WAITLIST_CANCELLED"));
}

export async function sendMockSlotOfferAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      branchId: uuidSchema,
      expiresInHours: z.coerce.number().int().min(1).max(168),
      providerId: uuidSchema,
      startsAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
      waitlistEntryId: uuidSchema,
    })
    .safeParse({
      branchId: value(formData, "branchId"),
      expiresInHours: value(formData, "expiresInHours"),
      providerId: value(formData, "providerId"),
      startsAtLocal: value(formData, "startsAtLocal"),
      waitlistEntryId: value(formData, "waitlistEntryId"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/waitlist`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    await schedulingRepository.sendMockSlotOffer(
      access,
      {
        ...parsed.data,
        expiresAt: new Date(Date.now() + parsed.data.expiresInHours * 60 * 60 * 1000),
      },
      await requestAuditDetails(),
    );
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/waitlist`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/waitlist`, "notice", "MOCK_OFFER_SENT"));
}

async function resolveSlotOfferAction(
  formData: FormData,
  operation: "accept" | "decline" | "expire",
): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z.object({ offerId: uuidSchema, requestKey: uuidSchema.optional() }).safeParse({
    offerId: value(formData, "offerId"),
    requestKey: value(formData, "requestKey") || undefined,
  });
  if (!parsed.success || (operation !== "expire" && !parsed.data.requestKey)) {
    redirect(destination(`/${locale}/dashboard/waitlist`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantAccess(locale);
    const details = await requestAuditDetails();
    if (operation === "accept") {
      const requestKey = parsed.data.requestKey;
      if (!requestKey) {
        redirect(destination(`/${locale}/dashboard/waitlist`, "error", "VALIDATION_FAILED"));
      }
      await schedulingRepository.acceptSlotOffer(
        access,
        { offerId: parsed.data.offerId, requestKey },
        details,
      );
    } else if (operation === "decline") {
      const requestKey = parsed.data.requestKey;
      if (!requestKey) {
        redirect(destination(`/${locale}/dashboard/waitlist`, "error", "VALIDATION_FAILED"));
      }
      await schedulingRepository.declineSlotOffer(
        access,
        { offerId: parsed.data.offerId, requestKey },
        details,
      );
    } else {
      await schedulingRepository.expireSlotOffer(access, parsed.data.offerId, new Date(), details);
    }
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/waitlist`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/waitlist`, "notice", "OFFER_UPDATED"));
}

export async function acceptSlotOfferAction(formData: FormData): Promise<never> {
  return resolveSlotOfferAction(formData, "accept");
}

export async function declineSlotOfferAction(formData: FormData): Promise<never> {
  return resolveSlotOfferAction(formData, "decline");
}

export async function expireSlotOfferAction(formData: FormData): Promise<never> {
  return resolveSlotOfferAction(formData, "expire");
}

export async function setCommunicationPreferenceAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      channel: z.enum([CommunicationChannel.SMS, CommunicationChannel.WHATSAPP]),
      customerId: uuidSchema,
      enabled: z.enum(["true", "false"]).transform((item) => item === "true"),
      reason: optionalText,
    })
    .safeParse({
      channel: value(formData, "channel"),
      customerId: value(formData, "customerId"),
      enabled: value(formData, "enabled"),
      reason: value(formData, "reason") || undefined,
    });
  if (!parsed.success)
    redirect(destination(`/${locale}/dashboard/customers`, "error", "VALIDATION_FAILED"));
  try {
    const access = await requireTenantPermission(locale, "communication_preferences.manage");
    await communicationRepository.setCommunicationPreference(access, parsed.data);
  } catch (error) {
    redirect(
      destination(
        `/${locale}/dashboard/customers/${parsed.data.customerId}`,
        "error",
        errorCode(error),
      ),
    );
  }
  redirect(
    destination(
      `/${locale}/dashboard/customers/${parsed.data.customerId}`,
      "notice",
      "PREFERENCE_UPDATED",
    ),
  );
}

export async function sendTemplateMessageAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      appointmentId: z.union([uuidSchema, z.literal("")]).transform((item) => item || undefined),
      channel: z.enum([CommunicationChannel.SMS, CommunicationChannel.WHATSAPP]),
      customerId: uuidSchema,
      messageLocale: z.enum(["en", "ar"]),
      templateKey: z.enum(communicationTemplateKeys),
    })
    .safeParse({
      appointmentId: value(formData, "appointmentId") ?? "",
      channel: value(formData, "channel"),
      customerId: value(formData, "customerId"),
      messageLocale: value(formData, "messageLocale"),
      templateKey: value(formData, "templateKey"),
    });
  if (!parsed.success)
    redirect(destination(`/${locale}/dashboard/communications`, "error", "VALIDATION_FAILED"));
  try {
    const access = await requireTenantAccess(locale);
    await communicationRepository.createOutboundMessage(access, {
      ...(parsed.data.appointmentId ? { appointmentId: parsed.data.appointmentId } : {}),
      channel: parsed.data.channel,
      customerId: parsed.data.customerId,
      locale: parsed.data.messageLocale,
      templateKey: parsed.data.templateKey,
    });
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/communications`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/communications`, "notice", "MESSAGE_QUEUED"));
}

export async function retryMessageAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const messageId = uuidSchema.safeParse(value(formData, "messageId"));
  if (!messageId.success)
    redirect(destination(`/${locale}/dashboard/communications`, "error", "VALIDATION_FAILED"));
  try {
    const access = await requireTenantPermission(locale, "messages.retry");
    await communicationRepository.retryMessage(access, messageId.data);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/communications`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/communications`, "notice", "MESSAGE_RETRY_QUEUED"));
}

export async function setMockProviderBehaviorAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      behavior: z.enum([
        MockProviderBehavior.SUCCESS,
        MockProviderBehavior.TRANSIENT_ONCE,
        MockProviderBehavior.TIMEOUT,
        MockProviderBehavior.PERMANENT_FAILURE,
      ]),
      connectionId: uuidSchema,
    })
    .safeParse({
      behavior: value(formData, "behavior"),
      connectionId: value(formData, "connectionId"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/communications`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "provider_credentials.manage");
    await communicationRepository.setMockProviderBehavior(
      access,
      parsed.data.connectionId,
      parsed.data.behavior,
    );
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/communications`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/communications`, "notice", "PROVIDER_UPDATED"));
}

export async function ingestKnowledgeAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const upload = value(formData, "upload");
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(180),
      sourceId: z.union([uuidSchema, z.literal("")]).transform((item) => item || undefined),
      textContent: z.string().max(200_000),
      title: z.string().trim().min(2).max(220),
    })
    .safeParse({
      name: value(formData, "name"),
      sourceId: value(formData, "sourceId") ?? "",
      textContent: value(formData, "textContent") ?? "",
      title: value(formData, "title"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/knowledge`, "error", "VALIDATION_FAILED"));
  }
  let content = parsed.data.textContent;
  let originalFilename: string | undefined;
  if (upload instanceof File && upload.size > 0) {
    const safeType = ["text/markdown", "text/plain", ""].includes(upload.type);
    const safeName = /\.(md|markdown|txt)$/i.test(upload.name);
    if (!safeType || !safeName || upload.size > 200_000 || upload.name.length > 255) {
      redirect(destination(`/${locale}/dashboard/knowledge`, "error", "VALIDATION_FAILED"));
    }
    content = await upload.text();
    originalFilename = upload.name;
  }
  if (!content.trim()) {
    redirect(destination(`/${locale}/dashboard/knowledge`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "knowledge.manage");
    await aiFoundationRepository.ingestKnowledge(access, {
      content,
      name: parsed.data.name,
      ...(originalFilename ? { originalFilename } : {}),
      ...(parsed.data.sourceId ? { sourceId: parsed.data.sourceId } : {}),
      title: parsed.data.title,
    });
    revalidatePath(`/${locale}/dashboard/knowledge`);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/knowledge`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/knowledge`, "notice", "KNOWLEDGE_INGESTED"));
}

export async function activateKnowledgeVersionAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({ sourceId: uuidSchema, versionId: uuidSchema })
    .safeParse({ sourceId: value(formData, "sourceId"), versionId: value(formData, "versionId") });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/knowledge`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "knowledge.manage");
    await aiFoundationRepository.activateKnowledgeVersion(
      access,
      parsed.data.sourceId,
      parsed.data.versionId,
    );
    revalidatePath(`/${locale}/dashboard/knowledge`);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/knowledge`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/knowledge`, "notice", "KNOWLEDGE_ACTIVATED"));
}

export async function updateAIConfigurationAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      allowedActionNames: z.array(z.enum(aiActionNames)).min(1),
      businessGuidance: z.string().trim().max(2_000).optional(),
      expectedVersion: z.coerce.number().int().min(1),
      minimumConfidence: z.coerce.number().min(0.5).max(1),
      monthlyActionLimit: z.coerce.number().int().min(0).max(1_000_000),
      monthlyCostLimitMicros: z.coerce.number().int().min(0),
      monthlyTokenLimit: z.coerce.number().int().min(0).max(1_000_000_000),
    })
    .safeParse({
      allowedActionNames: formData.getAll("allowedActionNames"),
      businessGuidance: value(formData, "businessGuidance") || undefined,
      expectedVersion: value(formData, "expectedVersion"),
      minimumConfidence: value(formData, "minimumConfidence"),
      monthlyActionLimit: value(formData, "monthlyActionLimit"),
      monthlyCostLimitMicros: value(formData, "monthlyCostLimitMicros"),
      monthlyTokenLimit: value(formData, "monthlyTokenLimit"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/ai-settings`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "ai.configure");
    await aiFoundationRepository.updatePromptConfiguration(access, parsed.data);
    revalidatePath(`/${locale}/dashboard/ai-settings`);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/ai-settings`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/ai-settings`, "notice", "AI_CONFIGURATION_UPDATED"));
}

export async function updateHumanHandoffAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      assignedMembershipId: z
        .union([uuidSchema, z.literal("")])
        .transform((item) => item || undefined),
      handoffId: uuidSchema,
      status: z.enum(["ASSIGNED", "CLOSED", "RESOLVED"]),
    })
    .safeParse({
      assignedMembershipId: value(formData, "assignedMembershipId") ?? "",
      handoffId: value(formData, "handoffId"),
      status: value(formData, "status"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/ai-handoffs`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "conversations.handoff");
    await aiFoundationRepository.updateHumanHandoff(
      access,
      parsed.data.handoffId,
      parsed.data.status,
      parsed.data.assignedMembershipId,
    );
    revalidatePath(`/${locale}/dashboard/ai-handoffs`);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/ai-handoffs`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/ai-handoffs`, "notice", "HANDOFF_UPDATED"));
}

export async function createWidgetConfigurationAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
      allowedOrigins: z
        .string()
        .max(10_000)
        .transform((item) =>
          item
            .split(/\r?\n/u)
            .map((origin) => origin.trim())
            .filter(Boolean),
        )
        .pipe(z.array(z.string().url()).min(1).max(20)),
      defaultLocale: z.enum(["en", "ar"]),
      displayNameAr: z.string().trim().min(2).max(160),
      displayNameEn: z.string().trim().min(2).max(160),
      name: z.string().trim().min(2).max(120),
      primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i),
    })
    .safeParse({
      accentColor: value(formData, "accentColor"),
      allowedOrigins: value(formData, "allowedOrigins"),
      defaultLocale: value(formData, "defaultLocale"),
      displayNameAr: value(formData, "displayNameAr"),
      displayNameEn: value(formData, "displayNameEn"),
      name: value(formData, "name"),
      primaryColor: value(formData, "primaryColor"),
    });
  if (!parsed.success) {
    redirect(destination(`/${locale}/dashboard/ai-channels`, "error", "VALIDATION_FAILED"));
  }
  try {
    const access = await requireTenantPermission(locale, "ai.configure");
    await aiChannelRepository.createWidgetConfiguration(access, parsed.data);
    revalidatePath(`/${locale}/dashboard/ai-channels`);
  } catch (error) {
    redirect(destination(`/${locale}/dashboard/ai-channels`, "error", errorCode(error)));
  }
  redirect(destination(`/${locale}/dashboard/ai-channels`, "notice", "AI_WIDGET_CREATED"));
}

export async function generateCopilotInsightAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      branchId: z.union([uuidSchema, z.literal("")]).transform((entry) => entry || undefined),
      endsOn: z.iso.date().optional(),
      insightType: z.enum(copilotInsightTypes),
      metric: z.enum(semanticMetricKeys).optional(),
      startsOn: z.iso.date().optional(),
      subjectId: z.union([uuidSchema, z.literal("")]).transform((entry) => entry || undefined),
    })
    .safeParse({
      branchId: value(formData, "branchId") ?? "",
      endsOn: value(formData, "endsOn") || undefined,
      insightType: value(formData, "insightType"),
      metric: value(formData, "metric") || undefined,
      startsOn: value(formData, "startsOn") || undefined,
      subjectId: value(formData, "subjectId") ?? "",
    });
  const fallbackPath = `/${locale}/dashboard/copilot`;
  if (!parsed.success) {
    redirect(destination(fallbackPath, "error", "VALIDATION_FAILED"));
  }
  const subjectPath =
    parsed.data.insightType === "CUSTOMER_SUMMARY" && parsed.data.subjectId
      ? `/${locale}/dashboard/customers/${parsed.data.subjectId}`
      : fallbackPath;
  try {
    const access = await requireTenantAccess(locale);
    const metricQuery =
      parsed.data.insightType === "ANALYTICS" &&
      parsed.data.metric &&
      parsed.data.startsOn &&
      parsed.data.endsOn
        ? {
            ...(parsed.data.branchId ? { branchId: parsed.data.branchId } : {}),
            endsAt: new Date(`${parsed.data.endsOn}T23:59:59.999Z`).toISOString(),
            metric: parsed.data.metric,
            startsAt: new Date(`${parsed.data.startsOn}T00:00:00.000Z`).toISOString(),
          }
        : undefined;
    await staffCopilotService.generate(access, {
      insightType: parsed.data.insightType,
      locale,
      ...(metricQuery ? { metricQuery } : {}),
      ...(parsed.data.subjectId ? { subjectId: parsed.data.subjectId } : {}),
    });
    revalidatePath(subjectPath);
  } catch (error) {
    redirect(destination(subjectPath, "error", errorCode(error)));
  }
  redirect(destination(subjectPath, "notice", "COPILOT_INSIGHT_GENERATED"));
}

export async function recordCopilotFeedbackAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const path = `/${locale}/dashboard/copilot`;
  const parsed = z
    .object({
      comment: z.string().trim().max(500).optional(),
      feedbackType: z.enum(copilotFeedbackTypes),
      insightId: uuidSchema,
    })
    .safeParse({
      comment: value(formData, "comment") || undefined,
      feedbackType: value(formData, "feedbackType"),
      insightId: value(formData, "insightId"),
    });
  if (!parsed.success) redirect(destination(path, "error", "VALIDATION_FAILED"));
  try {
    const access = await requireTenantAccess(locale);
    await copilotRepository.recordFeedback(
      access,
      parsed.data.insightId,
      parsed.data.feedbackType,
      parsed.data.comment,
    );
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "COPILOT_FEEDBACK_RECORDED"));
}
