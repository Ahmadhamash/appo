# JorMall Logical Data Model

Status: Design baseline updated through Phase 8 and sector-specific gym operations

## 1. Modeling conventions

- Primary keys are UUIDs. Public lookup tokens are separate random, revocable values and are never
  derived from sequential identifiers.
- Every tenant-owned table carries `organization_id` directly, including history, attempts, joins,
  and derived artifacts. `Organization.id` is itself the tenant boundary.
- Tenant relationships use composite candidate keys such as `(organization_id, id)` and matching
  composite foreign keys where supported. This makes an accidental cross-tenant relation invalid at
  the database layer.
- Mutable records have `created_at`, `updated_at`, and an integer `version` when optimistic
  concurrency matters. Actor/source attribution is stored on sensitive changes.
- Business instants use PostgreSQL `timestamptz` and UTC application values. Local calendar rules
  store an IANA timezone plus local day/time components.
- Human-facing names are not identifiers. Phone numbers use normalized E.164 form when possible;
  raw/provider values are retained only when needed and protected appropriately.
- Archival is explicit per aggregate. Financial, consent, clinical/service, audit, communication,
  and appointment history is not destroyed by a generic soft-delete flag.
- JSON is reserved for versioned provider payload projections and flexible metadata. Core query and
  authorization fields remain typed columns.

## 2. Entity ownership catalog

This table is the baseline catalog through the current roadmap. Any new persisted entity must be
added here with an ownership decision before implementation.

### Platform, identity, and organization

| Entity                     | Phase | Ownership                                      | Purpose and invariants                                                                      |
| -------------------------- | ----- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| User                       | 1     | Platform-owned, not tenant-owned               | Identity-provider subject link and platform profile; no tenant permission by itself         |
| Session                    | 1     | Platform/auth-provider owned                   | Secure session metadata and revocation; membership is resolved on each scoped session       |
| PlatformAdminGrant         | 1     | Platform-owned                                 | Explicit platform permission grant with issuer, expiry, and revocation                      |
| PlatformSupportAccess      | 1     | Platform-owned; references target Organization | Time-bound reason/ticket for exceptional tenant access; produces audit events               |
| Organization               | 1     | Tenant root (`id` is `organization_id`)        | Legal/display identity, status, default locale, IANA timezone, retention policy             |
| OrganizationDomain         | 1     | Tenant-owned                                   | Verified public/embedding domains; unique normalized host rules                             |
| OrganizationMembership     | 1     | Tenant-owned                                   | User-to-Organization membership, lifecycle, invited/accepted metadata                       |
| Role                       | 1     | Tenant-owned                                   | Immutable default-role key or custom role name; system defaults cannot be weakened silently |
| RolePermission             | 1     | Tenant-owned                                   | Permission and scope grant assigned to a Role; permission key comes from code registry      |
| MembershipRole             | 1     | Tenant-owned                                   | Membership-to-Role assignment with optional branch/self constraints                         |
| Branch                     | 1     | Tenant-owned                                   | Physical/virtual location, timezone override, contact and lifecycle                         |
| StaffProfile               | 1     | Tenant-owned                                   | Staff business identity linked to a Membership when login is enabled                        |
| StaffBranchAssignment      | 1     | Tenant-owned                                   | Staff eligibility at Branch with active interval                                            |
| OrganizationSetting        | 1     | Tenant-owned                                   | Versioned typed organization configuration; not a secret store                              |
| BranchSetting              | 1     | Tenant-owned                                   | Versioned typed branch override; inherits organization defaults                             |
| ExternalProviderCredential | 4+    | Tenant-owned                                   | Envelope-encrypted provider credential, key version, scopes, rotation/revocation metadata   |

Permissions themselves are a versioned code registry, not arbitrary database strings created by
clients. RolePermission references only registered keys.

### Catalog, availability, and resources

