# Phase 8 predictive operations

Status: Normative deterministic v1 operational contract

Phase 8 is an evidence-driven assistance layer. PostgreSQL scheduling rules remain authoritative,
and absence of sufficient history produces a visible refusal rather than a confident-looking score.
All calendar buckets use the applicable branch IANA timezone; stored instants remain UTC.

## 1. Available-data audit

Audit date: 2026-08-24.

Evidence provenance: the migrated models in `packages/db/prisma/schema.prisma`, read-only aggregate
queries against the local `jormall_test` PostgreSQL database, the deliberately terminal fixtures in
`tests/integration/operations-intelligence.integration.test.ts`, and the future-only appointment in
`apps/web/scripts/seed-development.ts`. No production database or provider dataset was available or
claimed.

The repository has the following usable operational evidence:

- `Appointment` and append-only `AppointmentStatusHistory`: source, branch, service, provider,
  scheduled UTC interval, timezone snapshot, version, created/rescheduled/status event time and
  final operational status;
- branch timezone/hours, provider availability and time off, service duration and branch buffers;
- capacity-one provider/resource reservations and service resource requirements;
- waitlist date/time/branch/provider preferences and expiring single-use slot-offer outcomes;
- communication attempt/delivery timestamps, consent and channel preferences;
- appointment/channel attribution timestamps.

The concrete schema evidence is:

| Use                                                            | PostgreSQL/Prisma source fields in `packages/db/prisma/schema.prisma`                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No-show target and operational factors                         | `AppointmentStatusHistory.{eventType,fromStatus,toStatus,startsAt,endsAt,source,createdAt,branchSnapshotId,serviceSnapshotId,providerSnapshotId,customerSnapshotId,timezoneSnapshot,dimensionSnapshotVerifiedAt}`; the latest verified pre-cutoff event defines a live target and the verified Created event defines historical factors |
| Demand arrival and local bucket                                | `AppointmentStatusHistory.{eventType=CREATED,startsAt,createdAt,branchSnapshotId,serviceSnapshotId,timezoneSnapshot,dimensionSnapshotVerifiedAt}`                                                                                                                                                                                       |
| Future service load                                            | `Service.defaultDurationMins` and `ServiceBranch.{durationMins,bufferBeforeMins,bufferAfterMins,isEnabled}`                                                                                                                                                                                                                             |
| Future provider capacity                                       | `BranchHoursRule.{weekday,startMinuteLocal,endMinuteLocal,effectiveFrom,effectiveUntil}`, `AvailabilityRule.{staffProfileId,branchId,weekday,startMinuteLocal,endMinuteLocal,effectiveFrom,effectiveUntil}` and `TimeOff.{staffProfileId,branchId,startsAt,endsAt}`                                                                     |
| Resource-valid recommendation/reflow                           | `ServiceResourceRequirement.{branchId,serviceId,resourceGroupId,quantity}`, `AppointmentResource.{resourceId,resourceGroupId,startsAt,endsAt}` and capacity reservations                                                                                                                                                                |
| Explicit customer constraints                                  | `WaitlistEntry.{preferredStartDate,preferredEndDate,preferredStartMinute,preferredEndMinute,status}`, `WaitlistEntryBranch` and `WaitlistEntryProvider`                                                                                                                                                                                 |
| Contact permission                                             | `Consent.{purpose,channel,status,recordedAt,revokesConsentId}` and `CommunicationPreference.{channel,isEnabled,version}`                                                                                                                                                                                                                |
| Delivery/call/attribution outcomes for aggregate analysis only | `MessageAttempt.{status,startedAt,finishedAt,durationMs}`, `DeliveryReceipt.{state,providerTimestamp,receivedAt}`, `Call.{status,startedAt,answeredAt,endedAt}` and `AttributionEvent.{source,occurredAt}`                                                                                                                              |

Free text and direct identifiers adjacent to these sources are not automatically features. Section 3
defines the allowlist and the explicit exclusions.

The available local PostgreSQL data is synthetic test data, not a training corpus:

