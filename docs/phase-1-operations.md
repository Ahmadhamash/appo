# Phase 1–2 local operations and manual verification

Use local-only values; never reuse a production or personal password. The seed refuses to run when
`NODE_ENV=production`, stores Better Auth password hashes rather than plaintext, and uses reserved
`example.invalid` email addresses.

## Start and seed

1. Copy `.env.example` to `.env` and replace every `replace-*` value. If port 5432 is occupied, set
   another `POSTGRES_PORT` and use the same port in `DATABASE_URL`.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm infra:up` and wait for PostgreSQL and Redis to report healthy.
4. Run `pnpm db:validate`, `pnpm db:generate`, and `pnpm db:migrate:deploy`.
5. Set a local `DEV_SEED_PASSWORD` of at least 12 characters, then run `pnpm db:seed`.
6. Run `pnpm dev` and open `http://localhost:3000/en/login` or `http://localhost:3000/ar/login`.

The seed creates `superadmin@example.invalid`, `owner@example.invalid`,
`beauty-owner@example.invalid`, `gym-owner@example.invalid`, `secretary@example.invalid`, and
`provider@example.invalid`. All use the locally supplied seed password. Each development owner
belongs to only its matching Clinic, Beauty Center, or Gym fixture. A single active membership is
selected on the server after sign-in and the tenant switcher is hidden; it is shown only for a user
who has been explicitly granted more than one active membership. Development Clinic A also receives
an Amman branch, a configured service/provider, a local-only customer, and a sample appointment.

## Exact manual checks

1. Sign in as `owner@example.invalid`. Confirm Development Clinic A is selected automatically and no
   organization switch control is shown.
2. Open Settings, Branches, Staff, Roles, and Services. Change the default locale/timezone, add a
   branch, create an invitation, create a custom role using only permissions the owner has, create a
   service, and save a different price/duration for one branch.
3. Copy the invitation link shown in the action result into a private window. Create the invited
   account with a new local-only password. Confirm the same link cannot be accepted a second time.
4. Sign in as `secretary@example.invalid` and manually navigate to `/en/dashboard/settings`. Confirm
   the app returns to Overview with a forbidden message. Open Roles and confirm role creation
   controls are absent.
5. Sign in as `provider@example.invalid`. Confirm staff administration is inaccessible. Provider
   schedule self-scope and unrelated-provider denial are covered by the PostgreSQL integration suite
   until a schedule UI is introduced.
6. Sign in as `superadmin@example.invalid`, open JorMall Admin, enter a reason of at least ten
   characters, and start support for an active organization. Confirm the support banner is visible
   and end support. Inspect `audit_events` to verify STARTED, TENANT_ACCESS, and ENDED entries share
   the support-access ID and reason.
7. From JorMall Admin, suspend an organization. Sign in as one of its members and confirm tenant
   data is blocked immediately. Reactivate it, suspend a membership from Staff, and confirm that
   member loses access on the next request.
8. Run `pnpm test:integration`. It changes valid UUID-style resource IDs across organizations and
   proves PostgreSQL RLS returns no cross-tenant read, update, or delete result.
9. Run `pnpm format:check`, `pnpm lint`, `pnpm lint:boundaries`, `pnpm typecheck`, `pnpm test`,
   `pnpm test:integration`, `pnpm build`, and `pnpm test:e2e` before handing off.
10. As the owner, open **Customers**, create a customer using `079 123 4567`, and confirm its
    profile keeps the original entry while normalizing it for duplicate detection. Record a grant
    and then a linked revocation under Consent history; verify both remain visible.
11. Open **Calendar**, create a pending or confirmed appointment using the seeded branch, service,
    provider, and customer. From the appointment page check in, start, and complete it with a
    fulfillment summary. Confirm the immutable status history is displayed and an internal note is
    shown only in the staff view, never in a public projection.
12. Open **Today operations** and filter by branch, provider, service, and status. Confirm the
    sample appointment is grouped by its Asia/Amman local date. Sign in as the provider and verify
    only that provider's appointments are returned; sign in as the secretary and confirm
    role/settings and restricted record-note actions are denied.