| Entity                     | Phase | Ownership    | Purpose and invariants                                                                |
| -------------------------- | ----- | ------------ | ------------------------------------------------------------------------------------- |
| Service                    | 1     | Tenant-owned | Name/translations, active status, duration, pre/post buffers, optional price/currency |
| BranchService              | 1     | Tenant-owned | Service availability and optional overrides at a Branch                               |
| StaffService               | 1     | Tenant-owned | Staff eligibility for Service with optional duration override                         |
| BranchHoursRule            | 2     | Tenant-owned | Local recurring opening interval with effective dates and timezone                    |
| AvailabilityRule           | 1     | Tenant-owned | Local recurring working interval, effective dates, and optional branch constraint     |
| TimeOff                    | 1     | Tenant-owned | Staff/branch closure interval stored as UTC instants                                  |
| Resource                   | 3     | Tenant-owned | Resource pool such as room, chair, or device; branch and capacity policy              |
| ResourceUnit               | 3     | Tenant-owned | Capacity-one allocatable unit used by exclusion constraints                           |
| ResourceAvailabilityRule   | 3     | Tenant-owned | Recurring/exception availability for resource units                                   |
| ServiceResourceRequirement | 3     | Tenant-owned | Required resource type/count for a Service at a Branch                                |

Recurring rules are expanded only within bounded search windows. The original rule, timezone, and
exception remain authoritative; generated slots are not stored as the scheduling source of truth.

### CRM and consent

| Entity          | Phase | Ownership    | Purpose and invariants                                                                                    |
| --------------- | ----- | ------------ | --------------------------------------------------------------------------------------------------------- |
| Customer        | 2     | Tenant-owned | Organization-local customer profile, locale, preferences, lifecycle; never globally shared                |
| CustomerContact | 2     | Tenant-owned | Original contact input plus safely normalized Jordanian phone where unambiguous; no cross-tenant identity |
| Consent         | 2     | Tenant-owned | Append-only purpose/channel/status/source/text-version evidence and withdrawal link                       |

Consent is not a boolean on Customer. Current consent is derived from the append-only record chain
for the requested purpose and channel.

### Sector profiles and gym operations

| Entity                 | Ownership    | Purpose and invariants                                                                  |
| ---------------------- | ------------ | --------------------------------------------------------------------------------------- |
| GymTraineeProfile      | Tenant-owned | One Customer profile with goal, metrics, budget and optional tenant-local trainer       |
| GymTraineePortalAccess | Tenant-owned | One authenticated User linked to exactly one tenant-local trainee profile               |
| GymTraineeInvitation   | Tenant-owned | Hashed, expiring, single-use capability for provisioning trainee access                 |
| GymWorkoutPlan         | Tenant-owned | Bilingual dated plan with explicit lifecycle and version                                |
| GymWorkoutExercise     | Tenant-owned | Bilingual weekday prescription with sets, repetitions, rest and optional target weight  |
| GymWorkoutLog          | Tenant-owned | Performed workout result with UTC timestamp, actual weight/repetitions and effort       |
| GymNutritionPlan       | Tenant-owned | Goal and budget-aware calorie/macronutrient targets; operational, not clinical guidance |
| GymNutritionMeal       | Tenant-owned | Bilingual meal option, timing, estimated minor-unit cost and macro breakdown            |
| GymProgressEntry       | Tenant-owned | Timestamped trainee measurements and notes                                              |

`OrganizationSettings.businessSector` is the typed, audited portal selector. Gym tables use
composite organization-aware foreign keys and forced RLS. `GymTraineePortalAccess` is the reviewed
independent-login boundary: tenant/profile context is resolved from the authenticated User link,
never from a browser identifier. See ADR 0016.

### Scheduling

