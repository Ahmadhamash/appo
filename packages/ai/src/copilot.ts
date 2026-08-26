import type {
  CopilotGeneratedInsight,
  CopilotGenerationPort,
  CopilotProjection,
} from "@jormall/domain/copilot";

export const deterministicCopilotModelIdentifier = "jormall-copilot-deterministic-mock-v1";

/**
 * Local-only model adapter. It performs no network request and can only render the
 * already-authorized projection supplied by the Copilot use case.
 */
export class DeterministicCopilotModel implements CopilotGenerationPort {
  async generate(projection: CopilotProjection): Promise<CopilotGeneratedInsight> {
    return {
      modelIdentifier: deterministicCopilotModelIdentifier,
      statements: projection.items.map((item) => ({
        evidenceIds: item.evidenceIds,
        kind: item.kind,
        projectionItemId: item.id,
        text: `${projection.locale === "ar" ? item.labelAr : item.labelEn}: ${item.value}`,
      })),
    };
  }
}
