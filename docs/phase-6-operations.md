# Phase 6 Staff Copilot operations

## Runtime boundary

Phase 6 adds no model SDK, queue, provider credential, or external network dependency. The only
adapter is `jormall-copilot-deterministic-mock-v1`. PostgreSQL creates authorized projections and
append-only evidence; `packages/ai` has no database import. The semantic layer registers eleven
allowlisted metrics: ten are direct aggregates, while waitlist matches are computed only by the
bounded daily matching use case. It cannot execute arbitrary SQL.

## Manual proof

1. Start PostgreSQL, apply migrations, generate Prisma types, seed, and run web as documented in
   `phase-5b-operations.md`.
2. Sign in as `owner@example.invalid`, select Development Clinic A, and open **Staff Copilot**.
3. Generate the daily briefing, schedule gaps, and waitlist matches. Confirm every line is labelled
   Fact, Computed metric, or AI suggestion and has a supporting-record link.
4. Run an Analytics Copilot query for `APPOINTMENTS_TOTAL`. Confirm the trace displays the local
   mock model, prompt version, active knowledge-version count, confidence, and data watermark.
5. Submit Helpful, Incorrect, Unsafe, and Outdated feedback with an optional note. Refresh and
   verify the insight did not change and append-only feedback/audit rows exist.
6. Open a Customer profile and generate its evidence-linked summary. Verify it contains appointment,
   consent/preferences, recent message/call, cancellation/no-show, and handoff facts only when those
   source categories are authorized. It must not contain appointment-record notes or a medical
   conclusion.
7. If an authorized, appointment-linked completed mock call exists, generate Call quality. Review
   all eight rubric rows and their restricted call evidence.
8. Sign in as the secretary. Confirm operational reports are branch-scoped and call-quality controls
   are absent. Sign in as the provider and confirm summaries/metrics include only that provider's
   customers and appointments.
9. Switch to Development Clinic B and confirm no insight, evidence, feedback, customer, call, or
   snapshot from Clinic A is visible. Suspend the Membership or Organization and confirm the next
   request is denied.
10. Confirm generating the same unchanged insight twice returns the same persisted insight; change a
    supporting record and regenerate to obtain a new watermark/evidence hash.

## Performance assumptions and production gates

Dashboard queries cap source windows and return at most 50 insights, 20 daily appointments/waitlist
matches, 20 customer appointments, 10 messages/consents, and five calls/handoffs. Initial target is
dashboard p95 below 500 ms for those bounds. Add reporting read models before materially larger
tenants; do not relax tenant predicates or evidence links for performance.

A production model requires approved retention/data-use terms, regional review, monitored latency
and cost, Jordanian Arabic factuality evaluation, bias/privacy review, unsafe-output thresholds, and
a rollback/kill switch. The deterministic adapter is functional evidence, not a production AI claim.
