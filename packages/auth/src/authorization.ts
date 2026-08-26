import type { AuthenticatedActor } from "./actor";

export type AuthorizationDecision = Readonly<{
  decisionId: string;
  granted: boolean;
  permission: string;
  reasonCode: string;
}>;

export interface AuthorizationPolicy {
  authorize(actor: AuthenticatedActor, permission: string): Promise<AuthorizationDecision>;
}