| Entity                         | Phase | Ownership    | Purpose and invariants                                                                                                                                                                                                                           |
| ------------------------------ | ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Appointment                    | 2     | Tenant-owned | Customer, branch, service, UTC interval, timezone snapshot, lifecycle status, channel and version                                                                                                                                                |
| AppointmentStaffReservation    | 2     | Tenant-owned | Capacity-one staff interval; tenant-aware FK and GiST exclusion constraint                                                                                                                                                                       |
| AppointmentResourceReservation | 3     | Tenant-owned | Resource unit interval; tenant-aware FK and GiST exclusion constraint                                                                                                                                                                            |
| AppointmentStatusHistory       | 2     | Tenant-owned | Append-only event with status/schedule, actor/source/version and database-captured branch/service/provider/customer/timezone dimensions plus verification time; pre-capture legacy dimensions remain unverified and predictive work refuses them |
| AppointmentRecord              | 2     | Tenant-owned | Provider/service outcome notes and structured fields, sensitivity and authorship                                                                                                                                                                 |
| AppointmentNote                | 2     | Tenant-owned | Restricted staff-authored internal note; absent from public booking projections                                                                                                                                                                  |
| AppointmentParticipant         | 2     | Tenant-owned | Customer/provider/staff participants with organization-local references                                                                                                                                                                          |
| AppointmentIdempotency         | 2     | Tenant-owned | Operation, key, immutable request fingerprint, result reference and expiry; unique per Organization/operation/key                                                                                                                                |
| WaitlistEntry                  | 3     | Tenant-owned | Customer preference window, service/branch/staff constraints, priority and lifecycle                                                                                                                                                             |
| SlotOffer                      | 3     | Tenant-owned | Expiring, single-use offer tied to WaitlistEntry and proposed slot; acceptance remains transactional                                                                                                                                             |

Reservation intervals include service buffers and use half-open `[start, end)` semantics so adjacent
appointments do not conflict. Appointment display duration and blocking duration remain
distinguishable.

### Communications and asynchronous delivery

| Entity                  | Phase | Ownership                           | Purpose and invariants                                                                            |
| ----------------------- | ----- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| MessageTemplate         | 4     | Tenant-owned                        | Versioned locale/channel template and approval status                                             |
| Message                 | 4     | Tenant-owned                        | Logical inbound/outbound message, customer/channel, consent decision and delivery aggregate state |
| MessageAttempt          | 4     | Tenant-owned                        | One provider attempt with idempotency key, response projection, retry and timestamps              |
| OutboxEvent             | 2     | Tenant-owned                        | Committed event envelope for asynchronous work; aggregate/version uniqueness                      |
| Conversation            | 4     | Tenant-owned                        | Staff-visible customer/channel thread with optional appointment context                           |
| InboxEvent              | 4     | Tenant-owned after verified routing | Normalized payload, raw-body hash, provider event identity, processing and dead-letter state      |
| DeliveryReceipt         | 4     | Tenant-owned                        | Append-only monotonic provider delivery evidence                                                  |
| CommunicationPreference | 4     | Tenant-owned                        | Per-customer channel opt-in/opt-out state, actor, reason and optimistic version                   |
| ProviderConnection      | 4     | Tenant-owned                        | Replaceable adapter selection, provider account identity and environment-backed secret reference  |

Unroutable but signature-valid provider events are held in a restricted platform quarantine and do
not become tenant-owned until routing is proven.

### Knowledge, conversations, and AI

