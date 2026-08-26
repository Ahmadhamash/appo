import { isSupportedLocale } from "@jormall/contracts/locales";
import { GymPortalAccessStatus, Weekday } from "@jormall/db/generated/enums";
import { gymGoals } from "@jormall/domain/gym";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../../../components/feedback";
import { GymPortalInvitationForm } from "../../../../../../components/gym-portal-invitation-form";
import { SubmitButton } from "../../../../../../components/submit-button";
import { TrainingAvatar } from "../../../../../../components/training-avatar";
import { sectorMessages, sectorValueLabel } from "../../../../../../messages/sectors";
import { gymRepository, requireTenantAccess } from "../../../../../../server/identity";
import {
  addNutritionMealAction,
  addWorkoutExerciseAction,
  createNutritionPlanAction,
  createWorkoutPlanAction,
  recordGymProgressAction,
  recordWorkoutAction,
  setGymPortalAccessStatusAction,
} from "../../actions";

export default async function GymTraineeProfilePage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/gym/trainees/[traineeId]">) {
  const [{ locale, traineeId }, query] = await Promise.all([params, searchParams]);
  if (!isSupportedLocale(locale)) notFound();
  const access = await requireTenantAccess(locale);
  const trainee = await gymRepository.getTrainee(access, traineeId);
  const canManagePlans = access.grants.some((grant) => grant.code === "gym.plans.manage");
  const canManageTrainees = access.grants.some((grant) => grant.code === "gym.trainees.manage");
  const canRecordProgress = access.grants.some((grant) => grant.code === "gym.progress.write");
  const messages = sectorMessages[locale];
  const today = new Date().toISOString().slice(0, 10);
  const currentProgress = trainee.progressEntries[0];
  const portalProvisioning = canManageTrainees
    ? await gymRepository.portalProvisioning(access, trainee.id)
    : null;

  return (
    <section className="page-stack gym-workspace" aria-labelledby="trainee-title">
      <nav aria-label={locale === "ar" ? "مسار الصفحة" : "Breadcrumb"}>
        <Link className="text-link" href={`/${locale}/dashboard/gym/trainees`}>
          {locale === "ar" ? "← كل المتدربين" : "← All trainees"}
        </Link>
      </nav>
      <header className="trainee-hero">
        <TrainingAvatar
          frame={trainee.avatarFrame}
          hairStyle={trainee.avatarHairStyle}
          label={locale === "ar" ? "شخصية المتدرّب" : "Trainee avatar"}
          shirtColor={trainee.avatarShirtColor}
          size="compact"
          skinTone={trainee.avatarSkinTone}
        />
        <div>
          <p className="eyebrow">{messages.traineeProfile}</p>
          <h1 id="trainee-title">{trainee.customer.displayName}</h1>
          <p className="muted" dir="ltr">
            {trainee.customer.contacts[0]?.originalValue ?? "—"}
          </p>
        </div>
        <span className="status">{sectorValueLabel(locale, trainee.goal)}</span>
      </header>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />

      {canManageTrainees ? (
        <section className="panel owner-portal-access" aria-labelledby="portal-access-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{locale === "ar" ? "دخول المتدرّب" : "Trainee access"}</p>
              <h2 id="portal-access-title">
                {locale === "ar" ? "حساب المتدرّب المنفصل" : "Separate trainee account"}
              </h2>
              <p className="muted">
                {locale === "ar"
                  ? "الحساب يعرض لهذا المتدرّب فقط تمارينه وتغذيته وتقدّمه، ولا يفتح إدارة النادي."
                  : "This account shows only this trainee's workouts, nutrition and progress. It cannot open gym management."}
              </p>
            </div>
            {portalProvisioning?.portalAccess ? (
              <span
                className={
                  portalProvisioning.portalAccess.status === GymPortalAccessStatus.ACTIVE
                    ? "status status-active"
                    : "status status-suspended"
                }
              >
                {portalProvisioning.portalAccess.status === GymPortalAccessStatus.ACTIVE
                  ? locale === "ar"
                    ? "الحساب فعّال"
                    : "Active account"
                  : locale === "ar"
                    ? "الحساب معلّق"
                    : "Suspended account"}
              </span>
            ) : null}
          </div>
          {portalProvisioning?.portalAccess ? (
            <div className="portal-access-active">
              <span dir="ltr">{portalProvisioning.portalAccess.user.email}</span>
              <form action={setGymPortalAccessStatusAction}>
                <input name="locale" type="hidden" value={locale} />
                <input name="traineeProfileId" type="hidden" value={trainee.id} />
                <input
                  name="status"
                  type="hidden"
                  value={
                    portalProvisioning.portalAccess.status === GymPortalAccessStatus.ACTIVE
                      ? GymPortalAccessStatus.SUSPENDED
                      : GymPortalAccessStatus.ACTIVE
                  }
                />
                <SubmitButton
                  tone={
                    portalProvisioning.portalAccess.status === GymPortalAccessStatus.ACTIVE
                      ? "danger"
                      : "secondary"
                  }
                >
                  {portalProvisioning.portalAccess.status === GymPortalAccessStatus.ACTIVE
                    ? locale === "ar"
                      ? "تعليق الدخول"
                      : "Suspend access"
                    : locale === "ar"
                      ? "إعادة التفعيل"
                      : "Reactivate access"}
                </SubmitButton>
              </form>
            </div>
          ) : (
            <GymPortalInvitationForm locale={locale} traineeProfileId={trainee.id} />
          )}
        </section>
      ) : null}

      <dl className="profile-metric-grid">
        <Metric label={messages.trainer} value={trainerName(locale, trainee.trainer)} />
        <Metric
          label={messages.experience}
          value={sectorValueLabel(locale, trainee.experienceLevel)}
        />
        <Metric label={messages.startingWeight} value={withUnit(trainee.startingWeightKg, "kg")} />
        <Metric label={messages.targetWeight} value={withUnit(trainee.targetWeightKg, "kg")} />
        <Metric
          label={messages.latestProgress}
          value={withUnit(currentProgress?.bodyWeightKg, "kg")}
        />
        <Metric
          label={messages.budget}
          value={
            trainee.monthlyFoodBudgetMinor === null
              ? "—"
              : formatMoney(locale, trainee.monthlyFoodBudgetMinor, trainee.currency)
          }
        />
      </dl>

      {canRecordProgress ? (
        <details className="panel action-disclosure" open={trainee.progressEntries.length === 0}>
          <summary>{messages.recordProgress}</summary>
          <form action={recordGymProgressAction} className="form-grid disclosure-form">
            <input name="locale" type="hidden" value={locale} />
            <input name="traineeProfileId" type="hidden" value={trainee.id} />
            <NumberField
              label={messages.bodyWeight}
              max="400"
              min="20"
              name="bodyWeightKg"
              required
            />
            <NumberField label={messages.bodyFat} max="80" min="1" name="bodyFatPercent" />
            <NumberField label={messages.waist} max="300" min="20" name="waistCm" />
            <label className="field field-span">
              <span className="field-label">{messages.profileNotes}</span>
              <textarea className="textarea" maxLength={4000} name="notes" rows={2} />
            </label>
            <div className="form-actions field-span">
              <SubmitButton>{messages.recordProgress}</SubmitButton>
            </div>
          </form>
        </details>
      ) : null}

      <section className="gym-section" aria-labelledby="workout-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{messages.workoutPlan}</p>
            <h2 id="workout-title">{locale === "ar" ? "برامج التمرين" : "Workout programming"}</h2>
          </div>
        </div>
        {canManagePlans ? (
          <details className="panel action-disclosure" open={trainee.workoutPlans.length === 0}>
            <summary>{messages.createWorkoutPlan}</summary>
            <form action={createWorkoutPlanAction} className="form-grid disclosure-form">
              <input name="locale" type="hidden" value={locale} />
              <input name="traineeProfileId" type="hidden" value={trainee.id} />
              <TextField label={messages.workoutPlanTitleAr} name="titleAr" />
              <TextField label={messages.workoutPlanTitleEn} name="titleEn" />
              <DateField defaultValue={today} label={messages.startsOn} name="startsOn" required />
              <DateField label={messages.endsOn} name="endsOn" />
              <div className="form-actions field-span">
                <SubmitButton>{messages.createWorkoutPlan}</SubmitButton>
              </div>
            </form>
          </details>
        ) : null}
        {trainee.workoutPlans.length === 0 ? (
          <p className="empty-state">{messages.noWorkoutPlan}</p>
        ) : (
          <div className="plan-stack">
            {trainee.workoutPlans.map((plan) => (
              <article className="panel gym-plan" key={plan.id}>
                <div className="section-heading">
                  <div>
                    <span className="status">{sectorValueLabel(locale, plan.status)}</span>
                    <h3>{locale === "ar" ? plan.titleAr : plan.titleEn}</h3>
                    <p className="muted">
                      {formatDate(locale, plan.startsOn)} —{" "}
                      {plan.endsOn ? formatDate(locale, plan.endsOn) : "∞"}
                    </p>
                  </div>
                </div>
                {plan.exercises.length > 0 ? (
                  <div className="exercise-list">
                    {plan.exercises.map((exercise) => (
                      <article className="exercise-row" key={exercise.id}>
                        <div>
                          <span className="status">
                            {sectorValueLabel(locale, exercise.weekday)}
                          </span>
                          <h4>{locale === "ar" ? exercise.nameAr : exercise.nameEn}</h4>
                          <p className="muted">
                            {exercise.sets} × {exercise.repsMin}–{exercise.repsMax} ·{" "}
                            {exercise.restSeconds}s
                            {exercise.targetWeightKg
                              ? ` · ${exercise.targetWeightKg.toString()} kg`
                              : ""}
                          </p>
                        </div>
                        {canRecordProgress ? (
                          <details className="inline-disclosure">
                            <summary>{messages.recordWorkout}</summary>
                            <form action={recordWorkoutAction} className="compact-form">
                              <input name="locale" type="hidden" value={locale} />
                              <input name="traineeProfileId" type="hidden" value={trainee.id} />
                              <input name="workoutExerciseId" type="hidden" value={exercise.id} />
                              <NumberField
                                label={messages.actualSets}
                                max="30"
                                min="1"
                                name="actualSets"
                                required
                              />
                              <NumberField
                                label={messages.actualReps}
                                max="500"
                                min="1"
                                name="actualReps"
                                required
                              />
                              <NumberField
                                label={messages.actualWeight}
                                max="1000"
                                min="0"
                                name="actualWeightKg"
                              />
                              <NumberField
                                label={messages.perceivedEffort}
                                max="10"
                                min="1"
                                name="perceivedEffort"
                              />
                              <SubmitButton>{messages.recordWorkout}</SubmitButton>
                            </form>
                          </details>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : null}
                {canManagePlans ? (
                  <details className="inline-disclosure">
                    <summary>{messages.addExercise}</summary>
                    <form action={addWorkoutExerciseAction} className="form-grid disclosure-form">
                      <input name="locale" type="hidden" value={locale} />
                      <input name="traineeProfileId" type="hidden" value={trainee.id} />
                      <input name="workoutPlanId" type="hidden" value={plan.id} />
                      <label className="field">
                        <span className="field-label">{messages.weekday}</span>
                        <select className="select" name="weekday">
                          {Object.values(Weekday).map((day) => (
                            <option key={day} value={day}>
                              {sectorValueLabel(locale, day)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <TextField label={messages.exerciseNameAr} name="nameAr" />
                      <TextField label={messages.exerciseNameEn} name="nameEn" />
                      <NumberField
                        defaultValue="3"
                        label={locale === "ar" ? "الجولات" : "Sets"}
                        max="20"
                        min="1"
                        name="sets"
                        required
                      />
                      <NumberField
                        defaultValue="8"
                        label={messages.repsMinimum}
                        max="200"
                        min="1"
                        name="repsMin"
                        required
                      />
                      <NumberField
                        defaultValue="12"
                        label={messages.repsMaximum}
                        max="200"
                        min="1"
                        name="repsMax"
                        required
                      />
                      <NumberField
                        defaultValue="60"
                        label={messages.restSeconds}
                        max="3600"
                        min="0"
                        name="restSeconds"
                        required
                      />
                      <NumberField
                        label={messages.targetWorkoutWeight}
                        max="1000"
                        min="0"
                        name="targetWeightKg"
                      />
                      <input name="sortOrder" type="hidden" value={plan.exercises.length} />
                      <div className="form-actions field-span">
                        <SubmitButton>{messages.addExercise}</SubmitButton>
                      </div>
                    </form>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="gym-section" aria-labelledby="nutrition-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{messages.nutrition}</p>
            <h2 id="nutrition-title">{messages.nutritionPlan}</h2>
          </div>
          <p className="muted nutrition-safety">{messages.nutritionSafety}</p>
        </div>
        {canManagePlans ? (
          <details className="panel action-disclosure" open={trainee.nutritionPlans.length === 0}>
            <summary>{messages.createNutritionPlan}</summary>
            <form action={createNutritionPlanAction} className="form-grid disclosure-form">
              <input name="locale" type="hidden" value={locale} />
              <input name="traineeProfileId" type="hidden" value={trainee.id} />
              <input name="currency" type="hidden" value={trainee.currency} />
              <TextField label={messages.nutritionPlanTitleAr} name="titleAr" />
              <TextField label={messages.nutritionPlanTitleEn} name="titleEn" />
              <label className="field">
                <span className="field-label">{locale === "ar" ? "الهدف" : "Goal"}</span>
                <select className="select" defaultValue={trainee.goal} name="goal">
                  {gymGoals.map((goal) => (
                    <option key={goal} value={goal}>
                      {sectorValueLabel(locale, goal)}
                    </option>
                  ))}
                </select>
              </label>
              <NumberField
                defaultValue="500"
                label={messages.dailyBudget}
                max="10000000"
                min="0"
                name="dailyBudgetMinor"
                required
                step="1"
              />
              <NumberField
                defaultValue="2000"
                label={messages.dailyCalories}
                max="10000"
                min="500"
                name="dailyCalories"
                required
                step="1"
              />
              <NumberField
                defaultValue="120"
                label={messages.protein}
                max="1000"
                min="0"
                name="proteinGrams"
                required
                step="1"
              />
              <NumberField
                defaultValue="230"
                label={messages.carbohydrates}
                max="2000"
                min="0"
                name="carbohydratesGrams"
                required
                step="1"
              />
              <NumberField
                defaultValue="65"
                label={messages.fat}
                max="1000"
                min="0"
                name="fatGrams"
                required
                step="1"
              />
              <DateField defaultValue={today} label={messages.startsOn} name="startsOn" required />
              <DateField label={messages.endsOn} name="endsOn" />
              <div className="form-actions field-span">
                <SubmitButton>{messages.createNutritionPlan}</SubmitButton>
              </div>
            </form>
          </details>
        ) : null}
        {trainee.nutritionPlans.length === 0 ? (
          <p className="empty-state">{messages.noNutritionPlan}</p>
        ) : (
          <div className="plan-stack">
            {trainee.nutritionPlans.map((plan) => (
              <article className="panel gym-plan" key={plan.id}>
                <div className="section-heading">
                  <div>
                    <span className="status">{sectorValueLabel(locale, plan.status)}</span>
                    <h3>{locale === "ar" ? plan.titleAr : plan.titleEn}</h3>
                    <p className="muted">
                      {plan.dailyCalories} kcal · {plan.proteinGrams}g P · {plan.carbohydratesGrams}
                      g C · {plan.fatGrams}g F
                    </p>
                  </div>
                  <strong>
                    {formatMoney(locale, plan.dailyBudgetMinor, plan.currency)} /{" "}
                    {locale === "ar" ? "يوم" : "day"}
                  </strong>
                </div>
                {plan.meals.length > 0 ? (
                  <div className="meal-grid">
                    {plan.meals.map((meal) => (
                      <article className="meal-card" key={meal.id}>
                        <span className="eyebrow">
                          {locale === "ar" ? meal.timingLabelAr : meal.timingLabelEn}
                        </span>
                        <h4>{locale === "ar" ? meal.nameAr : meal.nameEn}</h4>
                        <p>
                          {meal.calories} kcal · {meal.proteinGrams}g P
                        </p>
                        <strong>
                          {formatMoney(locale, meal.estimatedCostMinor, plan.currency)}
                        </strong>
                      </article>
                    ))}
                  </div>
                ) : null}
                {canManagePlans ? (
                  <details className="inline-disclosure">
                    <summary>{messages.addMeal}</summary>
                    <form action={addNutritionMealAction} className="form-grid disclosure-form">
                      <input name="locale" type="hidden" value={locale} />
                      <input name="traineeProfileId" type="hidden" value={trainee.id} />
                      <input name="nutritionPlanId" type="hidden" value={plan.id} />
                      <TextField label={messages.mealNameAr} name="nameAr" />
                      <TextField label={messages.mealNameEn} name="nameEn" />
                      <TextField
                        label={messages.mealTimingAr}
                        name="timingLabelAr"
                        required={false}
                      />
                      <TextField
                        label={messages.mealTimingEn}
                        name="timingLabelEn"
                        required={false}
                      />
                      <NumberField
                        label={messages.mealCost}
                        max="10000000"
                        min="0"
                        name="estimatedCostMinor"
                        required
                        step="1"
                      />
                      <NumberField
                        label={messages.calories}
                        max="10000"
                        min="0"
                        name="calories"
                        required
                        step="1"
                      />
                      <NumberField
                        label={messages.protein}
                        max="1000"
                        min="0"
                        name="proteinGrams"
                        required
                        step="1"
                      />
                      <NumberField
                        label={messages.carbohydrates}
                        max="2000"
                        min="0"
                        name="carbohydratesGrams"
                        required
                        step="1"
                      />
                      <NumberField
                        label={messages.fat}
                        max="1000"
                        min="0"
                        name="fatGrams"
                        required
                        step="1"
                      />
                      <input name="sortOrder" type="hidden" value={plan.meals.length} />
                      <div className="form-actions field-span">
                        <SubmitButton>{messages.addMeal}</SubmitButton>
                      </div>
                    </form>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="grid two-column">
        <section className="panel" aria-labelledby="progress-history-title">
          <h2 id="progress-history-title">{messages.progress}</h2>
          <ul className="history-list">
            {trainee.progressEntries.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.bodyWeightKg.toString()} kg</strong>
                <span>{formatDateTime(locale, entry.measuredAt)}</span>
                <small>
                  {entry.bodyFatPercent ? `${entry.bodyFatPercent.toString()}%` : "—"} ·{" "}
                  {entry.waistCm ? `${entry.waistCm.toString()} cm` : "—"}
                </small>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel" aria-labelledby="workout-history-title">
          <h2 id="workout-history-title">{messages.workoutHistory}</h2>
          <ul className="history-list">
            {trainee.workoutLogs.map((log) => (
              <li key={log.id}>
                <strong>{locale === "ar" ? log.exercise.nameAr : log.exercise.nameEn}</strong>
                <span>
                  {log.actualSets} × {log.actualReps} · {withUnit(log.actualWeightKg, "kg")}
                </span>
                <small>{formatDateTime(locale, log.performedAt)}</small>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function TextField({
  label,
  name,
  required = true,
}: Readonly<{ label: string; name: string; required?: boolean }>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input className="input" maxLength={160} name={name} required={required} />
    </label>
  );
}

function NumberField({
  defaultValue,
  label,
  max,
  min,
  name,
  required = false,
  step = "0.1",
}: Readonly<{
  defaultValue?: string;
  label: string;
  max: string;
  min: string;
  name: string;
  required?: boolean;
  step?: string;
}>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        defaultValue={defaultValue}
        max={max}
        min={min}
        name={name}
        required={required}
        step={step}
        type="number"
      />
    </label>
  );
}

function DateField({
  defaultValue,
  label,
  name,
  required = false,
}: Readonly<{ defaultValue?: string; label: string; name: string; required?: boolean }>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        defaultValue={defaultValue}
        name={name}
        required={required}
        type="date"
      />
    </label>
  );
}

function trainerName(
  locale: "ar" | "en",
  trainer: Readonly<{ displayNameAr: string; displayNameEn: string }> | null,
): string {
  return trainer ? (locale === "ar" ? trainer.displayNameAr : trainer.displayNameEn) : "—";
}

function withUnit(value: { toString(): string } | null | undefined, unit: string): string {
  return value ? `${value.toString()} ${unit}` : "—";
}

function formatMoney(locale: "ar" | "en", minor: number, currency: string): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(minor / 100);
}

function formatDate(locale: "ar" | "en", date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function formatDateTime(locale: "ar" | "en", date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Amman",
  }).format(date);
}
