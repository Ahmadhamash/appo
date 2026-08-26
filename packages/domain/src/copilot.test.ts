import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import { assertCopilotGeneration, type CopilotProjection } from "./copilot";

const projection: CopilotProjection = {
  confidence: 1,
  dataWatermark: "2026-08-24T08:00:00.000Z",
  evidence: [
    {
      classification: "CONFIDENTIAL",
      href: "/en/dashboard/appointments/a1",
      id: "e1",
      label: "Appointment",
      occurredAt: "2026-08-24T08:00:00.000Z",
      sourceId: "a1",
      sourceType: "APPOINTMENT",
    },
  ],
  expiresAt: "2026-08-24T08:15:00.000Z",
  insightType: "DAILY_BRIEFING",
  items: [
    {
      evidenceIds: ["e1"],
      id: "i1",
      kind: "FACT",
      labelAr: "المواعيد",
      labelEn: "Appointments",
      value: "1",
    },
  ],
  knowledgeVersionIds: [],
  locale: "en",
  promptVersion: 1,
  titleAr: "الموجز اليومي",
  titleEn: "Daily briefing",
};

describe("Copilot evidence policy", () => {
  it("accepts a statement only when it cites the exact authorized evidence", () => {
    expect(() =>
      assertCopilotGeneration(projection, {
        modelIdentifier: "deterministic",
        statements: [
          { evidenceIds: ["e1"], kind: "FACT", projectionItemId: "i1", text: "Appointments: 1" },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects hallucinated sources and unsupported medical conclusions", () => {
    for (const statement of [
      { evidenceIds: ["other"], kind: "FACT" as const, projectionItemId: "i1", text: "One" },
      {
        evidenceIds: ["e1"],
        kind: "FACT" as const,
        projectionItemId: "i1",
        text: "The customer has a diagnosis.",
      },
    ]) {
      expect(() =>
        assertCopilotGeneration(projection, {
          modelIdentifier: "deterministic",
          statements: [statement],
        }),
      ).toThrow(DomainError);
    }
  });
});