| Evidence item                                        | Observed value    |
| ---------------------------------------------------- | ----------------- |
| Organizations in `jormall_test`                      | 121               |
| Organizations with appointments                      | 47                |
| Appointments                                         | 310               |
| Confirmed / Completed / Cancelled / No-show          | 260 / 20 / 22 / 8 |
| Median appointments per active organization          | 4                 |
| Median mature Completed/No-show labels               | 0                 |
| Maximum mature labels / no-shows in one organization | 2 / 1             |

The rows were created during roughly two hours of integration execution. Scheduled starts ranged
from 2026-08-24 through 2026-11-06. The fixtures deliberately manufacture statuses and edge cases;
the development seed contributes only a near-future appointment. They are valid functional-test
fixtures and invalid statistical evidence. After this audit snapshot, the Phase 8 worker integration
suite added a purpose-built tenant with 220 synthetic mature outcomes solely to prove the generated,
replay and redaction paths. That fixture is not production evidence and does not change this audit.
Ordinary development-seed tenants therefore return `INSUFFICIENT_SAMPLE`; only the explicitly named
statistical test fixture is expected to cross a numerical gate.

Material gaps are:

- no persisted availability-query/impression stream or unavailable-request outcome, so forecasts
  measure observed scheduled demand rather than latent/turned-away market demand;
- no pre-Phase-8 historical country/holiday/closure versions; `OperationalCalendarEvent` begins
  collecting explicit tenant evidence now but cannot reconstruct past knowledge;
- no verified appointment-dimension snapshots before migration 1120. The migration backfills
  branch/service/provider/customer/timezone values for inspection but leaves their verification time
  null; any relevant legacy row makes the statistical audit `MODEL_DEGRADED` instead of using
  present-day Appointment dimensions;
- no effective-dated history for branch hours, service/branch duration and buffers, staff/service
  eligibility, resource status/requirements or deleted time off;
- no employee shift, clock-in, break, contract-hours, labor-cost or actual absence data;
- no recommendation candidate-set impression and selection log;
- no ordinary-appointment flexible branch/provider/time preference beyond explicit waitlist data;
- imported appointments do not carry the original booking/event timestamp and therefore cannot
  supply historical lead-time or arrival features.

These gaps are rendered in the data-quality view and included in evaluation reports. Missing data is
not silently imputed from another Organization.

## 2. Targets, horizons and maturity

### No-show

V1 scores a future appointment at the explicit `PredictiveJob` request/as-of timestamp. When the job
is requested by the booking workflow this is an at-booking score; a later staff request is a current
pre-start score. Lead time is recorded and short-lead requests are explained by the bounded
lead-time factor. V1 does not schedule an automatic T-minus-24-hour score and does not claim one
occurred. A future scheduled horizon must use a distinct model/horizon version and leakage backtest.

The prediction is invalidated on reschedule; a new schedule produces a new prediction. The outcome
matures 168 hours after the scheduled UTC end instant. This delay permits correction of an erroneous
No-show to Checked-in and completion. The label is:

```text
y = 1  when the final status as-of maturity is NO_SHOW
y = 0  when append-only arrival evidence reached CHECKED_IN or IN_PROGRESS,
       or the final status as-of maturity is COMPLETED
unknown when CANCELLED or still PENDING/CONFIRMED without arrival evidence
```

Cancelled is a competing outcome, not a negative no-show. Unknown outcomes are excluded and their
count is reported. A stuck Checked-in/In-progress workflow is retained as attended because it is
direct evidence that the customer arrived; its incomplete operational state is counted as a data
quality warning. Every historical row becomes eligible only after both its status evidence is
available and `scheduled UTC end + 168 hours` is at or before the prediction cutoff. Imported rows
without original event time are excluded from booking-horizon features and evaluation.

### Demand

Phase 8 calls this **observed scheduled demand**:

```text
booking demand(org, branch, service, local bucket)
  = count of append-only CREATED appointment events whose requested start falls in the bucket

realized provider minutes(bucket)
  = sum of historical scheduled appointment intervals, grouped by terminal outcome
```

Created demand and realized Completed, No-show and Cancelled load are reported separately. A
reschedule does not create a second booking-demand arrival; its moved interval is available to
schedule-flow analysis. The product must not label this forecast “total demand” until rejected and
unavailable requests are persistently measured.