| Entity                     | Phase | Ownership    | Purpose and invariants                                                                                     |
| -------------------------- | ----- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| KnowledgeSource            | 5A    | Tenant-owned | Manual/text-upload source, ingestion state, active-version pointer                                         |
| KnowledgeDocument          | 5A    | Tenant-owned | Immutable normalized text document, language and checksum                                                  |
| KnowledgeChunk             | 5A    | Tenant-owned | Deterministic retrieval chunk with provenance and quarantine state; tenant/active-version filter mandatory |
| KnowledgeVersion           | 5A    | Tenant-owned | Draft/active/rolled-back version with checksum and creator                                                 |
| AIConversation             | 5A    | Tenant-owned | Trusted tenant/customer binding, locale, model and prompt-policy snapshot                                  |
| AIMessage                  | 5A    | Tenant-owned | Customer/assistant/system message with safety label and model identifier                                   |
| AIAction                   | 5A    | Tenant-owned | Gateway request, permission decision, redacted input/result, idempotency, latency, model and outcome       |
| AIActionApproval           | 5A    | Tenant-owned | Short-lived single-use confirmation bound to customer, conversation, action summary and payload hashes     |
| AIUsage                    | 5A    | Tenant-owned | Per-turn/action tokens, estimated micro-cost, latency, model and outcome                                   |
| HumanHandoff               | 5A    | Tenant-owned | Reason, summary, queue/assignee, urgency and lifecycle                                                     |
| PromptConfiguration        | 5A    | Tenant-owned | Immutable base safety policy plus subordinate guidance, allowlist, confidence and monthly limits           |
| AIEvaluationCase           | 5A    | Tenant-owned | Versionable multilingual/adversarial expected behavior fixture                                             |
| AIEvaluationRun            | 5A    | Tenant-owned | Model/prompt evaluation result, safe trace, latency and outcome                                            |
| WebsiteWidgetConfiguration | 5B    | Tenant-owned | Public-key installation, exact origins, bilingual branding, activation and optimistic version              |
| AIChannelSession           | 5B    | Tenant-owned | Website/WhatsApp/voice binding to one AIConversation and verified channel route                            |
| AIChannelPendingAction     | 5B    | Tenant-owned | Server-stored mutation payload and single-use confirmation state; never reconstructed from model text      |
| Call                       | 5B    | Tenant-owned | Provider call identity, verified route, customer/session, direction, consent, timing and lifecycle         |
| CallEvent                  | 5B    | Tenant-owned | Append-only deduplicated provider callback, payload digest, normalized payload and processing outcome      |
| CallRecording              | 5B    | Tenant-owned | Consent-bound mock/provider recording identity and future encrypted object/retention metadata              |
| CallTranscript             | 5B    | Tenant-owned | Partial/final speaker transcript with event provenance, locale, timing and confidence                      |
| CallSummary                | 5B    | Tenant-owned | Intent, outcome, optional appointment, unresolved items, handoff reason and model evidence                 |

Embedding/vector infrastructure must support an immutable tenant filter. If a provider cannot
enforce that filter server-side, retrieval must use physically tenant-partitioned indexes or a
different provider.

### Audit, imports, reporting, and intelligence

