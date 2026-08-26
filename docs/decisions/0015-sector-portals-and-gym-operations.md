# ADR 0015: Sector profiles and gym operations

Status: Accepted

## Context

JorMall organizations may operate as a gym, clinic, or beauty center. The shared identity,
appointments, scheduling, communications, reporting, and AI foundations remain valid across those
sectors, but owners need sector language and workflows rather than a generic customer portal. Gyms
also require operational trainee programming that cannot be represented safely as appointment notes
or untyped JSON.

## Decision

`OrganizationSettings.businessSector` is the authoritative typed sector selection. JorMall Super
Admin must select it while creating the organization. The Organization, settings, default roles and
permissions, infrastructure defaults, owner invitation, and creation audit commit atomically. An
ordinary owner cannot reclassify the tenant. Exceptional correction uses a separate Super Admin
repository path, requires a reason, and appends an immutable tenant audit event. The database column
remains nullable only for pre-decision rows; new creation contracts require a value.

A sector choice changes navigation, labels, dashboard actions, and availability of sector modules;
it never changes or weakens tenant authorization. Gym owners receive a data-backed command center.
Its deterministic attention policy separates recorded facts from advisory next steps and never
changes a plan automatically.

The shared `Customer` aggregate remains the organization-local person record. In a gym, a
`GymTraineeProfile` adds trainer assignment, goal, experience, measurements, and budget. A trainer
is an existing `StaffProfile`, so trainer access inherits membership lifecycle and the provider
`SELF` permission scope. This release does not claim that a trainee has an independent login; that
requires a separately reviewed customer identity and delegation model.

Workout plans, exercises, performed workout logs, nutrition plans, meals, and progress entries are
typed tenant-owned tables with composite tenant foreign keys and forced PostgreSQL RLS. Repository
methods reload active organization and membership state and enforce these permissions:

- owner: all gym permissions at organization scope;
- manager: trainee read/manage, plan management, and progress write at organization scope;
- provider/trainer: trainee read, plan management, and progress write at self scope;
- secretary: no gym plan, progress, or trainee permission.

Nutrition plans store operational targets and budget-aware meal options. The UI clearly states that
allergies, medical conditions, and clinical diets require a qualified professional. No medical
conclusion, diagnosis, automatic diet generation, membership billing, or trainee account is
introduced by this decision.

Clinic and beauty-center selection currently specializes safe shared concepts (patients/clients,
doctors/specialists, rooms/chairs, and services). Deeper sector-specific clinical or beauty records
must use their own reviewed domain modules rather than adding nullable columns to shared tables.

## Consequences

- Sector selection is explicit at platform provisioning and audited; tenant owners cannot change it.
- URL identifier changes cannot cross tenant or trainer-self boundaries because repositories derive
  Organization and trainer context from authenticated access.
- The gym module can evolve independently while continuing to reuse scheduling and communications.
- Future independent trainee access, subscriptions/billing, clinical records, and automated meal
  recommendations are release gates, not implied capabilities.
