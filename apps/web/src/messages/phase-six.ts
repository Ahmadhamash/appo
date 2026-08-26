import type { SupportedLocale } from "@jormall/contracts/locales";

const en = {
  analytics: "Analytics Copilot",
  callQuality: "Call quality review",
  confidence: "Confidence",
  copilot: "Staff Copilot",
  dailyBriefing: "Daily briefing",
  dataWatermark: "Data watermark",
  evidence: "Supporting records",
  facts: "Facts",
  feedback: "Feedback",
  generate: "Generate from authorized records",
  gaps: "Schedule gap detection",
  knownBoundary:
    "The local deterministic model can summarize authorized evidence only. Suggestions never change appointments.",
  metrics: "Computed metrics",
  modelTrace: "Model and policy trace",
  noInsights: "No Copilot insights generated yet.",
  suggestions: "AI suggestions",
  waitlist: "Waitlist matching",
};

const ar: typeof en = {
  analytics: "مساعد التحليلات",
  callQuality: "مراجعة جودة المكالمة",
  confidence: "الثقة",
  copilot: "مساعد الموظفين",
  dailyBriefing: "الموجز اليومي",
  dataWatermark: "علامة حداثة البيانات",
  evidence: "السجلات الداعمة",
  facts: "حقائق",
  feedback: "التقييم",
  generate: "إنشاء من السجلات المصرح بها",
  gaps: "اكتشاف فجوات الجدول",
  knownBoundary: "النموذج المحلي الحتمي يلخص الأدلة المصرح بها فقط، ولا تغيّر الاقتراحات أي موعد.",
  metrics: "مقاييس محسوبة",
  modelTrace: "تتبّع النموذج والسياسة",
  noInsights: "لم يتم إنشاء نتائج للمساعد بعد.",
  suggestions: "اقتراحات الذكاء الاصطناعي",
  waitlist: "مطابقة قائمة الانتظار",
};

export const phaseSixMessages: Readonly<Record<SupportedLocale, typeof en>> = { ar, en };

export function phaseSixKind(locale: SupportedLocale, kind: string): string {
  const labels = {
    ar: { AI_SUGGESTION: "اقتراح AI", COMPUTED_METRIC: "مقياس محسوب", FACT: "حقيقة" },
    en: { AI_SUGGESTION: "AI suggestion", COMPUTED_METRIC: "Computed metric", FACT: "Fact" },
  } as const;
  return labels[locale][kind as keyof (typeof labels)["en"]] ?? kind;
}
