# ADR 0007: AI Action Gateway

- Status: Accepted
- Date: 2026-08-23

## Context

Language models are probabilistic and vulnerable to hallucination and prompt injection. Direct model
access to databases, repositories, provider credentials, or generic network tools would bypass
tenant, authorization, consent, confirmation, idempotency, and audit controls.

## Decision

AI receives no direct persistence or secret access. Every business read/mutation uses a compiled,
allowlisted Action Gateway definition with versioned Zod input/output, verified
tenant/actor/channel, fresh authorization, identity/consent prerequisites, idempotency, confirmation
policy, rate/budget limits, one normal application use case, disclosure filtering, and audit
evidence.

Destructive/sensitive actions require a short-lived single-use confirmation bound to a canonical
action summary and payload hash. Knowledge retrieval enforces tenant/publication filters before
model context. The `packages/ai` dependency graph is prohibited from importing `packages/db`.

## Consequences

- Model/provider changes cannot bypass core business invariants.
- Each tool needs more explicit schemas, policies, tests, and localized confirmation copy.
- AI may be less flexible than an unrestricted agent; unsupported requests hand off to humans.
- A successful model tool-call proposal is not success until the gateway/use case commits and
  returns.
- Phase 5A uses a PostgreSQL transaction advisory lock keyed by tenant, action, and idempotency key
  plus a unique fingerprint constraint. It serializes concurrent retries through confirmation,
  ordinary use-case execution, redacted result storage, and audit completion.

## Alternatives considered

- Model-generated SQL or direct ORM access: rejected as an unacceptable tenancy and integrity risk.
- Generic HTTP/browser tool: rejected because destination and action policy cannot be safely
  bounded.
- Prompt-only safety: rejected because prompts cannot provide deterministic authorization or
  confirmation enforcement.
