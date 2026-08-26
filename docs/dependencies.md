# Direct Dependency Register

Every direct production dependency requires an entry here. Versions are pinned in package manifests
and the pnpm lockfile. Transitive packages are reviewed through automated update and security
tooling.

| Dependency                       | Scope                          | Reason                                                                                       |
| -------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| Next.js                          | `apps/web`                     | App Router web delivery, server endpoints, public pages, and production build                |
| React / React DOM                | `apps/web`, `packages/ui` peer | Accessible web composition and rendering                                                     |
| Tailwind CSS / PostCSS adapter   | `apps/web`                     | Design tokens and RTL-capable utility styling without runtime CSS injection                  |
| Zod                              | contracts, config, web         | Runtime validation with inferred TypeScript types at every untrusted boundary                |
| Prisma ORM / Prisma Client       | `packages/db`                  | Typed PostgreSQL access and explicit migration workflow                                      |
| Prisma PostgreSQL adapter / `pg` | `packages/db`                  | Prisma 7 PostgreSQL runtime connection using the supported driver adapter                    |
| dotenv                           | `packages/db`                  | Explicit local `.env` loading required by Prisma 7; production injects environment variables |
| Better Auth                      | `apps/web`                     | Password hashing, database sessions, secure cookies, CSRF checks, and login rate limits      |
| server-only                      | `apps/web`                     | Prevents session and authorization modules from entering browser bundles                     |
| BullMQ                           | `apps/worker`                  | Durable Redis-backed job processing, retry, scheduling, and concurrency controls             |
| ioredis                          | `apps/web`, `apps/worker`      | BullMQ/worker connections and fail-closed distributed public-widget rate limiting            |

Development-only dependencies:

| Dependency                               | Reason                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| TypeScript                               | Strict static checking across all workspaces; pinned to 5.9 until the ESLint parser supports TypeScript 7 |
| ESLint / Next.js ESLint config / globals | Type-aware source, React, accessibility, and framework lint policy                                        |
| Prettier                                 | Deterministic source and documentation formatting                                                         |
| Turborepo                                | Workspace task ordering and caching without changing runtime boundaries                                   |
| Vitest / V8 coverage                     | Fast unit and integration test runner with native TypeScript support                                      |
| Playwright                               | Browser-level English, Arabic RTL, accessibility, and critical booking-flow tests                         |
| tsx                                      | TypeScript worker entrypoint and development-only seed runner; not production bundling                    |
| Node/React/PostgreSQL type packages      | Type declarations for runtime APIs and libraries                                                          |

pnpm build scripts are denied by default. `pnpm-workspace.yaml` explicitly permits only the required
Prisma engines/CLI, esbuild binary, and optional native accelerators used by the queue and import
resolver dependency graph. Additions require review rather than a blanket script allowlist.

`deepmerge-ts` is temporarily overridden to patched 8.0.2 because Prisma 7.9.1 pins vulnerable 7.1.5
([CVE-2026-40345](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)). Prisma validation,
generation, type checking, and build are release gates for the override. Remove it once
`@prisma/config` ships a patched direct dependency.

Adding an SDK for identity, SMS, WhatsApp, telephony, models, vector search, storage, or
observability requires an ADR or provider decision record, a port-owned adapter, credential and
webhook threat review, and a real integration-test plan.
