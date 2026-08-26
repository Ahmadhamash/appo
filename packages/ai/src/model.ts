import {
  aiActionNames,
  type AIActionName,
  type AIKnowledgeChunkProjection,
} from "@jormall/domain/ai-foundation";

export type ModelToolCall = Readonly<{
  input: unknown;
  name: AIActionName;
}>;

export type ModelCompletion = Readonly<{
  ambiguous: boolean;
  confidence: number;
  content: string;
  informationAbsent: boolean;
  outputTokens: number;
  toolCall?: ModelToolCall | undefined;
}>;

export type ModelRequest = Readonly<{
  immutableSafetyPolicy: string;
  knowledge: readonly AIKnowledgeChunkProjection[];
  locale: "ar" | "en" | "mixed";
  organizationInstructions: string;
  userMessage: string;
}>;

export interface ProviderNeutralModelAdapter {
  readonly identifier: string;
  complete(request: ModelRequest): Promise<ModelCompletion>;
}

function actionName(value: string): AIActionName | undefined {
  return aiActionNames.find((candidate) => candidate === value);
}

function completion(
  content: string,
  options: Partial<Omit<ModelCompletion, "content" | "outputTokens">> = {},
): ModelCompletion {
  return {
    ambiguous: options.ambiguous ?? false,
    confidence: options.confidence ?? 0.95,
    content,
    informationAbsent: options.informationAbsent ?? false,
    outputTokens: Math.max(1, Math.ceil(content.length / 4)),
    ...(options.toolCall ? { toolCall: options.toolCall } : {}),
  };
}

/**
 * This adapter performs no network calls and is intentionally deterministic. The explicit tool
 * directive exists only for integration/evaluation fixtures; production transports must never
 * expose it to customers.
 */
export class DeterministicMockModelAdapter implements ProviderNeutralModelAdapter {
  readonly identifier = "jormall-deterministic-mock-v1";

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    const directive = /^\[\[tool:([a-z_]+)\]\](?:\s+([\s\S]+))?$/u.exec(request.userMessage.trim());
    if (directive) {
      const name = actionName(directive[1] ?? "");
      if (!name) {
        return completion("Unsupported deterministic tool fixture.", {
          confidence: 0.1,
          informationAbsent: true,
        });
      }
      let input: unknown = {};
      if (directive[2]) {
        try {
          input = JSON.parse(directive[2]);
        } catch {
          return completion("Invalid deterministic tool fixture.", {
            confidence: 0.1,
            informationAbsent: true,
          });
        }
      }
      return completion("A deterministic tool call was selected.", {
        toolCall: { input, name },
      });
    }

    const lower = request.userMessage.toLocaleLowerCase("en");
    if (/speak to (?:a )?(?:person|human)|موظف|حدا احكي معه/u.test(lower)) {
      return completion("I will request a human handoff.", {
        toolCall: {
          input: { reasonCode: "CUSTOMER_REQUEST" },
          name: "request_human_handoff",
        },
      });
    }
    if (/بكرا|بعد بكرا|next friday|sometime|العصر/u.test(lower)) {
      return completion(
        request.locale === "ar"
          ? "لو سمحت حدّد التاريخ والوقت المقصودين بشكل واضح."
          : "Please provide the exact local date and time you mean.",
        { ambiguous: true, confidence: 0.62 },
      );
    }
    if (/services?|خدمات/u.test(lower)) {
      return completion("I will retrieve the active services.", {
        toolCall: {
          input: { locale: request.locale === "ar" ? "ar" : "en" },
          name: "list_services",
        },
      });
    }
    if (/branches?|locations?|فروع|وين موقع/u.test(lower)) {
      return completion("I will retrieve the active branches.", {
        toolCall: {
          input: { locale: request.locale === "ar" ? "ar" : "en" },
          name: "list_branches",
        },
      });
    }
    if (/hours?|business information|ساعات|دوام/u.test(lower)) {
      return completion("I will retrieve the published business information.", {
        toolCall: {
          input: { locale: request.locale === "ar" ? "ar" : "en" },
          name: "get_business_information",
        },
      });
    }
    const firstKnowledge = request.knowledge[0];
    if (firstKnowledge) {
      return completion(
        request.locale === "ar"
          ? `بحسب قاعدة المعرفة المفعّلة: ${firstKnowledge.content}`
          : `According to the active knowledge base: ${firstKnowledge.content}`,
      );
    }
    return completion(
      request.locale === "ar"
        ? "هذه المعلومة غير موجودة في قاعدة المعرفة المفعّلة."
        : "That information is not present in the active knowledge base.",
      { informationAbsent: true },
    );
  }
}
