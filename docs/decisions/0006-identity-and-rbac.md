# ADR 0006: Externalized identity and scoped RBAC

- Status: Accepted
- Date: 2026-08-23

## Context

One user may belong to multiple Organizations and branches. Roles need organization, branch,
self/assigned, customer-own, and AI gateway scopes. JorMall also needs secure sessions and explicit
platform administration without inventing password or authentication cryptography.

## Decision

Select a maintained identity/session provider or library during Phase 1 through a focused provider
decision. Store only provider subject linkage and application Memberships. Authorization is
JorMall's responsibility: a versioned permission registry, tenant-owned Roles/grants, default-role
templates, resource constraints, and policy evaluation in application use cases.

Session tenant selection is only a hint; active Membership and grants are revalidated. JorMall Super
Admin is a platform role and has no implicit tenant role. Exceptional access requires a time-bound
PlatformSupportAccess record and immutable audit evidence.

## Consequences

- Authentication can evolve without embedding provider claims as permanent business authorization.
- Fine-grained branch/self policies require explicit tests and query constraints beyond simple role
  names.
- Revocation takes effect through authoritative Membership/grant checks and session rotation.
- Phase 1 must evaluate provider support for secure cookies/sessions, MFA, invitations, account
  recovery, webhook lifecycle, local development, and data residency before implementation.

## Alternatives considered

- Custom password/session implementation: rejected as unnecessary security risk.
- Provider roles as application authorization: rejected because they cannot express tenant resource
  constraints and couple core policy to one vendor.
- One global user role: rejected because multi-membership and least privilege require
  context-specific grants.
