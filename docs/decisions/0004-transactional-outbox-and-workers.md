# ADR 0004: Transactional outbox and BullMQ workers

- Status: Accepted
- Date: 2026-08-23

Implementation status: Phase 4 implemented. PostgreSQL claims outbox events with
`FOR UPDATE SKIP LOCKED` through the non-login `jormall_relay` role. The relay uses the OutboxEvent
UUID as BullMQ's stable job ID. The worker reloads the authoritative event in tenant context, uses
adapter idempotency keys, retries at 1s/2s/4s with a 30s ceiling and four-attempt cap, and marks
exhausted messages/events dead-letter. Inbound WhatsApp requests are HMAC-verified over timestamp
plus raw body inside a five-minute replay window, then deduplicated before an inbox-processing
outbox event is committed. Local adapters are explicitly mock-only.

## Context

Appointment changes must reliably trigger messages, webhook work, analytics, and AI follow-up.
Calling a provider inside a database transaction is slow and cannot atomically commit both the
database and remote system. Enqueuing after commit can lose work if the process crashes between
steps.

## Decision

Commit an OutboxEvent in the same PostgreSQL transaction as business state/history. A relay claims
events and enqueues BullMQ jobs in Redis with stable event-derived job IDs. Workers are idempotent,
record MessageAttempt/execution state, retry bounded transient failures, expose dead letters, and
run reconciliation for ambiguous outcomes.

Inbound provider events are signature-verified, deduplicated in PostgreSQL, acknowledged quickly,
and processed asynchronously. Delivery semantics are at-least-once; business effects are idempotent.

## Consequences

- Committed business changes do not silently lose intended work.
- Duplicate delivery is expected and must be safe in every consumer/provider adapter.
- Relay lag, queue health, dead letters, stale claims, and reconciliation need metrics and runbooks.
- PostgreSQL remains the record of intent; Redis queue loss can be rebuilt from undelivered outbox
  state.

## Alternatives considered

- Direct provider calls in request transactions: rejected for atomicity, latency, and lock duration.
- Best-effort enqueue after commit: rejected because of the crash gap.
- Distributed transaction across PostgreSQL and providers/Redis: rejected as unavailable or
  operationally disproportionate.
