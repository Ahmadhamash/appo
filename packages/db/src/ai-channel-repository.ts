import { createHash, randomBytes } from "node:crypto";

import type { AITrustedContext } from "@jormall/domain/ai-foundation";
import { assertCallStatusTransition } from "@jormall/domain/ai-channels";
import { isCommunicationOptOut } from "@jormall/domain/ai-channels";
import { renderCommunicationTemplate } from "@jormall/domain/communications";
import { DomainError } from "@jormall/domain/errors";
import type { PermissionCode, TenantAccessSnapshot } from "@jormall/domain/identity";
import { normalizeJordanianPhone } from "@jormall/domain/jordan-phone";

import { createAIFoundationDefaults } from "./ai-defaults";
import {
  AICustomerChannel,
  AIChannelSessionStatus,
  AIConversationStatus,
  CallEventStatus,
  CallStatus,
  CommunicationChannel,
  ConsentStatus,
  MessageDirection,
  MessageStatus,
  OrganizationStatus,
  OutboxEventStatus,
  Prisma,
  ProviderConnectionStatus,
  RecordingConsentStatus,
  type PrismaClient,
  type SupportedLocale,
} from "./generated/prisma/client";
import { runInTenant, type TenantTransaction } from "./tenant-context";

const aiServiceActorId = "00000000-0000-4000-8000-000000000005";
const communicationConsentPurpose = "appointment_messages";

export type WidgetConfigurationInput = Readonly<{
  accentColor: string;
  allowedOrigins: readonly string[];
  defaultLocale: SupportedLocale;
  displayNameAr: string;
  displayNameEn: string;
  name: string;
  primaryColor: string;
}>;

export type NormalizedVoiceEvent = Readonly<{
  confidence?: number | undefined;
  eventId: string;
  from?: string | undefined;
  isFinal?: boolean | undefined;
  locale: SupportedLocale;
  occurredAt: string;
  providerCallId: string;
  sequence?: number | undefined;
  text?: string | undefined;
  to: string;
  type: string;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireGrant(access: TenantAccessSnapshot, permission: PermissionCode): void {
  if (!access.grants.some((grant) => grant.code === permission)) {
    throw new DomainError({ code: "FORBIDDEN", message: "The AI channel permission is missing." });
  }
}

async function assertActiveOrganization(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<void> {
  const organization = await transaction.organization.findFirst({
    select: { status: true },
    where: { id: organizationId },
  });
  if (organization?.status === OrganizationStatus.SUSPENDED) {
    throw new DomainError({ code: "ORGANIZATION_SUSPENDED", message: "Organization suspended." });
  }
  if (organization?.status !== OrganizationStatus.ACTIVE) {
    throw new DomainError({ code: "NOT_FOUND", message: "Organization not found." });
  }
}

function normalizedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Widget origin is invalid." });
  }
  const localDevelopment =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !localDevelopment) || url.origin !== value) {
    throw new DomainError({
      code: "VALIDATION_FAILED",
      message: "Widget origins must be exact HTTPS origins or local development origins.",
    });
  }
  return url.origin;
}

