import { isSupportedLocale } from "@jormall/contracts/locales";
import { gymAvatarFrames, gymAvatarHairStyles, gymAvatarSkinTones } from "@jormall/domain/gym";
import { notFound } from "next/navigation";

import { Feedback } from "../../../components/feedback";
import { NumberStepper } from "../../../components/number-stepper";
import { SubmitButton } from "../../../components/submit-button";
import { TrainingAvatar } from "../../../components/training-avatar";
import { gymPortalMessages } from "../../../messages/gym-portal";
import { sectorValueLabel } from "../../../messages/sectors";
import { gymRepository } from "../../../server/identity";
import { requireSession } from "../../../server/session";
import { recordOwnProgressAction, recordOwnWorkoutAction, updateOwnAvatarAction } from "./actions";

export default async function TraineePortalPage({
  params,
  searchParams,
}: PageProps<"/[locale]/trainee">) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  if (!isSupportedLocale(locale)) notFound();
  const session = await requireSession(locale);
  const portal = await gymRepository.getOwnPortal(session.user.id);
  const trainee = portal.trainee;
  const messages = gymPortalMessages[locale];
  const workoutPlan = trainee.workoutPlans[0];
  const nutritionPlan = trainee.nutritionPlans[0];
  const latestProgress = trainee.progressEntries[0];
  const weekday = weekdayIn(portal.organization.settings?.timezone ?? "Asia/Amman");
  const todayExercises =
    workoutPlan?.exercises.filter((exercise) => exercise.weekday === weekday) ?? [];
  const latestWeight = latestProgress?.bodyWeightKg ?? trainee.startingWeightKg;
  const progressPercent = weightProgress(
    trainee.startingWeightKg?.toNumber(),
    latestWeight?.toNumber(),
    trainee.targetWeightKg?.toNumber(),
  );

  return (
    <section className="trainee-portal-page" aria-labelledby="trainee-dashboard-title">
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <section className="trainee-welcome">
        <div className="trainee-welcome-copy">
          <p className="eyebrow">{messages.greeting}</p>
          <h1 id="trainee-dashboard-title">{trainee.customer.displayName}</h1>
          <p>
            {sectorValueLabel(locale, trainee.goal)} · {messages.trainer}:{" "}
            {trainee.trainer
              ? locale === "ar"
                ? trainee.trainer.displayNameAr
                : trainee.trainer.displayNameEn
              : "—"}
          </p>
          <div
            className="trainee-goal-track"
            aria-label={`${messages.progress} ${progressPercent}%`}
          >
            <span style={{ inlineSize: `${progressPercent}%` }} />
          </div>
          <dl className="trainee-inline-stats">
            <Metric label={messages.latestWeight} value={weightLabel(latestWeight)} />
            <Metric label={messages.target} value={weightLabel(trainee.targetWeightKg)} />
            <Metric
              label={messages.activePlan}
              value={
                workoutPlan ? (locale === "ar" ? workoutPlan.titleAr : workoutPlan.titleEn) : "—"
              }
            />
          </dl>
        </div>
        <TrainingAvatar
          frame={trainee.avatarFrame}
          hairStyle={trainee.avatarHairStyle}
          label={messages.avatar}
          shirtColor={trainee.avatarShirtColor}
          skinTone={trainee.avatarSkinTone}
        />
      </section>

      <div className="trainee-quick-grid">
        <section className="trainee-panel trainee-today" aria-labelledby="today-workout-title">
          <div className="trainee-section-heading">
            <div>
              <p className="eyebrow">{weekdayLabel(locale, weekday)}</p>
              <h2 id="today-workout-title">{messages.todayWorkout}</h2>
            </div>
            <span className="trainee-count">
              {todayExercises.length} {messages.exercises}
            </span>
          </div>
          {todayExercises.length === 0 ? (
            <p className="trainee-empty">{messages.emptyToday}</p>
          ) : (
            <div className="trainee-exercise-stack">
              {todayExercises.map((exercise, index) => (
                <article className="trainee-exercise" key={exercise.id}>
                  <span className="exercise-order">{String(index + 1).padStart(2, "0")}</span>
                  <div className="exercise-copy">
                    <h3>{locale === "ar" ? exercise.nameAr : exercise.nameEn}</h3>
                    <p>
                      {exercise.sets} × {exercise.repsMin}–{exercise.repsMax} ·{" "}
                      {exercise.restSeconds}s {messages.rest}
                    </p>
                  </div>
                  <strong className="exercise-target">
                    {weightLabel(exercise.targetWeightKg)}
                  </strong>
                  <details className="trainee-log-disclosure">
                    <summary>{messages.logSet}</summary>
                    <form action={recordOwnWorkoutAction} className="trainee-log-form">
                      <input name="locale" type="hidden" value={locale} />
                      <input name="workoutExerciseId" type="hidden" value={exercise.id} />
                      <NumberStepper
                        defaultValue={exercise.sets}
                        label={messages.sets}
                        max={30}
                        min={1}
                        name="actualSets"
                        required
                        step={1}
                      />
                      <NumberStepper
                        defaultValue={exercise.repsMin}
                        label={messages.reps}
                        max={500}
                        min={1}
                        name="actualReps"
                        required
                        step={1}
                      />
                      <NumberStepper
                        defaultValue={exercise.targetWeightKg?.toNumber() ?? 0}
                        label={messages.weight}
                        max={1000}
                        min={0}
                        name="actualWeightKg"
                        step={2.5}
                        unit="kg"
                      />
                      <NumberStepper
                        defaultValue={7}
                        label={locale === "ar" ? "المجهود" : "Effort"}
                        max={10}
                        min={1}
                        name="perceivedEffort"
                        step={1}
                      />
                      <SubmitButton>{messages.logSet}</SubmitButton>
                    </form>
                  </details>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="trainee-panel measurement-panel" aria-labelledby="measurement-title">
          <p className="eyebrow">{messages.progress}</p>
          <h2 id="measurement-title">{messages.addMeasurement}</h2>
          <form action={recordOwnProgressAction} className="measurement-form">
            <input name="locale" type="hidden" value={locale} />
            <NumberStepper
              defaultValue={latestWeight?.toNumber() ?? 70}
              label={messages.bodyWeight}
              max={400}
              min={20}
              name="bodyWeightKg"
              required
              step={0.1}
              unit="kg"
            />
            <label className="field">
              <span className="field-label">{messages.bodyFat}</span>
              <input
                className="input"
                max="80"
                min="1"
                name="bodyFatPercent"
                step="0.1"
                type="number"
              />
            </label>
            <label className="field">
              <span className="field-label">{messages.waist}</span>
              <input className="input" max="300" min="20" name="waistCm" step="0.1" type="number" />
            </label>
            <SubmitButton>{messages.saveMeasurement}</SubmitButton>
          </form>
        </section>
      </div>

      <div className="trainee-lower-grid">
        <section className="trainee-panel nutrition-dashboard" aria-labelledby="nutrition-title">
          <div className="trainee-section-heading">
            <div>
              <p className="eyebrow">{messages.foodBudget}</p>
              <h2 id="nutrition-title">{messages.macros}</h2>
            </div>
            {nutritionPlan ? (
              <strong>
                {money(locale, nutritionPlan.dailyBudgetMinor, nutritionPlan.currency)} /{" "}
                {locale === "ar" ? "يوم" : "day"}
              </strong>
            ) : null}
          </div>
          {nutritionPlan ? (
            <>
              <div className="macro-grid">
                <Macro label={messages.calories} value={`${nutritionPlan.dailyCalories}`} />
                <Macro
                  label={locale === "ar" ? "البروتين" : "Protein"}
                  value={`${nutritionPlan.proteinGrams}g`}
                />
                <Macro
                  label={locale === "ar" ? "الكربوهيدرات" : "Carbs"}
                  value={`${nutritionPlan.carbohydratesGrams}g`}
                />
                <Macro
                  label={locale === "ar" ? "الدهون" : "Fat"}
                  value={`${nutritionPlan.fatGrams}g`}
                />
              </div>
              <h3>{messages.meals}</h3>
              <div className="portal-meal-list">
                {nutritionPlan.meals.map((meal) => (
                  <article key={meal.id}>
                    <span>{locale === "ar" ? meal.timingLabelAr : meal.timingLabelEn}</span>
                    <strong>{locale === "ar" ? meal.nameAr : meal.nameEn}</strong>
                    <small>
                      {meal.calories} kcal ·{" "}
                      {money(locale, meal.estimatedCostMinor, nutritionPlan.currency)}
                    </small>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <p className="trainee-empty">{messages.noNutrition}</p>
          )}
        </section>

        <section className="trainee-panel avatar-settings" aria-labelledby="avatar-settings-title">
          <p className="eyebrow">{messages.customize}</p>
          <h2 id="avatar-settings-title">{messages.avatarStyle}</h2>
          <form action={updateOwnAvatarAction} className="avatar-settings-form">
            <input name="locale" type="hidden" value={locale} />
            <Select
              label={messages.avatarSkin}
              name="skinTone"
              options={gymAvatarSkinTones}
              value={trainee.avatarSkinTone}
              locale={locale}
            />
            <Select
              label={messages.avatarFrame}
              name="frame"
              options={gymAvatarFrames}
              value={trainee.avatarFrame}
              locale={locale}
            />
            <Select
              label={messages.avatarHair}
              name="hairStyle"
              options={gymAvatarHairStyles}
              value={trainee.avatarHairStyle}
              locale={locale}
            />
            <label className="field color-field">
              <span className="field-label">{messages.shirtColor}</span>
              <input defaultValue={trainee.avatarShirtColor} name="shirtColor" type="color" />
            </label>
            <SubmitButton>{messages.saveAppearance}</SubmitButton>
          </form>
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

function Macro({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Select<T extends string>({
  label,
  locale,
  name,
  options,
  value,
}: Readonly<{
  label: string;
  locale: "ar" | "en";
  name: string;
  options: readonly T[];
  value: T;
}>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select className="select" defaultValue={value} name={name}>
        {options.map((option) => (
          <option key={option} value={option}>
            {appearanceLabel(locale, option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function appearanceLabel(locale: "ar" | "en", value: string): string {
  const labels: Readonly<Record<string, readonly [string, string]>> = {
    ATHLETIC: ["Athletic", "رياضية"],
    BALD: ["Bald", "بدون شعر"],
    BROAD: ["Broad", "عريضة"],
    COVERED: ["Covered", "غطاء رأس"],
    CURLY: ["Curly", "مجعّد"],
    DARK: ["Dark", "داكنة"],
    LIGHT: ["Light", "فاتحة"],
    MEDIUM: ["Medium", "متوسطة"],
    SHORT: ["Short", "قصير"],
    SLIM: ["Slim", "نحيفة"],
    TAN: ["Tan", "قمحية"],
  };
  const label = labels[value];
  return label ? label[locale === "ar" ? 1 : 0] : sectorValueLabel(locale, value);
}

function weekdayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" })
    .format(new Date())
    .toUpperCase();
}

function weekdayLabel(locale: "ar" | "en", weekday: string): string {
  return sectorValueLabel(locale, weekday);
}

function weightLabel(value: { toString(): string } | null | undefined): string {
  return value ? `${value.toString()} kg` : "—";
}

function weightProgress(
  start: number | undefined,
  current: number | undefined,
  target: number | undefined,
): number {
  if (start === undefined || current === undefined || target === undefined || start === target)
    return 0;
  return Math.round(Math.min(100, Math.max(0, ((current - start) / (target - start)) * 100)));
}

function money(locale: "ar" | "en", minor: number, currency: string): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    currency,
    style: "currency",
  }).format(minor / 100);
}
