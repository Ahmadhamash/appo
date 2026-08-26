# JorMall Platform

JorMall is a greenfield, multi-tenant appointment and AI-receptionist SaaS for clinics, salons,
service businesses, and stores. Implemented phases cover tenant identity/RBAC, CRM and appointment
operations, concurrency-safe resource scheduling/waitlists, mock reliable communications, safe AI
customer channels, the permission-scoped staff copilot, imports/audit/reporting, and the Phase 8
deterministic predictive-assistance layer. Phase 8 adds tenant-local no-show and observed-demand
baselines, staffing/reflow/recommendation suggestions, refusal thresholds, backtesting, drift,
feedback, and PostgreSQL/Redis workers. It does not claim production predictive validity, a live
messaging/telephony provider, a production AI model, or automatic schedule/staffing changes.

## Prerequisites

- Node.js 24
- pnpm 10.33 (Corepack is recommended)
- Docker with Docker Compose

## Start locally

1. Enable the pinned package manager: `corepack enable`.
2. Install dependencies: `pnpm install --frozen-lockfile`.
3. Copy `.env.example` to `.env` and replace every `replace-*` placeholder.
4. Start PostgreSQL and Redis: `pnpm infra:up`.
5. Generate the Prisma client and apply reviewed migrations: `pnpm db:generate` then
   `pnpm db:migrate:deploy`.
6. Optionally set `DEV_SEED_PASSWORD` locally and run `pnpm db:seed`. Seed identities use only the
   reserved `.invalid` domain and the locally supplied development password.
7. Start the web and worker development processes: `pnpm dev`.

The web scaffold is available at `http://localhost:3000/en` and `http://localhost:3000/ar`.

## Quality commands

| Command                 | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `pnpm format:check`     | Verify repository formatting                                   |
| `pnpm lint`             | Run ESLint with strict TypeScript and Next.js rules            |
| `pnpm lint:boundaries`  | Enforce workspace dependency direction and no-barrel rules     |
| `pnpm typecheck`        | Type-check every workspace package                             |
| `pnpm test`             | Run Vitest unit tests                                          |
| `pnpm test:coverage`    | Run unit tests with V8 coverage                                |
| `pnpm test:integration` | Run tenant/security integration tests against PostgreSQL       |
| `pnpm test:e2e`         | Run identity, RTL, customer, calendar, and Today browser tests |
| `pnpm build`            | Build production-capable applications                          |

Read [the product specification](docs/product-spec.md), [architecture](docs/architecture.md),
[Phase 5A operations](docs/phase-5a-operations.md),
[Phase 5B operations](docs/phase-5b-operations.md),
[Phase 8 predictive operations](docs/phase-8-predictive-operations.md), and
[roadmap](docs/roadmap.md) before extending the product.
