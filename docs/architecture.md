# JorMall Architecture

Status: Accepted design baseline through Phase 8

## 1. Architectural style

JorMall is a TypeScript modular monolith with two initial runtime processes:

- `apps/web`: Next.js App Router for authenticated dashboards, public booking, chat surfaces, and
  HTTP/webhook endpoints.
- `apps/worker`: BullMQ consumers for outbox delivery, provider work, imports, predictive jobs, and
  asynchronous AI workflows.

`apps/realtime` is not created until Phase 5 proves that telephony requires a persistent low-latency
service. PostgreSQL is the system of record. Redis supports queues, short-lived coordination, and
rate limiting; Redis is never authoritative for appointments or authorization.

## 2. Bounded modules

| Module                  | Owns                                                                                                   | Must not own                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Platform                | Organization lifecycle, platform support access, platform audit                                        | Tenant operational data                       |
| Identity & Access       | User linkage, sessions/adapters, memberships, grants, authorization policy                             | Business scheduling rules                     |
| Organization            | Organization/branch configuration, hours, staff profile                                                | Authentication credentials                    |
| Catalog                 | Services, durations, buffers, staff/branch eligibility                                                 | Appointment lifecycle                         |
| CRM                     | Customers, identifiers, consent, preferences, customer timeline                                        | Global person matching across tenants         |
| Scheduling              | Availability, time off, appointments, reservations, history, waitlist, slot offers                     | Provider message delivery                     |
| Communications          | Messages, attempts, templates, inbound provider events, outbox dispatch                                | Appointment state transitions                 |
| Knowledge               | Sources, documents, chunks, publication lifecycle, retrieval policy                                    | Direct AI mutations                           |
| Conversations           | Channel conversations, turns, calls, recordings, summaries, handoff                                    | Scheduling persistence shortcuts              |
| AI Orchestration        | Prompts/policies, model adapters, Action Gateway, evaluation                                           | Database or provider credentials              |
| Reporting               | Read models, metrics and attribution                                                                   | Mutation source of truth                      |
| Predictive Intelligence | Data audits, feature jobs, model versions, predictions, evaluation, drift and advisory recommendations | LLM numerical prediction or business mutation |
| Imports                 | Import jobs, staged rows, validation, commit orchestration                                             | Bypassing domain use cases                    |
| Audit                   | Append-only security and business action evidence                                                      | Mutable operational state                     |

Inside `packages/domain`, each module will use `domain`, `application`, and `ports` folders. Domain
objects enforce local invariants. Application use cases coordinate policies and transactions. Ports
describe persistence, clocks, IDs, queues, and providers. Infrastructure packages implement those
ports.

## 3. Workspace boundaries

| Workspace            | Responsibility                                                | Allowed internal dependencies                |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| `apps/web`           | HTTP/UI delivery and composition root                         | all packages, through explicit subpaths      |
| `apps/worker`        | Queue delivery and composition root                           | AI, auth, config, contracts, db, domain      |
| `packages/domain`    | Pure domain rules, use cases, and outbound ports              | none                                         |
| `packages/contracts` | Zod transport/queue/tool schemas and inferred types           | none other than Zod                          |
| `packages/auth`      | Actor resolution and authorization policy adapters            | domain, contracts                            |
| `packages/db`        | Prisma, PostgreSQL repositories, transaction and RLS adapters | domain, config                               |
| `packages/ai`        | Model adapters, retrieval orchestration, Action Gateway       | auth, contracts, domain                      |
| `packages/ui`        | Accessible reusable presentation components                   | contracts only when display types are needed |
| `packages/config`    | Validated environment and service configuration               | none other than Zod                          |

Dependency direction is enforced by `scripts/check-workspace-boundaries.mjs`. Internal package
imports must name an explicit export subpath; barrel `index.ts` files are prohibited.

## 4. Request and transaction flow

### Authenticated mutation

1. The delivery adapter verifies the session and CSRF posture.
2. Identity & Access resolves the actor's active Membership; a body/query `organizationId` is
   ignored.
