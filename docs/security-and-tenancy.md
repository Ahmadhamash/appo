# Security, Tenancy, and Authorization

Status: Mandatory security baseline

## 1. Security objectives

1. A tenant actor cannot discover, read, mutate, infer, search, cache-hit, or receive another
   Organization's data.
2. A compromised browser, webhook, prompt, job payload, or provider cannot choose its tenant
   context.
3. High-impact actions are authenticated, authorized, idempotent, attributable, and auditable.
4. Secrets and sensitive content are minimized, encrypted appropriately, and absent from logs/model
   context unless explicitly required.
5. Platform support power is exceptional and visible rather than an implicit universal tenant role.

The initial threat model covers broken object-level authorization, privilege escalation, session and
CSRF attacks, webhook forgery/replay, queue payload tampering, cache/key collisions, prompt
injection, credential disclosure, cross-tenant retrieval, race conditions, and insider support
access.

## 2. Tenant context resolution

| Channel             | Trusted source of Organization context                                                                                  | Rejected source                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Staff dashboard/API | Verified session -> active OrganizationMembership; active organization selection is checked against memberships         | Browser body/query/header organization ID alone  |
| Public booking      | Server-resolved public booking slug/domain -> active Organization/Branch plus signed flow token                         | Hidden form organization ID                      |
| Website chatbot     | Signed, origin-restricted embed configuration issued by JorMall                                                         | Unsigned JavaScript configuration                |
| WhatsApp            | Verified raw webhook signature -> configured provider account/number -> Organization                                    | Message text or arbitrary provider metadata      |
| Voice               | Verified provider webhook/call connection -> provisioned number/assistant -> Organization                               | Caller-supplied tenant claim                     |
| Worker              | Validated queue envelope -> authoritative OutboxEvent or dedicated durable job reloaded through tenant-bound repository | Queue payload as sole authorization evidence     |
| Platform support    | Platform identity + active PlatformSupportAccess target/reason/expiry                                                   | Ordinary tenant session or a free-form target ID |

Route parameters may select a resource only after tenant context exists. Repository lookups include
both tenant and resource ID. Out-of-tenant and nonexistent resources produce the same external
result.

## 3. Isolation layers

### Application layer

- Every tenant repository method takes a non-optional TenantContext.
- Use cases authorize before loading sensitive projections when practical and again before mutation
  if state affects permission.
- Cross-organization operations do not exist in ordinary use-case interfaces.
- Background jobs and AI actions carry tenant context for correlation, then reload authoritative
  state and re-authorize rather than trusting serialized decisions.

### PostgreSQL layer

- Every tenant table has `organization_id NOT NULL`.
- Composite tenant-aware foreign keys prevent a child referencing a parent in another Organization.
- Normal web/worker database roles have row-level security enabled and cannot bypass it.
- At transaction start, the adapter uses transaction-local settings for organization, actor, and an
  optional validated support-access ID. Policies use those settings and deny when absent.
- Pool connections never use session-persistent tenant state. Automated tests alternate tenants on
  the same small pool to detect context bleed.
- Schema migration and restricted platform-maintenance roles are separate from application roles.

Application scoping remains mandatory even with RLS. RLS is defense in depth, not a reason to expose
unscoped repositories.

### Redis, queues, search, and storage

- Keys and job IDs include a namespaced Organization ID; cached values repeat tenant identity and
  are verified on decode.
- Queue schemas require Organization ID, correlation ID, job type/version, and idempotency
  reference.
- Knowledge/vector queries include an immutable tenant filter and publication filter before ranking.
- Object keys begin with an opaque tenant prefix. Access uses short-lived signed URLs issued only
  after authorization; buckets are private.
- Metrics avoid high-cardinality PII labels. Logs may contain opaque tenant/resource IDs but no
  message bodies, credentials, tokens, recordings, prompts, or clinical/service notes.

## 4. RBAC model

Authorization combines:

- a registered permission key;
- a grant scope: `organization`, `assigned_branches`, `self_or_assigned`, `own_customer`, or
  `gateway_action`;
- Membership, branch assignment, staff/customer relationship, and current resource state;
- channel and action-specific policy such as confirmation or consent.

A role is a bundle of grants, not a magic conditional in endpoint code. Default roles are created
from a versioned code template. Owners may add custom roles later, but cannot grant a permission
they do not hold, modify protected system-role semantics, or expand beyond their Organization.

