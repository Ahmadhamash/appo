# Phase 3 scheduling operations

## Performance assumptions

The initial target is availability-search p95 below 750 ms for a 14-day query and booking p95 below
1.5 seconds, excluding communications. The bounded engine supports at most 31 local dates, 100
returned slots, 20 units per service requirement, and 10 preferred branches per waitlist entry.
Candidate intervals use a 15-minute default step. Relevant reservations are fetched only for the
query window, and indexed tenant/resource/provider start timestamps support conflict scans.

The initial operational capacity assumption is up to 50 bookable providers per branch, 20 resource
groups per service/branch, and 100 active resources per group. Booking locks every active candidate
resource in a required group in stable UUID order. Monitor lock-wait time, availability duration,
candidate count, and conflict rate before increasing those limits. A measured lock hotspot requires
a reviewed allocation change, not removal of database constraints.

## Conflict behavior

Availability is a suggestion. Booking, rescheduling, no-show restoration, and offer acceptance
revalidate inside the database transaction. Staff and resource reservations include service buffers
and use half-open ranges, so exact adjacency is allowed only when buffers do not overlap. A conflict
returns `CONFLICT`; the UI asks the operator to find a fresh slot. No partial appointment or
resource set commits.

## Time and recurrence

The database stores appointment, reservation, offer, expiry, and audit instants as `TIMESTAMPTZ`.
Recurring rules store weekday plus local minutes and are interpreted using the branch IANA timezone.
Invalid or ambiguous daylight-saving local times are omitted from availability and rejected on
mutation. `Asia/Amman` is the development default. Overnight hours require two rules split at local
midnight.

## Mock offer operations

Phase 3 performs no network delivery. “Send mocked offer” requires current `appointment_slot_offers`
consent, stores a `MOCK_SENT` attempt, and labels the UI as mocked. Offers reserve no capacity. An
offer can be expired when its timestamp passes, declined once, or accepted once. Exact acceptance
replays return the existing appointment; different requests receive a conflict. Phase 4 will own
actual message/outbox delivery.
