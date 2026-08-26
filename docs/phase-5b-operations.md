# Phase 5B AI Customer Channels Operations

Status: implemented with deterministic local/mock providers; no production provider is connected

## Delivered paths

| Channel  | Ingress                                      | Egress                                         | Trusted tenant source                                    | Local behavior                                                      |
| -------- | -------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Website  | `/api/ai/widget/session`, `/turn`, `/verify` | streamed NDJSON through the embed script       | signed public config, opaque session nonce, exact Origin | deterministic mock model; mock verification only outside production |
| WhatsApp | `/api/webhooks/whatsapp/[connectionId]`      | Phase 4 Message/Outbox/BullMQ pipeline         | signature-verified active ProviderConnection             | `MOCK_WHATSAPP`; optional fixture-only voice-note transcription     |
| Voice    | `/api/webhooks/voice/[connectionId]`         | provider-neutral telephony port through BullMQ | signature-verified dialed-number ProviderConnection      | `MOCK_VOICE`; callback events, no live audio/media                  |

Every operation uses `SharedAIChannelCoordinator` and the existing Action Gateway. There is no
channel-owned booking implementation and no AI import path to Prisma or `@jormall/db`.

## Local configuration

Set non-production values for the existing database/Redis/auth variables and these Phase 5B values:

```dotenv
NEXT_PUBLIC_APP_URL=http://localhost:3000
WIDGET_SIGNING_SECRET=replace-with-at-least-32-random-characters
MOCK_WHATSAPP_WEBHOOK_SECRET=replace-with-a-local-only-random-secret
MOCK_VOICE_WEBHOOK_SECRET=replace-with-a-different-local-only-random-secret
```

Then run:

```text
pnpm install --frozen-lockfile
pnpm infra:up
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev
```

`pnpm dev` runs web and worker together. The worker is required for WhatsApp, voice, missed-call
recovery, and outbound confirmation delivery. Redis is required for both the worker and fail-closed
public widget rate limiting.

## Website installation

1. Sign in as an Organization Owner and open `/en/dashboard/ai-channels` or the Arabic equivalent.
2. Create an installation with exact HTTPS origins (localhost HTTP is accepted only for local
   development), bilingual display names, and brand colors.
3. Copy the generated script tag before the host page's closing `body` tag.
4. If the host uses CSP, allow the JorMall origin in `script-src`, `style-src`, and `connect-src`.
5. Confirm English, Arabic RTL, keyboard focus, mobile layout, streaming, and rate-limit behavior.

The installation token contains a dedicated public key, version, timestamps, and signature. The
session capability contains locale, origin, timestamps, a random nonce, and signature. Neither
contains an Organization, Customer, Appointment, Provider, Conversation, or session-row ID.

The local verification form accepts code `000000` only when `NODE_ENV` is not `production`. In
production the endpoint rejects every attempt until a reviewed identity-verification adapter is
installed.

## Mock WhatsApp replay

Create a signed raw webhook body matching the Zod schema, using the seeded `MOCK_WHATSAPP`
connection and `MOCK_WHATSAPP_WEBHOOK_SECRET`. `message.received` accepts either text or one
fixture-only voice note with `mediaReference` and `mockTranscript`. The worker:

1. deduplicates InboxEvent by provider connection/event ID;
2. resolves the customer from the verified sender within the routed tenant;
3. applies opt-out and current consent/preference state;
4. invokes the shared coordinator and Action Gateway;
5. creates Message and OutboxEvent atomically; and
6. sends through the clearly labeled mock adapter.

No media URL is downloaded and no real WhatsApp message is sent.

## Mock voice replay

The seeded `MOCK_VOICE` connection has a deterministic unique mock dialed number. Submit signed
events in lifecycle order: `call.started`, `call.answered`, partial/final transcripts, optional
barge-in/silence/recording-consent events, handoff, and disconnect/completion. Final transcript
events run the shared coordinator. Partials are stored but cannot invoke tools. Low-confidence voice
confirmation asks again.

Recording requires a persisted `recording.consent_granted` event. Consent is checked before the
adapter call and again before CallRecording is committed. The local adapter stores evidence only; it
creates no media and uploads nothing.

Missed calls create a recovery message only when the matched customer has current appointment
message consent, an enabled WhatsApp/SMS preference, an active connection, and the localized
template. The outbox deduplication key is stable per call.

## Mock end-to-end proof

`tests/integration/ai-foundation.integration.test.ts` replays the same seven-step scenario for
website, WhatsApp, and voice contexts:

1. list a service;
2. check availability;
3. propose a booking and require confirmation;
4. consume explicit confirmation and create exactly one appointment;
5. return the gateway-confirmed result;
6. propose/confirm a reschedule; and
7. request handoff and suppress the next AI reply.

`tests/integration/worker-communications.integration.test.ts` additionally proves WhatsApp
voice-note ingress through Message/Inbox/Outbox/BullMQ to `SENT`, voice partial/final transcript
processing, call summary creation, duplicate suppression, Phase 4 retry, and permanent voice
provider dead-letter behavior. It also proves four bounded timeout attempts reuse one Action Gateway
idempotency key before normalized dead-letter state. Replay fixtures live under
`tests/fixtures/ai-channels`.

## Production readiness gates

The shared orchestration, Action Gateway, PostgreSQL/RLS data model, outbox routing, confirmation,
takeover suppression, signed widget configuration, opaque session routing, origin enforcement, rate
limiting, bilingual widget shell, and deterministic adapters are production-shaped and tested.

Production channel activation still requires:

- a reviewed production model adapter and prompt/evaluation thresholds;
- real WhatsApp credentials, official signature contract tests, template/session-window policy,
  provider media download, and production transcription;
- a telephony trunk/number adapter, media streaming or callback SLA measurements, real barge-in and
  transfer tests, emergency fallback, and regional availability evidence;
- encrypted recording object storage, KMS, retention/deletion policy, and recording access review;
- a production website identity-verification adapter instead of the disabled mock verifier;
- managed Redis/PostgreSQL, proxy/CSP configuration, observability alerts, load tests, red-team
  review, and per-channel operational kill switches.

Never label the mock provider rows or deterministic model as production integrations.

## Performance assumptions

- Widget session/turn bodies are capped at 16 KiB and customer turns at 5,000 characters.
- One widget session is limited to 30 turns/minute and one public IP to 120 turns/minute; session
  creation is 20/minute per public key/origin/IP and mock verification is 5/10 minutes.
- The outbox relay claims 25 rows at a time; BullMQ worker concurrency is eight with four bounded
  attempts for retryable work.
- Knowledge retrieval remains the Phase 5A bounded PostgreSQL lexical search. No slot rows, vector
  service, realtime process, or media buffer is introduced.
- These are conservative functional defaults, not certified capacity. Establish p95/p99 latency,
  queue age, provider timeout, Arabic recognition, and concurrent-call limits in staging before a
  production provider is enabled.
