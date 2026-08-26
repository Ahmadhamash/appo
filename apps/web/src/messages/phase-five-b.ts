import type { SupportedLocale } from "@jormall/contracts/locales";

const en = {
  accentColor: "Accent color",
  allowedOrigins: "Allowed website origins (one exact origin per line)",
  calls: "Recent AI calls",
  channels: "AI customer channels",
  copy: "Copy installation code",
  copied: "Installation code copied",
  createWidget: "Create widget installation",
  defaultLocale: "Default language",
  displayNameAr: "Arabic display name",
  displayNameEn: "English display name",
  installation: "Website installation",
  mockNotice:
    "Website, WhatsApp and voice use deterministic local adapters. No live provider or production model is configured.",
  name: "Installation name",
  primaryColor: "Primary color",
  providerConnections: "Verified channel routes",
  realtimeNotice:
    "Voice uses signed callbacks and the shared worker. No persistent realtime service is introduced until measured latency requires it.",
  widgetInstructions:
    "Place this script before the closing body tag. Allow this JorMall origin in script-src, style-src and connect-src when your site has CSP.",
};

const ar: typeof en = {
  accentColor: "لون التمييز",
  allowedOrigins: "نطاقات الموقع المسموحة (نطاق مطابق في كل سطر)",
  calls: "مكالمات الذكاء الاصطناعي الأخيرة",
  channels: "قنوات العملاء بالذكاء الاصطناعي",
  copy: "نسخ كود التثبيت",
  copied: "تم نسخ كود التثبيت",
  createWidget: "إنشاء تثبيت للويدجت",
  defaultLocale: "اللغة الافتراضية",
  displayNameAr: "اسم العرض بالعربية",
  displayNameEn: "اسم العرض بالإنجليزية",
  installation: "تثبيت محادثة الموقع",
  mockNotice:
    "تستخدم قنوات الموقع وواتساب والصوت محولات محلية حتمية. لا يوجد مزود حي أو نموذج إنتاجي مهيأ.",
  name: "اسم التثبيت",
  primaryColor: "اللون الرئيسي",
  providerConnections: "مسارات القنوات الموثقة",
  realtimeNotice:
    "يستخدم الصوت callbacks موقعة والـ worker المشترك. لن نضيف خدمة realtime دائمة قبل أن تثبت قياسات التأخير الحاجة لها.",
  widgetInstructions:
    "ضع هذا السكربت قبل إغلاق وسم body. إذا كان موقعك يستخدم CSP، اسمح بنطاق JorMall ضمن script-src وstyle-src وconnect-src.",
};

export const phaseFiveBMessages: Readonly<Record<SupportedLocale, typeof en>> = { ar, en };