### Staffing

Expected load is each demand count bound multiplied by the versioned service duration selected for
that future forecast target. Configured future provider availability supplies capacity:

```text
expected utilization = expected provider minutes / configured provider minutes

ADD_CAPACITY when lower forecast load minutes > configured available minutes
REVIEW_EXCESS_CAPACITY when upper forecast load minutes < 0.60 * configured available minutes
BALANCED otherwise
```

The point estimate and interval are always shown together. Current service duration and availability
are valid for a live future suggestion; they are not substituted into a historical staffing backtest
because pre-Phase-8 configuration history is absent. This supports coverage suggestions only; it is
not evidence of employee attendance, productivity, cost or a need to hire/fire.

## 3. Allowed features and leakage controls

Allowed no-show factors are operational and available as-of the scoring instant:

- lead time as the bounded adjustment defined below;
- exact branch-local weekday/hour combination;
- service, provider and appointment source, with sparse categories backed off to the organization
  rate;
- the customer's prior mature Completed/No-show history strictly before scoring, only after the same
  50-outcome and five-No-show factor gate.

Duration/buffer, reschedule and pre-cutoff communication factors are not part of v1. In particular,
a reminder is an intervention that may itself affect attendance; it cannot be added without a new
feature/model version and leakage evaluation.

The following are prohibited features or explanation inputs:

- customer/staff names, raw or normalized phone, contact labels and free-text address;
- preferred language/locale because it can proxy nationality or ethnicity;
- age, gender, nationality, religion, disability, health condition or any inferred protected trait;
- appointment records, internal notes, consent evidence, message bodies, AI messages/actions,
  transcripts, call payloads/summaries, staff bios and free-text source/reason fields;
- current/final appointment status, cancellation/completion time or record;
- status/reschedule events, message delivery/failure, slot-offer response, waitlist fulfillment,
  call outcome, attribution conversion, audit event, update timestamp or version that occurs after
  the scoring instant;
- current mutable catalog/schedule configuration substituted into a historical prediction.

Random row splits are forbidden. Customer history is rebuilt as-of every backtest origin and never
includes the current appointment or future visits. Operational branch/provider/service factors use
shrinkage and may not be presented as personal blame. No protected attribute is inferred to conduct
an unsupported fairness analysis; performance is instead monitored across authorized operational
segments and coverage/refusal cohorts.

Historical appointment dimensions come only from the database-captured snapshot on an append-only
AppointmentStatusHistory event. The trigger overwrites caller-supplied snapshot fields, resolves the
Organization/Appointment pair itself and records `dimensionSnapshotVerifiedAt` with the database
statement clock. Both event time and verification time must be at or before the job cutoff. Created
events supply pre-outcome dimensions; terminal status events supply labels only. Import booking
origins remain excluded. A legacy or backdated-but-late-verified event is never substituted from the
current Appointment row. At each rolling backtest origin, training rows additionally require their
terminal label to have been database-verified by that origin; the held-out target label may mature
after its scoring origin but must be verified by the immutable evaluation-job cutoff.

## 4. Minimum data thresholds and refusal codes

Thresholds are part of the immutable baseline version.

| Capability                        | Minimum evidence                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization no-show baseline     | 200 mature attended/No-show appointments, including at least 20 No-show and 100 attended, spanning 90 calendar days and eight active weeks          |
| No-show segment factor            | 50 mature matching outcomes including at least five No-show; otherwise back off to organization                                                     |
| No-show evaluation holdout        | 50 mature outcomes, including ten positive and ten negative labels                                                                                  |
| Demand organization history       | 200 Created events, 182 calendar days and 13 non-zero weeks                                                                                         |
| Demand service target bucket      | Eight comparable local weekday/hour weeks at branch+service; broader branch/organization coverage is diagnostic only and the service output refuses |
| Demand rolling holdout            | 20 time-ordered target buckets after applying the normal history and leaf gates                                                                     |
| Staffing suggestion               | Eligible demand forecast plus complete branch/provider/service capacity for the forecast horizon                                                    |
| Rules-based recommendation/reflow | At least one live candidate passing every provider/resource/buffer/customer/consent validity check; otherwise refuse                                |
| Learned recommendation            | Not implemented in Phase 8; candidate impressions are unavailable, so no learned score may be shown                                                 |
| Drift status                      | 200 recent and 200 reference feature rows; outcome calibration also requires 100 mature labels and 20 positives                                     |