3. Zod validates the transport contract.
4. The authorization policy evaluates permission and row/branch/self constraints.
5. An application use case runs inside a tenant-bound database transaction.
6. Domain changes, append-only history, audit evidence, and outbox events commit atomically.
7. The endpoint maps the structured result/error to a localized transport response.

### Public or conversational mutation

1. The channel adapter verifies a signed public-channel token or provider webhook signature.
2. The verified channel configuration resolves Organization and optional Branch context.
3. Customer identity is resolved or challenged according to action sensitivity.
4. The same application authorization and use case path used by staff channels executes.

### Asynchronous side effect

1. A committed OutboxEvent is claimed with `FOR UPDATE SKIP LOCKED` by a relay.
2. The relay enqueues a BullMQ job with the OutboxEvent ID as the stable job ID.
3. A worker executes an idempotent adapter, writes MessageAttempt/provider state, and marks
   delivery.
4. Retry uses bounded exponential backoff with jitter; exhausted work becomes visible dead-letter
   work.
5. Reconciliation detects stale claimed events and provider status drift.

Network calls never occur while the transaction that creates business state is open.

## 5. Persistence and tenant context

- Tenant-owned tables carry `organization_id`; high-risk relationships use composite foreign keys
  including `organization_id` to prevent cross-tenant joins.
- Repository methods accept a required `TenantContext`. They do not offer unscoped list/get/update
  variants.
- On transaction start, the adapter sets transaction-local PostgreSQL settings for organization,
  actor, and platform-override audit ID. Row-level security policies deny mismatched tenant rows.
- A connection may not retain tenant settings outside the transaction. Pool checkout tests verify
  context reset and no tenant bleed.
- Platform migrations, background maintenance, and support access use separate database roles.
  Bypass capability is unavailable to normal web and worker roles.
- Cache and object keys start with the organization ID. Queue payloads carry organization and are
  validated on receipt; consumers reload and re-authorize authoritative state.

The complete policy is in `security-and-tenancy.md`.

## 6. Scheduling consistency

Availability search is advisory; the booking transaction is authoritative. A create or reschedule
use case:

1. Normalizes the requested local time against the IANA timezone and converts to UTC.
2. Loads service, branch, staff, hours, time off, buffers, and required resource policy in the same
   tenant.
3. Acquires deterministic locks for pooled-capacity resources when needed.
4. Creates or updates the Appointment and its staff/resource reservation rows.
5. Relies on PostgreSQL GiST exclusion constraints over half-open `tstzrange` intervals for
   capacity-one staff and resource units.
6. Appends AppointmentHistory and OutboxEvent rows and commits.

The exclusion constraint is the final defense against races. A constraint conflict maps to the
stable `CONFLICT` error and prompts a fresh availability search. Idempotency records are unique by
organization, operation, and key and include a request fingerprint to reject key reuse with
different inputs.

## 7. Application contracts and errors

- Transport schemas live in `packages/contracts`; domain objects do not depend on them.
- External payloads are parsed once at the boundary and converted to domain inputs.
- Error responses expose a stable code, localized safe message, correlation ID, and field issues
  when appropriate. Stack traces, provider payloads, tenant existence, and secrets are never
  returned.
- Retries depend on explicit retryability/category, never matching message text.

## 8. Communications and provider adapters

Communications owns a provider-neutral Message and one MessageAttempt per send attempt. An adapter
translates a normalized message into provider calls. Provider credentials are envelope-encrypted and
resolved only inside the adapter after tenant authorization.

Phase 4 ships `MOCK_SMS` and `MOCK_WHATSAPP`; Phase 5B adds `MOCK_VOICE`. Their webhook secret is
referenced by an allowlisted environment variable name; no credential value is stored in tenant rows
and no production-delivery claim is made. A real adapter must add reviewed encrypted credential
storage, rotation, least-privilege scopes, and provider contract tests before activation.

Inbound webhooks are verified against raw bytes, stored by a provider-scoped unique event ID, and
acknowledged quickly. Processing is asynchronous and idempotent. Delivery callbacks may arrive out
of order; a monotonic provider-status policy prevents regression.

