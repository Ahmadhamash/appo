# ADR 0013: Staged imports, attribution events, and reproducible reports

Status: Accepted for Phase 7

## Decision

CSV input is decoded as UTF-8 and parsed incrementally. Files are limited to 5 MB, 10,000 data rows,
16 columns and 2,000 characters per cell. A SHA-256 file digest and caller idempotency key identify
an `ImportBatch`; reusing a key with different input is rejected. Dry-run rows are stored under
tenant RLS with only normalized payload needed for commit. Error exports contain row number, stable
code, field and safe message, not the original PII value.

Commit processes at most 100 rows at a time and invokes ordinary customer, invitation, service and
appointment use cases. Appointment imports therefore retain PostgreSQL scheduling constraints and
per-row idempotency. A batch may be partial and is resumable. Rollback deletes only unchanged,
unreferenced customers/services and revokes only pending invitations. Appointments and accepted
memberships are retained because deleting their history is unsafe; operators receive the retained
count instead of a false success claim.

`AttributionEvent`, `ReportRun` and `PlatformAuditEvent` are append-only. Reports store formula
version, exact UTC bounds derived from the organization IANA timezone, dimensions, result and data
watermark. Export jobs expire after one hour, belong to their requesting actor, re-authorize every
download page, stream 250 rows at a time and neutralize spreadsheet formulas.

Super-admin platform queries use a separate explicit method, require a reason and create immutable
platform audit evidence. Tenant report, audit, import and export methods always use normal tenant
context and PostgreSQL RLS.

## Consequences

- Database staging is intentionally bounded; object storage and malware scanning are required before
  increasing the 5 MB limit.
- Safe rollback favors preserved history over completeness.
- Export files are generated on demand from an expiring job rather than stored as public objects.
- Large analytical workloads need dedicated read models before raising the documented bounds.
