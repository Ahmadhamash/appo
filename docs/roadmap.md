# JorMall Delivery Roadmap and Acceptance Criteria

Status: Ordered product plan; phases are capability gates, not calendar estimates

## Phase 0 — Architecture and foundation (this run)

### Deliverables

- Product, architecture, data, security/tenancy, AI, dependency, testing, and roadmap documents.
- ADR baseline and permanent repository rules.
- pnpm/Turborepo TypeScript workspace with web, worker, and package boundaries.
- Next.js English/Arabic RTL foundation, Zod contracts/config, structured errors, AI gateway port.
- Empty Prisma 7 foundation with explicit migration directory; no product models.
- PostgreSQL/Redis Docker Compose, placeholder-only environment example, CI quality workflow.

### Acceptance

- Workspace is confirmed isolated from old projects and no product Phase 1 feature exists.
- Install, format check, lint, architecture-boundary check, type check, unit tests, Prisma
  validation, Compose configuration validation, production web build, and foundation browser smoke
  tests pass.
- Open risks and local commands are reported without claiming any external integration.

## Phase 1 — Identity, tenants, branches, staff, permissions, and services

### Deliverables

- Reviewed identity/session provider adapter and secure session/CSRF controls.
- Organization, Branch, Membership, Role/grant, StaffProfile/assignment, Service/eligibility models
  and first explicit migration.
- AvailabilityRule and TimeOff foundations required for provider self-scope authorization tests.
- Tenant-context resolution, application authorization policy, tenant-bound repositories, and RLS.
- Owner/manager administration for branches, staff, role assignment, and services in English/Arabic.
- Explicit, time-bound, audited JorMall support-access workflow.

### Acceptance

- RBAC default matrix and branch/self constraints pass unit and PostgreSQL integration tests.
- Cross-tenant invariant suite proves read/write/list/relation/RLS/pool isolation for every Phase 1
  entity using the normal application database role.
- Browser cannot select an unauthorized Organization by body, query, header, slug, or stale session.
- Suspended membership, revoked grant, role escalation, support expiry, CSRF, rate limit, and audit
  tests pass.
- Empty and upgrade migrations pass; English/Arabic/RTL owner journey passes Playwright and
  accessibility checks.
- No customer or appointment feature is smuggled into Phase 1.

## Phase 2 — CRM, consent, appointments, records, operational status, and today screen

### Deliverables

- Customer, identifiers, notes, append-only consent, and tenant-local deduplication.
- Branch hours, availability search, Appointment, staff reservations, AppointmentHistory,
  AppointmentRecord, IdempotencyRecord, and OutboxEvent.
- Manual and public create/reschedule/cancel workflows using the explicit state machine.
- Reception today screen and provider assigned-work view.

### Acceptance

- PostgreSQL exclusion constraints and deterministic concurrent tests prove no committed staff
  double booking, including stale availability and buffers.
- Every state pair, timing rule, expected version, reschedule, cancel, no-show, and correction path
  is tested with atomic history/outbox behavior.
- Booking/rescheduling/cancellation are idempotent; key reuse with different input is rejected.
- Consent is purpose/channel/version evidenced and no boolean shortcut exists.
- Cross-tenant coverage includes CRM search/deduplication, appointment records, exports, today
  queries, and public manage-booking tokens.
- English/Arabic public booking and staff operational journeys pass mobile, keyboard, accessibility,
  and timezone tests including `Asia/Amman`.

## Phase 3 — Resources, conflict prevention, waitlist, and slot offers

### Deliverables

- Resources/resource units, availability, service requirements, and pooled capacity policy.
- Resource-aware slot search and transactional reservations.
- Waitlist preference/priority lifecycle and expiring, single-use slot offers.

### Acceptance

- Concurrent tests prove capacity-one and capacity-N limits, deterministic locking, and no partial
  appointment on resource conflict.
- Slot offer accept/expire/cancel races are idempotent; one offered slot cannot overbook.
- Waitlist ranking is explainable, tenant-scoped, consent-aware, timezone-correct, and auditable.
- Staff/public Playwright journeys cover unavailable-resource recovery and Arabic/English offers.

