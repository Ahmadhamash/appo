import { DomainError } from "@jormall/domain/errors";
import type {
  PermissionCode,
  PermissionGrant,
  PermissionScope,
  TenantAccessSnapshot,
} from "@jormall/domain/identity";

const scopeRank: Readonly<Record<PermissionScope, number>> = {
  ORGANIZATION: 3,
  ASSIGNED_BRANCHES: 2,
  SELF: 1,
};

export type ResourceScope = Readonly<{
  branchId?: string;
  staffProfileId?: string;
}>;

export function strongestGrant(
  grants: readonly PermissionGrant[],
  permission: PermissionCode,
): PermissionGrant | undefined {
  return grants
    .filter((grant) => grant.code === permission)
    .toSorted((left, right) => scopeRank[right.scope] - scopeRank[left.scope])[0];
}

export function canAccessResource(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
  resource: ResourceScope = {},
): boolean {
  const grant = strongestGrant(access.grants, permission);
  if (!grant) {
    return false;
  }

  if (grant.scope === "ORGANIZATION") {
    return true;
  }

  if (grant.scope === "ASSIGNED_BRANCHES") {
    return resource.branchId !== undefined && access.assignedBranchIds.includes(resource.branchId);
  }

  return (
    resource.staffProfileId !== undefined &&
    access.staffProfileId !== undefined &&
    resource.staffProfileId === access.staffProfileId
  );
}

export function requirePermission(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
  resource: ResourceScope = {},
): PermissionGrant {
  const grant = strongestGrant(access.grants, permission);
  if (!grant || !canAccessResource(access, permission, resource)) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "The active tenant context does not grant this permission.",
      metadata: { permission },
    });
  }
  return grant;
}