| Entity                      | Phase | Ownership                                                          | Purpose and invariants                                                                              |
| --------------------------- | ----- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| AuditEvent                  | 1     | Tenant-owned for tenant action; platform-owned for platform action | Append-only actor/action/target/context/result evidence with integrity controls                     |
| AttributionEvent            | 7     | Tenant-owned                                                       | Append-only channel/campaign touch linked to customer/appointment where known                       |
| ImportBatch                 | 7     | Tenant-owned                                                       | File digest, idempotency key, initiator, dry-run/commit state, totals and safe rollback evidence    |
| ImportRow                   | 7     | Tenant-owned                                                       | Staged row, validation/dedupe decision, digest and committed entity reference                       |
| ReportRun                   | 7     | Tenant-owned                                                       | Formula version, local-date UTC bounds, timezone, aggregate result and source watermark             |
| DataExportJob               | 7     | Tenant-owned                                                       | Actor-bound, expiring, permission-revalidated paginated export descriptor                           |
| PlatformAuditEvent          | 7     | Platform-owned                                                     | Immutable reason-bearing evidence for Super Admin global audit and aggregate access                 |
| CopilotInsight              | 6     | Tenant-owned                                                       | Generated briefing/gap/quality insight with evidence, confidence and disposition                    |
| CopilotInsightSource        | 6     | Tenant-owned                                                       | Authorized source link/classification for one generated statement                                   |
| CopilotFeedback             | 6     | Tenant-owned                                                       | Append-only helpful/incorrect/unsafe/outdated employee feedback and audit attribution               |
| PredictiveCapabilitySetting | 8     | Tenant-owned                                                       | Per-capability enablement, optimistic version and actor evidence                                    |
| PredictiveDataAudit         | 8     | Tenant-owned                                                       | As-of sample/label/configuration counts, threshold decisions and explicit refusal reasons           |
| PredictiveJob               | 8     | Tenant-owned                                                       | Idempotent bounded audit/feature/generate/backtest/drift work, progress, retry/dead-letter outcome  |
| PredictiveModelVersion      | 8     | Tenant-owned                                                       | Immutable deterministic formula/configuration, thresholds, training/as-of scope and lifecycle       |
| Prediction                  | 8     | Tenant-owned                                                       | Immutable model/horizon/as-of score or refusal, interval, sanitized features/details and expiry     |
| PredictiveFeatureSnapshot   | 8     | Tenant-owned                                                       | Sanitized as-of features, source watermark and deterministic feature hash                           |
| PredictiveEvaluationRun     | 8     | Tenant-owned                                                       | Offline/backtest cohort, baseline comparison, metric values, coverage/refusals and source watermark |
| PredictiveDriftRun          | 8     | Tenant-owned                                                       | Same-tenant reference/recent distribution, label/calibration drift and minimum-sample decision      |
| PredictiveFeedback          | 8     | Tenant-owned                                                       | Append-only helpful/incorrect/unsafe/outdated feedback attributed to one Prediction                 |
| OperationalCalendarEvent    | 8     | Tenant-owned                                                       | Versioned active holiday/closure/special-open event on a tenant-local date                          |

ReportRun stores aggregates only, not a duplicate row-level warehouse. ImportRow payloads are
short-lived staging data subject to the import retention policy; error downloads expose row number,
stable error code, and safe message rather than the original payload.

## 3. Key relationships

- User -> OrganizationMembership -> MembershipRole -> RolePermission determines organization access.
- Organization -> Branch -> BranchService/StaffBranchAssignment establishes where work is allowed.
- Customer + Service + Branch -> Appointment; reservations establish scarce staff/resource capacity.
- AppointmentStatusHistory, AuditEvent, and AppointmentIdempotency are committed with the Phase 2
  mutation they describe.
- AIConversation is bound by the server to an Organization and optional verified Customer. AIAction
  links the conversation, authorization/confirmation evidence, redacted action result, and
  AuditEvent; model-supplied tenant/customer references never establish identity.
- Message is provider-neutral; MessageAttempt records provider-specific execution.
- Organization -> PredictiveCapabilitySetting selects whether each predictive class may run; the
  latest active PredictiveModelVersion for the same tenant/capability supplies the baseline.
  Disabling prevents new current results without deleting evidence.
- PredictiveJob may produce one PredictiveDataAudit and bounded FeatureSnapshot, Prediction,
  Evaluation or Drift evidence. Each relation repeats Organization and carries the relevant
  version/as-of/source-watermark lineage so cross-tenant attachment is structurally invalid and a
  replay is reproducible.
- Prediction explanation/details JSON contains allowlisted operational factors only. Staffing,
  reflow and service/provider/slot recommendations are typed Prediction artifacts and advisory
  evidence; feedback never mutates the source Appointment. Accepted reflow returns through the
  ordinary SlotOffer or Appointment use case.

## 4. Appointment state machine

### States

