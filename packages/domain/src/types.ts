export type OrganizationId = string;
export type BranchId = string;
export type ActorId = string;

export type TenantContext = Readonly<{
  branchId?: BranchId;
  organizationId: OrganizationId;
}>;
