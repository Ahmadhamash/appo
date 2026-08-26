import type { SupportedLocale } from "@jormall/contracts/locales";

const en = {
  audit: "Audit log",
  auditDescription: "Protected, paginated history. Viewing and exporting audit data is audited.",
  commit: "Commit valid rows",
  downloadErrors: "Download error report",
  exportData: "Data exports",
  exports: "Exports",
  importDescription:
    "CSV files are streamed, validated and previewed before any business record changes.",
  imports: "Safe imports",
  reports: "Reports and attribution",
  reportsDescription:
    "Reproducible metrics use the organization timezone and a recorded data watermark.",
  rollback: "Rollback safe records",
  runReport: "Run report",
  startDryRun: "Upload and dry run",
};

const ar: typeof en = {
  audit: "سجل التدقيق",
  auditDescription: "سجل محمي ومقسّم إلى صفحات. يتم تدقيق عرض بيانات التدقيق وتصديرها.",
  commit: "اعتماد الصفوف الصالحة",
  downloadErrors: "تنزيل تقرير الأخطاء",
  exportData: "تصدير البيانات",
  exports: "عمليات التصدير",
  importDescription: "تُقرأ ملفات CSV تدريجياً وتُفحص وتُعرض قبل تغيير أي سجل تشغيلي.",
  imports: "الاستيراد الآمن",
  reports: "التقارير والإسناد",
  reportsDescription: "مقاييس قابلة لإعادة الإنتاج بتوقيت المؤسسة وعلامة بيانات مسجلة.",
  rollback: "التراجع عن السجلات الآمنة",
  runReport: "تشغيل التقرير",
  startDryRun: "رفع وتشغيل المعاينة",
};

export const phaseSevenMessages: Readonly<Record<SupportedLocale, typeof en>> = { ar, en };
