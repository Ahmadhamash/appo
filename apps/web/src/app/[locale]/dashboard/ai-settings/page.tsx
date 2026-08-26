import { isSupportedLocale } from "@jormall/contracts/locales";
import { aiActionNames } from "@jormall/domain/ai-foundation";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseFiveAMessages } from "../../../../messages/phase-five-a";
import { aiFoundationRepository, requirePagePermission } from "../../../../server/identity";
import { updateAIConfigurationAction } from "../../actions";

const guidanceSeparator = "Organization guidance (untrusted and subordinate to policy):\n";

export default async function AISettingsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/ai-settings">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "ai.configure"),
    searchParams,
  ]);
  const [configuration, evaluations] = await Promise.all([
    aiFoundationRepository.getPromptConfiguration(access),
    aiFoundationRepository.listEvaluationCases(access),
  ]);
  const messages = phaseFiveAMessages[locale];
  const businessGuidance = configuration.systemPrompt.split(guidanceSeparator)[1] ?? "";
  return (
    <section className="page-stack" aria-labelledby="ai-settings-title">
      <div>
        <p className="eyebrow">Phase 5A</p>
        <h1 id="ai-settings-title">{messages.configuration}</h1>
        <p className="muted">{messages.promptSafetyNotice}</p>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <form action={updateAIConfigurationAction} className="panel form-grid">
        <input name="locale" type="hidden" value={locale} />
        <input name="expectedVersion" type="hidden" value={configuration.version} />
        <h2 className="form-title">
          {configuration.name} · v{configuration.version}
        </h2>
        <label className="field form-title">
          <span className="field-label">{messages.businessGuidance}</span>
          <textarea
            className="input textarea"
            defaultValue={businessGuidance}
            dir="auto"
            maxLength={2000}
            name="businessGuidance"
            rows={5}
          />
        </label>
        <label className="field">
          <span className="field-label">{messages.minimumConfidence}</span>
          <input
            className="input"
            defaultValue={configuration.minimumConfidence}
            max="1"
            min="0.5"
            name="minimumConfidence"
            required
            step="0.01"
            type="number"
          />
        </label>
        <label className="field">
          <span className="field-label">{locale === "ar" ? "حد الإجراءات" : "Action limit"}</span>
          <input
            className="input"
            defaultValue={configuration.monthlyActionLimit}
            min="0"
            name="monthlyActionLimit"
            required
            type="number"
          />
        </label>
        <label className="field">
          <span className="field-label">{locale === "ar" ? "حد الرموز" : "Token limit"}</span>
          <input
            className="input"
            defaultValue={configuration.monthlyTokenLimit}
            min="0"
            name="monthlyTokenLimit"
            required
            type="number"
          />
        </label>
        <label className="field">
          <span className="field-label">
            {locale === "ar" ? "حد الكلفة بالمايكرو" : "Cost limit (micros)"}
          </span>
          <input
            className="input"
            defaultValue={configuration.monthlyCostLimitMicros}
            min="0"
            name="monthlyCostLimitMicros"
            required
            type="number"
          />
        </label>
        <fieldset className="permission-grid">
          <legend>{messages.allowedTools}</legend>
          {aiActionNames.map((actionName) => (
            <label className="check-field" key={actionName}>
              <input
                defaultChecked={configuration.allowedActionNames.includes(actionName)}
                name="allowedActionNames"
                type="checkbox"
                value={actionName}
              />
              <span>{actionName}</span>
            </label>
          ))}
        </fieldset>
        <div className="form-actions">
          <SubmitButton>{messages.save}</SubmitButton>
        </div>
      </form>
      <section className="panel" aria-labelledby="evaluation-title">
        <h2 id="evaluation-title">{messages.evaluations}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{locale === "ar" ? "الحالة" : "Case"}</th>
                <th>{locale === "ar" ? "المدخل" : "Input"}</th>
                <th>{messages.outcome}</th>
                <th>{messages.actions}</th>
                <th>{locale === "ar" ? "آخر تشغيل" : "Latest run"}</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.map((evaluation) => (
                <tr key={evaluation.id}>
                  <td>{evaluation.name}</td>
                  <td dir="auto">{evaluation.input}</td>
                  <td>{evaluation.expectedOutcome}</td>
                  <td>{evaluation.expectedAction ?? "—"}</td>
                  <td>{evaluation.runs[0]?.outcome ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
