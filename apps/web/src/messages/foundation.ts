import type { SupportedLocale } from "@jormall/contracts/locales";

type FoundationMessages = Readonly<{
  badge: string;
  description: string;
  phaseLabel: string;
  statusLabel: string;
  title: string;
}>;

export const foundationMessages: Readonly<Record<SupportedLocale, FoundationMessages>> = {
  ar: {
    badge: "منصة المواعيد ومساعد الاستقبال الذكي",
    description: "تم تجهيز الأساس الهندسي الآمن متعدد المؤسسات. لم تبدأ ميزات المنتج بعد.",
    phaseLabel: "المرحلة الحالية",
    statusLabel: "التصميم والبنية التحتية",
    title: "أساس جورمول جاهز",
  },
  en: {
    badge: "Appointment and AI receptionist platform",
    description:
      "The secure multi-organization engineering foundation is ready. Product features have not started.",
    phaseLabel: "Current phase",
    statusLabel: "Architecture and infrastructure",
    title: "The JorMall foundation is ready",
  },
};