## Phase 4 — Reliable SMS and WhatsApp communications

### Deliverables

- Message, MessageAttempt, MessageTemplate, ProviderWebhookEvent, transactional outbox relay, BullMQ
  workers, dead-letter/reconciliation operations.
- Provider-neutral SMS and WhatsApp ports, explicit mock adapters, then approved real/sandbox
  adapters.
- Consent, quiet-time, opt-out, locale/template-version, retry and delivery-state policies.

### Acceptance

- Transaction rollback, relay/worker crash points, duplicate jobs/webhooks, retries, dead-letter
  replay, and out-of-order callbacks pass PostgreSQL/Redis integration tests.
- Raw webhook signature, replay window, account-to-tenant routing, idempotent acknowledgement, and
  body limits match each provider specification and sandbox test.
- No network request runs in a business transaction and no provider credential enters logs/client
  code.
- Delivery dashboards expose pending/retrying/failed states and correlation without PII leakage.
- A mock is never labeled as a working provider integration.

## Phase 5A — Safe shared AI foundation

### Implemented scope

- Tenant-isolated text/Markdown knowledge ingestion, chunk quarantine, version activation and
  rollback.
- AI conversations/messages, action/approval evidence, usage limits, prompt configuration,
  evaluation fixtures and human-handoff queue.
- Provider-neutral model port, deterministic mock model and the twelve-tool Action Gateway
  allowlist.
- Explicit confirmation for booking/rescheduling/cancellation, server-resolved identities, mutation
  idempotency, redaction, audit and PostgreSQL concurrency locking.
- English/Arabic staff management views. No customer-facing transport or production model is
  connected.

### Acceptance

- AI-to-database dependency is absent and enforced by the workspace-boundary check.
- PostgreSQL integration tests prove tenant-isolated retrieval, prompt-injection quarantine, context
  mismatch rejection, confirmation, concurrent replay, redaction, handoff and the deterministic
  mock-to-gateway lifecycle.
- Built-in eval cases cover Arabic, Jordanian dialect, English, ambiguity, wrong tenant IDs,
  injection, unavailable slots, cancellation confirmation, human requests and absent information.

## Phase 5B — Voice/WhatsApp/web AI transports

### Implemented scope

- Signed embeddable bilingual website widget with opaque sessions, exact-origin enforcement,
  fail-closed Redis rate limits, NDJSON response streaming, installation UI, and a non-production
  identity-verification fixture.
- WhatsApp AI through verified Phase 4 webhooks, Inbox/Message/Outbox/BullMQ, consent/preferences,
  opt-out, fixture-only voice-note transcription, recovery, and human takeover suppression.
- Provider-neutral voice callbacks and mock telephony with Call/Event/Recording/Transcript/Summary,
  state transitions, recording consent, partial/final confidence, interruption/silence/handoff,
  missed-call recovery, retry/dead letter, and channel usage/latency.
- One shared coordinator, Action Gateway, server-stored confirmation payload, tenant routing, and
  idempotency policy across all channels. No channel duplicates booking or AI orchestration.
- `apps/realtime` remains absent under ADR 0011 because no measured media latency evidence justifies
  it. Production model, WhatsApp, transcription, telephony, and recording storage adapters remain
  explicit release gates.

### Acceptance

- AI package has no database/credential import path; every business operation uses the gateway and
  produces AIAction/AuditEvent evidence.
- Cross-tenant knowledge canary leakage is zero; draft/revoked/poisoned content tests pass.
- Every tool passes identity, scope, consent, confirmation, disclosure, idempotency, rate, timeout,
  and model-independent integration tests.
- English/Jordanian-Arabic replay evaluations and red-team tests meet approved thresholds for tool
  accuracy, hallucinated success, injection refusal, unsafe disclosure, and handoff.
- Provider disconnect/model outage degrades to deterministic information, callback, or human
  handoff; per-tenant/channel/action kill switches are proven.

Current integration evidence proves the deterministic all-channel booking/reschedule/handoff
scenario, cross-tenant denial, disabled tools, takeover suppression, duplicate callbacks, partial
transcripts, retry/dead-letter behavior, and per-channel metrics. Production provider SLAs, red-team
thresholds, load thresholds, and operational channel kill switches remain release work and must not
be inferred from the mocks.

