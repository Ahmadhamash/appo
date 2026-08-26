# Phase 7 imports, audit, attribution, and reports

## Metric formulas (definition version 1)

All tenant date inputs are inclusive local calendar dates. They are converted to a half-open UTC
interval using the Organization IANA timezone. Empty denominators return `null`, never zero percent.

| Metric               | Formula                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bookings             | Count of appointments whose scheduled start is in the interval, grouped by organization, branch, service, provider and appointment source.                  |
| Cancellation rate    | Cancelled bookings / all bookings in the interval.                                                                                                          |
| No-show rate         | No-show bookings / all bookings in the interval.                                                                                                            |
| Channel conversion   | Attribution events linked to an appointment / all attribution touch events, grouped by source.                                                              |
| Waitlist conversion  | Entries created in the interval that are currently fulfilled / all entries created in the interval.                                                         |
| AI containment       | AI conversations created in the interval with no HumanHandoff / all AI conversations created in the interval.                                               |
| Human handoff        | AI conversations created in the interval with at least one HumanHandoff / all AI conversations created in the interval.                                     |
| Call outcomes        | Count of calls started in the interval, grouped by call status.                                                                                             |
| Message failure rate | Outbound messages in Failed or Dead-letter state / all outbound messages created in the interval.                                                           |
| Schedule utilization | Non-cancelled scheduled minutes / configured staff-availability minutes for weekdays in the interval. This is gross utilization, not claimed billable time. |
| Revenue estimate     | Completed appointment branch price, falling back to service default. `null` if any completed appointment lacks reliable pricing.                            |
| AI usage and cost    | Input tokens, output tokens and estimated cost micros, grouped by recorded channel.                                                                         |

Platform aggregates are explicitly labelled lifetime counts and are not cross-timezone date reports.

## CSV contracts

- Customers: `external_key,display_name,phone,preferred_locale`
- Staff invitations: `external_key,email,role_key`
- Services: `external_key,name_en,name_ar,duration_minutes,price_minor,currency`
- Appointments:
  `external_key,customer_phone,branch_name,service_name,provider_email,starts_at_local,status,source_detail`

Staff imports create invitations, never credentials. Appointment imports accept only Pending or
Confirmed, use source Import, resolve references inside the active tenant, and invoke normal
booking.

## Manual proof

1. Upload a UTF-8 CSV under **Safe imports** and inspect dry-run counts.
2. Download errors and confirm original PII values are absent.
3. Commit an error-free batch, retry its same key/digest, then run safe rollback.
4. Run **Reports and attribution** and inspect timezone, definition version and watermark.
5. Download an expiring export and verify formulas are neutralized and notes/phones are absent.
6. Inspect tenant audit pagination. As Super Admin, enter a reason in **Platform audit** and verify
   the access and aggregate reads created immutable platform evidence.