Stable refusal reasons include:

- `CAPABILITY_DISABLED`
- `INSUFFICIENT_SAMPLE`
- `INSUFFICIENT_POSITIVES`
- `INSUFFICIENT_HISTORY_SPAN`
- `MISSING_SCHEDULE_CONFIGURATION`
- `MODEL_DEGRADED`
- `NO_ELIGIBLE_TARGET`
- `NO_VALID_CANDIDATE`

A refusal stores the observed counts, required threshold, as-of time and baseline version. The UI
shows that evidence and does not show a probability, uncertainty adjective, staffing direction,
learned rank or healthy drift badge. A safe deterministic live option may be shown independently of
a refused statistical prediction.

## 5. Deterministic baselines and explanations

### No-show baseline

`jormall-stat-no-show-eb-v1` uses only mature history from the same tenant. The organization
baseline is its empirical no-show rate. Each eligible operational segment is shrunk toward that
baseline with prior strength eight:

```text
p_org = organization_no_shows / organization_mature_outcomes
p_segment = (segment_no_shows + 8 * p_org) / (segment_mature_outcomes + 8)
```

Segments with fewer than 50 mature outcomes or fewer than five No-show outcomes use `p_org` and are
omitted from the explanation. The score is exact and versioned:

```text
lead_adjustment = clamp((lead_time_days - 7) / 180, -0.08, 0.08)

probability = clamp(
  0.35 * p_org
  + 0.18 * p_service
  + 0.14 * p_provider
  + 0.13 * p_customer
  + 0.10 * p_local_weekday_hour
  + 0.10 * p_source
  + lead_adjustment,
  0,
  1
)
```

The four largest absolute permitted factor deltas are stored, with their sample sizes and direction.
Identical features and algorithm version produce byte-equivalent results.

The explanation shows the organization base rate, sample size and the largest permitted operational
deltas. It says “associated operational factor,” never “cause.” It contains no personal attributes
and never recommends denial of service.

### Demand baseline

`jormall-stat-demand-seasonal-v1` selects the first hierarchy level with at least eight comparable
complete weeks for the target local weekday/hour: branch + service, then branch, then organization.
It never backs off to another tenant. A branch fallback first sums all in-scope service leaf counts
for each comparable local date/hour; an organization fallback likewise sums all in-scope
branch/service leaves for that date/hour. This prevents a tenant with more configured leaves from
artificially lowering the aggregate. Those broader candidates are coverage diagnostics only for a
service-specific operational request: if branch + service evidence is insufficient, the persisted
service prediction is an explicit refusal and contains no aggregate estimate or interval. For the
selected comparable historical totals `x`:

```text
point = mean(x) * calendar_adjustment
sample_variance = sum((x - mean(x))^2) / (n - 1)
uncertainty = 1.00 for branch+service, otherwise 1.35
uncertainty *= 1.50 for an identified holiday without a calibrated adjustment
half_width = 1.96 * sqrt(max(sample_variance, mean(x))) * uncertainty * calendar_adjustment
interval_95 = [max(0, point - half_width), max(0, point + half_width)]
```

The overall series gate remains 200 appointments, 182 history days and 13 non-zero weeks. Croston,
SBA, residual conformal intervals and other sparse-series models are future candidates only; they
must beat this v1 baseline in a new immutable algorithm version before activation.

An Organization-scoped live request enumerates at most 20 active branch/service configurations and
500 future leaf buckets. It first stores each supported branch/service leaf in that branch's
timezone. It then converts the bucket instant to `OrganizationSettings.timezone` and stores one
branchless `ORGANIZATION_DEMAND_BUCKET` per organization-local hour. Its point estimate and bounds
are the sums of mutually exclusive `BRANCH_SERVICE` leaf point estimates and marginal bounds. The
summed bounds are labelled a conservative component envelope, not a separately calibrated 95%
organization interval. A capped configuration/target set, refused leaf, or component that would
require branch/organization fallback produces an explicit branchless refusal for that organization
bucket; the system never double counts an aggregate fallback or presents a partial total as
complete.

