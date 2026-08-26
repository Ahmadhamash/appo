# Architecture Decision Records

ADRs capture decisions whose consequences extend across modules or phases. Accepted ADRs are
normative. Supersede an ADR with a new record; do not rewrite its historical decision.

| ADR                                                                 | Decision                                     | Status   |
| ------------------------------------------------------------------- | -------------------------------------------- | -------- |
| [0001](0001-modular-monolith-and-workspace.md)                      | Modular monolith and pnpm workspace          | Accepted |
| [0002](0002-tenant-isolation.md)                                    | Explicit tenant scoping plus PostgreSQL RLS  | Accepted |
| [0003](0003-postgresql-prisma-and-migrations.md)                    | PostgreSQL, Prisma, and explicit migrations  | Accepted |
| [0004](0004-transactional-outbox-and-workers.md)                    | Transactional outbox and BullMQ workers      | Accepted |
| [0005](0005-timezones-and-localization.md)                          | UTC instants, IANA timezones, English/Arabic | Accepted |
| [0006](0006-identity-and-rbac.md)                                   | Externalized identity and scoped RBAC        | Accepted |
| [0007](0007-ai-action-gateway.md)                                   | AI Action Gateway                            | Accepted |
| [0008](0008-scheduling-concurrency.md)                              | PostgreSQL-enforced scheduling conflicts     | Accepted |
| [0009](0009-better-auth-database-sessions.md)                       | Better Auth with database sessions           | Accepted |
| [0010](0010-phase-3-resource-allocation.md)                         | Deterministic Phase 3 resource allocation    | Accepted |
| [0011](0011-shared-ai-channel-transports.md)                        | Shared verified AI customer transports       | Accepted |
| [0012](0012-authorized-copilot-and-semantic-metrics.md)             | Authorized Copilot and semantic metrics      | Accepted |
| [0013](0013-staged-imports-attribution-and-reproducible-reports.md) | Staged imports and reproducible reports      | Accepted |
| [0014](0014-tenant-local-deterministic-predictive-intelligence.md)  | Tenant-local deterministic predictions       | Accepted |
| [0015](0015-sector-portals-and-gym-operations.md)                   | Sector profiles and gym operations           | Accepted |
| [0016](0016-gym-trainee-identity-and-portal.md)                     | Private gym trainee identity and portal      | Accepted |
