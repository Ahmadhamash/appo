import { randomUUID } from "node:crypto";

import { isSupportedLocale, type SupportedLocale } from "@jormall/contracts/locales";
import {
  getPredictiveRepository,
  type TenantAccessSelection,
} from "@jormall/db/predictive-repository";
import {
  predictionFeedbackTypes,
  predictiveCapabilities,
  type PredictiveCapability,
} from "@jormall/domain/predictive";
import { notFound, redirect } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import {
  phaseEightCapabilityLabel,
  phaseEightFactorLabel,
  phaseEightFeedbackLabel,
  phaseEightMessages,
  phaseEightRefusalLabel,
  phaseEightSafeErrorLabel,
  phaseEightValueLabel,
} from "../../../../messages/phase-eight";
import type { JorMallSession } from "../../../../server/auth";
import { identityRepository, requireTenantAccess } from "../../../../server/identity";
import { requireSession } from "../../../../server/session";
import {
  recordPredictionFeedbackAction,
  requestPredictiveJobAction,
  updatePredictiveCapabilityAction,
} from "../../phase-eight-actions";

const predictiveRepository = getPredictiveRepository();
const predictiveJobTypes = [
  "DATA_AUDIT",
  "FEATURE_COMPUTE",
  "GENERATE",
  "BACKTEST",
  "DRIFT",
] as const;

type PredictiveOverview = Awaited<ReturnType<typeof predictiveRepository.getOverview>>;
type Prediction = PredictiveOverview["predictions"][number];
type PhaseEightMessages = (typeof phaseEightMessages)[SupportedLocale];
type ArtifactReferenceNames = Readonly<{
  branches: ReadonlyMap<string, string>;
  providers: ReadonlyMap<string, string>;
  selfProviderId: string | null;
  services: ReadonlyMap<string, string>;
}>;

