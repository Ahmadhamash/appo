import type { SupportedLocale } from "@jormall/contracts/locales";

const en = {
  appointment: "Appointment",
  appointments: "Appointments",
  calendar: "Calendar",
  cancel: "Cancel",
  checkIn: "Check in",
  complete: "Complete",
  createAppointment: "Create appointment",
  createCustomer: "Create customer",
  customer: "Customer",
  customerProfile: "Customer profile",
  customers: "Customers",
  duplicateHint:
    "Likely duplicate matches are shown for review; records are never merged automatically.",
  endTime: "End time",
  filters: "Filters",
  internalNote: "Internal note",
  markNoShow: "Mark no-show",
  operationsToday: "Today operations",
  provider: "Provider",
  recordDetails: "Operational details",
  recordSummary: "Fulfillment summary",
  reschedule: "Reschedule",
  start: "Start service",
  startTime: "Start time",
  status: "Status",
};

const ar: typeof en = {
  appointment: "موعد",
  appointments: "المواعيد",
  calendar: "التقويم",
  cancel: "إلغاء",
  checkIn: "تسجيل الوصول",
  complete: "إتمام",
  createAppointment: "إنشاء موعد",
  createCustomer: "إضافة عميل",
  customer: "العميل",
  customerProfile: "ملف العميل",
  customers: "العملاء",
  duplicateHint: "تظهر المطابقات المحتملة للمراجعة فقط؛ لا يتم دمج السجلات تلقائياً.",
  endTime: "وقت الانتهاء",
  filters: "التصفية",
  internalNote: "ملاحظة داخلية",
  markNoShow: "تسجيل عدم الحضور",
  operationsToday: "عمليات اليوم",
  provider: "مقدم الخدمة",
  recordDetails: "تفاصيل التنفيذ",
  recordSummary: "ملخص التنفيذ",
  reschedule: "إعادة الجدولة",
  start: "بدء الخدمة",
  startTime: "وقت البدء",
  status: "الحالة",
};

export const phaseTwoMessages: Readonly<Record<SupportedLocale, typeof en>> = { ar, en };

const labels: Readonly<Record<SupportedLocale, Readonly<Record<string, string>>>> = {
  ar: {
    CANCELLED: "ملغى",
    CHECKED_IN: "تم الوصول",
    COMPLETED: "مكتمل",
    CONFIRMED: "مؤكد",
    IN_PROGRESS: "قيد التنفيذ",
    NO_SHOW: "لم يحضر",
    PENDING: "معلّق",
  },
  en: {
    CANCELLED: "Cancelled",
    CHECKED_IN: "Checked in",
    COMPLETED: "Completed",
    CONFIRMED: "Confirmed",
    IN_PROGRESS: "In progress",
    NO_SHOW: "No-show",
    PENDING: "Pending",
  },
};

export function phaseTwoLabel(locale: SupportedLocale, value: string): string {
  return labels[locale][value] ?? value;
}
