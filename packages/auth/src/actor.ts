import type { ActorId, TenantContext } from "@jormall/domain/types";

export type AuthenticatedActor =
  | Readonly<{
      id: ActorId;
      kind: "platform_super_admin";
      tenant?: never;
    }>
  | Readonly<{
      id: ActorId;
      kind: "organization_member" | "customer" | "ai_receptionist" | "system";
      tenant: TenantContext;
    }>;