## Phase 6 — Staff Copilot and operational intelligence

### Implemented scope

- Authorized customer summaries, daily briefings, schedule gaps, waitlist matching, call-quality
  rubric, and safe Analytics Copilot.
- Evidence-linked append-only insights, semantic snapshots, feedback, model/prompt/knowledge trace,
  confidence, watermark, expiry, deterministic regeneration, and tenant RLS.
- Organization/assigned-branch/provider-self projections with restricted recording policy and a
  database-free deterministic local model. No production model or automatic mutation is enabled.

### Deliverables

- Customer summaries, daily briefings, schedule-gap detection, waitlist matching, call-quality
  review, and Analytics Copilot.
- Evidence-linked CopilotInsight lifecycle with dismiss/correct/accept feedback.

### Acceptance

- Every insight links to authorized source evidence, model/policy version, confidence and data
  watermark.
- Generated text cannot mutate source records; recommended actions still use normal authorized use
  cases.
- Restricted records/recordings respect role/branch/self scope in summaries and analytics.
- Offline evaluation measures factuality, usefulness, bias, Jordanian Arabic quality and correction
  rate; human override and feedback are auditable.
- Briefing regeneration, duplicate jobs, source changes, and stale insight expiry are deterministic.

## Phase 7 — Imports, global audit, attribution, and reports

Implementation status: Phase 7 foundation implemented with bounded staged CSV imports, protected
streaming exports, attribution events, audit viewers and versioned operational reports.

### Deliverables

- Staged imports with mapping, validation, tenant-local dedupe, dry run, resumable commit and row
  results.
- Audit search/export with protected access and tamper/retention controls.
- Attribution events and reproducible operational/management reports with source watermarks.

### Acceptance

- Malformed, oversized, formula-injection, mixed-encoding, duplicate, partial-failure, resume and
  rollback import cases pass; imports invoke domain use cases rather than direct bulk table writes.
- Cross-tenant tests cover import files/staging/errors, reports, audit and export object URLs.
- Report values reconcile to fixtures and remain reproducible from recorded watermark/definition.
- Audit access/export is itself audited; retention/legal hold and safe spreadsheet export are
  proven.

## Phase 8 — Prediction, forecasting, staffing, reflow, and recommendations

### Deliverables

- Historical data audit and stable refusal evidence before any score is generated. Current synthetic
  fixtures are explicitly insufficient for production prediction.
- Tenant-local deterministic no-show, observed-demand and staffing baselines with uncertainty,
  sparse/holiday policy and no LLM numerical prediction.
- Advanced schedule reflow plus valid service/provider/slot recommendations that preserve ordinary
  availability, resource, consent, authorization, confirmation and concurrency rules.
- Per-capability organization enablement, feature jobs, model/version registry, immutable prediction
  explanations/details, rolling-origin evaluation/backtesting, drift monitoring and append-only
  feedback.

### Acceptance

- Predictions record model/version/horizon/as-of watermark, sanitized feature provenance, sample
  gates, interval/refusal and expiry. Mature outcomes are re-derived as-of the evaluation cutoff
  into append-only evaluation metrics/lineage; no-show labels use the documented correction maturity
  window and exclude cancellation as a competing outcome.
- Leakage, drift, calibration, segment performance, privacy, cold-start and exact-replay tests meet
  `phase-8-predictive-operations.md`; insufficient data displays no confident score.
- Backtests are tenant-local rolling-origin evaluations against deterministic baselines. Current
  mutable configuration is never substituted for unavailable historical state.
- Recommendations are advisory by default, explainable, expiring, reversible where possible, and
  never execute without ordinary permission/confirmation/use-case constraints.
- Schedule reflow simulations preserve all appointment, resource, consent and tenant invariants
  under concurrent real-world changes.
- Operations can disable each model/recommendation class per tenant and roll back model versions.

## Cross-phase release rule

A phase is complete only when its acceptance evidence is reproducible in CI/staging, migrations and
operations are documented, observability and runbooks cover its failure modes, English and Arabic
are complete, tenant isolation passes, and no required check is waived to meet a date.
