# AI Architecture and Action Gateway

Status: Mandatory boundary for every model-driven capability

## 1. Core rule

AI is an untrusted reasoning and language layer. It never receives database credentials, imports the
database package, opens repository connections, reads Redis directly, consumes provider credentials,
or emits business events on its own. It can:

1. receive a minimal, tenant-scoped context projection;
2. retrieve published tenant knowledge through a constrained retrieval port;
3. request one registered Action Gateway action;
4. phrase the validated result for the current channel; and
5. hand off to a human when confidence, identity, consent, or policy is insufficient.

Model output, tool names, tool arguments, citations, customer claims, and prompt instructions are
all untrusted until independently validated.

## 2. Components

| Component                   | Responsibility                                                                                     | Prohibited behavior                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Channel adapter             | Normalize website, WhatsApp, voice, and staff-copilot turns; verify channel identity               | Choosing tenant from free-form user/model text                     |
| Conversation orchestrator   | Maintain turn state, locale, budgets, prompt policy, handoff state                                 | Business mutations or direct provider credentials                  |
| Context projector           | Fetch the minimum authorized customer/appointment/public organization projection through use cases | Returning unrestricted records or another tenant's content         |
| Knowledge retrieval service | Search only published, organization-filtered chunks and return provenance                          | Global vector search followed by client-side tenant filtering      |
| Model adapter               | Invoke an approved model with timeouts, data-use configuration, and structured output              | Treating model success as business-action success                  |
| Action Gateway              | Validate, re-authorize, confirm, deduplicate, execute a registered use case, and audit             | Dynamic tool execution or arbitrary SQL/HTTP/queue access          |
| Safety/evaluation layer     | Detect injection, unsafe disclosure/action, quality regressions, and escalation needs              | Silently rewriting a rejected destructive action into another tool |
| Human handoff               | Transfer context summary and reason under access policy                                            | Sending hidden chain-of-thought or unrestricted sensitive context  |

## 3. Gateway request contract

The versioned Zod envelope is scaffolded at `packages/contracts/src/action-gateway.ts`. Every
request contains:

- request ID, occurred-at timestamp, action name, and version;
- Organization and optional Branch context resolved from the verified channel;
- actor ID/type and channel;
- required permission and a prior authorization decision ID for traceability;
- idempotency key;
- structured payload;
- optional confirmation evidence for actions that require it.

The prior decision is not trusted as permission. The gateway reloads current actor/channel state and
re-authorizes immediately before executing the use case.

## 4. Registry and execution pipeline

Tool definitions are compiled code registered at startup. Each definition declares exact name,
versioned input/output schemas, required permission, identity/consent prerequisites, confirmation
policy, rate/budget class, timeout, idempotency semantics, disclosure projection, and use-case
handler. Names supplied by a model cannot select arbitrary functions.

For each request the gateway:

1. validates envelope and registered action/version;
2. verifies tenant and channel context and binds actor/customer identity;
3. parses action input with the action-specific Zod schema and rejects unknown fields;
4. reloads relevant authoritative records using a tenant-bound query use case;
5. evaluates permission, branch/self scope, consent, rate limit, and channel policy;
6. validates required confirmation against the canonical action summary;
7. reserves the idempotency key and matching input fingerprint;
8. executes one application use case in its normal transaction boundary;
9. writes AIAction and AuditEvent evidence and returns a disclosure-filtered result; and
10. records safe metrics/traces and a human-handoff reason on controlled failure.

Validation or authorization failure stops the pipeline. The model cannot ask the gateway to weaken a
schema, skip confirmation, or reinterpret a failed action.

## 5. Initial allowlist

Phase 5A implements this provider-neutral allowlist. Phase 5B exposes the same allowlist through
website, WhatsApp, and voice adapters without adding channel-specific tools or business logic.
Integration and evaluation use the deterministic local mock model; no production model is claimed.

### Read-only or public projection

| Action                     | Required policy                                           | Result boundary                                       |
| -------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `get_business_information` | Verified tenant conversation                              | Organization name, currency and timezone              |
| `list_branches`            | Verified tenant conversation                              | Active branch booking-safe projection                 |
| `list_services`            | Verified tenant/optional branch                           | Active service booking-safe projection                |
| `list_providers`           | Verified tenant plus optional branch/service              | Bookable provider names and references                |
| `check_availability`       | Rate-limited tenant channel and validated local window    | Candidate slots only; never a reservation guarantee   |
| `find_customer_safely`     | Tenant lookup plus separately verified conversation owner | Match/ambiguity result; sensitive lookup is redacted  |
| `check_booking_status`     | Verified customer identity and own-customer authorization | Minimum manage-booking projection; no internal record |

### Reversible or operational writes

| Action                  | Required policy                                                   | Confirmation                                              |
| ----------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `create_booking`        | Verified customer, fresh availability, ordinary appointment rules | Explicit canonical booking summary                        |
| `reschedule_booking`    | Own appointment and fresh availability                            | Explicit canonical reschedule summary                     |
| `join_waitlist`         | Verified customer and valid preferences                           | No destructive confirmation in Phase 5A                   |
| `request_human_handoff` | Current trusted conversation                                      | No destructive confirmation; disclose handoff expectation |

### Destructive or sensitive

| Action           | Required policy                                    | Confirmation                                        |
| ---------------- | -------------------------------------------------- | --------------------------------------------------- |
| `cancel_booking` | Own appointment and ordinary cancellation policies | Explicit canonical cancellation summary; single-use |

AI does not receive tools for provider credential management, role grants, data export, recording
access, bulk marketing, customer archival, organization closure, arbitrary report query, messaging,
or raw appointment-record access.

## 6. Confirmation protocol

Natural-language agreement alone is not a database flag. For a confirmation-required action:

