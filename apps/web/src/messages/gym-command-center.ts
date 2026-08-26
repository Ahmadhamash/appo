import type { SupportedLocale } from "@jormall/contracts/locales";
import type { GymTraineeAttentionLevel, GymTraineeAttentionReason } from "@jormall/domain/gym";

const en = {
  activePlans: "Training-ready",
  aiFlowDescription:
    "AI analyzes authorized workout and progress facts, then proposes the next step. It never changes a plan silently.",
  aiFlowTitle: "Safe coaching loop",
  aiStepActivate: "Coach or trainee confirms the approved change",
  aiStepAssess: "AI assesses progress from recorded evidence",
  aiStepOnboard: "Trainee answers goal, experience, budget and food questions",
  aiStepPropose: "A clear workout or nutrition change is proposed",
  attentionDescription: "Computed from current plans, portal access and recent recorded progress.",
  attentionTitle: "Needs attention",
  coachLane: "Trainer workspace",
  coachLaneDescription: "Assigned trainees, evidence-based reviews and approved plan updates.",
  commandCenter: "Gym command center",
  commandCenterDescription: "The current state of your club—not a generic appointment launcher.",
  factsLabel: "Recorded facts",
  followUp: "Follow-up queue",
  noAttention: "Every visible trainee is currently on track.",
  noTrainees: "Add the first trainee to start the coaching workflow.",
  ownerLane: "Owner workspace",
  ownerLaneDescription: "Club-wide operations, trainers, programs, communications and reports.",
  portalEnabled: "Trainee access",
  reviewTrainee: "Open trainee",
  roleWorkspaces: "One club, clear workspaces",
  roleWorkspacesDescription: "Each role sees the tools it needs inside this organization only.",
  secretaryLane: "Secretary workspace",
  secretaryLaneDescription:
    "Front-desk operations, appointments, permitted messages and customer follow-up.",
  suggestionLabel: "Suggested next step",
  suggestionsAreReviewOnly:
    "Suggestions are advisory. Workout, nutrition and appointment changes still require normal permission and confirmation.",
  traineeLane: "Trainee workspace",
  traineeLaneDescription: "Today’s workout, easy weight logging, nutrition and personal progress.",
  trainees: "Trainees",
  viewAllTrainees: "View all trainees",
};

const ar: typeof en = {
  activePlans: "جاهزون للتدريب",
  aiFlowDescription:
    "يحلل الذكاء الاصطناعي التمارين والتقدم المصرح بهما، ثم يقترح الخطوة التالية ولا يغيّر أي خطة بصمت.",
  aiFlowTitle: "حلقة متابعة آمنة بالذكاء الاصطناعي",
  aiStepActivate: "المدرب أو المتدرب يؤكد التغيير المعتمد",
  aiStepAssess: "الذكاء الاصطناعي يقيّم التقدم من السجلات الفعلية",
  aiStepOnboard: "المتدرب يجيب عن الهدف والخبرة والميزانية والطعام",
  aiStepPropose: "يظهر اقتراح واضح لتعديل التمرين أو التغذية",
  attentionDescription: "محسوبة من الخطط الحالية وحساب المتدرب وآخر تقدم مسجل.",
  attentionTitle: "يحتاجون انتباهك",
  coachLane: "مساحة المدرب",
  coachLaneDescription: "المتدربون المرتبطون به، التقييم الموثق وتحديث الخطط بعد الموافقة.",
  commandCenter: "مركز قيادة النادي",
  commandCenterDescription: "وضع ناديك الآن، وليس مجرد لوحة مواعيد عامة.",
  factsLabel: "حقائق مسجلة",
  followUp: "قائمة المتابعة",
  noAttention: "كل المتدربين الظاهرين يسيرون بشكل جيد حالياً.",
  noTrainees: "أضف أول متدرب لبدء دورة المتابعة والتدريب.",
  ownerLane: "مساحة صاحب النادي",
  ownerLaneDescription: "كل تشغيل النادي والمدربين والبرامج والاتصالات والتقارير.",
  portalEnabled: "حسابات المتدربين",
  reviewTrainee: "فتح المتدرب",
  roleWorkspaces: "نادٍ واحد، ومساحة واضحة لكل دور",
  roleWorkspacesDescription: "كل شخص يرى أدواته داخل هذه المؤسسة فقط.",
  secretaryLane: "مساحة السكرتير",
  secretaryLaneDescription: "الاستقبال والمواعيد والرسائل المسموحة ومتابعة العملاء.",
  suggestionLabel: "الخطوة المقترحة",
  suggestionsAreReviewOnly:
    "الاقتراحات للمساعدة فقط؛ تغيير التمرين أو التغذية أو الموعد يبقى خاضعاً للصلاحية والتأكيد.",
  traineeLane: "مساحة المتدرب",
  traineeLaneDescription: "تمرين اليوم، تسجيل الأوزان بسهولة، التغذية والتقدم الشخصي.",
  trainees: "المتدربون",
  viewAllTrainees: "عرض كل المتدربين",
};

export const gymCommandCenterMessages: Readonly<Record<SupportedLocale, typeof en>> = { ar, en };

const attentionLabels: Readonly<
  Record<SupportedLocale, Readonly<Record<GymTraineeAttentionLevel, string>>>
> = {
  ar: {
    FOLLOW_UP: "متابعة مطلوبة",
    ONBOARDING: "إكمال التجهيز",
    ON_TRACK: "يسير جيداً",
    PROGRESSION_REVIEW: "جاهز لمراجعة التطور",
  },
  en: {
    FOLLOW_UP: "Follow-up needed",
    ONBOARDING: "Finish setup",
    ON_TRACK: "On track",
    PROGRESSION_REVIEW: "Ready for progression review",
  },
};

const reasonLabels: Readonly<
  Record<SupportedLocale, Readonly<Record<GymTraineeAttentionReason, string>>>
> = {
  ar: {
    NO_NUTRITION_PLAN: "لا توجد خطة غذائية نشطة",
    NO_PORTAL_ACCESS: "حساب المتدرب غير مفعّل",
    NO_RECENT_MEASUREMENT: "لا يوجد قياس حديث خلال 14 يوماً",
    NO_RECENT_WORKOUT: "لا يوجد تمرين مسجل خلال 7 أيام",
    NO_TRAINER: "غير مرتبط بمدرب",
    NO_WORKOUT_PLAN: "لا يوجد جدول تمارين نشط",
    READY_FOR_PROGRESSION_REVIEW: "آخر 3 سجلات حققت الحد الأعلى بجهد منخفض",
  },
  en: {
    NO_NUTRITION_PLAN: "No active nutrition plan",
    NO_PORTAL_ACCESS: "Trainee portal access is not active",
    NO_RECENT_MEASUREMENT: "No recent measurement in 14 days",
    NO_RECENT_WORKOUT: "No workout recorded in 7 days",
    NO_TRAINER: "No trainer assigned",
    NO_WORKOUT_PLAN: "No active workout plan",
    READY_FOR_PROGRESSION_REVIEW: "The last 3 logs reached the rep ceiling at low effort",
  },
};

export function gymAttentionLabel(
  locale: SupportedLocale,
  level: GymTraineeAttentionLevel,
): string {
  return attentionLabels[locale][level];
}

export function gymAttentionReasonLabel(
  locale: SupportedLocale,
  reason: GymTraineeAttentionReason,
): string {
  return reasonLabels[locale][reason];
}
