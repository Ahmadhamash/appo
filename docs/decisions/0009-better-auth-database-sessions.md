# ADR 0009: Better Auth with database sessions

- Status: Accepted
- Date: 2026-08-23
- Supersedes: the open provider-selection action in ADR 0006

## Context

Phase 1 needs credential login, logout, revocable sessions, invitation-only registration, and an
explicit active tenant. JorMall must not implement password hashing or session cryptography. Its
normalized Membership, Role, Permission, resource-scope, and Super Admin support-access model must
remain authoritative instead of being replaced by provider organization claims.

## Decision

Use Better Auth 1.7 with its Prisma adapter, email/password provider, database sessions, secure
HTTP-only cookies, origin/CSRF checks, and database-backed login rate limits. Better Auth owns
password hashing and password verification. IDs use UUID generation. Cookie session caching is
disabled so session revocation and tenant-context changes are read from PostgreSQL.

Public email sign-up is blocked at the auth route. The only registration path is a server action
that first validates a JorMall invitation, invokes Better Auth's server API to create credentials,
and atomically consumes the email-bound JorMall invitation. Invitation secrets are random 256-bit
tokens; only their SHA-256 digest is stored. Tokens expire, are single-use, and cannot reactivate a
suspended or revoked membership.

The Better Auth Session stores nullable `activeOrganizationId`, `activeMembershipId`, and
`activeSupportAccessId` selectors. They are server-written hints. Every protected operation reloads
the session user, Organization status, Membership status, roles, permissions, branch assignments,
and provider identity before accessing tenant data. JorMall's custom tables remain the source of
authorization truth; the Better Auth organization plugin is deliberately not used.

JorMall Super Admin is a platform user flag, not a tenant role. Tenant access requires a separate,
30-minute PlatformSupportAccess grant with a reason and session selection. Starting, resolving, and
ending support access write append-only tenant audit events.

## Consequences

- Password storage and session-cookie security remain maintained-library responsibilities.
- Login and tenant revocation are immediately enforceable through fresh database checks.
- JorMall can change identity providers later without migrating tenant authorization semantics.
- Production invitation delivery needs an approved email adapter; Phase 1 exposes a one-time link
  for secure out-of-band delivery and never persists or logs the plaintext link.
- Account recovery, email verification delivery, and MFA are follow-up hardening work before broad
  public rollout; they do not weaken the invitation-only Phase 1 boundary.

## Alternatives considered

- Custom password hashing and session cookies: rejected as unnecessary security risk.
- Better Auth organization roles as JorMall RBAC: rejected because they do not model the required
  tenant-composite foreign keys, branch/self scopes, or audited platform support access.
- Stateless tenant claims: rejected because membership and organization suspension must take effect
  without waiting for a token to expire.