### Holidays and sparse series

Holiday/closure features use tenant-owned `OperationalCalendarEvent` rows: Holiday, Closure or
Special-open; optional branch; local date; bilingual label; optional demand adjustment; version and
active state. Do not infer country from phone, free-text address, locale or timezone. A backtest
must never substitute the current active row for the calendar known at its historical origin. Since
no pre-Phase-8 effective-dated calendar history exists, deterministic v1 demand backtests apply no
holiday adjustment and report that limitation; live forecasts may use the active version read at
their recorded configuration watermark. An adjustment must be in `[0, 2]`; it scales both point
estimate and interval width. A holiday without a calibrated adjustment leaves the point unchanged
and widens uncertainty by 1.5.

Weekly seasonality is permitted after the normal demand gate. Annual holiday-learning is not part of
v1 and remains disabled until at least two complete years and sufficient comparable occurrences
exist. Sparse service series report the attempted broader coverage level and exact leaf sample
weeks, but persist `INSUFFICIENT_SAMPLE` without an estimate unless branch+service itself has eight
comparable weeks. Branch/organization candidates are diagnostic or aggregate-only; they are never
presented as a service forecast.

## 6. Evaluation, backtesting and drift

All evaluation is tenant-local, time ordered and reproducible from a source watermark. Rolling
origins leave a gap equal to the prediction horizon. Advanced versions must be compared with the
deterministic baseline; a version that fails its gate remains disabled or rolls back.

| Capability     | Required offline metrics                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No-show        | Brier score, log loss, average precision/PR-AUC against prevalence, ROC-AUC as supplementary, five-bin expected calibration error, precision/recall at probability 0.5, sample size and coverage/refusal |
| Demand         | MAE, RMSE, WAPE, MASE against seasonal naive, signed bias, mean 0.025/0.975 pinball loss, empirical 95% interval coverage and mean width                                                                 |
| Staffing       | Provider-minute MAE/WAPE, under/over-capacity minutes, shortage-alert precision/recall and inherited interval coverage                                                                                   |
| Reflow         | Candidate validity, recovered minutes, final transaction conflicts, schedule churn and offer accept/decline/expiry                                                                                       |
| Recommendation | Candidate validity, Recall@k, NDCG@k, MRR/acceptance, time to valid slot and provider exposure, compared with earliest-valid-slot ordering                                                               |

An advanced no-show version must not be worse than the constant organization-rate baseline on Brier
score and log loss. An advanced demand version requires `MASE < 1` against seasonal naive. Reflow
and recommendation candidate validity has a 100% gate before display; transaction races may still
return a normal conflict and fresh search.

For each demand rolling origin, the MASE denominator is the mean absolute one-week seasonal-naive
error computed only from that target series' time-ordered training window. Each holdout absolute
error is divided by its corresponding positive in-sample scale before averaging. A missing or zero
scale makes MASE unavailable and cannot satisfy the `MASE < 1` gate; it is never replaced with a
cross-tenant or holdout-derived denominator.

Drift compares the same feature definition and same tenant over reference/recent windows. V1 uses
total variation distance over normalized categorical counts:

```text
drift = 0.5 * sum(abs(reference_share(key) - current_share(key)))
STABLE below 0.10; WATCH from 0.10; ALERT from 0.25
```

The v1 drift run records sample counts and total-variation change for appointment-source mix in the
no-show baseline and local weekday/hour mix in the demand baseline. Prediction-distribution change,
observed prevalence/calibration and missing/refusal-rate drift require additional mature windows and
are not claimed by v1. No cross-tenant row is used as a reference. A window below the documented
sample threshold is `INSUFFICIENT`, not “no drift.” Feedback changes no historical score and is
append-only: Helpful, Incorrect, Unsafe or Outdated remains attributed to actor and Prediction.

## 7. Safe reflow and recommendation

