# ADR 0001: Modular monolith and pnpm workspace

- Status: Accepted
- Date: 2026-08-23

## Context

JorMall spans administration, CRM, scheduling, communications, AI, reporting, and imports. These
capabilities need strong boundaries, but early product behavior and team topology do not justify the
deployment, distributed transaction, schema ownership, and observability cost of microservices.

## Decision

Build a modular monolith in a pnpm workspace. Next.js serves web/UI/HTTP delivery and a separate
worker process consumes durable jobs. Domain modules own rules, use cases, and ports. Infrastructure
packages implement ports; app workspaces are composition roots. Internal dependencies flow toward
pure domain and versioned contracts and are enforced by a repository script.

Create a persistent realtime process only after voice latency/streaming measurements justify it in a
new ADR.

## Consequences

- Cross-module business changes can commit atomically in PostgreSQL.
- Local development, refactoring, tracing, and deployment remain comparatively simple.
- Module boundaries require discipline because process isolation does not enforce them.
- Web and worker may scale independently, but individual domain modules do not initially scale
  alone.
- A later extraction must preserve application contracts and outbox/event boundaries.

## Alternatives considered

- Microservices now: rejected as premature operational and consistency complexity.
- One undifferentiated Next.js application: rejected because it provides no durable-worker
  separation or enforceable business/infrastructure boundaries.
- Reuse a scheduling fork: rejected because JorMall is a greenfield product with different tenancy
  and AI security requirements.
