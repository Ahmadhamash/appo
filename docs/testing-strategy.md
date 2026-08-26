# Testing Strategy

Status: Required verification model through Phase 8

## 1. Principles

- Test behavior at the lowest layer that can prove the requirement, then add boundary tests for
  security and integration risk.
- PostgreSQL constraints, transactions, migrations, RLS, Redis/BullMQ delivery, provider signature
  behavior, and browsers are tested against the real technology, not mocked substitutes.
- Tenant isolation and concurrent scheduling are invariant suites applied to every relevant feature.
- A mock adapter proves application behavior only. It never proves a live provider integration.
- Flaky tests are defects: quarantine does not count toward a release gate.

## 2. Test layers

| Layer                     | Tool/environment                                                           | Proves                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Domain unit               | Vitest, deterministic clocks/IDs                                           | State machines, policies, calculations, permission decisions, error codes                                         |
| Contract                  | Vitest + Zod fixtures                                                      | HTTP, queue, webhook, import, and AI envelope acceptance/rejection/versioning                                     |
| PostgreSQL integration    | Vitest against migrated PostgreSQL container                               | Repository scoping, composite FKs, RLS, exclusion constraints, transactions, idempotency                          |
| Worker/integration        | Vitest against PostgreSQL + Redis/BullMQ                                   | Outbox claim/recovery, retry, duplicate delivery, dead-letter and ordering policy                                 |
| Provider adapter contract | Provider sandbox/recorded specification fixtures, clearly labeled          | Signing, normalized request/response mapping, retry categories; sandbox suite proves configured provider behavior |
| HTTP integration          | Next.js server + real application/database adapters                        | Session/CSRF, context resolution, authorization, validation and response mapping                                  |
| Browser journey           | Playwright                                                                 | Critical English/Arabic/RTL, keyboard, accessibility and multi-step user flows                                    |
| AI evaluation             | Deterministic gateway fakes + replay sets + approved live-model evaluation | Tool safety, disclosure, injection resistance, language quality, handoff and regressions                          |
| Predictive evaluation     | Deterministic fixtures + rolling-origin replay                             | Formula reproducibility, leakage controls, calibration/forecast metrics, refusal, drift and safe fallback         |
| Performance/resilience    | Controlled load and fault injection                                        | Latency targets, booking contention, queue backlog/recovery, provider and model degradation                       |

## 3. Test placement and naming

- Unit tests live beside source as `*.test.ts` or `*.test.tsx`.
- PostgreSQL/Redis tests use `*.integration.test.ts` and a test harness that applies real
  migrations.
- Browser tests live in `tests/e2e` and describe user journeys, not component internals.
- Provider sandbox tests use `*.sandbox.test.ts`, require explicit credentials, and are not silently
  skipped in an integration release job.
- AI replay datasets and expected policy outcomes are versioned without production PII.

Every test creates unique Organization IDs and owns its records. Cleanup targets only that explicit
test scope; parallel tests never truncate shared tables.

## 4. Tenant-isolation invariant suite

For each tenant-owned aggregate, create Organization A and B with intentionally similar data.
Verify:

1. A can perform each granted operation on A's record.
2. A receives the public not-found response for B's valid record ID.
3. Direct repository, application use case, endpoint, list/filter/search, relation include, export,
   cache, queue consumer, object URL, report, and AI retrieval paths cannot return B.
4. A cannot create a child under B's parent or connect an A child to a B relation.
5. Missing tenant context is denied by application and RLS.
6. The normal application database role cannot disable or bypass RLS.
7. Alternating A/B transactions over a one-connection pool does not leak context.
8. Support access works only within target/scope/expiry and emits complete audit evidence.

This suite is a Phase 1 merge/release gate and expands with every module.

## 5. Scheduling race tests

Use a barrier so multiple independent PostgreSQL connections attempt the same staff/resource
interval at the same instant. Assert exactly one transaction commits for capacity one; losers
receive the stable conflict result; no partial Appointment/History/Outbox/Idempotency records
remain. Repeat for:

- create versus create;
- reschedule versus create and reschedule versus reschedule;
- cancellation racing a retry;
- identical idempotency requests (one effect, same response);
- same key with different fingerprint (idempotency conflict);
- adjacent half-open intervals (both allowed);
- buffer-only overlap (rejected);
- pooled resource capacity N (exactly N commits);
- pending-confirmation expiry racing confirmation.

