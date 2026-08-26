import { isSupportedLocale } from "@jormall/contracts/locales";
import { gymExperienceLevels, gymGoals } from "@jormall/domain/gym";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../../components/feedback";
import { SubmitButton } from "../../../../../components/submit-button";
import { phaseOneMessages } from "../../../../../messages/phase-one";
import { sectorMessages, sectorValueLabel } from "../../../../../messages/sectors";
import {
  gymRepository,
  identityRepository,
  requireTenantAccess,
} from "../../../../../server/identity";
import { createGymTraineeAction } from "../actions";

export default async function GymTraineesPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/gym/trainees">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([requireTenantAccess(locale), searchParams]);
  const trainees = await gymRepository.listTrainees(access);
  const canManage = access.grants.some((grant) => grant.code === "gym.trainees.manage");
  const availableCustomers = canManage ? await gymRepository.listAvailableCustomers(access) : [];
  const staff = canManage ? await identityRepository.listStaff(access) : [];
  const settings = canManage ? await identityRepository.getSettings(access) : null;
  const trainers = staff.flatMap((membership) =>
    membership.staffProfile ? [membership.staffProfile] : [],
  );
  const messages = sectorMessages[locale];
  const phaseOne = phaseOneMessages[locale];
  const summary = {
    activePlans: trainees.filter((trainee) => trainee.workoutPlans.length > 0).length,
    assigned: trainees.filter((trainee) => trainee.trainer !== null).length,
    progress: trainees.filter((trainee) => trainee.progressEntries.length > 0).length,
  };

  return (
    <section className="page-stack gym-workspace" aria-labelledby="gym-trainees-title">
      <header className="page-heading trainee-directory-heading">
        <div>
          <p className="eyebrow">{messages.gym}</p>
          <h1 id="gym-trainees-title">{messages.gymTrainees}</h1>
          <p className="page-description">{messages.gymDescription}</p>
        </div>
        <div className="directory-visual" aria-hidden="true">
          <span>◎</span>
          <small>GYM</small>
        </div>
      </header>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />

      <dl className="trainee-summary-grid">
        <SummaryMetric
          icon="◎"
          label={locale === "ar" ? "إجمالي المتدرّبين" : "Total trainees"}
          value={trainees.length}
        />
        <SummaryMetric
          icon="✓"
          label={locale === "ar" ? "عندهم خطة نشطة" : "Active plans"}
          value={summary.activePlans}
        />
        <SummaryMetric
          icon="♙"
          label={locale === "ar" ? "مربوطين بمدرب" : "Assigned to coach"}
          value={summary.assigned}
        />
        <SummaryMetric
          icon="↗"
          label={locale === "ar" ? "سجّلوا تقدّم" : "Progress recorded"}
          value={summary.progress}
        />
      </dl>

      {canManage ? (
        <details
          className="panel action-disclosure trainee-add-disclosure"
          open={trainees.length === 0}
        >
          <summary>{messages.addTrainee}</summary>
          <div className="section-heading trainee-add-heading">
            <div>
              <p className="eyebrow">{messages.traineeProfile}</p>
              <h2 id="add-trainee-title">{messages.addTrainee}</h2>
            </div>
            <Link className="button button-secondary" href={`/${locale}/dashboard/customers`}>
              {locale === "ar" ? "إضافة عميل أولًا" : "Add a customer first"}
            </Link>
          </div>
          {availableCustomers.length > 0 ? (
            <form action={createGymTraineeAction} className="form-grid gym-profile-form">
              <input name="locale" type="hidden" value={locale} />
              <input name="currency" type="hidden" value={settings?.currency ?? "JOD"} />
              <label className="field">
                <span className="field-label">{messages.selectCustomer}</span>
                <select className="select" name="customerId" required>
                  {availableCustomers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">{messages.selectTrainer}</span>
                <select className="select" name="trainerStaffProfileId">
                  <option value="">{locale === "ar" ? "يحدد لاحقًا" : "Assign later"}</option>
                  {trainers.map((trainer) => (
                    <option key={trainer.id} value={trainer.id}>
                      {locale === "ar" ? trainer.displayNameAr : trainer.displayNameEn}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">{locale === "ar" ? "الهدف" : "Goal"}</span>
                <select className="select" name="goal" required>
                  {gymGoals.map((goal) => (
                    <option key={goal} value={goal}>
                      {sectorValueLabel(locale, goal)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">{messages.experience}</span>
                <select className="select" name="experienceLevel" required>
                  {gymExperienceLevels.map((level) => (
                    <option key={level} value={level}>
                      {sectorValueLabel(locale, level)}
                    </option>
                  ))}
                </select>
              </label>
              <NumberField label={messages.height} max="250" min="80" name="heightCm" />
              <NumberField
                label={messages.startingWeight}
                max="400"
                min="20"
                name="startingWeightKg"
              />
              <NumberField label={messages.targetWeight} max="400" min="20" name="targetWeightKg" />
              <label className="field">
                <span className="field-label">{messages.budget}</span>
                <input className="input" min="0" name="monthlyFoodBudgetMinor" type="number" />
                <small className="field-hint">{messages.foodBudgetHint}</small>
              </label>
              <label className="field field-span">
                <span className="field-label">{messages.profileNotes}</span>
                <textarea className="textarea" maxLength={4000} name="notes" rows={3} />
              </label>
              <div className="form-actions field-span">
                <SubmitButton>{messages.addTrainee}</SubmitButton>
              </div>
            </form>
          ) : (
            <p className="muted">{messages.noTrainees}</p>
          )}
        </details>
      ) : null}

      {trainees.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true" className="empty-state-icon">
            ◉
          </span>
          <p>{messages.noTrainees}</p>
        </div>
      ) : (
        <div className="card-grid trainee-card-grid">
          {trainees.map((trainee) => {
            const progress = trainee.progressEntries[0];
            return (
              <Link
                className="record-card trainee-card"
                href={`/${locale}/dashboard/gym/trainees/${trainee.id}`}
                key={trainee.id}
              >
                <div className="record-card-heading">
                  <div className="trainee-avatar" aria-hidden="true">
                    {trainee.customer.displayName.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <h2>{trainee.customer.displayName}</h2>
                    <p className="muted" dir="ltr">
                      {trainee.customer.contacts[0]?.originalValue ?? "—"}
                    </p>
                  </div>
                </div>
                <dl className="compact-details trainee-card-details">
                  <div>
                    <dt>{locale === "ar" ? "الهدف" : "Goal"}</dt>
                    <dd>{sectorValueLabel(locale, trainee.goal)}</dd>
                  </div>
                  <div>
                    <dt>{messages.trainer}</dt>
                    <dd>
                      {trainee.trainer
                        ? locale === "ar"
                          ? trainee.trainer.displayNameAr
                          : trainee.trainer.displayNameEn
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>{messages.latestProgress}</dt>
                    <dd>{progress ? `${progress.bodyWeightKg.toString()} kg` : "—"}</dd>
                  </div>
                </dl>
                <div className="trainee-card-progress" aria-hidden="true">
                  <span
                    style={{
                      inlineSize: `${cardProgress(trainee.startingWeightKg?.toNumber(), progress?.bodyWeightKg.toNumber(), trainee.targetWeightKg?.toNumber())}%`,
                    }}
                  />
                </div>
                <span className="text-link">
                  {locale === "ar" ? "فتح الملف ←" : "Open profile →"}
                </span>
              </Link>
            );
          })}
        </div>
      )}
      <p className="muted">{phaseOne.portalDescription}</p>
    </section>
  );
}

function SummaryMetric({
  icon,
  label,
  value,
}: Readonly<{ icon: string; label: string; value: number }>) {
  return (
    <div>
      <span aria-hidden="true">{icon}</span>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function cardProgress(
  start: number | undefined,
  current: number | undefined,
  target: number | undefined,
): number {
  if (start === undefined || current === undefined || target === undefined || start === target)
    return 0;
  return Math.round(Math.min(100, Math.max(0, ((current - start) / (target - start)) * 100)));
}

function NumberField({
  label,
  max,
  min,
  name,
}: Readonly<{ label: string; max: string; min: string; name: string }>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input className="input" max={max} min={min} name={name} step="0.1" type="number" />
    </label>
  );
}
