# ADR 0003: PostgreSQL, Prisma, and explicit migrations

- Status: Accepted
- Date: 2026-08-23

## Context

JorMall needs transactions, relational integrity, range conflict constraints, RLS, JSON support, and
a typed TypeScript data layer. Some required PostgreSQL features cannot be fully expressed in a
portable ORM schema.

## Decision

Use PostgreSQL as the authoritative database and Prisma 7 with the ESM-first `prisma-client`
generator and PostgreSQL driver adapter. Prisma owns typed schema/client generation and baseline
migrations. Reviewed explicit migration SQL owns PostgreSQL-specific RLS, extensions,
partial/exclusion constraints, functions, and indexes.

Never use `prisma db push` for shared environments. Migrations run as a deployment job and are
tested from empty and prior schema states. Repository interfaces remain domain-owned so Prisma types
do not escape into domain/UI/contracts.

## Consequences

- Type-safe common queries coexist with required PostgreSQL safety features.
- Engineers must review generated migration SQL and maintain integration tests for non-Prisma
  features.
- Generated client code is build output and cannot be edited.
- Schema evolution must follow backward-compatible deployment practices once production begins.

## Alternatives considered

- Portable ORM-only constraints: rejected because scheduling exclusion and RLS are core
  requirements.
- Raw SQL everywhere: rejected because it increases routine mapping/query maintenance and weakens
  shared TypeScript ergonomics.
- NoSQL primary store: rejected because relational integrity and transactional scheduling dominate
  the model.
