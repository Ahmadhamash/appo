# ADR 0005: UTC instants, IANA timezones, English and Arabic

- Status: Accepted
- Date: 2026-08-23

## Context

Appointments are business-local events but comparisons, integrations, and storage require absolute
instants. Jordan and other markets can change timezone rules. Arabic requires right-to-left design,
and AI conversation quality in Jordanian Arabic differs from formal UI translation.

## Decision

Persist appointment and event instants as UTC `timestamptz`. Store Organization default and optional
Branch override as IANA timezone identifiers; support `Asia/Amman` from Phase 1. Store recurring
hours as local calendar rules plus timezone/effective dates, converting only for bounded evaluation
windows. Reject or explicitly disambiguate invalid/ambiguous local inputs.

English (`en`) and Arabic (`ar`) message catalogs and RTL-safe components are required in every
phase. Jordanian Arabic is a separately evaluated conversational behavior. Formatting occurs at
delivery edges using locale and timezone; domain rules do not depend on localized strings.

## Consequences

- Schedule comparisons are stable while displays follow business-local rules.
- Timezone database updates and regression tests are operational dependencies.
- APIs and import contracts must distinguish instants from local date/time/timezone tuples.
- Translation and RTL testing are definition-of-done work, not a later retrofit.

## Alternatives considered

- Store local timestamps only: rejected because they are ambiguous and cannot safely compare across
  rules/integrations.
- Fixed UTC offset: rejected because offsets are not timezone rules and may change.
- English-first UI: rejected because layout and message architecture would accumulate avoidable
  rework and accessibility defects.