| State         | Meaning                                                    | Blocks staff/resources                           |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `PENDING`     | Validated appointment awaiting staff/public confirmation   | Yes                                              |
| `CONFIRMED`   | Booked and operationally scheduled                         | Yes                                              |
| `CHECKED_IN`  | Customer has arrived and is waiting                        | Yes                                              |
| `IN_PROGRESS` | Service delivery has started                               | Yes                                              |
| `COMPLETED`   | Service delivery ended; terminal                           | No future capacity; historical interval retained |
| `CANCELLED`   | Cancelled with actor, reason, and effective time; terminal | No                                               |
| `NO_SHOW`     | Customer did not arrive after the configured grace period  | No; may be corrected to checked-in               |

### Allowed transitions

| From          | To            | Preconditions                                                                |
| ------------- | ------------- | ---------------------------------------------------------------------------- |
| none          | `PENDING`     | Valid slot, channel requires confirmation, idempotency accepted              |
| none          | `CONFIRMED`   | Valid slot, channel may commit immediately, idempotency accepted             |
| `PENDING`     | `CONFIRMED`   | Authorized staff confirms the appointment                                    |
| `PENDING`     | `CANCELLED`   | Authorized staff cancellation with a reason                                  |
| `CONFIRMED`   | `CHECKED_IN`  | Authorized staff/customer check-in policy; not before configured window      |
| `CONFIRMED`   | `IN_PROGRESS` | Authorized provider; check-in is optional for this Organization workflow     |
| `CONFIRMED`   | `CANCELLED`   | Authorized actor, cancellation reason/policy, confirmation when AI-driven    |
| `CONFIRMED`   | `NO_SHOW`     | Start plus grace has passed; authorized staff or idempotent worker policy    |
| `CHECKED_IN`  | `IN_PROGRESS` | Assigned/authorized provider starts service                                  |
| `CHECKED_IN`  | `CANCELLED`   | Service has not started; authorized staff and reason required                |
| `IN_PROGRESS` | `COMPLETED`   | Assigned/authorized provider records required outcome fields                 |
| `NO_SHOW`     | `CHECKED_IN`  | Explicit correction permission, reason, audit, and allowed correction window |

All other transitions fail with a structured conflict code. `COMPLETED` and `CANCELLED` are
terminal; corrections use append-only record correction workflows rather than reopening them.

Reschedule is not a status. It is an atomic operation allowed only while `PENDING` or `CONFIRMED`:
validate the new interval, acquire/replace reservations, increment version, and append a
`RESCHEDULED` history event in one transaction. Cancellation does not delete the Appointment.

Every transition checks expected version, actor permission, tenant, timing precondition, reason and
idempotency key. AppointmentHistory stores the prior/new state and schedule, source channel, actor,
correlation ID, and authorization decision.

## 5. Database constraints required in implementation

- Unique `(organization_id, id)` candidate key on tenant aggregates used by composite foreign keys.
- Unique active Membership per `(organization_id, user_id)`.
- Unique normalized CustomerIdentifier per `(organization_id, type, normalized_value)` according to
  verification/deduplication policy.
- Check `end_at > start_at` for appointments/reservations/time off.
- GiST exclusion constraints for overlapping blocking staff and resource-unit reservation ranges.
- Unique `(organization_id, operation, idempotency_key)` plus immutable request fingerprint.
- Unique provider webhook identity within verified provider account/tenant routing.
- Unique Outbox aggregate version/event key and AI action request/idempotency key.
- Unique PredictiveJob idempotency key with immutable request fingerprint per Organization; unique
  Prediction generation key and PredictiveFeatureSnapshot hash per Organization.
- Predictive snapshots, predictions (including factor/recommendation details), evaluations, drift,
  feedback and calendar events use tenant-aware foreign keys and RLS; source IDs are never accepted
  without the same Organization.
- Published PredictiveModelVersion formula/threshold configuration and completed evaluation reports
  are immutable. Supersession creates a new version rather than rewriting evidence.
- Foreign keys use restrictive deletion for evidence/history; archival workflows are explicit.

Prisma cannot express every PostgreSQL exclusion, RLS, or partial constraint. Reviewed migrations
will contain the necessary SQL and matching PostgreSQL integration tests.
