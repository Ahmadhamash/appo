# ADR 0011: Shared AI customer-channel transports

- Status: Accepted
- Date: 2026-08-28

## Context

Phase 5B adds website, WhatsApp, and voice delivery to the Phase 5A AI foundation. Reimplementing
orchestration or booking rules inside a channel would create inconsistent authorization,
confirmation, idempotency, and disclosure behavior. Public traffic also cannot select its tenant
from model or customer text. Voice may eventually need a persistent media service, but the current
provider-neutral contract is callback based and no measured latency result justifies another app.

## Decision

- All three channels call one `SharedAIChannelCoordinator`, one `SafeAIOrchestrator`, and the
  existing Action Gateway. Channel code only verifies/routs identity, normalizes events, delivers
  safe text, and handles transport lifecycle.
- Website installations use a signed public configuration containing only a dedicated public key,
  version, and expiry. Website session capabilities are signed and opaque with respect to tenant and
  database row IDs. A high-entropy nonce is routed by a narrow PostgreSQL role, then the normal
  tenant transaction reloads the session, origin, organization status, customer binding, and
  conversation.
- Public website requests require an exact configured Origin, fail-closed Redis rate limits, a
  bounded JSON body, and a client request UUID used in the Action Gateway idempotency key.
- WhatsApp and voice tenants are resolved from an active, signature-verified ProviderConnection.
  Provider IDs are deduplicated before the worker runs. Model text cannot override routing.
- WhatsApp uses the Phase 4 InboxEvent, OutboxEvent, Message, consent/preference, and BullMQ
  pipeline. Voice uses append-only CallEvent/Transcript evidence plus the same OutboxEvent and
  worker relay.
- Appointment mutations require the canonical Phase 5A confirmation protocol. Voice confirmation
  additionally requires a final transcript with confidence of at least 0.85. A waiting-human
  conversation suppresses all subsequent AI replies.
- Provider-neutral mock adapters are the only enabled adapters. `apps/realtime` is not introduced. A
  future persistent realtime service requires measured callback latency, media/barge-in quality
  evidence, capacity estimates, failure isolation, and a superseding ADR.

## Reliability and conflict strategy

- Database mutation and outbound work remain atomic through the transactional outbox.
- Inbox and call events have provider-scoped uniqueness; duplicate callbacks acknowledge without
  repeating effects. Stable per-event/per-request keys flow into Action Gateway operations.
- BullMQ performs bounded exponential backoff for retryable failures. Permanent telephony failures
  become dead-letter work after one attempt with a normalized code. Retry exhaustion is visible on
  OutboxEvent and CallEvent.
- Recording cannot start until persisted consent is checked before the provider call and checked
  again before CallRecording evidence is created.
- Call state changes use the domain state machine. Invalid, out-of-order state changes fail with a
  structured conflict and remain recoverable evidence.

## Security and disclosure consequences

- Widget tokens, streamed responses, and public errors contain no tenant/customer/appointment/
  provider database IDs, internal notes, secrets, raw action results, or stack details.
- Router roles can read only the columns required to resolve one public key, opaque nonce, or
  provider connection. All tenant reads after routing use forced RLS.
- Mock website identity verification (`000000`) is disabled in production. A production identity
  challenge adapter is a release prerequisite for customer appointment mutations.
- No live WhatsApp, transcription, telephony, recording storage, or production model capability is
  claimed without credentials and provider contract tests.

## Operational consequences

Web and worker continue to deploy separately against PostgreSQL and Redis. Redis is required for
public rate limiting and queue delivery; website AI fails closed if it is unavailable. Per-channel
usage stores channel, model, latency, token, cost, and outcome projections without message bodies.