### Permission registry

| Area                 | Permission keys                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization         | `organization.read`, `organization.settings.manage`, `organization.billing.manage`                                                                                                                                                                       |
| Branches             | `branches.read`, `branches.manage`                                                                                                                                                                                                                       |
| Staff/access         | `staff.read`, `staff.manage`, `roles.read`, `roles.manage`                                                                                                                                                                                               |
| Catalog              | `services.read`, `services.manage`, `schedules.read`, `schedules.manage`                                                                                                                                                                                 |
| CRM/consent          | `customers.read`, `customers.write`, `customers.export`, `customers.archive`, `consent.read`, `consent.record`                                                                                                                                           |
| Appointments         | `appointments.availability.read`, `appointments.read`, `appointments.create`, `appointments.reschedule`, `appointments.cancel`, `appointments.status.transition`, `appointments.status.correct`, `appointment_records.read`, `appointment_records.write` |
| Resources/waitlist   | `resources.read`, `resources.manage`, `waitlist.read`, `waitlist.manage`, `slot_offers.manage`                                                                                                                                                           |
| Communications       | `messages.read`, `messages.send`, `messages.retry`, `message_templates.manage`, `communication_preferences.manage`, `provider_credentials.manage`                                                                                                        |
| Conversations/AI     | `conversations.read`, `conversations.handoff`, `recordings.read`, `knowledge.read`, `knowledge.manage`, `ai.configure`, `ai.actions.execute`                                                                                                             |
| Operations/reporting | `reports.read`, `imports.manage`, `exports.manage`, `audit.read`, `provider_credentials.manage`, `predictions.read`, `predictions.run`, `predictions.configure`, `predictions.feedback`                                                                  |
| Platform only        | `platform.organizations.manage`, `platform.support_access.request`, `platform.audit.read`                                                                                                                                                                |

`organization.delete` is intentionally absent. Tenant closure is a separately confirmed, delayed,
recoverable platform workflow with retention/legal checks.

### Default role grants

Legend: `O` = organization, `B` = assigned branches, `S` = self/assigned records, `C` = customer's
own data, `G` = one allowlisted gateway action after channel policy, `—` = no default grant.

