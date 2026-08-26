# ADR 0002: Explicit tenant scoping plus PostgreSQL RLS

- Status: Accepted
- Date: 2026-08-23

## Context

A broken filter can expose one Organization's customers, knowledge, appointments, or conversations
to another. Application-only filtering is vulnerable to missed clauses; database-only row-level
security does not cover caches, queues, search, object storage, authorization, or accidental
privileged roles.

## Decision

Every tenant-owned table carries `organization_id`. Repositories require TenantContext and issue
explicit tenant-scoped queries. Composite tenant-aware foreign keys prevent cross-tenant relations.
Normal web and worker PostgreSQL roles also enforce RLS using transaction-local context that is set
and cleared by the database adapter.

Browser-supplied tenant IDs are not trusted. Context resolves from verified Membership or signed
channel routing. Platform support uses a separate, time-bound, reasoned, audited override path.
Tenant prefixes/filters are equally mandatory in Redis, queues, search/vector retrieval, object
storage, analytics, and telemetry.

## Consequences

- Isolation has defense in depth and can be tested at each boundary.
- Schemas and repository signatures are more verbose; tenant-aware compound constraints are
  required.
- All database work must occur in correctly initialized transactions, and pooling context-bleed
  tests become mandatory.
- Platform-wide reporting and operations require deliberate privileged paths rather than convenient
  unscoped queries.

## Alternatives considered

- Application filters only: rejected because one omitted predicate becomes a data breach.
- RLS only: rejected because it cannot express the full authorization model or protect non-database
  systems.
- Database/schema per tenant: deferred; it improves physical isolation but creates migration,
  connection, analytics, and operational overhead beyond the initial needs.
