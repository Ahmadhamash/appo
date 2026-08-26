# JorMall Engineering Rules

These rules apply to the entire repository. They are permanent unless a reviewed ADR explicitly
replaces one of them.

## Product and scope

- JorMall is a greenfield product. Never copy, import, modify, or depend on `cal.diy` or a Cal.com
  fork.
- Work in small phase-sized changes. Do not pull later-roadmap capabilities into an earlier phase.
- The documents in `docs/` and accepted ADRs are the current source of architectural truth. Update
  them in the same change when a decision changes.
- Do not claim an external provider works unless a real integration test proves it. Label mock,
  fake, and sandbox adapters clearly.

## Architecture and dependencies

- Keep a modular monolith: `apps/*` are composition and delivery; business rules live in use-case
  modules under `packages/domain`; infrastructure implements ports owned by the domain.
- Dependency direction is apps -> adapters -> domain/contracts. `packages/domain` must not import
  framework, database, queue, HTTP, UI, or AI SDK code.
- React components contain presentation behavior only. Repositories contain persistence behavior
  only. Put workflows and policies in explicit use-case/service modules.
- AI code must not import `@jormall/db` or a generated Prisma client.
- Import internal packages through explicit export subpaths. Do not add source `index.ts` barrels or
  bare `@jormall/<package>` imports.
- Run `pnpm lint:boundaries` after changing a workspace dependency.
- Document every direct production dependency and its purpose in `docs/dependencies.md`.

## TypeScript and contracts

- Keep TypeScript strict. Do not weaken the shared compiler options.
- Never use `any`, `as any`, non-null assertions, or unchecked browser payloads.
- Prefer type-only imports where a symbol is not used at runtime.
- Validate every external boundary with Zod: HTTP inputs, webhooks, environment, queue payloads,
  imports, and AI tool calls.
- Expose stable structured error codes. Do not branch application logic on human-readable messages.

## Tenancy and authorization

- Never accept the active `organizationId` from an ordinary browser form or request body. Resolve it
  from an authenticated membership or a verified signed public-channel identity.
- Every tenant-owned table must carry `organizationId`. Cross-table relationships use composite
  tenant-aware foreign keys where practical.
- Every repository method requires a tenant context; unscoped tenant-table methods are forbidden.
- Authorize in the application layer and enforce PostgreSQL row-level security as defense in depth.
- Platform super-admin operations use a separate explicit path, require a reason, and always emit an
  immutable audit event.
- Treat existence of an out-of-tenant record as undisclosed; return the same public result as not
  found.
- Add negative cross-tenant tests for every tenant-owned repository and endpoint.

## Database and scheduling

- PostgreSQL is authoritative. Prisma schema changes require reviewed explicit migrations. Never use
  `prisma db push` for shared environments.
- Never edit generated Prisma files. Regenerate with `pnpm db:generate`.
- Store instants in UTC. Evaluate business hours, availability, and calendar labels in the
  configured IANA organization/branch timezone. Do not store timezone-less appointment timestamps.
- Protect against double booking in a database transaction with database constraints; a UI check is
  never sufficient.
- Appointment mutations are idempotent. State changes go through the documented state machine and
  append history in the same transaction.
- Side effects use the transactional outbox. Do not send network messages inside a database
  transaction.

## Security, privacy, and AI

- Never commit secrets or real credentials. Public environment variables must never contain secrets.
- Use established identity/session libraries and provider KMS/envelope encryption; do not implement
  passwords or cryptography directly.
- Verify webhook signatures against the raw request body before parsing, and deduplicate all inbound
  provider events.
- Track consent, recording status, purpose, source, timestamp, and withdrawal explicitly.
- AI may read curated context and execute allowlisted Action Gateway tools only. It has no database,
  repository, queue, or provider credential access.
- Every AI action carries tenant, actor, channel, authorization decision, idempotency key, and audit
  identifiers. The gateway independently re-authorizes all requests.
- Cancellation, identity changes, bulk messaging, disclosure of sensitive information, and other
  destructive or high-impact AI actions require explicit, bound, unexpired confirmation.

## UI, accessibility, and language

- Add English and Arabic message-catalog entries for every user-facing string in the same change.
- Treat right-to-left layout as a first-class mode. Prefer logical CSS properties and test both
  directions.
- Build accessible components: semantic HTML, keyboard operation, visible focus, programmatic
  labels, and appropriate contrast are acceptance requirements.

## Tests and completion

- Add tests with every domain rule and regression fix. Never weaken a rule or assertion to make a
  test pass.
- Unit-test domain policies; integration-test PostgreSQL constraints, transactions, RLS, queues, and
  adapters; use Playwright for critical user journeys.
- Every tenant feature requires cross-tenant denial tests. Every concurrent scheduling feature
  requires a deterministic race test.
- Before handing off a change, run `pnpm format:check`, `pnpm lint`, `pnpm lint:boundaries`,
  `pnpm typecheck`, and `pnpm test`. Run relevant database integration and Playwright suites when
  the change touches those paths.
- Stop and report the exact failure if validation does not pass. Never silently skip or dilute a
  required check.
