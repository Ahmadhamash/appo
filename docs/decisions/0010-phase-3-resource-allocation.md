# ADR 0010: Deterministic Phase 3 resource allocation

- Status: Accepted
- Date: 2026-08-25

## Context

ADR 0008 establishes PostgreSQL as the scheduling authority. Phase 3 must implement capacity-one
resources, pooled capacity, waitlist offers, and idempotent acceptance without materializing a row
for every possible slot. Availability reads can be stale before a customer accepts an offer.

## Decision

Model a capacity pool as a tenant- and branch-owned `ResourceGroup` containing individually
allocatable `Resource` rows. A service/branch requirement states how many resources from the group
are required. This provides capacity N by configuring N active resources while retaining the exact
units allocated to an appointment.

Availability expands branch, staff, and resource recurrence rules in memory for a bounded query of
at most 31 days and 100 results. It subtracts staff time off and half-open staff/resource
reservation intervals that include service buffers. It persists neither generated slots nor
availability query results.

Every create, reschedule, no-show restoration, and slot-offer acceptance uses one tenant-bound
database transaction. The transaction:

1. locks the provider row;
2. rechecks branch hours, staff availability, time off, and staff reservations;
3. locks candidate resources by resource-group ID and resource ID in deterministic order;
4. selects currently unreserved resources and writes the appointment and all reservations;
5. writes append-only appointment/offer history and audit evidence before commit.

PostgreSQL GiST exclusion constraints over
`(organization_id, provider_id/resource_id, tstzrange(starts_at, ends_at, '[)'))` remain the final
capacity-one defense. Row locks make pool allocation deterministic; constraints protect against
missed or future code paths. Any failure rolls back the appointment, staff reservation, and every
resource reservation. Conflict errors are safe, human-readable, and tell the caller to refresh
availability.

Slot offers do not reserve capacity. Acceptance locks the offer row, rejects expiry or previous use,
and creates or reschedules the appointment atomically. The accepted request UUID and immutable
fingerprint make an exact replay return the first appointment; a different request cannot reuse the
offer. Mock sends only create database attempts and perform no external communication.

## Consequences

- Two contenders for a capacity-one provider/resource produce one commit and one conflict.
- A group with N active resources admits at most N overlapping reservations.
- Large pools serialize briefly while their candidate rows are locked. This is an intentional
  initial tradeoff for correctness and can later be partitioned only with a new ADR and equivalent
  race tests.
- Providers may also be represented as linked `Resource` rows for inventory/reporting, but the
  mandatory appointment provider continues to use the staff reservation constraint.
- Overnight branch/resource rules are not represented in one row; configure two rules around
  midnight.

## Alternatives considered

- Permanent generated slot rows: rejected because recurrence expansion would create large amounts of
  disposable state and still require booking-time conflict checks.
- A numeric capacity counter without unit reservations: rejected because read/increment races and
  rescheduling rollback are harder to make explainable and auditable.
- Advisory locks or Redis locks as the only guard: rejected because they do not encode the interval
  invariant in the system of record.
