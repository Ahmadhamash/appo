# Phase 4 communications operations

## Runtime shape

Run PostgreSQL and Redis, apply migrations, then start `pnpm dev`. Turbo starts the Next.js web
process and the BullMQ worker together. Required local values are `DATABASE_URL`, `REDIS_URL`,
`AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL`, and
`MOCK_WHATSAPP_WEBHOOK_SECRET`. All sample values must remain local-only.

The relay claims at most 25 available events per pass with `FOR UPDATE SKIP LOCKED`. Claims older
than two minutes are recoverable. Jobs use OutboxEvent IDs, four attempts, bounded exponential
backoff, concurrency 8, and idempotent provider keys. PostgreSQL remains authoritative; Redis may be
flushed and rebuilt from unprocessed/stale outbox rows.

## Mock lifecycle proof

After `pnpm db:seed`, run `pnpm --filter @jormall/web prove:phase4` while web and worker are
running. The script queues one consented WhatsApp appointment confirmation, waits for the mock
adapter to record `SENT`, POSTs a raw-body signed delivery webhook to the running web process, then
waits for the inbox worker to record `DELIVERED`. It prints IDs and states only, never the message
body or secret.

The mock webhook contract uses `x-jormall-timestamp` (Unix seconds) and
`x-jormall-signature: sha256=<HMAC-SHA256(timestamp.rawBody)>`. Requests outside five minutes,
invalid signatures, oversized/non-JSON bodies, duplicate provider event IDs, inactive connections,
and unallowlisted secret references are rejected or idempotently acknowledged as appropriate.

## Production boundary and performance assumptions

No production SMS or WhatsApp adapter is enabled. ProviderConnection rows select only local mock
adapters and reference an environment variable rather than storing a secret. Production rollout
requires a reviewed credential vault/envelope-encryption integration and provider-specific signing,
timeouts, rate limits, receipt ordering, and reconciliation.

The initial target is sustained low hundreds of outbox events per minute per worker process. Scale
worker replicas horizontally after measuring Redis latency, PostgreSQL claim duration, provider rate
limits, and dead-letter growth. Message bodies are intentionally absent from logs, queue payloads,
and outbox payloads; authorized tenant reads fetch them from PostgreSQL.