function safeColors(input: Pick<WidgetConfigurationInput, "accentColor" | "primaryColor">): void {
  if (![input.accentColor, input.primaryColor].every((value) => /^#[0-9a-f]{6}$/iu.test(value))) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Widget color is invalid." });
  }
}

function actionChannel(channel: AICustomerChannel): AITrustedContext["channel"] {
  return channel === AICustomerChannel.WEBSITE
    ? "website_chat"
    : channel === AICustomerChannel.WHATSAPP
      ? "whatsapp"
      : "voice";
}

export class AIChannelRepository {
  constructor(private readonly client: PrismaClient) {}

  async createWidgetConfiguration(access: TenantAccessSnapshot, input: WidgetConfigurationInput) {
    requireGrant(access, "ai.configure");
    safeColors(input);
    const origins = [...new Set(input.allowedOrigins.map(normalizedOrigin))];
    if (origins.length < 1 || origins.length > 20) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Widget origins are invalid." });
    }
    return runInTenant(this.client, access, async (transaction) => {
      await assertActiveOrganization(transaction, access.organizationId);
      const configuration = await transaction.websiteWidgetConfiguration.create({
        data: {
          accentColor: input.accentColor.toLocaleLowerCase("en"),
          allowedOrigins: origins,
          defaultLocale: input.defaultLocale,
          displayNameAr: input.displayNameAr.trim(),
          displayNameEn: input.displayNameEn.trim(),
          name: input.name.trim(),
          organizationId: access.organizationId,
          primaryColor: input.primaryColor.toLocaleLowerCase("en"),
        },
      });
      await transaction.auditEvent.create({
        data: {
          action: "AI_WIDGET_CONFIGURATION_CREATED",
          actorUserId: access.actorUserId,
          organizationId: access.organizationId,
          targetId: configuration.id,
          targetType: "WebsiteWidgetConfiguration",
        },
      });
      return configuration;
    });
  }

  async listChannelOverview(access: TenantAccessSnapshot) {
    requireGrant(access, "ai.configure");
    return runInTenant(this.client, access, async (transaction) => {
      const [widgets, connections, calls] = await Promise.all([
        transaction.websiteWidgetConfiguration.findMany({ orderBy: { createdAt: "asc" } }),
        transaction.providerConnection.findMany({
          orderBy: { createdAt: "asc" },
          select: {
            adapterKey: true,
            channel: true,
            id: true,
            name: true,
            providerAccountId: true,
            status: true,
          },
          where: { channel: { in: [CommunicationChannel.WHATSAPP, CommunicationChannel.VOICE] } },
        }),
        transaction.call.findMany({
          include: { summary: true },
          orderBy: { startedAt: "desc" },
          take: 50,
        }),
      ]);
      return { calls, connections, widgets };
    });
  }

  async resolveWidgetConfiguration(publicKey: string) {
    const route = await this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_channel_router"');
      return transaction.websiteWidgetConfiguration.findUnique({
        select: { id: true, organizationId: true },
        where: { publicKey },
      });
    });
    if (!route) return null;
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: route.organizationId },
      async (transaction) => {
        await assertActiveOrganization(transaction, route.organizationId);
        return transaction.websiteWidgetConfiguration.findFirst({
          where: { id: route.id, isActive: true, organizationId: route.organizationId },
        });
      },
    );
  }

  async openWebsiteSession(
    input: Readonly<{
      configurationId: string;
      configurationVersion: number;
      locale: SupportedLocale;
      nonce: string;
      organizationId: string;
      origin: string;
    }>,
  ) {
    const origin = normalizedOrigin(input.origin);
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        await assertActiveOrganization(transaction, input.organizationId);
        const widget = await transaction.websiteWidgetConfiguration.findFirst({
          where: {
            id: input.configurationId,
            isActive: true,
            organizationId: input.organizationId,
            version: input.configurationVersion,
          },
        });
        if (!widget || !widget.allowedOrigins.includes(origin)) {
          throw new DomainError({ code: "NOT_FOUND", message: "Widget was not found." });
        }
        await createAIFoundationDefaults(transaction, input.organizationId);
        const prompt = await transaction.promptConfiguration.findFirstOrThrow({
          where: { isActive: true, organizationId: input.organizationId },
        });
        const conversation = await transaction.aIConversation.create({
          data: {
            channel: "WEBSITE_CHAT",
            locale: input.locale,
            modelIdentifier: "jormall-deterministic-mock-v1",
            organizationId: input.organizationId,
            promptConfigurationId: prompt.id,
          },
        });
        const session = await transaction.aIChannelSession.create({
          data: {
            channel: AICustomerChannel.WEBSITE,
            conversationId: conversation.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
            externalKeyHash: digest(input.nonce),
            locale: input.locale,
            organizationId: input.organizationId,
            origin,
            widgetConfigurationId: widget.id,
          },
        });
        await transaction.attributionEvent.create({
          data: {
            occurredAt: new Date(),
            organizationId: input.organizationId,
            source: "WEBSITE_CHATBOT",
            sourceDetail: "Website AI session started",
          },
        });
        return { session, widget };
      },
    );
  }

  async trustedWebsiteContext(
    input: Readonly<{
      nonce: string;
      organizationId: string;
      origin: string;
      sessionId: string;
    }>,
  ): Promise<AITrustedContext> {
    return this.trustedSessionContext({
      channel: AICustomerChannel.WEBSITE,
      externalKeyHash: digest(input.nonce),
      organizationId: input.organizationId,
      origin: normalizedOrigin(input.origin),
      sessionId: input.sessionId,
    });
  }

  async trustedWebsiteContextFromCapability(
    input: Readonly<{
      nonce: string;
      origin: string;
    }>,
  ): Promise<AITrustedContext> {
    const route = await this.resolveWebsiteSessionRoute(input.nonce);
    if (!route) {
      throw new DomainError({ code: "NOT_FOUND", message: "AI channel session not found." });
    }
    return this.trustedWebsiteContext({
      nonce: input.nonce,
      organizationId: route.organizationId,
      origin: input.origin,
      sessionId: route.id,
    });
  }

  async bindDevelopmentWebsiteCustomer(
    input: Readonly<{
      nonce: string;
      organizationId: string;
      phone: string;
      sessionId: string;
    }>,
  ): Promise<void> {
    const normalizedPhone = normalizeJordanianPhone(input.phone);
    if (!normalizedPhone) {
      throw new DomainError({ code: "VALIDATION_FAILED", message: "Phone is invalid." });
    }
    await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        const session = await transaction.aIChannelSession.findFirst({
          where: {
            channel: AICustomerChannel.WEBSITE,
            expiresAt: { gt: new Date() },
            externalKeyHash: digest(input.nonce),
            id: input.sessionId,
            organizationId: input.organizationId,
            status: AIChannelSessionStatus.OPEN,
          },
        });
        if (!session) throw new DomainError({ code: "NOT_FOUND", message: "Session not found." });
        const contacts = await transaction.customerContact.findMany({
          select: { customerId: true },
          take: 2,
          where: { normalizedPhoneE164: normalizedPhone, organizationId: input.organizationId },
        });
        if (contacts.length !== 1 || !contacts[0]) {
          throw new DomainError({ code: "NOT_FOUND", message: "Verified customer not found." });
        }
        await transaction.aIChannelSession.update({
          data: { customerId: contacts[0].customerId, version: { increment: 1 } },
          where: { id: session.id },
        });
        await transaction.aIConversation.update({
          data: { customerId: contacts[0].customerId, version: { increment: 1 } },
          where: { id: session.conversationId },
        });
        await transaction.auditEvent.create({
          data: {
            action: "AI_WIDGET_CUSTOMER_VERIFIED_MOCK",
            organizationId: input.organizationId,
            targetId: session.id,
            targetType: "AIChannelSession",
          },
        });
      },
    );
  }

  async bindDevelopmentWebsiteCustomerFromCapability(
    input: Readonly<{
      nonce: string;
      origin: string;
      phone: string;
    }>,
  ): Promise<void> {
    const route = await this.resolveWebsiteSessionRoute(input.nonce);
    if (!route) {
      throw new DomainError({ code: "NOT_FOUND", message: "AI channel session not found." });
    }
    await this.trustedWebsiteContext({
      nonce: input.nonce,
      organizationId: route.organizationId,
      origin: input.origin,
      sessionId: route.id,
    });
    await this.bindDevelopmentWebsiteCustomer({
      nonce: input.nonce,
      organizationId: route.organizationId,
      phone: input.phone,
      sessionId: route.id,
    });
  }

  async resolveWhatsAppContext(
    input: Readonly<{
      organizationId: string;
      providerConnectionId: string;
      sender: string;
    }>,
  ): Promise<AITrustedContext> {
    const normalizedPhone = normalizeJordanianPhone(input.sender);
    if (!normalizedPhone) {
      throw new DomainError({ code: "NOT_FOUND", message: "WhatsApp customer not found." });
    }
    const sessionId = await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        await assertActiveOrganization(transaction, input.organizationId);
        const connection = await transaction.providerConnection.findFirst({
          where: {
            channel: CommunicationChannel.WHATSAPP,
            id: input.providerConnectionId,
            organizationId: input.organizationId,
            status: ProviderConnectionStatus.ACTIVE,
          },
        });
        if (!connection) {
          throw new DomainError({ code: "NOT_FOUND", message: "WhatsApp route not found." });
        }
        const contacts = await transaction.customerContact.findMany({
          select: { customerId: true },
          take: 2,
          where: { normalizedPhoneE164: normalizedPhone, organizationId: input.organizationId },
        });
        if (contacts.length !== 1 || !contacts[0]) {
          throw new DomainError({ code: "NOT_FOUND", message: "WhatsApp customer not found." });
        }
        await createAIFoundationDefaults(transaction, input.organizationId);
        const externalKeyHash = digest(`${connection.id}:${normalizedPhone}`);
        const existing = await transaction.aIChannelSession.findFirst({
          where: {
            channel: AICustomerChannel.WHATSAPP,
            externalKeyHash,
            organizationId: input.organizationId,
          },
        });
        if (existing) {
          await transaction.aIChannelSession.update({
            data: {
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
              lastInboundAt: new Date(),
              status: AIChannelSessionStatus.OPEN,
              version: { increment: 1 },
            },
            where: { id: existing.id },
          });
          return existing.id;
        }
        const customer = await transaction.customer.findFirstOrThrow({
          where: { id: contacts[0].customerId, organizationId: input.organizationId },
        });
        const prompt = await transaction.promptConfiguration.findFirstOrThrow({
          where: { isActive: true, organizationId: input.organizationId },
        });
        const conversation = await transaction.aIConversation.create({
          data: {
            channel: "WHATSAPP",
            customerId: customer.id,
            locale: customer.preferredLocale,
            modelIdentifier: "jormall-deterministic-mock-v1",
            organizationId: input.organizationId,
            promptConfigurationId: prompt.id,
          },
        });
        const session = await transaction.aIChannelSession.create({
          data: {
            channel: AICustomerChannel.WHATSAPP,
            conversationId: conversation.id,
            customerId: customer.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
            externalKeyHash,
            lastInboundAt: new Date(),
            locale: customer.preferredLocale,
            organizationId: input.organizationId,
            providerConnectionId: connection.id,
          },
        });
        await transaction.attributionEvent.create({
          data: {
            customerId: customer.id,
            occurredAt: new Date(),
            organizationId: input.organizationId,
            source: "WHATSAPP_AI",
            sourceDetail: "WhatsApp AI session started",
          },
        });
        return session.id;
      },
    );
    return this.trustedSessionContext({
      channel: AICustomerChannel.WHATSAPP,
      organizationId: input.organizationId,
      sessionId,
    });
  }

  async loadWhatsAppTurn(organizationId: string, outboxEventId: string) {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId },
      async (transaction) => {
        const event = await transaction.outboxEvent.findFirst({
          where: {
            eventType: "AI_WHATSAPP_TURN_REQUESTED",
            id: outboxEventId,
            organizationId,
          },
        });
        if (!event) throw new DomainError({ code: "NOT_FOUND", message: "AI turn not found." });
        const payload = event.payload;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new DomainError({ code: "VALIDATION_FAILED", message: "AI turn is invalid." });
        }
        const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
        const inboxEventId = typeof payload.inboxEventId === "string" ? payload.inboxEventId : "";
        const [message, inbox] = await Promise.all([
          transaction.message.findFirst({ where: { id: messageId, organizationId } }),
          transaction.inboxEvent.findFirst({
            include: { providerConnection: true },
            where: { id: inboxEventId, organizationId },
          }),
        ]);
        if (!message || !inbox) {
          throw new DomainError({ code: "NOT_FOUND", message: "Inbound message not found." });
        }
        return { inbox, message, outbox: event };
      },
    );
  }

  async applyWhatsAppOptOut(
    organizationId: string,
    outboxEventId: string,
    customerId: string,
  ): Promise<void> {
    await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId },
      async (transaction) => {
        await transaction.communicationPreference.upsert({
          create: {
            channel: CommunicationChannel.WHATSAPP,
            customerId,
            isEnabled: false,
            organizationId,
            reason: "Customer opt-out received through verified WhatsApp channel",
          },
          update: {
            isEnabled: false,
            reason: "Customer opt-out received through verified WhatsApp channel",
            version: { increment: 1 },
          },
          where: {
            organizationId_customerId_channel: {
              channel: CommunicationChannel.WHATSAPP,
              customerId,
              organizationId,
            },
          },
        });
        await transaction.auditEvent.create({
          data: {
            action: "WHATSAPP_CUSTOMER_OPT_OUT",
            organizationId,
            targetId: customerId,
            targetType: "Customer",
          },
        });
        await this.finishOutbox(transaction, outboxEventId);
      },
    );
  }

  async queueWhatsAppAssistantResponse(
    input: Readonly<{
      body: string;
      inboundMessageId: string;
      organizationId: string;
      outboxEventId: string;
    }>,
  ): Promise<boolean> {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        const inbound = await transaction.message.findFirst({
          where: { id: input.inboundMessageId, organizationId: input.organizationId },
        });
        if (!inbound?.providerConnectionId) {
          throw new DomainError({ code: "NOT_FOUND", message: "Inbound message not found." });
        }
        const [preference, consent] = await Promise.all([
          transaction.communicationPreference.findUnique({
            where: {
              organizationId_customerId_channel: {
                channel: CommunicationChannel.WHATSAPP,
                customerId: inbound.customerId,
                organizationId: input.organizationId,
              },
            },
          }),
          transaction.consent.findFirst({
            orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
            where: {
              customerId: inbound.customerId,
              organizationId: input.organizationId,
              purpose: communicationConsentPurpose,
            },
          }),
        ]);
        if (!preference?.isEnabled || consent?.status !== ConsentStatus.GRANTED) {
          await transaction.auditEvent.create({
            data: {
              action: "AI_WHATSAPP_REPLY_SUPPRESSED_CONSENT",
              organizationId: input.organizationId,
              targetId: inbound.id,
              targetType: "Message",
            },
          });
          await this.finishOutbox(transaction, input.outboxEventId);
          return false;
        }
        const message = await transaction.message.create({
          data: {
            body: input.body,
            channel: CommunicationChannel.WHATSAPP,
            consentId: consent.id,
            consentPurpose: communicationConsentPurpose,
            conversationId: inbound.conversationId,
            customerId: inbound.customerId,
            direction: MessageDirection.OUTBOUND,
            locale: inbound.locale,
            organizationId: input.organizationId,
            providerConnectionId: inbound.providerConnectionId,
            status: MessageStatus.QUEUED,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            aggregateId: message.id,
            aggregateType: "Message",
            aggregateVersion: message.version,
            deduplicationKey: `message:${message.id}:ai-send:v${message.version}`,
            eventType: "MESSAGE_SEND_REQUESTED",
            organizationId: input.organizationId,
            payload: { messageId: message.id },
          },
        });
        await transaction.conversation.update({
          data: { lastMessageAt: message.createdAt, version: { increment: 1 } },
          where: { id: inbound.conversationId },
        });
        await this.finishOutbox(transaction, input.outboxEventId);
        return true;
      },
    );
  }

  async markSuppressedChannelTurn(organizationId: string, outboxEventId: string): Promise<void> {
    await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId },
      (transaction) => this.finishOutbox(transaction, outboxEventId),
    );
  }

  async resolveVoiceConnection(connectionId: string) {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_webhook_router"');
      return transaction.providerConnection.findUnique({
        select: {
          adapterKey: true,
          channel: true,
          id: true,
          mockBehavior: true,
          organizationId: true,
          providerAccountId: true,
          status: true,
          webhookSecretReference: true,
        },
        where: { id: connectionId },
      });
    });
  }

  async storeVerifiedVoiceEvent(
    connection: Readonly<{
      id: string;
      organizationId: string;
      providerAccountId: string | null;
    }>,
    event: NormalizedVoiceEvent,
    rawBody: string,
  ): Promise<Readonly<{ callEventId?: string; duplicate: boolean }>> {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: connection.organizationId },
      async (transaction) => {
        await assertActiveOrganization(transaction, connection.organizationId);
        const verifiedRoute = await transaction.providerConnection.findFirst({
          select: { id: true },
          where: {
            channel: CommunicationChannel.VOICE,
            id: connection.id,
            organizationId: connection.organizationId,
            providerAccountId: event.to,
            status: ProviderConnectionStatus.ACTIVE,
          },
        });
        if (
          !verifiedRoute ||
          !connection.providerAccountId ||
          connection.providerAccountId !== event.to
        ) {
          throw new DomainError({ code: "NOT_FOUND", message: "Dialed voice route not found." });
        }
        let call = await transaction.call.findFirst({
          where: {
            organizationId: connection.organizationId,
            providerCallId: event.providerCallId,
            providerConnectionId: connection.id,
          },
        });
        if (!call) {
          if (event.type !== "call.started" && event.type !== "call.missed") {
            throw new DomainError({ code: "NOT_FOUND", message: "Call not found." });
          }
          await createAIFoundationDefaults(transaction, connection.organizationId);
          const normalizedPhone = normalizeJordanianPhone(event.from ?? "");
          const contact = normalizedPhone
            ? await transaction.customerContact.findFirst({
                include: { customer: true },
                where: {
                  normalizedPhoneE164: normalizedPhone,
                  organizationId: connection.organizationId,
                },
              })
            : null;
          const prompt = await transaction.promptConfiguration.findFirstOrThrow({
            where: { isActive: true, organizationId: connection.organizationId },
          });
          const conversation = await transaction.aIConversation.create({
            data: {
              channel: "VOICE",
              customerId: contact?.customerId ?? null,
              locale: event.locale,
              modelIdentifier: "jormall-deterministic-mock-v1",
              organizationId: connection.organizationId,
              promptConfigurationId: prompt.id,
            },
          });
          const session = await transaction.aIChannelSession.create({
            data: {
              channel: AICustomerChannel.VOICE,
              conversationId: conversation.id,
              customerId: contact?.customerId ?? null,
              expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000),
              externalKeyHash: digest(`${connection.id}:${event.providerCallId}`),
              lastInboundAt: new Date(event.occurredAt),
              locale: event.locale,
              organizationId: connection.organizationId,
              providerConnectionId: connection.id,
            },
          });
          await transaction.attributionEvent.create({
            data: {
              customerId: contact?.customerId ?? null,
              occurredAt: new Date(event.occurredAt),
              organizationId: connection.organizationId,
              source: "VOICE_AI",
              sourceDetail:
                event.type === "call.missed" ? "Missed voice call" : "Voice AI call started",
            },
          });
          call = await transaction.call.create({
            data: {
              channelSessionId: session.id,
              customerId: contact?.customerId ?? null,
              locale: event.locale,
              organizationId: connection.organizationId,
              providerCallId: event.providerCallId,
              providerConnectionId: connection.id,
              startedAt: new Date(event.occurredAt),
              status: event.type === "call.missed" ? CallStatus.MISSED : CallStatus.RINGING,
            },
          });
        }
        const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "call_events" (
            "organization_id", "call_id", "provider_event_id", "event_type", "sequence",
            "payload_digest", "payload", "status", "occurred_at", "created_at"
          ) VALUES (
            ${connection.organizationId}::uuid, ${call.id}::uuid, ${event.eventId}, ${event.type},
            ${event.sequence ?? null}, ${digest(rawBody)}, CAST(${JSON.stringify(event)} AS jsonb),
            'RECEIVED', ${new Date(event.occurredAt)}, CURRENT_TIMESTAMP
          )
          ON CONFLICT ("organization_id", "call_id", "provider_event_id") DO NOTHING
          RETURNING "id"
        `);
        const row = rows[0];
        if (!row) return { duplicate: true };
        if (
          (event.type === "transcript.partial" || event.type === "transcript.final") &&
          event.text
        ) {
          await transaction.callTranscript.create({
            data: {
              callEventId: row.id,
              callId: call.id,
              confidence: event.confidence ?? null,
              content: event.text,
              isFinal: event.type === "transcript.final",
              locale: event.locale,
              organizationId: connection.organizationId,
              speaker: "CUSTOMER",
              startedAt: new Date(event.occurredAt),
            },
          });
        }
        await transaction.outboxEvent.create({
          data: {
            aggregateId: row.id,
            aggregateType: "CallEvent",
            aggregateVersion: 1,
            deduplicationKey: `call-event:${row.id}:process`,
            eventType: "AI_VOICE_EVENT_REQUESTED",
            organizationId: connection.organizationId,
            payload: { callEventId: row.id },
          },
        });
        return { callEventId: row.id, duplicate: false };
      },
    );
  }

  async loadVoiceEvent(organizationId: string, outboxEventId: string) {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId },
      async (transaction) => {
        const outbox = await transaction.outboxEvent.findFirst({
          where: { eventType: "AI_VOICE_EVENT_REQUESTED", id: outboxEventId, organizationId },
        });
        if (!outbox)
          throw new DomainError({ code: "NOT_FOUND", message: "Voice event not found." });
        const payload = outbox.payload;
        const callEventId =
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          typeof payload.callEventId === "string"
            ? payload.callEventId
            : "";
        const callEvent = await transaction.callEvent.findFirst({
          include: {
            call: { include: { channelSession: true, providerConnection: true } },
          },
          where: { id: callEventId, organizationId },
        });
        if (!callEvent) {
          throw new DomainError({ code: "NOT_FOUND", message: "Voice event not found." });
        }
        return { callEvent, outbox };
      },
    );
  }

  async trustedVoiceContext(organizationId: string, sessionId: string): Promise<AITrustedContext> {
    return this.trustedSessionContext({
      channel: AICustomerChannel.VOICE,
      organizationId,
      sessionId,
    });
  }

  async recordVoiceAssistantResponse(
    input: Readonly<{
      callEventId: string;
      callId: string;
      content: string;
      locale: SupportedLocale;
      organizationId: string;
      outboxEventId: string;
    }>,
  ): Promise<void> {
    await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        const occurredAt = new Date();
        await transaction.callTranscript.create({
          data: {
            callEventId: input.callEventId,
            callId: input.callId,
            confidence: 1,
            content: input.content,
            isFinal: true,
            locale: input.locale,
            organizationId: input.organizationId,
            speaker: "ASSISTANT",
            startedAt: occurredAt,
          },
        });
        await transaction.callEvent.update({
          data: { processedAt: occurredAt, status: CallEventStatus.PROCESSED },
          where: { id: input.callEventId },
        });
        await this.finishOutbox(transaction, input.outboxEventId);
      },
    );
  }

  async processVoiceLifecycleEvent(
    input: Readonly<{
      callEventId: string;
      organizationId: string;
      outboxEventId: string;
      type: string;
    }>,
  ): Promise<void> {
    await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        const event = await transaction.callEvent.findFirst({
          include: { call: true },
          where: { id: input.callEventId, organizationId: input.organizationId },
        });
        if (!event) throw new DomainError({ code: "NOT_FOUND", message: "Call event not found." });
        const now = new Date();
        if (input.type === "call.answered") {
          if (event.call.status !== CallStatus.ACTIVE) {
            assertCallStatusTransition(event.call.status, CallStatus.ACTIVE);
            await transaction.call.update({
              data: { answeredAt: now, status: CallStatus.ACTIVE, version: { increment: 1 } },
              where: { id: event.callId },
            });
          }
        } else if (input.type === "recording.consent_granted") {
          await transaction.call.update({
            data: {
              recordingConsentStatus: RecordingConsentStatus.GRANTED,
              version: { increment: 1 },
            },
            where: { id: event.callId },
          });
        } else if (input.type === "recording.consent_declined") {
          await transaction.call.update({
            data: {
              recordingConsentStatus: RecordingConsentStatus.DECLINED,
              version: { increment: 1 },
            },
            where: { id: event.callId },
          });
        } else if (input.type === "human_transfer.requested") {
          if (event.call.status !== CallStatus.HUMAN_TRANSFER) {
            assertCallStatusTransition(event.call.status, CallStatus.HUMAN_TRANSFER);
            await transaction.call.update({
              data: { status: CallStatus.HUMAN_TRANSFER, version: { increment: 1 } },
              where: { id: event.callId },
            });
          }
        } else if (input.type === "call.completed" || input.type === "call.disconnected") {
          if (event.call.status !== CallStatus.COMPLETED) {
            assertCallStatusTransition(event.call.status, CallStatus.COMPLETED);
            await transaction.call.update({
              data: { endedAt: now, status: CallStatus.COMPLETED, version: { increment: 1 } },
              where: { id: event.callId },
            });
          }
          await transaction.callSummary.upsert({
            create: {
              callId: event.callId,
              intent: "Customer service conversation",
              modelIdentifier: event.call.channelSessionId
                ? "jormall-deterministic-mock-v1"
                : "unknown",
              organizationId: input.organizationId,
              outcome: "Call ended",
              unresolvedItems: [],
            },
            update: { outcome: "Call ended" },
            where: { callId: event.callId },
          });
        } else if (input.type === "provider.failure") {
          if (event.call.status !== CallStatus.FAILED) {
            assertCallStatusTransition(event.call.status, CallStatus.FAILED);
            await transaction.call.update({
              data: { endedAt: now, status: CallStatus.FAILED, version: { increment: 1 } },
              where: { id: event.callId },
            });
          }
        }
        await transaction.callEvent.update({
          data: { processedAt: now, status: CallEventStatus.PROCESSED },
          where: { id: event.id },
        });
        await this.finishOutbox(transaction, input.outboxEventId);
      },
    );
  }

  async queueMissedCallRecovery(
    input: Readonly<{
      callId: string;
      organizationId: string;
      outboxEventId: string;
    }>,
  ): Promise<boolean> {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        const call = await transaction.call.findFirst({
          include: {
            customer: { include: { contacts: true } },
          },
          where: { id: input.callId, organizationId: input.organizationId },
        });
        if (!call?.customer) {
          await this.finishOutbox(transaction, input.outboxEventId);
          return false;
        }
        const [consent, preferences] = await Promise.all([
          transaction.consent.findFirst({
            orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
            where: {
              customerId: call.customer.id,
              organizationId: input.organizationId,
              purpose: communicationConsentPurpose,
            },
          }),
          transaction.communicationPreference.findMany({
            where: {
              channel: { in: [CommunicationChannel.WHATSAPP, CommunicationChannel.SMS] },
              customerId: call.customer.id,
              isEnabled: true,
              organizationId: input.organizationId,
            },
          }),
        ]);
        if (consent?.status !== ConsentStatus.GRANTED) {
          await this.finishOutbox(transaction, input.outboxEventId);
          return false;
        }
        const preferredChannel = preferences.some(
          ({ channel }) => channel === CommunicationChannel.WHATSAPP,
        )
          ? CommunicationChannel.WHATSAPP
          : preferences.some(({ channel }) => channel === CommunicationChannel.SMS)
            ? CommunicationChannel.SMS
            : null;
        if (!preferredChannel) {
          await this.finishOutbox(transaction, input.outboxEventId);
          return false;
        }
        const [connection, template] = await Promise.all([
          transaction.providerConnection.findFirst({
            where: {
              channel: preferredChannel,
              organizationId: input.organizationId,
              status: ProviderConnectionStatus.ACTIVE,
            },
          }),
          transaction.messageTemplate.findFirst({
            orderBy: { version: "desc" },
            where: {
              channel: preferredChannel,
              isActive: true,
              key: "MISSED_CALL_RECOVERY",
              locale: call.locale,
              organizationId: input.organizationId,
            },
          }),
        ]);
        const contact = call.customer.contacts.find(
          ({ normalizedPhoneE164 }) => normalizedPhoneE164,
        );
        if (!connection || !template || !contact?.normalizedPhoneE164) {
          await this.finishOutbox(transaction, input.outboxEventId);
          return false;
        }
        let conversation = await transaction.conversation.findFirst({
          where: {
            channel: preferredChannel,
            customerId: call.customer.id,
            organizationId: input.organizationId,
            status: "OPEN",
          },
        });
        conversation ??= await transaction.conversation.create({
          data: {
            channel: preferredChannel,
            customerId: call.customer.id,
            organizationId: input.organizationId,
            subject: "Missed call recovery",
          },
        });
        const body = renderCommunicationTemplate(template.body, {
          customerName: call.customer.displayName,
          serviceName: "—",
          startsAt: "—",
        });
        const message = await transaction.message.create({
          data: {
            body,
            channel: preferredChannel,
            consentId: consent.id,
            consentPurpose: communicationConsentPurpose,
            conversationId: conversation.id,
            customerId: call.customer.id,
            direction: MessageDirection.OUTBOUND,
            locale: call.locale,
            organizationId: input.organizationId,
            providerConnectionId: connection.id,
            status: MessageStatus.QUEUED,
            templateId: template.id,
          },
        });
        await transaction.outboxEvent.create({
          data: {
            aggregateId: message.id,
            aggregateType: "Message",
            aggregateVersion: message.version,
            deduplicationKey: `call:${call.id}:missed-recovery`,
            eventType: "MESSAGE_SEND_REQUESTED",
            organizationId: input.organizationId,
            payload: { messageId: message.id },
          },
        });
        await transaction.attributionEvent.create({
          data: {
            customerId: call.customer.id,
            occurredAt: new Date(),
            organizationId: input.organizationId,
            source: "MISSED_CALL_RECOVERY",
            sourceDetail: preferredChannel,
          },
        });
        await this.finishOutbox(transaction, input.outboxEventId);
        return true;
      },
    );
  }

  async startRecording(
    input: Readonly<{
      callEventId: string;
      organizationId: string;
      providerRecordingId: string;
    }>,
  ) {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        const event = await transaction.callEvent.findFirst({
          include: { call: true },
          where: { id: input.callEventId, organizationId: input.organizationId },
        });
        if (!event || event.call.recordingConsentStatus !== RecordingConsentStatus.GRANTED) {
          throw new DomainError({
            code: "CONSENT_REQUIRED",
            message: "Recording consent must be granted before recording.",
          });
        }
        const consentEvent = await transaction.callEvent.findFirst({
          orderBy: { occurredAt: "desc" },
          where: {
            callId: event.callId,
            eventType: "recording.consent_granted",
            organizationId: input.organizationId,
          },
        });
        if (!consentEvent) {
          throw new DomainError({ code: "CONSENT_REQUIRED", message: "Consent evidence missing." });
        }
        return transaction.callRecording.create({
          data: {
            callId: event.callId,
            consentEventId: consentEvent.id,
            organizationId: input.organizationId,
            providerRecordingId: input.providerRecordingId,
            startedAt: new Date(),
            status: "RECORDING",
          },
        });
      },
    );
  }

  async assertRecordingConsent(organizationId: string, callEventId: string): Promise<void> {
    await runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId },
      async (transaction) => {
        const event = await transaction.callEvent.findFirst({
          include: { call: true },
          where: { id: callEventId, organizationId },
        });
        if (!event || event.call.recordingConsentStatus !== RecordingConsentStatus.GRANTED) {
          throw new DomainError({
            code: "CONSENT_REQUIRED",
            message: "Recording consent must be granted before recording.",
          });
        }
      },
    );
  }

  async recordCallSummary(
    input: Readonly<{
      appointmentId?: string | undefined;
      callId: string;
      handoffReason?: string | undefined;
      intent: string;
      organizationId: string;
      outcome: string;
      unresolvedItems: readonly string[];
    }>,
  ) {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        if (input.appointmentId) {
          const appointment = await transaction.appointment.findFirst({
            where: { id: input.appointmentId, organizationId: input.organizationId },
          });
          if (!appointment) {
            throw new DomainError({ code: "NOT_FOUND", message: "Appointment not found." });
          }
        }
        return transaction.callSummary.upsert({
          create: {
            appointmentId: input.appointmentId ?? null,
            callId: input.callId,
            handoffReason: input.handoffReason ?? null,
            intent: input.intent,
            modelIdentifier: "jormall-deterministic-mock-v1",
            organizationId: input.organizationId,
            outcome: input.outcome,
            unresolvedItems: [...input.unresolvedItems],
          },
          update: {
            appointmentId: input.appointmentId ?? null,
            handoffReason: input.handoffReason ?? null,
            intent: input.intent,
            outcome: input.outcome,
            unresolvedItems: [...input.unresolvedItems],
          },
          where: { callId: input.callId },
        });
      },
    );
  }

  isOptOut(content: string): boolean {
    return isCommunicationOptOut(content);
  }

  private async trustedSessionContext(
    input: Readonly<{
      channel: AICustomerChannel;
      externalKeyHash?: string | undefined;
      organizationId: string;
      origin?: string | undefined;
      sessionId: string;
    }>,
  ): Promise<AITrustedContext> {
    return runInTenant(
      this.client,
      { actorUserId: aiServiceActorId, organizationId: input.organizationId },
      async (transaction) => {
        await assertActiveOrganization(transaction, input.organizationId);
        const session = await transaction.aIChannelSession.findFirst({
          include: { conversation: true },
          where: {
            channel: input.channel,
            expiresAt: { gt: new Date() },
            ...(input.externalKeyHash ? { externalKeyHash: input.externalKeyHash } : {}),
            id: input.sessionId,
            organizationId: input.organizationId,
            ...(input.origin ? { origin: input.origin } : {}),
            status: AIChannelSessionStatus.OPEN,
          },
        });
        if (
          !session ||
          session.conversation.status === AIConversationStatus.CLOSED ||
          session.conversation.customerId !== session.customerId
        ) {
          throw new DomainError({ code: "NOT_FOUND", message: "AI channel session not found." });
        }
        return {
          actorId: aiServiceActorId,
          actorType: "ai_receptionist",
          channel: actionChannel(session.channel),
          conversationId: session.conversationId,
          modelIdentifier: session.conversation.modelIdentifier,
          organizationId: input.organizationId,
          ...(session.customerId ? { verifiedCustomerId: session.customerId } : {}),
        };
      },
    );
  }

  private async resolveWebsiteSessionRoute(nonce: string) {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_channel_router"');
      return transaction.aIChannelSession.findFirst({
        select: { id: true, organizationId: true },
        where: {
          channel: AICustomerChannel.WEBSITE,
          expiresAt: { gt: new Date() },
          externalKeyHash: digest(nonce),
          status: AIChannelSessionStatus.OPEN,
        },
      });
    });
  }

  private async finishOutbox(transaction: TenantTransaction, outboxEventId: string): Promise<void> {
    await transaction.outboxEvent.update({
      data: { processedAt: new Date(), status: OutboxEventStatus.PROCESSED },
      where: { id: outboxEventId },
    });
  }

  static createSessionNonce(): string {
    return randomBytes(32).toString("hex");
  }
}
