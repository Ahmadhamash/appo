# JorMall Product Specification

Status: Architecture baseline  
Audience: Product, engineering, security, operations, and implementation partners  
Scope of this revision: Product definition through the eight-phase roadmap; no feature
implementation

## 1. Product vision

JorMall is a Jordan-first, multi-tenant appointment and AI-receptionist platform for clinics,
salons, service businesses, and stores. JorMall operates the platform. Each subscribing business is
an Organization whose customers, staff, branches, knowledge, conversations, communications,
appointments, reports, and configuration are isolated from every other Organization.

The product combines reliable appointment operations with conversational booking. A customer may
book on a public page or talk to a website, WhatsApp, or voice assistant; each channel invokes the
same authorization, scheduling, and audit-controlled use cases.

## 2. Product principles

1. Tenant safety is a product capability, not only an implementation detail.
2. Scheduling correctness wins over apparent availability and optimistic UI behavior.
3. Human staff and AI channels share one source of truth and one action boundary.
4. AI recommends or executes constrained actions; it never becomes an alternate backend.
5. Arabic and English, including RTL behavior and Jordanian Arabic, are designed together.
6. Consent, attribution, and auditability are recorded at the moment an action occurs.
7. Reliable asynchronous delivery is preferable to synchronous best-effort integrations.
8. A modular monolith is the default until measured operational requirements justify extraction.

## 3. Actors

| Actor                     | Description                                                 | Trust boundary                                                                         |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| JorMall Super Admin       | Operates the platform and supports tenants                  | Platform identity; tenant access is exceptional, explicit, reason-bound, and audited   |
| Organization Owner        | Accountable business administrator                          | Authenticated membership in exactly scoped organizations                               |
| Organization Manager      | Runs assigned branches and operational teams                | Authenticated membership with branch constraints                                       |
| Secretary / Receptionist  | Manages daily customer and appointment operations           | Authenticated membership with operational permissions                                  |
| Doctor / Service Provider | Delivers assigned services and manages own schedule/records | Authenticated membership, normally constrained to self/assigned appointments           |
| Customer                  | Books and manages their own appointments and consent        | Authenticated customer or short-lived signed channel identity                          |
| AI Receptionist           | Conversational agent acting through approved tools          | Service principal plus verified customer/channel context; no direct persistence access |

One person may have memberships in multiple Organizations. Authorization is evaluated independently
for each membership. Customer identities are tenant-owned CRM records; they are not automatically
shared between Organizations even if contact details match.

## 4. Booking and service channels

- Public, mobile-first booking page.
- Embeddable website chatbot using a signed tenant/channel configuration.
- WhatsApp AI through verified provider webhooks.
- Inbound and outbound AI phone calls with consent and recording controls.
- Manual booking by authorized organization staff.

All channels call shared application use cases. They may differ in authentication, presentation, and
conversation state, but never in scheduling invariants.

## 5. Core capabilities

### Platform and organization administration

- Create, suspend, and configure Organizations and branches.
- Manage staff memberships, role grants, branch scope, and service assignments.
- Explicitly audit platform support access and sensitive configuration changes.

### Customer relationship management

- Tenant-scoped customer profiles, identifiers, preferences, notes, consent records, and timeline.
- Source attribution from initial contact through booked and completed appointment.
- Safe duplicate detection and imports without cross-tenant matching.

### Scheduling operations

- Branch hours, staff availability, time off, service duration/buffers, and resource requirements.
- Atomic create, reschedule, and cancel operations with idempotency and append-only history.
- Today view, operational states, records, waitlist, expiring slot offers, and conflict prevention.
- UTC persistence with availability evaluated in the branch/organization IANA timezone.

### Communications

- Durable outbound Message, MessageAttempt, and Outbox processing.
- SMS and WhatsApp adapters with delivery status and idempotent webhook ingestion.
- Templates, locale selection, quiet-time policy, opt-out, and consent enforcement.

### AI receptionist and copilots

- Tenant-isolated knowledge ingestion and retrieval.
- Voice, WhatsApp, and website conversations in English and Jordanian Arabic.
- Allowlisted Action Gateway tools for availability, booking, rescheduling, cancellation, handoff,
  summaries, and missed-call recovery.
- Staff assistance, briefings, gap/waitlist recommendations, analytics explanations, and call
  quality.

### Reporting and intelligence

- Operational and attribution reports based on auditable source events.
- No-show risk, demand forecasting, staffing suggestions, schedule reflow, and recommendations with
  confidence, rationale, and human override.

## 6. Localization and time

- Every user-facing string has English (`en`) and Arabic (`ar`) translations.
- Arabic surfaces render right-to-left; numbers, phone numbers, dates, and mixed-direction
  identifiers receive explicit bidirectional handling.
- Jordanian Arabic is an AI conversation locale, not a substitute for formal Arabic UI copy.
- Organizations configure an IANA timezone. `Asia/Amman` is supported from Phase 1. Branches may
  override it later when an Organization spans timezones.
- Instants are stored in UTC. Local date/time input is converted using the selected timezone and
  must explicitly handle invalid or ambiguous daylight-saving times.

## 7. Non-functional requirements

### Security and privacy

- Tenant isolation at application, database, cache, queue, object storage, search, and observability
  boundaries.
- Least privilege, secure sessions, rate limiting, CSRF defense where applicable, encrypted provider
  credentials, webhook verification, and immutable sensitive-action audits.
- Consent purpose, source, status, and withdrawal are queryable. Recording status is never inferred.
- Data retention, deletion, export, and legal-hold policies are configuration-backed and auditable.

### Reliability

- Appointment conflict invariants are enforced in PostgreSQL under concurrency.
- Booking, rescheduling, cancellation, webhook intake, jobs, and AI actions are idempotent.
- Network side effects are delivered from a transactional outbox with bounded retry and dead-letter
  handling.
- Provider failures degrade to visible operational states and human handoff, never silent loss.

### Performance targets

Targets are validated and tuned per phase rather than treated as guarantees in this architecture
run:

- Dashboard read p95 below 500 ms under the initial capacity model.
- Availability search p95 below 750 ms for a 14-day range under the initial capacity model.
- Booking mutation p95 below 1.5 seconds excluding provider communications.
- Webhook acknowledgement below provider timeouts by persisting first and processing asynchronously.

### Accessibility and quality

- WCAG 2.2 AA is the product target for web surfaces.
- Keyboard, screen reader, contrast, focus, Arabic layout, and mobile viewport checks are part of
  acceptance.
- Structured logs, traces, metrics, and correlation IDs cover web, worker, provider, and AI actions.

## 8. Success measures

- Booking completion and channel conversion rate.
- Appointment conflict rate (target: zero committed double bookings).
- No-show, cancellation, and recovered-slot rate.
- Message delivery and webhook-processing success rate.
- AI containment, successful tool execution, handoff rate, unsafe-action rejection, and call
  quality.
- Staff time saved without reduced customer satisfaction or increased correction rate.
- Tenant-isolation security tests passing on every release.

## 9. Out of scope for the architecture run

- Identity provider selection or login implementation.
- Prisma product models or Phase 1 migrations.
- Organization, branch, staff, service, or appointment user interfaces.
- Live SMS, WhatsApp, telephony, model, vector database, payment, or email integrations.
- Production deployment infrastructure and capacity commitments.
