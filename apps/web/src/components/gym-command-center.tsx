import type { SupportedLocale } from "@jormall/contracts/locales";
import type { GymTraineeAttentionLevel, GymTraineeAttentionReason } from "@jormall/domain/gym";
import Link from "next/link";

import {
  gymAttentionLabel,
  gymAttentionReasonLabel,
  gymCommandCenterMessages,
} from "../messages/gym-command-center";

export type GymCommandCenterTrainee = Readonly<{
  attention: Readonly<{
    level: GymTraineeAttentionLevel;
    reasons: readonly GymTraineeAttentionReason[];
  }>;
  id: string;
  name: string;
  trainerName?: string | undefined;
}>;

export function GymCommandCenter({
  activePlanCount,
  locale,
  portalAccessCount,
  trainees,
}: Readonly<{
  activePlanCount: number;
  locale: SupportedLocale;
  portalAccessCount: number;
  trainees: readonly GymCommandCenterTrainee[];
}>) {
  const messages = gymCommandCenterMessages[locale];
  const attention = trainees.filter(({ attention: item }) => item.level !== "ON_TRACK");
  const root = `/${locale}/dashboard`;
  const lanes = [
    { description: messages.ownerLaneDescription, icon: "◈", label: messages.ownerLane },
    { description: messages.coachLaneDescription, icon: "↗", label: messages.coachLane },
    { description: messages.secretaryLaneDescription, icon: "✓", label: messages.secretaryLane },
    { description: messages.traineeLaneDescription, icon: "◎", label: messages.traineeLane },
  ] as const;
  const aiSteps = [
    messages.aiStepOnboard,
    messages.aiStepAssess,
    messages.aiStepPropose,
    messages.aiStepActivate,
  ];

  return (
    <section className="gym-command-center" aria-labelledby="gym-command-title">
      <header className="gym-command-heading">
        <div>
          <p className="eyebrow">JorMall Gym OS</p>
          <h2 id="gym-command-title">{messages.commandCenter}</h2>
          <p>{messages.commandCenterDescription}</p>
        </div>
        <Link className="button button-primary" href={`${root}/gym/trainees`}>
          {messages.viewAllTrainees}
        </Link>
      </header>

      <dl className="gym-command-metrics">
        <div>
          <dt>{messages.trainees}</dt>
          <dd>{trainees.length}</dd>
        </div>
        <div>
          <dt>{messages.activePlans}</dt>
          <dd>{activePlanCount}</dd>
        </div>
        <div>
          <dt>{messages.followUp}</dt>
          <dd>{attention.length}</dd>
        </div>
        <div>
          <dt>{messages.portalEnabled}</dt>
          <dd>{portalAccessCount}</dd>
        </div>
      </dl>

      <div className="gym-command-grid">
        <section className="gym-attention-panel" aria-labelledby="gym-attention-title">
          <header>
            <div>
              <h3 id="gym-attention-title">{messages.attentionTitle}</h3>
              <p>{messages.attentionDescription}</p>
            </div>
            <span className="gym-count-badge">{attention.length}</span>
          </header>
          {trainees.length === 0 ? (
            <p className="gym-empty-note">{messages.noTrainees}</p>
          ) : attention.length === 0 ? (
            <p className="gym-empty-note">{messages.noAttention}</p>
          ) : (
            <ul className="gym-attention-list">
              {attention.slice(0, 5).map((trainee) => (
                <li key={trainee.id}>
                  <div className="gym-trainee-row-heading">
                    <div>
                      <strong>{trainee.name}</strong>
                      {trainee.trainerName ? <small>{trainee.trainerName}</small> : null}
                    </div>
                    <span
                      className={`gym-attention-status gym-attention-${trainee.attention.level.toLowerCase()}`}
                    >
                      {gymAttentionLabel(locale, trainee.attention.level)}
                    </span>
                  </div>
                  <p>
                    <b>{messages.factsLabel}:</b>{" "}
                    {trainee.attention.reasons
                      .map((reason) => gymAttentionReasonLabel(locale, reason))
                      .join(" · ")}
                  </p>
                  <div className="gym-suggestion-row">
                    <span>
                      <b>{messages.suggestionLabel}:</b>{" "}
                      {gymAttentionLabel(locale, trainee.attention.level)}
                    </span>
                    <Link href={`${root}/gym/trainees/${trainee.id}`}>
                      {messages.reviewTrainee}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="gym-ai-loop" aria-labelledby="gym-ai-loop-title">
          <span aria-hidden="true" className="gym-ai-mark">
            AI
          </span>
          <h3 id="gym-ai-loop-title">{messages.aiFlowTitle}</h3>
          <p>{messages.aiFlowDescription}</p>
          <ol>
            {aiSteps.map((step, index) => (
              <li key={step}>
                <span aria-hidden="true">{index + 1}</span>
                {step}
              </li>
            ))}
          </ol>
          <small>{messages.suggestionsAreReviewOnly}</small>
        </aside>
      </div>

      <section className="gym-role-workspaces" aria-labelledby="gym-role-title">
        <header>
          <h3 id="gym-role-title">{messages.roleWorkspaces}</h3>
          <p>{messages.roleWorkspacesDescription}</p>
        </header>
        <div>
          {lanes.map((lane) => (
            <article key={lane.label}>
              <span aria-hidden="true">{lane.icon}</span>
              <h4>{lane.label}</h4>
              <p>{lane.description}</p>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