Availability cache/search results are deliberately made stale in some tests to prove the transaction
constraint remains authoritative.

## 6. Appointment state-machine tests

Generate every state pair and assert only transitions listed in `data-model.md` succeed. For
successful transitions verify version increment, AppointmentHistory, actor/reason, reservation
behavior, AuditEvent when required, and OutboxEvent in the same commit. For failures verify no
writes. Use fixed UTC clocks and explicit `Asia/Amman` cases around historical/future timezone
transitions supplied by the runtime timezone database.

## 7. Outbox and messaging tests

- A business rollback leaves no deliverable outbox event.
- Relay crash before/after queue insertion is safe through stable job/event IDs.
- Worker crash before/after provider response produces at-most-one logical effect where provider
  idempotency exists and visible reconciliation otherwise.
- Retry classification, backoff/jitter bounds, dead-letter visibility and replay authorization.
- Webhook invalid signature, replay, duplicate, wrong account routing, out-of-order delivery state,
  and oversized body.
- Consent/opt-out/quiet-time/template-locale checks occur before every attempt.

## 8. AI safety tests

The gateway is tested independently of a language model for every tool/action:

- invalid/unknown tool or fields, mismatched tenant, stale authorization, wrong scope;
- missing/expired/replayed/mismatched confirmation;
- duplicate idempotency and changed payload;
- over-disclosure in success and error results;
- rate/budget limits, timeout, use-case failure and handoff mapping;
- complete AIAction and AuditEvent evidence with redacted inputs/results and model/latency/outcome.

Phase 5A additionally runs the deterministic model through the real PostgreSQL Action Gateway. It
tests active-version/non-quarantined retrieval, RLS and canary isolation, untrusted tenant IDs,
sensitive-field redaction, explicit customer confirmation, two parallel acceptances with one
business effect, human handoff, absent-information behavior, the ten shared foundation evals, and
three channel-specific replay evals.

Replay evaluations cover English, formal Arabic, Jordanian Arabic, mixed-language entities, time
ambiguity, prompt injection, poisoned knowledge, identity uncertainty, unsafe requests, provider
failure, and hallucinated success. Cross-tenant canary retrieval has a zero-tolerance threshold.

## 9. Predictive intelligence tests

Phase 8 never uses a language model to establish a numerical result. Its current automated evidence
is deliberately separated from release checks that still require a staging corpus or load harness.

Implemented domain tests cover deterministic no-show refusal/generation and target exclusion, the
seven-day maturity gate, branch-local ISO weeks, seasonal demand intervals and explicit calendar
adjustments, branch/organization sparse coverage diagnostics, safe zero-denominator metrics,
staffing policy, candidate validity and consent-aware reflow ordering. Hand-calculated assertions
cover Brier score, ROC/average precision, MASE, pinball loss and total-variation drift.

Implemented PostgreSQL integration tests cover disabled-by-default organization settings, optimistic
configuration updates, durable request idempotency, cross-tenant repository predicates and RLS,
secretary denial, immediate suspended-membership denial, sparse refusal with `NULL` estimate/bounds,
completed-job no-op replay, append-only Prediction evidence, and prohibited name/phone/note/bio
redaction. The authenticated browser test covers Owner job submission plus the English and Arabic
RTL route. Worker-focused PostgreSQL tests also cover immutable evaluation cutoffs, refreshed lease
clocks, completion-crash fail-closed behavior, incomplete-evidence hiding, stale-worker fencing,
relay-envelope validation, and membership/organization/support/role-scope revocation races.
Capability integration covers provider SELF redaction, assigned-branch manager projection and
execution, organization demand aggregation, same-branch sparse-service refusal without fallback
double counting, owner-generated organization-source denial for branch/SELF viewers,
evaluation/drift source coverage, cross-tenant denial and advisory non-mutation. A separate
real-Redis integration test starts the BullMQ worker, relays one durable feature job, observes its
stable queue completion and PostgreSQL evidence, and proves the sparse refusal path. It is lifecycle
evidence for that scenario only, not proof of crash recovery or production load.

