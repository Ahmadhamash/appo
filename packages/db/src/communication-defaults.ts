import { CommunicationChannel, type Prisma } from "./generated/prisma/client";

const bodies = {
  MISSED_CALL_RECOVERY: {
    ar: "مرحباً {{customerName}}، لاحظنا مكالمتك الفائتة. رد على هذه الرسالة إذا رغبت بمتابعة الطلب.",
    en: "Hello {{customerName}}, we noticed your missed call. Reply if you would like us to follow up.",
  },
  APPOINTMENT_CANCELLATION: {
    ar: "تم إلغاء موعد {{serviceName}} بتاريخ {{startsAt}}.",
    en: "Your {{serviceName}} appointment at {{startsAt}} has been cancelled.",
  },
  APPOINTMENT_CONFIRMATION: {
    ar: "مرحباً {{customerName}}، تم تأكيد موعد {{serviceName}} بتاريخ {{startsAt}}.",
    en: "Hello {{customerName}}, your {{serviceName}} appointment is confirmed for {{startsAt}}.",
  },
  APPOINTMENT_REMINDER: {
    ar: "تذكير: موعد {{serviceName}} الخاص بك بتاريخ {{startsAt}}.",
    en: "Reminder: your {{serviceName}} appointment is at {{startsAt}}.",
  },
  SLOT_OFFER: {
    ar: "يتوفر موعد لخدمة {{serviceName}} بتاريخ {{startsAt}}. تواصل مع المؤسسة للقبول.",
    en: "A {{serviceName}} slot is available at {{startsAt}}. Contact the organization to accept.",
  },
} as const;

export async function createCommunicationDefaults(
  transaction: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  const voiceNumber = `+9626${(
    BigInt(`0x${organizationId.replaceAll("-", "").slice(0, 12)}`) % 10_000_000n
  )
    .toString()
    .padStart(7, "0")}`;
  await transaction.providerConnection.createMany({
    data: [
      {
        adapterKey: "MOCK_WHATSAPP",
        channel: CommunicationChannel.WHATSAPP,
        name: "Local mock WhatsApp",
        organizationId,
        webhookSecretReference: "env:MOCK_WHATSAPP_WEBHOOK_SECRET",
      },
      {
        adapterKey: "MOCK_SMS",
        channel: CommunicationChannel.SMS,
        name: "Local mock SMS",
        organizationId,
      },
      {
        adapterKey: "MOCK_VOICE",
        channel: CommunicationChannel.VOICE,
        name: "Local mock voice",
        organizationId,
        providerAccountId: voiceNumber,
        webhookSecretReference: "env:MOCK_VOICE_WEBHOOK_SECRET",
      },
    ],
  });
  await transaction.messageTemplate.createMany({
    data: Object.entries(bodies).flatMap(([key, translations]) =>
      ([CommunicationChannel.SMS, CommunicationChannel.WHATSAPP] as const).flatMap((channel) => [
        { body: translations.en, channel, key, locale: "en" as const, organizationId },
        { body: translations.ar, channel, key, locale: "ar" as const, organizationId },
      ]),
    ),
  });
}