## 9. AI and knowledge boundaries

Model providers receive the smallest contextual projection required for the turn. Retrieval filters
by organization and publication status before content reaches a model. AI orchestration has no
import path to the database package. All business reads/mutations occur through the Action Gateway
described in `ai-architecture.md`.

Prompts and model output are untrusted input. Tool names, payloads, result disclosure, confirmation,
rate limits, and authorization are enforced in code outside the model.

Phase 5B channel delivery is composed in web/worker adapters around one shared coordinator. Website
uses signed public configuration, opaque nonce routing, exact origins, Redis rate limits, and an
NDJSON response stream. WhatsApp uses the existing Inbox/Message/Outbox pipeline. Voice uses
signature-verified CallEvent callbacks and a provider-neutral telephony port. No persistent
`apps/realtime` process exists; ADR 0011 defines the evidence required before introducing one.

## 10. Predictive intelligence boundary

Phase 8 numerical work is deterministic domain/application logic, not AI orchestration. It does not
send features to an LLM and does not import `packages/ai`. Feature builders read a bounded tenant-
scoped projection as-of a recorded watermark. Mutable schedule state can validate a live candidate,
but it cannot be substituted for unavailable historical configuration during a backtest.

Interactive requests create an authoritative `PredictiveJob`. A dedicated predictive relay claims
pending jobs with `FOR UPDATE SKIP LOCKED` and delivers the stable job ID to BullMQ. This does not
use the communications OutboxEvent relay: that relay has its own allowlisted provider/channel event
types, and treating an internal computation request as an unknown message event would dead-letter
valid work. A worker reloads the PredictiveJob in tenant context, rechecks organization status,
permission and capability enablement, and keyset-pages source rows. PostgreSQL stores enablement,
model versions, feature/data audits, predictions, evaluations, drift and feedback; Redis contains no
authoritative score.

Predictions and recommendations are derived evidence. They never update customer, appointment, staff
or resource state. A reflow/recommendation execution returns to the ordinary authorized
booking/reschedule/slot-offer use case, with explicit confirmation, expected version, idempotency
and the PostgreSQL scheduling transaction as final authority. Cross-tenant pooling is not part of
Phase 8; ADR 0014 defines the evidence required to reconsider it.

## 11. Observability

Phase 7 operational intelligence stays inside the modular monolith. CSV requests are decoded and
parsed incrementally by the web delivery layer, validated/staged in bounded row transactions, and
committed by domain use cases. Reports page through PostgreSQL source rows into bounded aggregate
maps and persist the formula version, timezone, date bounds, and data watermark. Export jobs are
actor-bound and expire after one hour; each download page revalidates the current tenant
permissions. Attribution is append-only and is written in the same transaction as appointment
creation or channel touch creation where that transaction already exists.

Phase 8 telemetry additionally records prediction/job kind and version, source watermark, rows
scanned, refusal/outcome code, evaluation window, drift sample counts, duration and queue delay.
Feature values, customer identifiers and recommendation text are not metric labels or log fields.

Web, worker, and future realtime processes emit OpenTelemetry-compatible JSON logs, traces, and
metrics with:

- correlation/request, trace, organization, actor, channel, use-case, job, outbox, message, and AI
  execution identifiers where applicable;
- structured error code and retryability;
- duration and outcome without message bodies, prompts, phone numbers, credentials, or clinical
  notes.

Sensitive fields are allowlisted rather than redacted after serialization. Audit events are not a
substitute for logs, and logs are not the audit ledger.

## 12. Deployment shape

Initial production deployment uses separately scalable web and worker containers against managed
PostgreSQL and Redis. Migrations run as a one-shot deployment job before compatible application
rollout. Backward-compatible expand/migrate/contract changes are required once zero-downtime
releases begin. Static/object content and recordings use tenant-prefixed object storage with
short-lived signed access.

## 13. Evolution rule

A module may be extracted only when measured scaling, availability, security, or team-autonomy needs
outweigh transaction and operational complexity. Extraction preserves the same application contract
and outbox/event boundary; it is not triggered solely by code size.