The PostgreSQL worker suite also proves that the history trigger overwrites forged dimension fields,
post-cutoff Appointment edits and backdated-but-late-verified status events do not change reproduced
No-show features, pre-trigger legacy rows refuse No-show and Demand audits as `MODEL_DEGRADED`, a
zero-evidence mutable-input retry dead-letters without evidence, and only cutoff-only No-show/Demand
data audits may safely replay. Demand backtests explicitly remain `INSUFFICIENT` with holiday and
historical-configuration evaluation marked `NOT_EVALUATED`. Capability integration fixes equal-time
consent selection with the immutable Consent ID as the descending tie-break.

The following remain mandatory pre-production checks and must not be described as already proven:

- before/after-cutoff leakage fixtures for every candidate status, reschedule, message, call, offer
  and attribution source, including arrival followed by cancellation and corrections on both sides
  of the maturity boundary;
- full boundary matrices for every sample/positive/history/holdout/configuration gate;
- historical calendar-version backtests once genuine effective-dated calendar history exists;
- endpoint and RLS denial for every predictive evidence table, branch/self projection and feedback;
- live provider/resource/buffer/consent invalidation followed by ordinary transaction conflict;
- Redis/BullMQ process-loss crash recovery, bounded backoff/dead-letter timing and stale-delivery
  replay under real Redis (the PostgreSQL lease fence and one complete Redis lifecycle are covered);
- a tenant above the 5,000-row cap, measured memory/query bounds, queue fairness and starvation/load
  behavior.

Until those checks run in CI/staging, the deterministic baseline remains an opt-in advisory feature,
and the performance/fairness values in the Phase 8 operations document remain assumptions.

## 10. Browser and accessibility coverage

Critical Playwright journeys eventually include:

- staff sign-in and tenant switch without stale data;
- owner creates branch/staff/service and assigns scoped role;
- public/customer booking, concurrent conflict recovery, reschedule and cancellation;
- receptionist today-screen check-in through completion/no-show;
- waitlist offer acceptance/expiry;
- WhatsApp/voice/chat handoff projections using controlled adapters;
- Arabic RTL and English for each journey at mobile and desktop viewports.

Automated accessibility checks supplement keyboard and screen-reader manual review. Snapshot-only
tests do not establish accessibility.

## 11. Migration and release testing

- Apply migrations from an empty database and from the previous production schema snapshot.
- Verify down/recovery strategy in a disposable environment; production rollback normally uses
  forward-compatible corrective migrations.
- Test expand/migrate/contract deployments with old and new application versions where relevant.
- Run data backfills resumably with counts, watermarks, tenant scoping, and reconciliation.
- Validate Prisma schema and generated client drift; never replace migration testing with `db push`.

## 12. CI gates

Every pull request runs formatting, ESLint, dependency-boundary validation, strict type checking,
unit tests, and secret/dependency scanning when configured. Phase work adds migrated
PostgreSQL/Redis integration jobs and targeted Playwright jobs. Main/release adds the full isolation
matrix, migration, browser, provider sandbox, performance, and AI evaluation gates required by the
touched phase.

Coverage reports guide missing-test review, but no percentage can override risk-based gates. Domain
state machines, authorization decisions, tenant repository methods, idempotency, and Action Gateway
branches require complete decision coverage.

## 13. Current implementation verification

The repository contains PostgreSQL integration suites for identity/RLS, CRM/appointments, scheduling
races, communications/outbox, Phase 5A AI, and Phase 5B channel routing. Phase 5B PostgreSQL/Redis
coverage includes the shared website/WhatsApp/voice lifecycle, explicit and low-confidence voice
confirmation, duplicate webhook/call events, WhatsApp voice-note replay, partial transcripts, human
takeover suppression, provider dead letter behavior, disabled tools, cross-tenant denial, and
per-channel usage. Deterministic fixtures live in `tests/fixtures/ai-channels`; mock success is not
evidence for a live provider. Unit suites cover domain state machines, structured contracts, AI
injection/language/chunking/redaction and provider-neutral mocks. Playwright covers the staff
journeys, AI channel management, and Arabic RTL; provider sandboxes remain production release gates.

## 14. Gym trainee portal tests

Trainee portal coverage includes one-time invitation acceptance, staff/trainee identity separation,
own-profile projections, suspended access and organization denial, foreign exercise denial, Arabic
RTL, mobile layout, and the accessible number stepper. PostgreSQL integration tests exercise the
real unique constraints and forced RLS rather than replacing portal authorization with mocks.