| Permission group                                        | Owner            | Manager                 | Secretary                   | Provider                   | Customer                         | AI Receptionist                          |
| ------------------------------------------------------- | ---------------- | ----------------------- | --------------------------- | -------------------------- | -------------------------------- | ---------------------------------------- |
| `organization.read`                                     | O                | O                       | —                           | —                          | —                                | G (public projection only)               |
| `organization.settings.manage`, billing                 | O                | —                       | —                           | —                          | —                                | —                                        |
| `branches.read`                                         | O                | B                       | B                           | B                          | G (public projection)            | G (public projection)                    |
| `branches.manage`                                       | O                | B                       | —                           | —                          | —                                | —                                        |
| `staff.read`                                            | O                | B                       | B                           | B                          | G (public projection)            | G (public projection)                    |
| `staff.manage`                                          | O                | B                       | —                           | —                          | —                                | —                                        |
| `roles.manage`                                          | O                | —                       | —                           | —                          | —                                | —                                        |
| `services.read`                                         | O                | B                       | B                           | B                          | G (public catalog)               | G (public catalog)                       |
| `services.manage`                                       | O                | B                       | —                           | —                          | —                                | —                                        |
| `schedules.read`                                        | O                | B                       | B                           | S                          | —                                | G (availability projection)              |
| `schedules.manage`                                      | O                | B                       | —                           | S                          | —                                | —                                        |
| `customers.read`                                        | O                | B                       | B                           | S                          | C                                | G (verified customer projection)         |
| `customers.write`                                       | O                | B                       | B                           | S (service notes excluded) | C (limited profile fields)       | G (verified limited fields)              |
| `customers.export`, archive                             | O                | B (export policy-gated) | —                           | —                          | C (data request workflow)        | —                                        |
| `consent.read`, record                                  | O                | B                       | B                           | S                          | C                                | G (explicit purpose workflow)            |
| `appointments.availability.read`                        | O                | B                       | B                           | S                          | G                                | G                                        |
| `appointments.read`                                     | O                | B                       | B                           | S                          | C                                | G (verified customer only)               |
| `appointments.create`                                   | O                | B                       | B                           | S                          | C                                | G                                        |
| `appointments.reschedule`, cancel                       | O                | B                       | B                           | S (assigned/policy)        | C                                | G (bound confirmation)                   |
| `appointments.status.transition`                        | O                | B                       | B (check-in/no-show policy) | S                          | C (check-in policy only)         | G (narrow policy only)                   |
| `appointments.status.correct`                           | O                | B (explicit grant)      | —                           | —                          | —                                | —                                        |
| `appointment_records.read`, `appointment_records.write` | O                | B (sensitivity policy)  | —                           | S                          | C (approved customer projection) | —                                        |
| `resources.read`                                        | O                | B                       | B                           | B                          | —                                | G (availability only)                    |
| `resources.manage`                                      | O                | B                       | —                           | —                          | —                                | —                                        |
| waitlist and slot offers                                | O                | B                       | B                           | S (assigned service)       | C                                | G                                        |
| `messages.read`, send                                   | O                | B                       | B                           | S (assigned customer)      | C                                | G (approved transactional messages only) |
| `message_templates.manage`                              | O                | B                       | —                           | —                          | —                                | —                                        |
| `conversations.read`, handoff                           | O                | B                       | B                           | S                          | C                                | G (current conversation/handoff only)    |
| `recordings.read`                                       | O (policy-gated) | B (policy-gated)        | —                           | S (policy-gated)           | C (policy/legal workflow)        | —                                        |
| `knowledge.read`                                        | O                | B                       | B                           | B                          | —                                | G (published retrieval only)             |
| `knowledge.manage`, `ai.configure`                      | O                | B                       | —                           | —                          | —                                | —                                        |
| `ai.actions.execute`                                    | —                | —                       | —                           | —                          | —                                | G (service principal)                    |
| `reports.read`                                          | O                | B                       | B (operational subset)      | S                          | C (own history)                  | —                                        |
| `imports.manage`                                        | O                | O                       | —                           | —                          | —                                | —                                        |
| `exports.manage`                                        | O                | O                       | —                           | —                          | —                                | —                                        |
| `audit.read`                                            | O                | B (branch-filtered)     | —                           | —                          | C (own activity export)          | —                                        |
| `provider_credentials.manage`                           | O                | —                       | —                           | —                          | —                                | —                                        |
| `predictions.read`                                      | O                | B                       | B                           | S                          | —                                | —                                        |
| `predictions.run`                                       | O                | B                       | —                           | —                          | —                                | —                                        |
| `predictions.configure`                                 | O                | —                       | —                           | —                          | —                                | —                                        |
| `predictions.feedback`                                  | O                | B                       | B                           | S                          | —                                | —                                        |

The Customer and AI Receptionist columns describe capability-policy defaults, not tenant Membership
roles. Exact read projections remain data-classification aware. Appointment records and recordings
are never exposed merely because an actor can read an Appointment.

Prediction scopes filter both the displayed derived artifact and every source projection used to
compute it. A Manager's branch scope cannot run an organization-wide feature job and then infer
other branches from its aggregate. Demand and staffing artifacts persist effective evidence scope
(`BRANCH_SERVICE`, `BRANCH`, or `ORGANIZATION`) independently from their target branch. Assigned-
branch projection and feedback reject organization-sourced artifacts even when an Owner generated
them with a branch target; SELF never covers branch aggregate evidence. Evaluation and drift
projections apply the same source-coverage rule. Secretary and Provider defaults are read/feedback
only. Feedback does not authorize recomputation or mutation. JorMall Super Admin has no default
tenant prediction permission; support access remains explicit, scoped, reason-bearing and audited.

### JorMall Super Admin

Super Admin has platform permissions only by default. Tenant access requires a time-bound
PlatformSupportAccess record naming target Organization, reason/ticket, requested scopes, approver
when policy requires, and expiry. Entering, using, and leaving support mode emits platform and
tenant audit evidence and a visible banner. Support mode never exposes provider secret plaintext.

## 5. Authentication and session controls

- Use a maintained identity/session library or external identity provider; do not store custom
  password hashes or implement authentication cryptography.
- Cookies are Secure, HttpOnly, SameSite Lax/Strict as flow permits, narrowly scoped, rotated after
  authentication/privilege changes, and revoked on membership suspension.
