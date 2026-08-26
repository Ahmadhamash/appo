import { prisma } from "@jormall/db/client";
import { AIFoundationRepository } from "@jormall/db/ai-foundation-repository";
import { AIChannelRepository } from "@jormall/db/ai-channel-repository";
import { CrmAppointmentRepository } from "@jormall/db/crm-appointment-repository";
import { CommunicationRepository } from "@jormall/db/communication-repository";
import { BusinessSector, OrganizationStatus, PlatformRole } from "@jormall/db/generated/enums";
import { IdentityRepository } from "@jormall/db/identity-repository";
import { GymRepository } from "@jormall/db/gym-repository";
import { runInTenant } from "@jormall/db/tenant-context";
import { SchedulingRepository } from "@jormall/db/scheduling-repository";
import { hashPassword } from "better-auth/crypto";

import { auth } from "../src/server/auth-config";

if (process.env.NODE_ENV === "production") {
  throw new Error("Development seed is disabled in production.");
}

const seedPassword = process.env.DEV_SEED_PASSWORD;
if (!seedPassword || seedPassword.length < 12) {
  throw new Error("DEV_SEED_PASSWORD with at least 12 characters is required.");
}

const repository = new IdentityRepository(prisma);
const crmRepository = new CrmAppointmentRepository(prisma);
const communicationRepository = new CommunicationRepository(prisma);
const schedulingRepository = new SchedulingRepository(prisma);
const aiFoundationRepository = new AIFoundationRepository(prisma);
const aiChannelRepository = new AIChannelRepository(prisma);
const gymRepository = new GymRepository(prisma);
const seedWeekdays = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

async function ensureUser(email: string, name: string) {
  const existing = await prisma.user.findUnique({
    include: { accounts: { select: { id: true, providerId: true } } },
    where: { email },
  });
  if (existing?.accounts.length) {
    if (!email.endsWith("@example.invalid")) {
      throw new Error("The development seed only updates reserved example.invalid identities.");
    }
    const credentialAccount = existing.accounts.find(
      ({ providerId }) => providerId === "credential",
    );
    if (!credentialAccount) {
      throw new Error(`Seed identity ${email} has no credential account.`);
    }
    await prisma.$transaction([
      prisma.account.update({
        data: { password: await hashPassword(seedPassword) },
        where: { id: credentialAccount.id },
      }),
      prisma.session.deleteMany({ where: { userId: existing.id } }),
    ]);
    return existing;
  }
  if (existing && email.endsWith("@example.invalid")) {
    await prisma.user.delete({ where: { id: existing.id } });
  }
  const created = await auth.api.signUpEmail({ body: { email, name, password: seedPassword } });
  return created.user;
}

async function ensureOrganization(
  superAdminId: string,
  owner: Readonly<{ email: string; id: string }>,
  input: Readonly<{ nameAr: string; nameEn: string; slug: string }>,
) {
  const existing = await prisma.organization.findUnique({ where: { slug: input.slug } });
  if (existing) {
    const expectedOwnerMembership = await prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId: existing.id, userId: owner.id } },
    });
    if (!expectedOwnerMembership) {
      const fixtureOwnerMembership = await prisma.organizationMembership.findFirst({
        include: { user: { select: { email: true } } },
        where: {
          organizationId: existing.id,
          roles: { some: { role: { systemKey: "ORGANIZATION_OWNER" } } },
        },
      });
      if (!fixtureOwnerMembership?.user.email.endsWith("@example.invalid")) {
        throw new Error(
          `Development organization ${input.slug} has no reassignable fixture owner.`,
        );
      }
      await prisma.organizationMembership.update({
        data: { userId: owner.id },
        where: { id: fixtureOwnerMembership.id },
      });
    }
    return existing;
  }
  const created = await repository.createOrganization(superAdminId, {
    ...input,
    ownerEmail: owner.email,
  });
  await repository.acceptInvitation(owner.id, owner.email, created.invitationToken);
  await repository.setOrganizationStatus(
    superAdminId,
    created.organizationId,
    OrganizationStatus.ACTIVE,
  );
  const organization = await prisma.organization.findUnique({
    where: { id: created.organizationId },
  });
  if (!organization) throw new Error("Seed organization was not created.");
  return organization;
}

