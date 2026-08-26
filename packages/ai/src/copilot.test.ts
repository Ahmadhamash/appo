import { describe, expect, it } from "vitest";

import { DeterministicCopilotModel, deterministicCopilotModelIdentifier } from "./copilot";

describe("DeterministicCopilotModel", () => {
  it("renders only supplied projection items and preserves their evidence", async () => {
    const result = await new DeterministicCopilotModel().generate({
      confidence: 0.9,
      dataWatermark: "2026-08-24T00:00:00.000Z",
      evidence: [],
      expiresAt: "2026-08-24T00:15:00.000Z",
      insightType: "ANALYTICS",
      items: [
        {
          evidenceIds: ["metric-1"],
          id: "item-1",
          kind: "COMPUTED_METRIC",
          labelAr: "المواعيد",
          labelEn: "Appointments",
          value: "12",
        },
      ],
      knowledgeVersionIds: [],
      locale: "ar",
      promptVersion: 2,
      titleAr: "التحليلات",
      titleEn: "Analytics",
    });
    expect(result).toEqual({
      modelIdentifier: deterministicCopilotModelIdentifier,
      statements: [
        {
          evidenceIds: ["metric-1"],
          kind: "COMPUTED_METRIC",
          projectionItemId: "item-1",
          text: "المواعيد: 12",
        },
      ],
    });
  });
});
