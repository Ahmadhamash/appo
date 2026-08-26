# Sector portals and gym operations

Status: implemented with a deep gym operational module and shared clinic/beauty specialization

## Owner flow

JorMall Super Admin selects Gym, Clinic, or Beauty center in the platform organization-creation
form. Organization, typed `OrganizationSettings.businessSector`, system roles, role grants,
provider-neutral defaults, the owner invitation, and the reason-bearing creation audit are committed
in one database transaction. The invited owner therefore opens the correct workspace immediately;
ordinary tenant settings cannot reclassify the organization. An exceptional reclassification is a
separate Super Admin-only, reason-bearing audited repository path.

Gym enables the Trainees workspace. An authorized owner or manager first creates a Customer, then
adds a gym profile with trainer, goal, experience, measurements, and food budget. Authorized owners,
managers, or the assigned provider can create workout/nutrition plans and record progress. Provider
`SELF` scope returns only assigned trainees and treats an unrelated or foreign ID as not found.

The Gym owner dashboard is a data-backed command center. It counts visible trainees, active
workout/nutrition readiness, active trainee portal access, and a deterministic follow-up queue. The
queue uses only authorized facts: trainer assignment, active plans, portal state, recent workout
logs, effort/repetition evidence, and recent measurements. A progression result is an advisory
review suggestion; it never mutates a workout or nutrition plan.

## Stored gym records

- `GymTraineeProfile`: one per organization-local Customer, with optional trainer StaffProfile.
- `GymWorkoutPlan` and `GymWorkoutExercise`: bilingual dated programming and prescriptions.
- `GymWorkoutLog`: performed sets, repetitions, weight, effort, timestamp, and optional notes.
- `GymNutritionPlan` and `GymNutritionMeal`: goal, daily budget, calories/macros, and bilingual meal
  options with estimated costs.
- `GymProgressEntry`: append-oriented weight, body fat, waist, timestamp, and notes.
- `GymTraineeInvitation` and `GymTraineePortalAccess`: single-use account provisioning and immediate
  access lifecycle for a private trainee portal.

All records carry `organization_id`, use tenant-aware foreign keys, have bounded list projections,
and use forced RLS. Every mutation appends an AuditEvent. Date-only plan windows are PostgreSQL
`date`; workout and measurement events are UTC instants and display in `Asia/Amman` in the current
UI.

## Trainee portal and explicit limitations

An owner or manager can create a single-use invitation from a trainee profile. The resulting Better
Auth identity is linked to that trainee only and never receives an OrganizationMembership. The
portal shows a safe projection of the assigned workout/nutrition plan and lets the trainee append
their performed weights and measurements. Staff/internal notes and customer contacts are excluded.

One identity can currently link to one gym trainee profile, so no implicit organization switch is
offered. Membership subscriptions, billing, automatic period-based plan replacement, automated
nutrition recommendations, allergy or medical screening, and clinical records are not included.
Nutrition content is operational guidance only and requires a qualified professional for medical
diets or conditions.

## Local verification

1. Run explicit migrations and the development seed with a local-only `DEV_SEED_PASSWORD`.
2. Sign in as `gym-owner@example.invalid`; Development Gym C is selected automatically and no other
   organization is offered.
3. Verify the owner immediately sees Gym management portal and Gym command center without choosing a
   sector.
4. Open Trainees, create a Customer, then create the trainee profile.
5. Add a workout plan/exercise and record performed sets, repetitions, and weight.
6. Add progress measurements.
7. Add a budget/macronutrient nutrition plan and a meal option.
8. Switch to English and verify layout direction and translations.
9. Sign in as an assigned provider and verify only that provider's trainees are returned.
10. From a trainee profile, create and copy a portal invitation, register with the invited email,
    and verify the account opens `/trainee` rather than the owner dashboard.
11. Record a workout and body weight, then suspend portal access from the owner profile and verify
    the trainee loses access immediately.