async function main(): Promise<void> {
  const [superAdmin, owner, beautyOwner, gymOwner, secretary, provider, gymTrainer, traineeUser] =
    await Promise.all([
      ensureUser("superadmin@example.invalid", "Development Super Admin"),
      ensureUser("owner@example.invalid", "Development Clinic Owner"),
      ensureUser("beauty-owner@example.invalid", "Development Beauty Owner"),
      ensureUser("gym-owner@example.invalid", "Development Gym Owner"),
      ensureUser("secretary@example.invalid", "Development Secretary"),
      ensureUser("provider@example.invalid", "Development Provider"),
      ensureUser("gym-trainer@example.invalid", "Development Gym Trainer"),
      ensureUser("trainee@example.invalid", "Development Gym Trainee"),
    ]);
  await prisma.user.update({
    data: { platformRole: PlatformRole.JORMALL_SUPER_ADMIN },
    where: { id: superAdmin.id },
  });
  const organizationA = await ensureOrganization(superAdmin.id, owner, {
    nameAr: "عيادة التطوير أ",
    nameEn: "Development Clinic A",
    slug: "development-clinic-a",
  });
  const organizationB = await ensureOrganization(superAdmin.id, beautyOwner, {
    nameAr: "صالون التطوير ب",
    nameEn: "Development Salon B",
    slug: "development-salon-b",
  });
  const organizationC = await ensureOrganization(superAdmin.id, gymOwner, {
    nameAr: "نادي التطوير ج",
    nameEn: "Development Gym C",
    slug: "development-gym-c",
  });

  const ownerMembership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: organizationA.id, userId: owner.id } },
  });
  if (!ownerMembership) throw new Error("Seed owner membership was not created.");
  const access = await repository.loadTenantAccess(
    owner.id,
    { activeMembershipId: ownerMembership.id, activeOrganizationId: organizationA.id },
    {},
  );
  for (const [organization, sectorOwner, businessSector] of [
    [organizationA, owner, BusinessSector.CLINIC],
    [organizationB, beautyOwner, BusinessSector.BEAUTY_CENTER],
    [organizationC, gymOwner, BusinessSector.GYM],
  ] as const) {
    const membership = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_userId: { organizationId: organization.id, userId: sectorOwner.id },
      },
    });
    if (!membership) throw new Error("Seed owner sector membership was not created.");
    const sectorAccess =
      organization.id === organizationA.id
        ? access
        : await repository.loadTenantAccess(
            sectorOwner.id,
            {
              activeMembershipId: membership.id,
              activeOrganizationId: organization.id,
            },
            {},
          );
    if ((await repository.getBusinessSector(sectorAccess)) !== businessSector) {
      await repository.setBusinessSector(sectorAccess, businessSector);
    }
  }

  const gymOwnerMembership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: organizationC.id, userId: gymOwner.id } },
  });
  if (!gymOwnerMembership) throw new Error("Seed gym owner membership was not created.");
  const gymAccess = await repository.loadTenantAccess(
    gymOwner.id,
    {
      activeMembershipId: gymOwnerMembership.id,
      activeOrganizationId: organizationC.id,
    },
    {},
  );
  const gymRoles = await repository.listRoles(gymAccess);
  let gymTrainerMembership = await prisma.organizationMembership.findUnique({
    where: {
      organizationId_userId: { organizationId: organizationC.id, userId: gymTrainer.id },
    },
  });
  if (!gymTrainerMembership) {
    const providerRole = gymRoles.find(({ systemKey }) => systemKey === "PROVIDER");
    if (!providerRole) throw new Error("Gym provider role is missing.");
    const token = await repository.createInvitation(gymAccess, gymTrainer.email, providerRole.id);
    const accepted = await repository.acceptInvitation(gymTrainer.id, gymTrainer.email, token);
    gymTrainerMembership = await prisma.organizationMembership.findUnique({
      where: { id: accepted.membershipId },
    });
  }
  if (!gymTrainerMembership) throw new Error("Gym trainer membership is missing.");
  if ((await repository.listBranches(gymAccess)).length === 0) {
    await repository.createBranch(gymAccess, {
      nameAr: "فرع النادي الرئيسي",
      nameEn: "Main Gym Branch",
      timezone: "Asia/Amman",
    });
  }
  if ((await repository.listServices(gymAccess)).length === 0) {
    await repository.createService(gymAccess, {
      currency: "JOD",
      defaultDurationMins: 60,
      defaultPriceMinor: 3500,
      nameAr: "جلسة تدريب شخصي",
      nameEn: "Personal training session",
    });
  }
  const [gymBranch] = await repository.listBranches(gymAccess);
  const [gymService] = await repository.listServices(gymAccess);
  if (!gymBranch || !gymService) throw new Error("Gym branch or service is missing.");
  const gymTrainerProfile = await runInTenant(
    prisma,
    { actorUserId: gymOwner.id, organizationId: organizationC.id },
    async (transaction) => {
      const profile = await transaction.staffProfile.findFirst({
        where: { membershipId: gymTrainerMembership.id, organizationId: organizationC.id },
      });
      if (!profile) throw new Error("Gym trainer profile is missing.");
      await transaction.staffProfile.update({
        data: { isBookable: true },
        where: { id: profile.id },
      });
      await transaction.staffBranchAssignment.upsert({
        create: {
          branchId: gymBranch.id,
          organizationId: organizationC.id,
          staffProfileId: profile.id,
        },
        update: {},
        where: {
          organizationId_staffProfileId_branchId: {
            branchId: gymBranch.id,
            organizationId: organizationC.id,
            staffProfileId: profile.id,
          },
        },
      });
      await transaction.staffService.upsert({
        create: {
          isEnabled: true,
          organizationId: organizationC.id,
          serviceId: gymService.id,
          staffProfileId: profile.id,
        },
        update: { isEnabled: true },
        where: {
          organizationId_staffProfileId_serviceId: {
            organizationId: organizationC.id,
            serviceId: gymService.id,
            staffProfileId: profile.id,
          },
        },
      });
      const existingRules = await transaction.availabilityRule.findMany({
        select: { weekday: true },
        where: {
          branchId: gymBranch.id,
          organizationId: organizationC.id,
          staffProfileId: profile.id,
        },
      });
      const existingWeekdays = new Set(existingRules.map(({ weekday }) => weekday));
      await transaction.availabilityRule.createMany({
        data: seedWeekdays
          .filter((weekday) => !existingWeekdays.has(weekday))
          .map((weekday) => ({
            branchId: gymBranch.id,
            endMinuteLocal: 1440,
            organizationId: organizationC.id,
            staffProfileId: profile.id,
            startMinuteLocal: 0,
            weekday,
          })),
      });
      return profile;
    },
  );
  await repository.configureServiceBranch(gymAccess, {
    branchId: gymBranch.id,
    durationMins: 60,
    isEnabled: true,
    priceMinor: 3500,
    serviceId: gymService.id,
  });
  const gymCustomers = await crmRepository.listCustomers(gymAccess, "أحمد المتدرّب");
  const gymCustomer =
    gymCustomers.find(({ displayName }) => displayName === "أحمد المتدرّب") ??
    (
      await crmRepository.createCustomer(gymAccess, {
        displayName: "أحمد المتدرّب",
        phoneOriginal: "0790000123",
        preferredLocale: "ar",
      })
    ).customer;
  let gymTrainee = (await gymRepository.listTrainees(gymAccess)).find(
    ({ customerId }) => customerId === gymCustomer.id,
  );
  if (!gymTrainee) {
    gymTrainee = await gymRepository.createTrainee(gymAccess, {
      currency: "JOD",
      customerId: gymCustomer.id,
      experienceLevel: "INTERMEDIATE",
      goal: "MUSCLE_GAIN",
      heightCm: 178,
      monthlyFoodBudgetMinor: 180_000,
      startingWeightKg: 80,
      targetWeightKg: 88,
      trainerStaffProfileId: gymTrainerProfile.id,
    });
  }
  let gymTraineeDetail = await gymRepository.getTrainee(gymAccess, gymTrainee.id);
  if (gymTraineeDetail.workoutPlans.length === 0) {
    const plan = await gymRepository.createWorkoutPlan(gymAccess, {
      startsOn: new Date("2026-01-01T00:00:00.000Z"),
      traineeProfileId: gymTrainee.id,
      titleAr: "خطة القوة والبناء",
      titleEn: "Strength and muscle plan",
    });
    for (const [index, weekday] of seedWeekdays.entries()) {
      await gymRepository.addWorkoutExercise(gymAccess, {
        nameAr: index % 2 === 0 ? "ضغط صدر بالبار" : "سحب أمامي",
        nameEn: index % 2 === 0 ? "Barbell bench press" : "Lat pulldown",
        repsMax: 12,
        repsMin: 8,
        restSeconds: 90,
        sets: 4,
        sortOrder: 0,
        targetWeightKg: index % 2 === 0 ? 60 : 45,
        weekday,
        workoutPlanId: plan.id,
      });
    }
  }
  gymTraineeDetail = await gymRepository.getTrainee(gymAccess, gymTrainee.id);
  if (gymTraineeDetail.progressEntries.length === 0) {
    await gymRepository.recordProgress(gymAccess, {
      bodyFatPercent: 18,
      bodyWeightKg: 83,
      measuredAt: new Date(),
      traineeProfileId: gymTrainee.id,
      waistCm: 86,
    });
  }
  if (gymTraineeDetail.nutritionPlans.length === 0) {
    const nutrition = await gymRepository.createNutritionPlan(gymAccess, {
      carbohydratesGrams: 280,
      currency: "JOD",
      dailyBudgetMinor: 600,
      dailyCalories: 2450,
      fatGrams: 70,
      goal: "MUSCLE_GAIN",
      proteinGrams: 165,
      startsOn: new Date("2026-01-01T00:00:00.000Z"),
      traineeProfileId: gymTrainee.id,
      titleAr: "غذاء بناء العضلات ضمن الميزانية",
      titleEn: "Budget muscle-building nutrition",
    });
    await gymRepository.addNutritionMeal(gymAccess, {
      calories: 620,
      carbohydratesGrams: 78,
      estimatedCostMinor: 135,
      fatGrams: 18,
      nameAr: "دجاج وأرز وسلطة",
      nameEn: "Chicken, rice and salad",
      nutritionPlanId: nutrition.id,
      proteinGrams: 48,
      sortOrder: 0,
      timingLabelAr: "الغداء",
      timingLabelEn: "Lunch",
    });
  }
  if (!(await gymRepository.hasActivePortalAccess(traineeUser.id))) {
    const portalToken = await gymRepository.createPortalInvitation(gymAccess, {
      email: traineeUser.email,
      traineeProfileId: gymTrainee.id,
    });
    await gymRepository.acceptPortalInvitation(traineeUser.id, traineeUser.email, portalToken);
  }
  const gymDay = localDateTimeInAmman(new Date()).slice(0, 10);
  if ((await crmRepository.listAppointments(gymAccess, { day: gymDay })).length === 0) {
    await crmRepository.createAppointment(gymAccess, {
      branchId: gymBranch.id,
      customerId: gymCustomer.id,
      providerId: gymTrainerProfile.id,
      serviceId: gymService.id,
      startsAtLocal: localDateTimeInAmman(new Date(Date.now() + 90 * 60 * 1000)),
    });
  }
  const roles = await repository.listRoles(access);
  for (const invitee of [
    { roleKey: "SECRETARY", user: secretary },
    { roleKey: "PROVIDER", user: provider },
  ] as const) {
    const membership = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: organizationA.id,
          userId: invitee.user.id,
        },
      },
    });
    if (!membership) {
      const role = roles.find(({ systemKey }) => systemKey === invitee.roleKey);
      if (!role) throw new Error(`Seed role ${invitee.roleKey} is missing.`);
      const token = await repository.createInvitation(access, invitee.user.email, role.id);
      await repository.acceptInvitation(invitee.user.id, invitee.user.email, token);
    }
  }
  if ((await repository.listBranches(access)).length === 0) {
    await repository.createBranch(access, {
      nameAr: "فرع عمّان",
      nameEn: "Amman Branch",
      timezone: "Asia/Amman",
    });
  }
  if ((await repository.listServices(access)).length === 0) {
    await repository.createService(access, {
      currency: "JOD",
      defaultDurationMins: 30,
      defaultPriceMinor: 2500,
      nameAr: "استشارة تطويرية",
      nameEn: "Development Consultation",
    });
  }
  const [branch] = await repository.listBranches(access);
  const [service] = await repository.listServices(access);
  const providerMembership = await prisma.organizationMembership.findUnique({
    where: {
      organizationId_userId: { organizationId: organizationA.id, userId: provider.id },
    },
  });
  if (!branch || !service || !providerMembership) {
    throw new Error("Development CRM fixture prerequisites are missing.");
  }
  const providerProfile = await runInTenant(
    prisma,
    { actorUserId: owner.id, organizationId: organizationA.id },
    async (transaction) => {
      const profile = await transaction.staffProfile.findFirst({
        where: { membershipId: providerMembership.id, organizationId: organizationA.id },
      });
      if (!profile) throw new Error("Development provider profile is missing.");
      await transaction.staffProfile.update({
        data: { isBookable: true },
        where: { id: profile.id },
      });
      await transaction.staffBranchAssignment.upsert({
        create: {
          branchId: branch.id,
          organizationId: organizationA.id,
          staffProfileId: profile.id,
        },
        update: {},
        where: {
          organizationId_staffProfileId_branchId: {
            branchId: branch.id,
            organizationId: organizationA.id,
            staffProfileId: profile.id,
          },
        },
      });
      await transaction.staffService.upsert({
        create: {
          isEnabled: true,
          organizationId: organizationA.id,
          serviceId: service.id,
          staffProfileId: profile.id,
        },
        update: { isEnabled: true },
        where: {
          organizationId_staffProfileId_serviceId: {
            organizationId: organizationA.id,
            serviceId: service.id,
            staffProfileId: profile.id,
          },
        },
      });
      const existingRules = await transaction.availabilityRule.findMany({
        select: { weekday: true },
        where: {
          branchId: branch.id,
          organizationId: organizationA.id,
          staffProfileId: profile.id,
        },
      });
      const existingWeekdays = new Set(existingRules.map(({ weekday }) => weekday));
      await transaction.availabilityRule.createMany({
        data: seedWeekdays
          .filter((weekday) => !existingWeekdays.has(weekday))
          .map((weekday) => ({
            branchId: branch.id,
            endMinuteLocal: 1440,
            organizationId: organizationA.id,
            staffProfileId: profile.id,
            startMinuteLocal: 0,
            weekday,
          })),
      });
      return profile;
    },
  );
  await repository.configureServiceBranch(access, {
    branchId: branch.id,
    durationMins: 30,
    isEnabled: true,
    priceMinor: 2500,
    serviceId: service.id,
  });
  const existingCustomer = await crmRepository.listCustomers(access, "Leila Development");
  const customer =
    existingCustomer.find((record) => record.displayName === "Leila Development") ??
    (
      await crmRepository.createCustomer(access, {
        displayName: "Leila Development",
        phoneOriginal: "079 123 4567",
        preferredLocale: "en",
      })
    ).customer;
  const consentHistory = await crmRepository.getCustomer(access, customer.id);
  if (
    !consentHistory.consents.some(
      ({ purpose, status }) => purpose === "appointment_slot_offers" && status === "GRANTED",
    )
  ) {
    await crmRepository.recordConsent(access, {
      channel: "STAFF",
      customerId: customer.id,
      purpose: "appointment_slot_offers",
      source: "STAFF",
      status: "GRANTED",
      textVersion: "development-v1",
    });
  }
  if (
    !consentHistory.consents.some(
      ({ purpose, status }) => purpose === "appointment_messages" && status === "GRANTED",
    )
  ) {
    await crmRepository.recordConsent(access, {
      channel: "STAFF",
      customerId: customer.id,
      purpose: "appointment_messages",
      source: "STAFF",
      status: "GRANTED",
      textVersion: "development-v1",
    });
  }
  await communicationRepository.setCommunicationPreference(access, {
    channel: "SMS",
    customerId: customer.id,
    enabled: true,
    reason: "Development-only mock lifecycle fixture",
  });
  await communicationRepository.setCommunicationPreference(access, {
    channel: "WHATSAPP",
    customerId: customer.id,
    enabled: true,
    reason: "Development-only mock lifecycle fixture",
  });
  const resourceConfiguration = await schedulingRepository.listResourceConfiguration(access);
  let roomGroup = resourceConfiguration.groups.find(
    (group) =>
      group.branchId === branch.id &&
      group.kind === "ROOM" &&
      group.nameEn === "Consultation rooms",
  );
  if (!roomGroup) {
    roomGroup = await schedulingRepository.createResourceGroup(access, {
      branchId: branch.id,
      kind: "ROOM",
      nameAr: "غرف الاستشارة",
      nameEn: "Consultation rooms",
    });
  }
  const refreshedResources = await schedulingRepository.listResourceConfiguration(access);
  const refreshedGroup = refreshedResources.groups.find(({ id }) => id === roomGroup.id);
  if (!refreshedGroup?.resources.length) {
    await schedulingRepository.createResource(access, {
      groupId: roomGroup.id,
      nameAr: "غرفة 1",
      nameEn: "Room 1",
    });
  }
  await schedulingRepository.setServiceResourceRequirement(access, {
    branchId: branch.id,
    quantity: 1,
    resourceGroupId: roomGroup.id,
    serviceId: service.id,
  });
  const existingAppointments = await crmRepository.listAppointments(access, {
    branchId: branch.id,
  });
  if (!existingAppointments.some((appointment) => appointment.customerId === customer.id)) {
    await crmRepository.createAppointment(access, {
      branchId: branch.id,
      customerId: customer.id,
      providerId: providerProfile.id,
      serviceId: service.id,
      startsAtLocal: localDateTimeInAmman(new Date(Date.now() + 2 * 60 * 60 * 1000)),
    });
  }
  const knowledgeSources = await aiFoundationRepository.listKnowledgeSources(access);
  if (!knowledgeSources.some(({ name }) => name === "Development business information")) {
    const knowledge = await aiFoundationRepository.ingestKnowledge(access, {
      content:
        "JorMall Development Clinic is open Sunday through Thursday from 09:00 to 17:00.\n\nعيادة جورمول التجريبية مفتوحة من الأحد إلى الخميس من الساعة التاسعة صباحاً حتى الخامسة مساءً.",
      name: "Development business information",
      title: "Hours and business information",
    });
    await aiFoundationRepository.activateKnowledgeVersion(
      access,
      knowledge.sourceId,
      knowledge.versionId,
    );
  }
  const aiConversations = await aiFoundationRepository.listAIConversations(access);
  if (!aiConversations.some(({ customerId }) => customerId === customer.id)) {
    const conversation = await aiFoundationRepository.createAIConversation(access, {
      customerId: customer.id,
      locale: "mixed",
    });
    const context = await aiFoundationRepository.trustedContextForConversation(
      access,
      conversation.id,
    );
    await aiFoundationRepository.appendCustomerMessage(context, {
      content: "What are your business hours? / شو ساعات الدوام؟",
      safetyStatus: "SAFE",
    });
    await aiFoundationRepository.appendAssistantMessage(context, {
      content:
        "Development mock conversation only. Use the deterministic model integration test to prove the Action Gateway.",
      latencyMs: 0,
      safetyStatus: "SAFE",
    });
  }
  const channelOverview = await aiChannelRepository.listChannelOverview(access);
  if (channelOverview.widgets.length === 0) {
    await aiChannelRepository.createWidgetConfiguration(access, {
      accentColor: "#d7f265",
      allowedOrigins: ["http://localhost:3000"],
      defaultLocale: "en",
      displayNameAr: "مساعد عيادة جورمول",
      displayNameEn: "JorMall Clinic Assistant",
      name: "Local development widget",
      primaryColor: "#125e46",
    });
  }
}

function localDateTimeInAmman(date: Date): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Amman",
      year: "numeric",
    })
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}T${values.hour === "24" ? "00" : values.hour}:${values.minute}`;
}

await main();
await prisma.$disconnect();
process.stdout.write("Development identities and three isolated organizations are ready.\n");