export default async function PredictionsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/predictions">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const access = await requireTenantAccess(locale);
  if (!access.grants.some(({ code }) => code === "predictions.read")) {
    redirect(`/${locale}/dashboard?error=FORBIDDEN`);
  }
  const session = await requireSession(locale);
  const canConfigure = access.grants.some(({ code }) => code === "predictions.configure");
  const runGrant = access.grants.find(({ code }) => code === "predictions.run");
  const canRun = runGrant !== undefined;
  const canGiveFeedback = access.grants.some(({ code }) => code === "predictions.feedback");
  const canReadBranches = access.grants.some(({ code }) => code === "branches.read");
  const canReadServices = access.grants.some(({ code }) => code === "services.read");
  const canReadOrganizationStaff = access.grants.some(
    ({ code, scope }) => code === "staff.read" && scope === "ORGANIZATION",
  );
  const [overview, query, availableBranches, services, staff] = await Promise.all([
    predictiveRepository.getOverview(selectionFromSession(session), session.user.id),
    searchParams,
    canReadBranches ? identityRepository.listBranches(access) : Promise.resolve([]),
    canReadServices ? identityRepository.listServices(access) : Promise.resolve([]),
    canReadOrganizationStaff ? identityRepository.listStaff(access) : Promise.resolve([]),
  ]);
  const branches =
    runGrant?.scope === "ORGANIZATION"
      ? availableBranches
      : availableBranches.filter(({ id }) => access.assignedBranchIds.includes(id));
  const messages = phaseEightMessages[locale];
  const referenceNames: ArtifactReferenceNames = {
    branches: new Map(
      availableBranches.map((branch) => [
        branch.id,
        locale === "ar" ? branch.nameAr : branch.nameEn,
      ]),
    ),
    providers: new Map(
      staff.flatMap((member) =>
        member.staffProfile
          ? [
              [
                member.staffProfile.id,
                locale === "ar"
                  ? member.staffProfile.displayNameAr
                  : member.staffProfile.displayNameEn,
              ] as const,
            ]
          : [],
      ),
    ),
    selfProviderId: access.staffProfileId ?? null,
    services: new Map(
      services.map((service) => [service.id, locale === "ar" ? service.nameAr : service.nameEn]),
    ),
  };

  return (
    <section className="page-stack" aria-labelledby="predictions-title">
      <div>
        <p className="eyebrow">{messages.phaseLabel}</p>
        <h1 id="predictions-title">{messages.predictiveIntelligence}</h1>
        <p className="muted">{messages.advisoryBoundary}</p>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />

      <section className="page-stack" aria-labelledby="readiness-title">
        <div>
          <h2 id="readiness-title">{messages.dataAudit}</h2>
          <p className="muted">{messages.dataAuditDescription}</p>
        </div>
        <div className="card-grid">
          {predictiveCapabilities.map((capability) => {
            const configuration = overview.capabilities.find(
              (candidate) => candidate.capability === capability,
            );
            const latest = overview.predictions.find(
              (prediction) => prediction.capability === capability,
            );
            const refused = latest?.status === "REFUSED" || latest?.estimate === null;
            return (
              <article className="record-card" key={capability}>
                <div>
                  <span
                    className={`status ${
                      !configuration?.enabled || refused ? "status-suspended" : "status-active"
                    }`}
                  >
                    {!configuration?.enabled
                      ? messages.disabled
                      : refused
                        ? messages.insufficientData
                        : latest
                          ? messages.generated
                          : messages.readiness}
                  </span>
                  <h3>{phaseEightCapabilityLabel(locale, capability)}</h3>
                  {latest && refused ? (
                    <RefusalEvidence locale={locale} prediction={latest} />
                  ) : latest ? (
                    <p className="muted">
                      {booleanDetail(latest, "evidenceCountsRedacted") === true
                        ? messages.evidenceCountsWithheld
                        : `${messages.sampleSize}: ${formatNumber(locale, latest.sampleSize, 0)}`}
                    </p>
                  ) : (
                    <p className="muted">{messages.noReadinessEvidence}</p>
                  )}
                  {configuration ? (
                    <small>
                      {messages.updated}: {formatInstant(locale, configuration.updatedAt)} · v
                      {configuration.version}
                    </small>
                  ) : null}
                </div>
                {canConfigure && configuration ? (
                  <form action={updatePredictiveCapabilityAction} className="form-stack">
                    <input name="locale" type="hidden" value={locale} />
                    <input name="capability" type="hidden" value={capability} />
                    <input name="expectedVersion" type="hidden" value={configuration.version} />
                    <label className="field">
                      <span className="field-label">
                        {messages.enable} {phaseEightCapabilityLabel(locale, capability)}
                      </span>
                      <input
                        defaultChecked={configuration.enabled}
                        name="enabled"
                        type="checkbox"
                      />
                    </label>
                    <SubmitButton tone="secondary">{messages.saveSettings}</SubmitButton>
                  </form>
                ) : null}
              </article>
            );
          })}
        </div>
        {canConfigure ? <p className="muted">{messages.settingsDescription}</p> : null}
      </section>

      {canRun ? (
        <section className="panel page-stack" aria-labelledby="job-request-title">
          <div>
            <h2 id="job-request-title">{messages.queueJob}</h2>
            <p className="muted">{messages.refusalDescription}</p>
          </div>
          <form action={requestPredictiveJobAction} className="form-grid">
            <input name="locale" type="hidden" value={locale} />
            <input name="idempotencyKey" type="hidden" value={randomUUID()} />
            <label className="field">
              <span className="field-label">{messages.capability}</span>
              <select className="select" name="capability" required>
                {predictiveCapabilities.map((capability) => (
                  <option key={capability} value={capability}>
                    {phaseEightCapabilityLabel(locale, capability)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{messages.jobType}</span>
              <select className="select" name="jobType" required>
                {predictiveJobTypes.map((jobType) => (
                  <option key={jobType} value={jobType}>
                    {phaseEightValueLabel(locale, jobType)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{messages.branchScope}</span>
              <select
                className="select"
                name="branchId"
                required={runGrant?.scope !== "ORGANIZATION"}
              >
                <option disabled={runGrant?.scope !== "ORGANIZATION"} value="">
                  {messages.allAuthorizedBranches}
                </option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {locale === "ar" ? branch.nameAr : branch.nameEn}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{messages.serviceScope}</span>
              <select className="select" name="serviceId">
                <option value="">{messages.allServices}</option>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {locale === "ar" ? service.nameAr : service.nameEn}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{messages.appointmentTarget}</span>
              <input
                className="input"
                dir="ltr"
                maxLength={36}
                minLength={36}
                name="appointmentId"
              />
            </label>
            <label className="field">
              <span className="field-label">{messages.startsOn}</span>
              <input className="input" name="startsOn" type="date" />
            </label>
            <label className="field">
              <span className="field-label">{messages.endsOn}</span>
              <input className="input" name="endsOn" type="date" />
            </label>
            <p className="muted">{messages.dateRangeHint}</p>
            <p className="muted">{messages.jobTargetHint}</p>
            <div className="form-actions">
              <SubmitButton>{messages.queueJob}</SubmitButton>
            </div>
          </form>
        </section>
      ) : null}

      <JobHistory locale={locale} overview={overview} />
      <PredictionArtifacts
        canGiveFeedback={canGiveFeedback}
        locale={locale}
        overview={overview}
        referenceNames={referenceNames}
      />
      <EvaluationHistory locale={locale} overview={overview} />
      <DriftHistory locale={locale} overview={overview} />
    </section>
  );
}

function selectionFromSession(session: JorMallSession): TenantAccessSelection {
  return {
    ...(session.session.activeMembershipId
      ? { activeMembershipId: session.session.activeMembershipId }
      : {}),
    ...(session.session.activeOrganizationId
      ? { activeOrganizationId: session.session.activeOrganizationId }
      : {}),
    ...(session.session.activeSupportAccessId
      ? { activeSupportAccessId: session.session.activeSupportAccessId }
      : {}),
  };
}

function RefusalEvidence({
  locale,
  prediction,
}: Readonly<{ locale: SupportedLocale; prediction: Prediction }>) {
  const messages = phaseEightMessages[locale];
  const evidenceCountsRedacted = booleanDetail(prediction, "evidenceCountsRedacted") === true;
  return (
    <div className="feedback feedback-info" role="status">
      <strong>{messages.refusal}</strong>
      <p>
        {prediction.refusalReason
          ? phaseEightRefusalLabel(locale, prediction.refusalReason)
          : messages.refusalDescription}
      </p>
      <small>
        {evidenceCountsRedacted ? (
          messages.evidenceCountsWithheld
        ) : (
          <>
            {messages.sampleSize}: {prediction.sampleSize}
            {prediction.required !== null ? (
              <>
                {" · "}
                {messages.required}: {prediction.required}
              </>
            ) : null}
          </>
        )}
      </small>
    </div>
  );
}

function JobHistory({
  locale,
  overview,
}: Readonly<{ locale: SupportedLocale; overview: PredictiveOverview }>) {
  const messages = phaseEightMessages[locale];
  return (
    <section className="panel page-stack" aria-labelledby="predictive-jobs-title">
      <h2 id="predictive-jobs-title">{messages.featureJobs}</h2>
      {overview.jobs.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{messages.featureJobs}</caption>
            <thead>
              <tr>
                <th>{messages.capability}</th>
                <th>{messages.jobType}</th>
                <th>{messages.status}</th>
                <th>{messages.progress}</th>
                <th>{messages.submittedAt}</th>
              </tr>
            </thead>
            <tbody>
              {overview.jobs.map((job) => (
                <tr key={job.id}>
                  <td>{phaseEightCapabilityLabel(locale, job.capability)}</td>
                  <td>{phaseEightValueLabel(locale, job.jobType)}</td>
                  <td>
                    <span
                      className={`status ${
                        job.status === "FAILED" || job.status === "DEAD_LETTER"
                          ? "status-suspended"
                          : "status-active"
                      }`}
                    >
                      {phaseEightValueLabel(locale, job.status)}
                    </span>
                    {job.safeErrorCode ? (
                      <small> · {phaseEightSafeErrorLabel(locale, job.safeErrorCode)}</small>
                    ) : null}
                  </td>
                  <td>
                    {job.totalRows > 0 ? (
                      <label className="field">
                        <span className="sr-only">{messages.progress}</span>
                        <progress max={job.totalRows} value={job.processedRows} />
                        <small>
                          {job.processedRows}/{job.totalRows}
                        </small>
                      </label>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <time dateTime={job.createdAt}>{formatInstant(locale, job.createdAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">{messages.noJobs}</p>
      )}
    </section>
  );
}

function PredictionArtifacts({
  canGiveFeedback,
  locale,
  overview,
  referenceNames,
}: Readonly<{
  canGiveFeedback: boolean;
  locale: SupportedLocale;
  overview: PredictiveOverview;
  referenceNames: ArtifactReferenceNames;
}>) {
  const messages = phaseEightMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="prediction-artifacts-title">
      <h2 id="prediction-artifacts-title">{messages.artifacts}</h2>
      {overview.predictions.length ? (
        <div className="card-grid">
          {overview.predictions.map((prediction) => {
            const refused = prediction.status === "REFUSED" || prediction.estimate === null;
            return (
              <article className="record-card" key={prediction.id}>
                <div>
                  <span className={`status ${refused ? "status-suspended" : "status-active"}`}>
                    {phaseEightValueLabel(locale, prediction.status)}
                  </span>
                  <h3>{phaseEightCapabilityLabel(locale, prediction.capability)}</h3>
                  {refused ? (
                    <RefusalEvidence locale={locale} prediction={prediction} />
                  ) : (
                    <CapabilityResult
                      locale={locale}
                      prediction={prediction}
                      referenceNames={referenceNames}
                    />
                  )}
                  <PredictionReferences
                    locale={locale}
                    prediction={prediction}
                    referenceNames={referenceNames}
                  />
                  {!refused && prediction.capability === "STAFFING" ? (
                    <p className="feedback feedback-info">{messages.staffingSuggestionOnly}</p>
                  ) : null}
                  {!refused && prediction.capability === "SCHEDULE_REFLOW" ? (
                    <p className="feedback feedback-info">{messages.suggestionOnly}</p>
                  ) : null}
                  {!refused && prediction.capability === "SERVICE_PROVIDER_RECOMMENDATION" ? (
                    <p className="feedback feedback-info">{messages.recommendationOnly}</p>
                  ) : null}
                  <PredictionProvenance locale={locale} prediction={prediction} />
                  <details>
                    <summary>{messages.recordedEvidence}</summary>
                    <dl className="details-list">
                      <div>
                        <dt>{messages.modelVersion}</dt>
                        <dd>
                          {prediction.modelIdentifier} · v{prediction.modelVersion}
                        </dd>
                      </div>
                    </dl>
                  </details>
                </div>
                {canGiveFeedback ? (
                  <form action={recordPredictionFeedbackAction} className="form-stack">
                    <input name="locale" type="hidden" value={locale} />
                    <input name="predictionId" type="hidden" value={prediction.id} />
                    <label className="field">
                      <span className="field-label">{messages.feedback}</span>
                      <input
                        className="input"
                        maxLength={500}
                        name="comment"
                        placeholder={messages.feedbackNote}
                      />
                    </label>
                    <div className="row-actions">
                      {predictionFeedbackTypes.map((feedbackType) => (
                        <SubmitButton
                          key={feedbackType}
                          name="feedbackType"
                          tone="secondary"
                          value={feedbackType}
                        >
                          {phaseEightFeedbackLabel(locale, feedbackType)}
                        </SubmitButton>
                      ))}
                    </div>
                  </form>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="muted">{messages.noArtifacts}</p>
      )}
    </section>
  );
}

function CapabilityResult({
  locale,
  prediction,
  referenceNames,
}: Readonly<{
  locale: SupportedLocale;
  prediction: Prediction;
  referenceNames: ArtifactReferenceNames;
}>) {
  if (prediction.estimate === null) return null;
  const messages = phaseEightMessages[locale];
  const evidenceCountsRedacted = booleanDetail(prediction, "evidenceCountsRedacted") === true;
  const showInterval =
    (prediction.capability === "DEMAND_FORECAST" || prediction.capability === "STAFFING") &&
    prediction.lowerBound !== null &&
    prediction.upperBound !== null;
  return (
    <>
      <dl className="details-list">
        <div>
          <dt>{capabilityEstimateLabel(locale, prediction.capability)}</dt>
          <dd>
            <strong>
              {formatCapabilityEstimate(locale, prediction.capability, prediction.estimate)}
            </strong>
          </dd>
        </div>
        {showInterval ? (
          <div>
            <dt>{capabilityIntervalLabel(locale, prediction)}</dt>
            <dd>
              {formatCapabilityEstimate(locale, prediction.capability, prediction.lowerBound)}
              {" – "}
              {formatCapabilityEstimate(locale, prediction.capability, prediction.upperBound)}
            </dd>
          </div>
        ) : null}
        {evidenceCountsRedacted ? (
          <div>
            <dt>{messages.recordedEvidence}</dt>
            <dd>{messages.evidenceCountsWithheld}</dd>
          </div>
        ) : (
          <div>
            <dt>{messages.sampleSize}</dt>
            <dd>{formatNumber(locale, prediction.sampleSize, 0)}</dd>
          </div>
        )}
      </dl>
      <CapabilityOperationalDetails
        locale={locale}
        prediction={prediction}
        referenceNames={referenceNames}
      />
      {prediction.explanation.length ? (
        <div>
          <h4>{messages.explanations}</h4>
          <ul className="history-list">
            {prediction.explanation.map((factor) => (
              <li key={factor.code}>
                <strong>{phaseEightFactorLabel(locale, factor.code)}</strong>
                <span>{phaseEightValueLabel(locale, factor.direction)}</span>
                <small>
                  {formatContribution(locale, factor.contribution)}
                  {!evidenceCountsRedacted ? (
                    <>
                      {" · "}
                      {messages.sampleSize}: {formatNumber(locale, factor.sampleSize, 0)}
                    </>
                  ) : null}
                </small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function CapabilityOperationalDetails({
  locale,
  prediction,
  referenceNames,
}: Readonly<{
  locale: SupportedLocale;
  prediction: Prediction;
  referenceNames: ArtifactReferenceNames;
}>) {
  switch (prediction.capability) {
    case "NO_SHOW":
      return <NoShowDetails locale={locale} prediction={prediction} />;
    case "DEMAND_FORECAST":
      return <DemandDetails locale={locale} prediction={prediction} />;
    case "STAFFING":
      return <StaffingDetails locale={locale} prediction={prediction} />;
    case "SCHEDULE_REFLOW":
      return <ReflowDetails locale={locale} prediction={prediction} />;
    case "SERVICE_PROVIDER_RECOMMENDATION":
      return (
        <RecommendationDetails
          locale={locale}
          prediction={prediction}
          referenceNames={referenceNames}
        />
      );
  }
}

function NoShowDetails({
  locale,
  prediction,
}: Readonly<{ locale: SupportedLocale; prediction: Prediction }>) {
  const messages = phaseEightMessages[locale];
  const scheduledStartsAt = stringDetail(prediction, "scheduledStartsAt");
  const appointmentVersion = numberDetail(prediction, "appointmentVersion");
  const baselineProbability = numberDetail(prediction, "baselineProbability");
  const timezone = stringDetail(prediction, "timezone");
  if (!scheduledStartsAt && appointmentVersion === null && baselineProbability === null)
    return null;
  return (
    <dl className="details-list" aria-label={messages.noShowContext}>
      {baselineProbability !== null ? (
        <div>
          <dt>{messages.organizationBaseRate}</dt>
          <dd>{formatCapabilityEstimate(locale, "NO_SHOW", baselineProbability)}</dd>
        </div>
      ) : null}
      {scheduledStartsAt ? (
        <div>
          <dt>{messages.scheduledAppointment}</dt>
          <dd>
            <time dateTime={scheduledStartsAt}>
              {formatInstantInTimezone(locale, scheduledStartsAt, timezone)}
            </time>
          </dd>
        </div>
      ) : null}
      {timezone ? <TimezoneDetail label={messages.timezone} timezone={timezone} /> : null}
      {appointmentVersion !== null ? (
        <div>
          <dt>{messages.appointmentVersion}</dt>
          <dd>{formatNumber(locale, appointmentVersion, 0)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function DemandDetails({
  locale,
  prediction,
}: Readonly<{ locale: SupportedLocale; prediction: Prediction }>) {
  const messages = phaseEightMessages[locale];
  const localDate = stringDetail(prediction, "localDate");
  const localHour = numberDetail(prediction, "localHour");
  const timezone = stringDetail(prediction, "timezone");
  const fallbackLevel = stringDetail(prediction, "fallbackLevel");
  const sampleWeeks = numberDetail(prediction, "sampleWeeks");
  const isHoliday = booleanDetail(prediction, "isHoliday");
  const calendarAdjustment = numberDetail(prediction, "calendarAdjustment");
  const scope = stringDetail(prediction, "scope");
  const componentCount = numberDetail(prediction, "componentCount");
  const branchCount = numberDetail(prediction, "branchCount");
  const serviceCount = numberDetail(prediction, "serviceCount");
  return (
    <dl className="details-list" aria-label={messages.demandContext}>
      {scope === "ORGANIZATION" ? (
        <div>
          <dt>{messages.authorizedScope}</dt>
          <dd>{messages.organizationDemandAggregate}</dd>
        </div>
      ) : null}
      {localDate && localHour !== null ? (
        <div>
          <dt>{messages.localDemandBucket}</dt>
          <dd>{formatLocalBucket(locale, localDate, localHour)}</dd>
        </div>
      ) : null}
      {timezone ? <TimezoneDetail label={messages.timezone} timezone={timezone} /> : null}
      {fallbackLevel ? (
        <div>
          <dt>{messages.fallbackLevel}</dt>
          <dd>{phaseEightValueLabel(locale, fallbackLevel)}</dd>
        </div>
      ) : null}
      {sampleWeeks !== null ? (
        <div>
          <dt>{messages.sampleWeeks}</dt>
          <dd>{formatNumber(locale, sampleWeeks, 0)}</dd>
        </div>
      ) : null}
      {isHoliday !== null ? (
        <div>
          <dt>{messages.holidayBucket}</dt>
          <dd>{isHoliday ? messages.yes : messages.no}</dd>
        </div>
      ) : null}
      {calendarAdjustment !== null ? (
        <div>
          <dt>{messages.calendarAdjustment}</dt>
          <dd>
            <bdi dir="ltr">×{formatNumber(locale, calendarAdjustment, 2)}</bdi>
          </dd>
        </div>
      ) : null}
      {componentCount !== null ? (
        <div>
          <dt>{messages.componentForecasts}</dt>
          <dd>{formatNumber(locale, componentCount, 0)}</dd>
        </div>
      ) : null}
      {branchCount !== null ? (
        <div>
          <dt>{messages.branchesIncluded}</dt>
          <dd>{formatNumber(locale, branchCount, 0)}</dd>
        </div>
      ) : null}
      {serviceCount !== null ? (
        <div>
          <dt>{messages.servicesIncluded}</dt>
          <dd>{formatNumber(locale, serviceCount, 0)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function StaffingDetails({
  locale,
  prediction,
}: Readonly<{ locale: SupportedLocale; prediction: Prediction }>) {
  const messages = phaseEightMessages[locale];
  const action = stringDetail(prediction, "action");
  const availableMinutes = numberDetail(prediction, "availableMinutes");
  const timezone = stringDetail(prediction, "timezone");
  return (
    <dl className="details-list" aria-label={messages.staffingContext}>
      {action ? (
        <div>
          <dt>{messages.staffingAction}</dt>
          <dd>{phaseEightValueLabel(locale, action)}</dd>
        </div>
      ) : null}
      {availableMinutes !== null ? (
        <div>
          <dt>{messages.availableMinutes}</dt>
          <dd>{formatMinutes(locale, availableMinutes)}</dd>
        </div>
      ) : null}
      {timezone ? <TimezoneDetail label={messages.timezone} timezone={timezone} /> : null}
      <PredictionHorizon locale={locale} prediction={prediction} timezone={timezone} />
    </dl>
  );
}

function ReflowDetails({
  locale,
  prediction,
}: Readonly<{ locale: SupportedLocale; prediction: Prediction }>) {
  const messages = phaseEightMessages[locale];
  const slotStartsAt = stringDetail(prediction, "slotStartsAt");
  const timezone = stringDetail(prediction, "timezone");
  const appointmentVersion = numberDetail(prediction, "appointmentVersion");
  const customerConfirmation = booleanDetail(prediction, "requiresCustomerConfirmation");
  const staffConfirmation = booleanDetail(prediction, "requiresStaffConfirmation");
  return (
    <dl className="details-list" aria-label={messages.reflowContext}>
      {slotStartsAt ? (
        <div>
          <dt>{messages.candidateTime}</dt>
          <dd>
            <time dateTime={slotStartsAt}>
              {formatInstantInTimezone(locale, slotStartsAt, timezone)}
            </time>
          </dd>
        </div>
      ) : null}
      {timezone ? <TimezoneDetail label={messages.timezone} timezone={timezone} /> : null}
      {appointmentVersion !== null ? (
        <div>
          <dt>{messages.appointmentVersion}</dt>
          <dd>{formatNumber(locale, appointmentVersion, 0)}</dd>
        </div>
      ) : null}
      <ConfirmationDetails
        customerConfirmation={customerConfirmation}
        locale={locale}
        staffConfirmation={staffConfirmation}
      />
    </dl>
  );
}

function RecommendationDetails({
  locale,
  prediction,
  referenceNames,
}: Readonly<{
  locale: SupportedLocale;
  prediction: Prediction;
  referenceNames: ArtifactReferenceNames;
}>) {
  const messages = phaseEightMessages[locale];
  const slotStartsAt = stringDetail(prediction, "slotStartsAt");
  const timezone = stringDetail(prediction, "timezone");
  const customerConfirmation = booleanDetail(prediction, "requiresCustomerConfirmation");
  const staffConfirmation = booleanDetail(prediction, "requiresStaffConfirmation");
  return (
    <dl className="details-list" aria-label={messages.recommendationContext}>
      {prediction.serviceId ? (
        <div>
          <dt>{messages.service}</dt>
          <dd>{resolveServiceName(prediction.serviceId, referenceNames, messages)}</dd>
        </div>
      ) : null}
      {prediction.providerId ? (
        <div>
          <dt>{messages.provider}</dt>
          <dd>{resolveProviderName(prediction.providerId, referenceNames, messages)}</dd>
        </div>
      ) : null}
      {slotStartsAt ? (
        <div>
          <dt>{messages.recommendedSlot}</dt>
          <dd>
            <time dateTime={slotStartsAt}>
              {formatInstantInTimezone(locale, slotStartsAt, timezone)}
            </time>
          </dd>
        </div>
      ) : null}
      {timezone ? <TimezoneDetail label={messages.timezone} timezone={timezone} /> : null}
      <ConfirmationDetails
        customerConfirmation={customerConfirmation}
        locale={locale}
        staffConfirmation={staffConfirmation}
      />
    </dl>
  );
}

function ConfirmationDetails({
  customerConfirmation,
  locale,
  staffConfirmation,
}: Readonly<{
  customerConfirmation: boolean | null;
  locale: SupportedLocale;
  staffConfirmation: boolean | null;
}>) {
  const messages = phaseEightMessages[locale];
  return (
    <>
      {customerConfirmation !== null ? (
        <div>
          <dt>{messages.customerConfirmation}</dt>
          <dd>{customerConfirmation ? messages.requiredConfirmation : messages.notRequired}</dd>
        </div>
      ) : null}
      {staffConfirmation !== null ? (
        <div>
          <dt>{messages.staffConfirmation}</dt>
          <dd>{staffConfirmation ? messages.requiredConfirmation : messages.notRequired}</dd>
        </div>
      ) : null}
    </>
  );
}

function TimezoneDetail({ label, timezone }: Readonly<{ label: string; timezone: string }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <bdi dir="ltr">{timezone}</bdi>
      </dd>
    </div>
  );
}

function PredictionHorizon({
  locale,
  prediction,
  timezone,
}: Readonly<{
  locale: SupportedLocale;
  prediction: Prediction;
  timezone: string | null;
}>) {
  const messages = phaseEightMessages[locale];
  return (
    <>
      {prediction.horizonStartsAt ? (
        <div>
          <dt>{messages.horizonStarts}</dt>
          <dd>
            <time dateTime={prediction.horizonStartsAt}>
              {formatInstantInTimezone(locale, prediction.horizonStartsAt, timezone)}
            </time>
          </dd>
        </div>
      ) : null}
      {prediction.horizonEndsAt ? (
        <div>
          <dt>{messages.horizonEnds}</dt>
          <dd>
            <time dateTime={prediction.horizonEndsAt}>
              {formatInstantInTimezone(locale, prediction.horizonEndsAt, timezone)}
            </time>
          </dd>
        </div>
      ) : null}
    </>
  );
}

function PredictionReferences({
  locale,
  prediction,
  referenceNames,
}: Readonly<{
  locale: SupportedLocale;
  prediction: Prediction;
  referenceNames: ArtifactReferenceNames;
}>) {
  const messages = phaseEightMessages[locale];
  const showService =
    prediction.serviceId !== null && prediction.capability !== "SERVICE_PROVIDER_RECOMMENDATION";
  const showProvider =
    prediction.providerId !== null && prediction.capability !== "SERVICE_PROVIDER_RECOMMENDATION";
  if (!prediction.branchId && !showService && !showProvider) return null;
  return (
    <dl className="details-list" aria-label={messages.authorizedScope}>
      {prediction.branchId ? (
        <div>
          <dt>{messages.branch}</dt>
          <dd>{resolveBranchName(prediction.branchId, referenceNames, messages)}</dd>
        </div>
      ) : null}
      {showService && prediction.serviceId ? (
        <div>
          <dt>{messages.service}</dt>
          <dd>{resolveServiceName(prediction.serviceId, referenceNames, messages)}</dd>
        </div>
      ) : null}
      {showProvider && prediction.providerId ? (
        <div>
          <dt>{messages.provider}</dt>
          <dd>{resolveProviderName(prediction.providerId, referenceNames, messages)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function PredictionProvenance({
  locale,
  prediction,
}: Readonly<{ locale: SupportedLocale; prediction: Prediction }>) {
  const messages = phaseEightMessages[locale];
  const timezone = stringDetail(prediction, "timezone");
  const configurationReadAt = stringDetail(prediction, "configurationReadAt");
  const historyCutoff = stringDetail(prediction, "historyCutoff");
  return (
    <dl className="details-list" aria-label={messages.predictionTiming}>
      <div>
        <dt>{messages.predictionAsOf}</dt>
        <dd>
          <time dateTime={prediction.asOf}>
            {formatInstantInTimezone(locale, prediction.asOf, timezone)}
          </time>
        </dd>
      </div>
      {historyCutoff ? (
        <div>
          <dt>{messages.historyCutoff}</dt>
          <dd>
            <time dateTime={historyCutoff}>
              {formatInstantInTimezone(locale, historyCutoff, timezone)}
            </time>
          </dd>
        </div>
      ) : null}
      {configurationReadAt ? (
        <div>
          <dt>{messages.configurationReadAt}</dt>
          <dd>
            <time dateTime={configurationReadAt}>
              {formatInstantInTimezone(locale, configurationReadAt, timezone)}
            </time>
          </dd>
        </div>
      ) : null}
      <div>
        <dt>{messages.generatedAt}</dt>
        <dd>
          <time dateTime={prediction.createdAt}>
            {formatInstantInTimezone(locale, prediction.createdAt, timezone)}
          </time>
        </dd>
      </div>
      <div>
        <dt>{messages.expiresAt}</dt>
        <dd>
          <time dateTime={prediction.expiresAt}>
            {formatInstantInTimezone(locale, prediction.expiresAt, timezone)}
          </time>
        </dd>
      </div>
    </dl>
  );
}

function EvaluationHistory({
  locale,
  overview,
}: Readonly<{ locale: SupportedLocale; overview: PredictiveOverview }>) {
  const messages = phaseEightMessages[locale];
  return (
    <section className="panel page-stack" aria-labelledby="evaluations-title">
      <h2 id="evaluations-title">{messages.backtests}</h2>
      {overview.evaluations.length ? (
        <div className="card-grid">
          {overview.evaluations.map((evaluation) => (
            <article className="record-card" key={evaluation.id}>
              <div>
                <span
                  className={`status ${
                    evaluation.outcome === "PASSED" ? "status-active" : "status-suspended"
                  }`}
                >
                  {phaseEightValueLabel(locale, evaluation.outcome)}
                </span>
                <h3>{phaseEightCapabilityLabel(locale, evaluation.capability)}</h3>
                <p>{phaseEightValueLabel(locale, evaluation.runType)}</p>
                <dl className="details-list">
                  {Object.entries(evaluation.metrics).map(([metric, result]) => (
                    <div key={metric}>
                      <dt>{phaseEightValueLabel(locale, metric)}</dt>
                      <dd>{result === null ? "—" : formatMetric(locale, result)}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>{messages.sampleSize}</dt>
                    <dd>{evaluation.sampleSize}</dd>
                  </div>
                </dl>
                <time dateTime={evaluation.createdAt}>
                  {formatInstant(locale, evaluation.createdAt)}
                </time>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted">{messages.noEvaluations}</p>
      )}
    </section>
  );
}

function DriftHistory({
  locale,
  overview,
}: Readonly<{ locale: SupportedLocale; overview: PredictiveOverview }>) {
  const messages = phaseEightMessages[locale];
  return (
    <section className="panel page-stack" aria-labelledby="drift-title">
      <h2 id="drift-title">{messages.drift}</h2>
      {overview.drift.length ? (
        <div className="card-grid">
          {overview.drift.map((report) => (
            <article className="record-card" key={report.id}>
              <div>
                <span
                  className={`status ${
                    report.status === "ALERT" || report.status === "INSUFFICIENT"
                      ? "status-suspended"
                      : "status-active"
                  }`}
                >
                  {phaseEightValueLabel(locale, report.status)}
                </span>
                <h3>{phaseEightCapabilityLabel(locale, report.capability)}</h3>
                <dl className="details-list">
                  <div>
                    <dt>{messages.drift}</dt>
                    <dd>{report.score === null ? "—" : formatMetric(locale, report.score)}</dd>
                  </div>
                  <div>
                    <dt>{messages.sampleSize}</dt>
                    <dd>{report.sampleSize}</dd>
                  </div>
                </dl>
                <time dateTime={report.createdAt}>{formatInstant(locale, report.createdAt)}</time>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted">{messages.noDrift}</p>
      )}
    </section>
  );
}

function formatInstant(locale: SupportedLocale, value: string): string {
  return new Date(value).toLocaleString(locale === "ar" ? "ar-JO" : "en-JO");
}

function formatInstantInTimezone(
  locale: SupportedLocale,
  value: string,
  timezone: string | null,
): string {
  if (!timezone) return formatInstant(locale, value);
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return formatInstant(locale, value);
  }
}

function formatLocalBucket(locale: SupportedLocale, localDate: string, localHour: number): string {
  const hour = Math.trunc(localHour);
  const date = new Date(`${localDate}T${hour.toString().padStart(2, "0")}:00:00Z`);
  if (Number.isNaN(date.getTime())) return `${localDate} ${hour}:00`;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    dateStyle: "medium",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function capabilityEstimateLabel(
  locale: SupportedLocale,
  capability: PredictiveCapability,
): string {
  const messages = phaseEightMessages[locale];
  switch (capability) {
    case "NO_SHOW":
      return messages.noShowProbability;
    case "DEMAND_FORECAST":
      return messages.expectedBookings;
    case "STAFFING":
      return messages.expectedLoad;
    case "SCHEDULE_REFLOW":
      return messages.reflowImprovement;
    case "SERVICE_PROVIDER_RECOMMENDATION":
      return messages.operationalRankingScore;
  }
}

function capabilityIntervalLabel(locale: SupportedLocale, prediction: Prediction): string {
  const messages = phaseEightMessages[locale];
  if (prediction.capability === "STAFFING") return messages.loadInterval;
  return stringDetail(prediction, "uncertaintyMethod") === "SUM_COMPONENT_MARGINAL_INTERVALS"
    ? messages.aggregateBookingInterval
    : messages.bookingInterval;
}

function formatCapabilityEstimate(
  locale: SupportedLocale,
  capability: PredictiveCapability,
  value: number,
): string {
  const messages = phaseEightMessages[locale];
  switch (capability) {
    case "NO_SHOW":
      return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
        maximumFractionDigits: 1,
        style: "percent",
      }).format(value);
    case "DEMAND_FORECAST":
      return `${formatNumber(locale, value, 2)} ${messages.bookingsUnit}`;
    case "STAFFING":
    case "SCHEDULE_REFLOW":
      return formatMinutes(locale, value);
    case "SERVICE_PROVIDER_RECOMMENDATION":
      return `${formatNumber(locale, value, 3)} ${messages.scoreUnit}`;
  }
}

function formatMinutes(locale: SupportedLocale, value: number): string {
  return `${formatNumber(locale, value, 1)} ${phaseEightMessages[locale].minutesUnit}`;
}

function formatNumber(
  locale: SupportedLocale,
  value: number,
  maximumFractionDigits: number,
): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    maximumFractionDigits,
  }).format(value);
}

function formatContribution(locale: SupportedLocale, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
    maximumFractionDigits: 1,
    signDisplay: "always",
    style: "percent",
  }).format(value);
}

function formatMetric(locale: SupportedLocale, value: number | string): string {
  return typeof value === "number"
    ? new Intl.NumberFormat(locale === "ar" ? "ar-JO" : "en-JO", {
        maximumFractionDigits: 4,
      }).format(value)
    : phaseEightValueLabel(locale, value);
}

function stringDetail(prediction: Prediction, key: string): string | null {
  const value = prediction.details[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberDetail(prediction: Prediction, key: string): number | null {
  const value = prediction.details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanDetail(prediction: Prediction, key: string): boolean | null {
  const value = prediction.details[key];
  return typeof value === "boolean" ? value : null;
}

function resolveBranchName(
  branchId: string,
  referenceNames: ArtifactReferenceNames,
  messages: PhaseEightMessages,
): string {
  return referenceNames.branches.get(branchId) ?? messages.authorizedBranch;
}

function resolveServiceName(
  serviceId: string,
  referenceNames: ArtifactReferenceNames,
  messages: PhaseEightMessages,
): string {
  return referenceNames.services.get(serviceId) ?? messages.authorizedService;
}

function resolveProviderName(
  providerId: string,
  referenceNames: ArtifactReferenceNames,
  messages: PhaseEightMessages,
): string {
  if (providerId === referenceNames.selfProviderId) return messages.yourProviderProfile;
  return referenceNames.providers.get(providerId) ?? messages.authorizedProvider;
}
