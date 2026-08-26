export type AIContentLanguage = "ar" | "en" | "mixed";

const injectionPatterns = [
  /ignore\s+(all\s+)?(previous|prior|system)\s+instructions?/i,
  /reveal\s+(the\s+)?(system|developer)\s+prompt/i,
  /act\s+as\s+(an?\s+)?(administrator|system|developer)/i,
  /bypass\s+(authorization|confirmation|policy|safety)/i,
  /(?:نف[ّ]?ذ|اتبع)\s+(?:هذه|التعليمات)\s+(?:بدل|وتجاهل)/u,
  /تجاهل\s+(?:كل\s+)?(?:التعليمات|الأوامر|السياسات)\s+(?:السابقة|السابقة كلها)?/u,
  /اكشف\s+(?:لي\s+)?(?:تعليمات|رسالة|موجه)\s+(?:النظام|المطور)/u,
];

const sensitiveKeyPattern =
  /(?:body|content|displayname|email|message|notes?|phone|phoneoremail|prompt|reason|summary)/i;

export function redactAISensitiveFields(value: unknown, key = ""): unknown {
  if (sensitiveKeyPattern.test(key) && value !== undefined && value !== null) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAISensitiveFields(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactAISensitiveFields(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function detectAIInstructionInjection(
  content: string,
): Readonly<{ detected: false }> | Readonly<{ detected: true; reason: "EMBEDDED_INSTRUCTION" }> {
  return injectionPatterns.some((pattern) => pattern.test(content))
    ? { detected: true, reason: "EMBEDDED_INSTRUCTION" }
    : { detected: false };
}

export function detectAIContentLanguage(content: string): AIContentLanguage {
  const arabicCount = [...content].filter((character) => /[\u0600-\u06ff]/u.test(character)).length;
  const latinCount = [...content].filter((character) => /[a-z]/iu.test(character)).length;
  if (arabicCount > 0 && latinCount > 0) return "mixed";
  if (arabicCount > 0) return "ar";
  return "en";
}

export function splitKnowledgeIntoChunks(
  content: string,
  maximumCharacters = 1_000,
): readonly string[] {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maximumCharacters) {
      flush();
      for (let index = 0; index < paragraph.length; index += maximumCharacters) {
        chunks.push(paragraph.slice(index, index + maximumCharacters));
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maximumCharacters) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}
