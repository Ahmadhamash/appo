import { describe, expect, it } from "vitest";

import type { TenantAccessSnapshot } from "@jormall/domain/identity";

import { canAccessResource, requirePermission } from "./tenant-policy";

const provider: TenantAccessSnapshot = {
  actorUserId: "user-1",
  assignedBranchIds: ["branch-1"],
  grants: [{ code: "schedules.read", scope: "SELF" }],
  membershipId: "membership-1",
  organizationId: "organization-1",
  staffProfileId: "staff-1",
};

const secretary: TenantAccessSnapshot = {
  actorUserId: "user-2",
  assignedBranchIds: ["branch-1"],
  grants: [
    { code: "organization.read", scope: "ORGANIZATION" },
    { code: "roles.read", scope: "ORGANIZATION" },
    { code: "schedules.read", scope: "ASSIGNED_BRANCHES" },
  ],
  membershipId: "membership-2",
  organizationId: "organization-1",
  staffProfileId: "staff-2",
};

describe("tenant policy", () => {
  it("allows a provider to read their own schedule", () => {
    expect(canAccessResource(provider, "schedules.read", { staffProfileId: "staff-1" })).toBe(true);
  });

  it("denies a provider access to another provider schedule", () => {
    expect(canAccessResource(provider, "schedules.read", { staffProfileId: "staff-2" })).toBe(
      false,
    );
    expect(() =>
      requirePermission(provider, "schedules.read", { staffProfileId: "staff-2" }),
    ).toThrowError(/does not grant/);
  });

  it("does not infer role or settings management from secretary read access", () => {
    expect(canAccessResource(secretary, "roles.manage")).toBe(false);
    expect(canAccessResource(secretary, "organization.settings.manage")).toBe(false);
    expect(canAccessResource(secretary, "organization.billing.manage")).toBe(false);
  });
});
