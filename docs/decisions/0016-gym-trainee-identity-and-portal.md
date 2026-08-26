# ADR 0016: Gym trainee identity and private portal

Status: Accepted

## Context

ADR 0015 deliberately deferred an independent trainee login until customer identity and delegation
could be reviewed. A gym now needs a private trainee workspace for assigned workouts, nutrition,
measurements, and performed weights without granting an OrganizationMembership or exposing the staff
dashboard.

## Decision

Better Auth remains the only password and session authority. A `GymTraineeInvitation` is a
high-entropy, hashed, seven-day, single-use capability created by an actor with
`gym.trainees.manage`. Acceptance checks the authenticated email, invitation lifecycle, active Gym
organization, and linked tenant-local trainee profile in one transaction. Staff identities and
trainee identities must use separate accounts; a user with any OrganizationMembership cannot accept
a trainee invitation.

`GymTraineePortalAccess` links one Better Auth User to one `GymTraineeProfile`. The globally unique
User link intentionally prevents implicit tenant switching in this release. Portal requests resolve
organization and trainee identifiers from the authenticated User link; neither identifier is
accepted from a browser form or URL. Every read reloads access and organization status. A suspended
access or organization loses access immediately.

The portal uses explicit safe projections. It does not return customer contacts, internal profile
notes, staff plan notes, or workout/progress notes. A trainee may append their own workout and
measurement records only when the exercise belongs to their linked profile. Appearance updates are
bounded enum choices plus a validated six-digit shirt color. Each mutation appends an AuditEvent.

## Consequences

- Owner/manager administration and trainee self-service are separate application surfaces.
- No OrganizationMembership, role, organization switcher, or staff navigation is given to a trainee.
- Multi-gym trainee accounts require a future explicit actor/tenant switch design; they are not
  inferred from identifiers.
- Invitation delivery is not claimed. Local development exposes a copyable link; production delivery
  must use the consent-aware outbox pipeline.
- ADR 0015 remains authoritative for gym operations, except its deferred trainee-login statement is
  superseded by this decision.
