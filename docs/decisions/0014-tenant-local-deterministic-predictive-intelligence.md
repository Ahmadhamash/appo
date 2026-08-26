# ADR 0014: Tenant-local deterministic predictive intelligence

Status: Accepted for Phase 8

## Context and evidence

Phase 8 adds numerical predictions and operational recommendations. These outputs can influence how
staff treat customers and allocate scarce time, so an attractive score without valid historical
evidence is worse than an explicit refusal.

The data audit performed on 2026-08-24 found no production history. The available `jormall_test`
database contained synthetic integration fixtures only: 310 appointments across 47 organizations,
including 20 Completed, 22 Cancelled and 8 No-show rows. The median organization had four
appointments and zero mature Completed/No-show labels; no organization had more than two mature
labels or one No-show label. The appointment rows were created during roughly two hours of test
execution and their scheduled starts spanned 2026-08-24 through 2026-11-06. Integration tests also
create terminal statuses directly, while the development seed creates one near-future appointment.
These rows prove application behavior, not predictive validity. They must not be presented as a
trained model or production backtest.

The schema has useful append-only appointment status history, UTC intervals, branch timezones,
service durations, buffers, availability, resource reservations, waitlist preferences, communication
outcomes and attribution. Before Phase 8 it did not have persisted availability searches or unmet
demand, historical holiday/closure versions, snapshots of mutable schedule/catalog configuration,
employee shift/attendance/cost data, or recommendation candidate impressions. Phase 8 begins a
versioned `OperationalCalendarEvent` history; it cannot retroactively reconstruct prior calendars.
Those limits constrain which claims Phase 8 may make.

The later Phase 8 integration fixture intentionally creates 220 synthetic mature outcomes in one
purpose-built tenant to exercise the generated-result path. It is test evidence only, was not part
of the audit snapshot above, and must never be presented as a production training corpus.

## Decision

Phase 8 begins with tenant-local deterministic statistical baselines. An LLM is not a numerical
predictor, feature generator, model trainer, confidence estimator, or evaluator. Generated prose may
summarize a stored result only after normal authorization and may not change the score, explanation,
refusal, or recommended action.

Every feature computation, prediction, evaluation and recommendation is bound to one Organization.
Raw customer, appointment, provider or feature rows are never pooled across tenants. The first
implementation has no cross-organization training fallback. A future pooled strategy requires a
superseding ADR, privacy and fairness review, aggregate sufficient statistics only, and tenant-held-
out leakage tests.

Each numerical result records:

- organization, prediction kind, subject and explicit prediction horizon;
- feature/as-of timestamp and source watermark;
- baseline/model key, immutable version and formula/configuration version;
- sanitized feature contributions or evidence references, sample counts and refusal gate results;
- point estimate and interval where applicable plus generated/expiry timestamps;
- evaluation/drift version, actor or job identity and audit correlation.

Features are computed as-of the prediction timestamp. Source records or configuration observed after
that instant are unavailable to the feature builder, even during a backtest. Versioned feature
snapshots preserve the exact sanitized inputs used. Current mutable configuration is permitted for
future live feasibility checks but cannot be substituted into a historical backtest and described as
historical truth.

AppointmentStatusHistory captures branch, service, provider, customer and timezone dimensions in a
database trigger on every new event. The trigger resolves the tenant-bound Appointment, overwrites
caller values and records the database verification time. Feature builders require both event and
verification timestamps at or before their cutoff, use the Created/pre-outcome snapshot for factors
and use later status events only for labels. Migration-backfilled legacy dimensions have no verified
timestamp and cause `MODEL_DEGRADED`; current Appointment dimensions are never used as historical
substitutes. Rolling-origin training evidence also requires the outcome label's database
verification time to precede that origin; a held-out outcome may occur after scoring but must exist
by the evaluation job's fixed cutoff.

`Prediction` is immutable and does not acquire a mutable observed-label field in v1. Once outcomes
mature, an evaluation job re-derives labels as-of its evaluation cutoff and stores aggregate
metrics, cohort lineage and watermark in append-only `PredictiveEvaluationRun` evidence.
Per-prediction observation evidence is a future schema enhancement if an approved use case requires
it.

