# ADR 0008: PostgreSQL-enforced scheduling conflicts

- Status: Accepted
- Date: 2026-08-23

## Context

Availability results become stale immediately. Concurrent public, staff, WhatsApp, and voice
attempts can select the same staff/resource slot. UI checks or a read-then-write application check
alone permit double booking.

## Decision

Treat availability search as advisory and the PostgreSQL booking transaction as authoritative. Store
capacity-one staff and resource-unit reservation intervals and enforce non-overlap with GiST
exclusion constraints over half-open UTC `tstzrange` values, scoped by Organization and blocking
state. Include service buffers in reservations. Use deterministic row locks plus counted
reservations for explicitly modeled pooled capacity.

Create/reschedule validates business rules, writes appointment/reservations/history/outbox, and
commits atomically. Constraint conflicts map to a structured conflict. Operations use
organization-scoped idempotency keys and immutable request fingerprints. Deterministic
multi-connection race tests are a release gate.

## Consequences

- Exactly one capacity-one contender can commit regardless of channel or stale cache.
- Migrations include PostgreSQL-specific extension/exclusion SQL not fully represented by Prisma.
- Rescheduling and pending-confirmation expiry must replace/release reservations in one transaction.
- Capacity pools need an explicit allocation/locking policy rather than a numeric field checked in
  UI.

## Alternatives considered

- UI/application availability check only: rejected because it races.
- Redis distributed lock as authority: rejected because Redis is not the scheduling source of truth
  and lock expiry/failure can violate integrity.
- Serializable isolation alone: rejected as useful but insufficiently explicit; database constraints
  encode the invariant and still require retry handling.