Reflow is a simulation until confirmation. It may be triggered by a cancellation, provider time off,
resource disruption or an explicit staff request. Candidate generation must:

1. preserve Organization and customer binding;
2. preserve service and the existing branch/provider unless an explicit customer preference or bound
   approval allows a change;
3. enforce branch hours, provider availability/time off, service eligibility/duration/buffers,
   required resources, current reservations and overlapping customer appointments;
4. require a current purpose-level consent record before producing a contact-oriented candidate;
5. attach source records, expected appointment version, expiry and explanation;
6. make no database mutation and reserve no capacity merely because it was recommended.

The existing availability engine produces candidates; the ordinary booking/reschedule or slot-offer
transaction is the final authority. Acceptance requires staff authorization, explicit customer
confirmation, idempotency and expected version. A stale, declined or expired recommendation cannot
execute. Concurrent acceptance/conflict returns a human-readable normal scheduling conflict.

V1 stores reflow and recommendation outputs as typed `Prediction` details, not appointment state.
Reflow first removes any candidate whose provider, resource, buffer, appointment-overlap or
purpose-consent check fails, then orders by recovered/improved minutes descending and slot start
ascending. It does not send a message in Phase 8. Communication preferences and opt-out state must
be rechecked by the existing messaging pipeline if staff later contacts the customer. Waitlist time
windows are not an input to this appointment-targeted v1 reflow. Every candidate flags both staff
and customer confirmation as required.

The initial service/provider/slot ordering first removes candidates that are not currently
available, eligible or resource-valid, then computes:

```text
score = 0.35 when explicit preference matches
      + 0.25 when provider continuity matches
      + min(prior completed count / 100, 0.40)
```

It sorts by score descending, slot start ascending and opaque provider ID as the stable tie-break.
It does not rank on names, phone/location proxies, locale, clinical text or unsupported sensitive
traits. Until candidate impressions exist, it is labelled rules-based and no learned acceptance
probability is shown.

## 8. Jobs, enablement and performance assumptions

Feature computation, prediction, backtest, evaluation and drift are bounded jobs. Each durable
`PredictiveJob` has a validated versioned request fingerprint, opaque ID, Organization routing ID,
kind and idempotency reference. A dedicated relay claims pending rows with `FOR UPDATE SKIP LOCKED`,
enqueues the stable job ID in BullMQ, and reconciles stale claims. The worker then:

1. opens tenant context and reloads the authoritative job;
2. rechecks active organization, membership/service actor where applicable, permission and
   per-capability enablement;
3. keyset-pages source rows rather than loading an Organization's full history;
4. writes feature/prediction/evaluation pages and a source watermark idempotently;
5. marks a stable completed, refused, retryable-failure or dead-letter outcome.

Redis/BullMQ coordinates delivery only. PostgreSQL owns jobs, versions, enablement, predictions and
outcomes. Tenant-local numerical history is cut off at the persisted job timestamp. The first
processing attempt sets one database-immutable `evaluationAt`; the separate `startedAt` is refreshed
for each processing lease so stale-worker recovery remains correct. Live feasibility policies record
that configuration/evaluation watermark because availability, consent and schedule configuration are
mutable and must be revalidated. A zero-evidence retry is replayable only for No-show and Demand
`DATA_AUDIT`, whose reads are verified append-only snapshots as-of the fixed cutoff. Every Generate,
Feature, Backtest and Drift retry, and Staffing/Reflow/Recommendation data-audit retry, fails closed
as `MUTABLE_INPUT_RETRY_REQUIRES_NEW_JOB`; a new job receives a coherent cutoff and configuration
read. If an attempt committed any evidence before interruption, every job kind instead fails closed
as `PARTIAL_EVIDENCE_ON_RETRY`. Both cases append nothing and move to dead-letter. Evidence
belonging to a non-completed job is never projected as current. Capability enablement and actor
authorization are rechecked by the worker; disabled results remain historical database evidence but
are not current operational advice.

Initial planning assumptions, not production capacity claims:

- source reads use keyset pages of at most 500 rows;
- v1 retains at most the latest 5,000 eligible appointment/history observations as-of the watermark
  in a rolling in-process array; demand uses bounded maps derived from that same window;
