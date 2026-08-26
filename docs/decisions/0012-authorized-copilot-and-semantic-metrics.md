# ADR 0012: Authorized Copilot projections and semantic metrics

- Status: Accepted
- Date: 2026-08-29

## Context

Phase 6 summarizes customers and operations, reviews calls, and explains analytics. A model that can
query arbitrary tables or SQL could bypass tenant, branch, provider-self, recording, and sensitive
data policies. Generated prose also needs verifiable sources and must not silently become a mutation
path.

## Decision

Staff Copilot is an application use case with three ports: an authorized context projector, a
provider-neutral generation adapter, and an append-only insight store. The PostgreSQL adapter loads
only records permitted by the current Membership grants and applies organization, assigned-branch,
or provider-self predicates before data reaches the model adapter. Restricted call evidence requires
both `recordings.read` and `conversations.read`. Internal appointment records and unsupported
medical conclusions are excluded from customer summaries.

Each generated statement is typed as `FACT`, `COMPUTED_METRIC`, or `AI_SUGGESTION` and must cite the
exact evidence IDs attached to its input projection. The domain rejects unknown, missing,
duplicated, or differently classified statements and unsupported medical conclusions. Persisted
`CopilotInsight`, `CopilotInsightSource`, `AnalyticsSnapshot`, and `CopilotFeedback` rows carry the
Organization, actor/Membership, model, prompt version, active knowledge-version IDs, confidence,
data watermark, expiry, and source links. They are append-only and protected by RLS.

Analytics accepts only compiled `SemanticMetricKey` values. The repository maps each key to a fixed
tenant-scoped aggregate; it accepts no SQL, expression, table, column, or arbitrary metric name.
Snapshots record definition version, interval, scope dimensions, value, and watermark. A hash of the
authorized evidence and values plus actor/policy context is locked and unique, so duplicate
generation returns the same insight while changed source data creates a new one.

Copilot output is advisory. It has no mutation port. Any future appointment change suggested by a
Copilot must enter the existing Action Gateway and normal use case with a bound, unexpired user
confirmation. Phase 6 adds no automatic mutation tool.

The included model is the clearly labeled deterministic local mock. It performs no network request
and only renders authorized projection items. A production model remains gated on privacy terms,
offline evaluation, red-team review, and monitored factuality/correction thresholds.

## Consequences

- Branch/self and restricted-record policy is enforced before model input, not by prompt wording.
- Every displayed statement has a clickable authorized source and reproducible trace.
- The semantic layer is intentionally less flexible than arbitrary SQL, but its definitions are
  reviewable, testable, and safe to expose to an AI explainer.
- Polymorphic evidence references are validated by the projector and stored with tenant identity;
  adding a source type requires code, migration, authorization tests, and UI disclosure review.
- Feedback is auditable evidence and never rewrites the generated insight.

## Alternatives considered

- Model-generated SQL: rejected because schemas and prompts cannot enforce full tenancy or
  disclosure policy.
- Send broad records and ask the model to redact: rejected because restricted data would already
  have crossed the model boundary.
- Store prose without evidence: rejected because staff cannot distinguish supported facts from
  suggestions or investigate corrections.