- State-changing browser requests require same-origin validation and CSRF protection where cookie
  semantics permit cross-site requests.
- Sensitive actions require recent authentication and optionally MFA based on role/risk.
- Session selection of an Organization records Membership ID, but authorization revalidates active
  membership and grants rather than trusting stale session claims.

## 6. Provider credentials, encryption, and secrets

- Production secrets come from a managed secret store. No real secret appears in source, image
  layers, client bundles, CI logs, or telemetry.
- ExternalProviderCredential uses envelope encryption with a managed KMS key. Store ciphertext,
  nonce/algorithm metadata produced by the approved library, key version, scope, creator, rotated
  time, and revoked time.
- Decryption occurs only inside the authorized provider adapter and plaintext lifetime is minimized.
- Searchable sensitive identifiers use a reviewed normalization and keyed-hash strategy when
  necessary; do not invent cryptographic primitives.
- Key rotation and provider credential rotation are operationally tested before production launch.

## 7. Webhooks and idempotency

1. Capture the raw request bytes under a strict body-size and time limit.
2. Select the candidate provider configuration from a non-secret route/account identifier.
3. Verify signature and timestamp/replay window with the provider's official library/specification.
4. Resolve tenant from verified account/number mapping, never payload claims alone.
5. Persist a deduplicated ProviderWebhookEvent and acknowledge within the provider deadline.
6. Process asynchronously with a tenant-bound consumer and monotonic state transitions.

Invalid signatures receive no data-dependent detail. Duplicate valid events return success without
repeating effects.

Phase 5B website routing uses a signed installation capability with a dedicated public key and an
opaque signed session capability with a random nonce. Neither contains tenant or entity database
IDs. A narrow `jormall_channel_router` role resolves the key or nonce; forced RLS and an ordinary
tenant transaction then reload active organization, exact origin, session/customer binding, prompt
policy, and conversation state. Redis rate limiting fails closed. WhatsApp and voice use
`jormall_webhook_router` only after raw-body signature and replay-window validation and resolve the
organization from ProviderConnection, never customer/model text.

## 8. Consent, data classification, and audit

- Data is classified public, internal, confidential, or restricted. Appointment records, recordings,
  credentials, and sensitive notes are restricted.
- Consent records capture subject, purpose, channel, exact text/version, status, source, actor,
  timestamp, and evidence. Withdrawal is a new linked record.
- Call recording begins only after provider state and explicit consent policy agree; unknown means
  not permitted.
- AuditEvent is append-only and records actor, tenant/platform context, action, target,
  authorization decision, request/correlation, source channel, result, timestamp, and safe change
  metadata.
- Audit access is itself audited. Tamper-evidence, retention, export, and partition strategy are
  defined before production data.

## 9. Rate limiting and abuse defense

Rate limits use layered keys (IP/network, channel identity, tenant, customer/contact, and action)
with stricter policies for login, verification, availability scraping, booking, AI actions, imports,
and provider sends. Limits return stable errors and do not reveal tenant/customer existence.
Expensive model or provider calls have tenant budgets, concurrency limits, circuit breakers, and
human fallback.

## 10. Required security tests

- Repository, use-case, endpoint, cache, object-key, queue, search, and AI retrieval cross-tenant
  denial.
- RLS tests using the actual application database role, including missing context and pooled
  connection reuse.
- Role escalation, branch-scope, self-scope, suspended membership, stale session, and support
  expiry.
- IDOR fuzzing with valid IDs from a second tenant and indistinguishable not-found responses.
- CSRF/origin, session fixation/rotation, rate limits, webhook invalid
  signature/replay/duplicate/order.
- Secret scanning and checks that server-only values cannot enter browser bundles or logs.
- Prompt-injection and poisoned-knowledge attempts against every AI tool/disclosure boundary.
- Concurrent booking, idempotency-key mismatch, worker redelivery, and outbox crash recovery.
- Predictive job/prediction/model and typed recommendation-Prediction IDOR and RLS denial;
  cross-tenant source canaries; branch/self aggregate non-inference; future-event and
  mutable-configuration leakage fixtures; prohibited-feature projection tests; capability
  disable/rollback races; confirmation and live scheduling revalidation for every accepted reflow.

No phase can be accepted until its tenant-isolation matrix passes against PostgreSQL, not only
mocks.