- Organization demand generation enumerates at most 20 active branch/service configurations and 500
  future component buckets; crossing either cap returns `MODEL_DEGRADED` rather than a partial
  aggregate;
- `PredictiveDataAudit` records a history-capped coverage warning. Evaluation is explicitly scoped
  to the retained window, and a capability refuses when the cap cannot preserve its required history
  span/sample evidence;
- snapshots/results write in bounded records and no source array grows with total tenant history;
- no cross-tenant batch, cache key or aggregate map;
- interactive views read stored current predictions/recommendations and do not train or backtest;
- one baseline result should remain below 250 ms after its feature snapshot exists; full feature
  jobs and backtests are asynchronous and publish measured duration/row counts;
- the initial worker has a global concurrency of two. Per-tenant fair scheduling is not yet proven;
  starvation and appropriate production concurrency must be established by load testing before the
  platform raises this limit.

Load tests must establish p95/p99 database and queue behavior before raising these bounds. An LLM or
external numerical service is not part of the baseline performance path.

## 9. Explicit v1 limits and safe fallback

The system refuses a numerical result whenever the tenant-local sample, positives/negatives, history
span, active weeks, comparable demand buckets, configuration completeness or live candidate validity
misses the gate in section 4. A failed offline quality gate returns `MODEL_DEGRADED` rather than
activating a more complex version. Disabled capabilities return `CAPABILITY_DISABLED`. The stored
refusal contains the cutoff, observed count, required count and immutable algorithm version; its
estimate and bounds are `NULL`.

V1 deliberately does not claim the following:

- production predictive validity, because no production corpus was available;
- latent or turned-away demand, because availability-query impressions are not persisted;
- historical holiday effects, because effective-dated calendar evidence starts with Phase 8;
- employee productivity, absence, cost or hiring need, because shift/attendance/contract data is
  absent;
- learned recommendation quality, because candidate impressions and selections are absent;
- a complete disruption optimizer: reflow offers an earlier valid slot for an explicitly selected
  appointment and requires normal confirmation/revalidation;
- full multivariate drift: deterministic v1 monitors only tenant-local source mix for no-show and
  local weekday/hour mix for observed demand.

An upgraded development or tenant database that contains pre-snapshot AppointmentStatusHistory rows
will refuse affected No-show and Demand statistical work with `MODEL_DEGRADED` until sufficient new,
database-verified evidence exists. This is intentional; migration backfill is not retroactive proof.

Rules-based recommendation and reflow candidates are live advisory fallbacks, not statistical
probabilities. Their displayed expiry is short, and appointment/resource/availability/consent state
must be revalidated by the normal scheduling transaction before any eventual mutation.

## 10. Manual evidence

1. Open an Organization with the development seed and request a no-show prediction; verify the page
   shows `INSUFFICIENT_SAMPLE`, observed counts and threshold, with no probability.
2. Disable each predictive capability and verify generation/feature/backtest/drift work returns
   `CAPABILITY_DISABLED` immediately while old evidence remains auditable. Data-audit jobs remain
   available so an Owner can inspect the evidence needed before re-enabling.
3. Run the same feature job twice with the same version/as-of/watermark and verify one logical
   result and byte-equivalent feature/result data.
4. Run the No-show rolling-origin backtest against a purpose-built tenant fixture and inspect
   calibration, baseline comparison and refusal coverage. Run Demand backtest and verify it is
   `INSUFFICIENT` with holiday and historical-configuration evaluation marked `NOT_EVALUATED` until
   genuine effective-dated evidence exists.
5. Attempt to reference a second tenant's model, feature snapshot, prediction or typed
   recommendation-Prediction ID; verify the same not-found result as an unknown ID and PostgreSQL
   RLS denial.
6. Create a cancellation and inspect reflow options. Change provider/resource state before
   accepting; verify the normal transaction rejects the stale option without a partial appointment
   change.
7. Confirm a valid option as authorized staff and customer; verify expected version, idempotency,
   ordinary audit/history and no automatic mutation before confirmation.
8. Repeat the views in Arabic RTL and English and verify refusal, interval and explanation labels
   are accessible and do not rely on color alone.