The initial baselines are:

- a tenant empirical no-show rate, prior-strength-eight segment shrinkage and a fixed weighted score
  over permitted service/provider/customer/time/source history plus bounded lead time;
- a hierarchical seasonal mean over matching branch/service, branch or organization local
  weekday/hour buckets, with deterministic variance-based 95% intervals; service-specific outputs
  publish only a supported branch/service leaf and otherwise refuse, while branch/organization
  candidates remain coverage diagnostics rather than mislabeled service estimates;
- forecast provider-minutes divided by configured future capacity for staffing pressure;
- the existing constraint-complete availability solver plus deterministic ordering for reflow and
  service/provider/slot options.

The v1 identifiers are `jormall-stat-no-show-eb-v1`, `jormall-stat-demand-seasonal-v1`,
`jormall-policy-staffing-capacity-v1`, `jormall-policy-reflow-validity-v1` and
`jormall-policy-recommendation-v1`. Constants are immutable parameters of those versions.

Cold-start and sparse cohorts return a stable insufficient-data reason, sample counts and the
threshold not met. They do not return a probability, fabricated interval, confidence adjective,
green drift status, staffing directive or learned ranking. The exact gates and formulas are
versioned in `docs/phase-8-predictive-operations.md`.

No-show assistance cannot deny, deprioritize, overbook, require payment, or otherwise alter service
eligibility. Staffing is suggestion-only. Reflow and recommendation candidates must be valid under
the ordinary tenant-scoped availability rules when displayed and must be revalidated by the normal
transaction at execution. Appointment changes require ordinary authorization, expected-version and
idempotency protections, plus explicit staff and customer confirmation. A recommendation never
reserves capacity by itself.

Feature, prediction, evaluation and drift work uses bounded `PredictiveJob` tenant jobs. A job
envelope may carry an Organization identifier for routing, but the worker opens tenant context,
reloads the authoritative job, configuration and enablement state, and processes keyset-paginated
source rows into a deliberately bounded rolling history window of at most 5,000 eligible
observations. A capped window emits data-audit/coverage evidence rather than implying complete
history. Idempotency is defined by organization, job kind, model/formula version, as-of window and
input watermark. Redis is coordination only; PostgreSQL remains authoritative. Retries are bounded
and visible, and a disabled organization/model is checked again before persistence. The first
processing attempt fixes a database-immutable `evaluationAt` evidence cutoff, while `startedAt` is
the renewable lease clock. If an attempt commits derived evidence but crashes before atomic job
completion, a retry refuses to append or combine evidence, records `PARTIAL_EVIDENCE_ON_RETRY`, and
dead-letters the job. Even with zero evidence, jobs that read mutable inputs refuse retry as
`MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB`; only No-show and Demand data audits over verified
append-only cutoff evidence may replay. A new job is required for every other coherent snapshot.
Evidence from a non-completed job is never part of the current projection.

A dedicated relay claims PredictiveJob rows with `FOR UPDATE SKIP LOCKED` and enqueues a stable
BullMQ job ID. Predictive computations do not use the communications OutboxEvent relay because they
are internal derived work, not a provider/business side effect, and that relay intentionally
dead-letters unknown event types. The durable PredictiveJob row supplies claim, retry,
reconciliation and dead-letter evidence.

## Consequences

- With the current local data, numerical no-show, demand and staffing features must demonstrate the
  insufficient-data path. This is an expected safe outcome, not a failed model.
- Historical reflow and learned recommendation evaluation remains unavailable until configuration
  snapshots and candidate impressions exist. Live rules-based options may still be offered.
- The v1 current projection hides expired results, disabled capabilities, inactive model versions,
  and appointment-targeted results whose appointment version or scheduled instant changed. Source
  and configuration watermarks remain visible provenance, but other operational changes do not
  proactively invalidate an unexpired result; the ordinary scheduling transaction is still the final
  authority and must revalidate every suggested slot.
- Deterministic baselines allow exact replay and give later statistical models a mandatory
  comparator.
- No new production dependency is required for the baseline implementation. Adding a numerical/ML
  library requires a dependency review and an update to `docs/dependencies.md`.