1. The server canonicalizes the exact proposed action, tenant, subject, target, material fields,
   consequences, and expiry and calculates a reviewed hash using an established library.
2. The channel displays/speaks a localized summary and issues a short-lived, single-use confirmation
   challenge ID tied to that hash and conversation/actor.
3. The customer/staff response is captured with channel evidence.
4. The gateway consumes the challenge only if action payload hash, actor, tenant, conversation, and
   expiry still match.
5. Any material payload change invalidates confirmation and requires a new summary.

Voice confirmation preserves transcript timestamps and consent policy; low-confidence speech or
ambiguous answers trigger clarification or human handoff. An AI statement that the user confirmed is
not itself evidence.

## 7. Identity and disclosure

Identity assurance is action-specific. Public catalog and availability require no customer identity.
Reading or changing an appointment requires a verified signed manage-booking token or a channel
challenge appropriate to the risk. Phone-number possession alone is not assumed sufficient for
sensitive records.

Tool results are projections designed for the conversational task. Internal IDs, notes, recording
URLs, authorization details, other household/customer records, and provider payloads stay hidden.
Before model invocation, content is minimized; after invocation, output passes deterministic
disclosure and formatting rules.

## 8. Tenant-isolated knowledge

- Ingestion resolves tenant before storing any source, document, chunk, object, or embedding.
- Files are malware/type/size checked; extracted text and metadata are treated as untrusted.
- Publication is explicit and versioned. Draft, failed, revoked, or superseded content is excluded.
- Retrieval query and index enforce Organization ID server-side. Branch/audience/language filters
  are additional intersections, never replacements.
- Returned chunks carry source, version, position, and checksum so answers can be traced.
- Retrieved instructions cannot redefine system policy or call tools. Content is quoted as
  knowledge, not concatenated as privileged instructions.
- Cross-tenant canary documents and poisoned prompt documents are permanent automated tests.
- Phase 5A uses bounded PostgreSQL lexical retrieval over at most ten active, non-quarantined
  chunks; embeddings and external vector infrastructure are deliberately not introduced yet.

## 9. Voice, WhatsApp, and website channels

### Voice

Phase 5B implements provider-neutral signed server callbacks and a deterministic mock telephony
adapter. `apps/realtime` is introduced only if measured turn latency or streaming control requires a
persistent service. The enforced call state machine tracks consent and recording independently.
Barge-in, silence, transcription confidence, Jordanian Arabic, tool latency, provider disconnect,
and human transfer have explicit mock/replay paths. Real media and emergency-provider behavior are
production gates, not mock claims.

### WhatsApp

Only verified raw webhooks enter the conversation pipeline. Provider account/number resolves tenant.
Messages are deduplicated and ordered as safely as provider metadata permits. The adapter obeys
template/session-window/opt-out policy and never interprets delivery callbacks as customer consent.
Phase 5B uses the existing Inbox/Outbox/Message/BullMQ path and a fixture-only voice-note
transcriber; it does not download real media.

### Website chatbot

Embeds use signed, expiring tenant/channel configuration with origin allowlists, strict CSP/frame
policy, rate limits, and no secret in client code. Anonymous conversation tokens are scoped to one
tenant and cannot become authenticated customer identity without verification. The Phase 5B session
capability is opaque with respect to tenant and row identifiers and is routed by a narrow database
role. The included mock verification code is disabled in production.

## 10. Privacy and provider governance

Before a model/provider is approved, document data residency, retention, training/data-use settings,
subprocessors, encryption, deletion, incident process, supported Arabic behavior, tool-call
semantics, rate limits, and fallback. Send only necessary data. Record model/provider/version,
prompt-policy version, tool schema version, token/latency/cost, safety outcome, and trace IDs
without logging full sensitive prompts by default.

Conversation, transcript, recording, summary, embedding, and evaluation retention are separately
configured. Evaluation datasets are de-identified or synthetic unless explicit approval and legal
basis exist.

## 11. Reliability and idempotency

- Model calls have deadlines, bounded retries only for safe transient errors, and tenant budgets.
- Tool retries reuse the original idempotency key; a different payload with the same key is
  rejected.
- Phase 5B derives stable tool idempotency from the signed website request UUID or deduplicated
  WhatsApp/voice provider event. Duplicate provider callbacks are stopped before orchestration.
- Phase 5A serializes the same `(organization, action, idempotency key)` with a PostgreSQL
  transaction advisory lock and also enforces a unique key/fingerprint constraint. The lock covers
  approval validation, the normal use-case transaction, result redaction, audit, and approval
  consumption, so concurrent acceptance cannot execute the mutation twice.
- Long-running actions return a tracked operation reference rather than holding voice turns open.
- Circuit breakers degrade to deterministic FAQs, staff callback, or human handoff.
- An action result comes only from the use case/gateway. The model never announces success from its
  own intent to call a tool.

## 12. Evaluation and release gates

Each language/channel/tool combination has tests for:

- correct tenant/publication retrieval and cross-tenant canaries;
- action selection, schema validity, identity level, permission, confirmation, and idempotency;
- refusal of role changes, raw database access, prompt-policy replacement, arbitrary URL/tool calls,
  sensitive disclosure, and destructive actions without confirmation;
- Jordanian Arabic understanding, mixed Arabic/English names and times, RTL text handoff, and
  date/time clarification;
- hallucination, tool-result faithfulness, handoff correctness, latency, provider failure, and cost;
- adversarial prompt injection from users, knowledge, web content, transcripts, and provider
  metadata.

No AI channel launches from a demo transcript alone. It requires deterministic gateway integration
tests, replayable conversation evaluations, human red-team review, operational dashboards, kill
switches per tenant/channel/action, and a documented fallback.
