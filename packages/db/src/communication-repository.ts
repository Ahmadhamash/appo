import { createHash, randomUUID } from "node:crypto";

import {
  boundedExponentialBackoff,
  type CommunicationChannelValue,
  type CommunicationTemplateKey,
  type MessageProviderAdapter,
  ProviderAdapterError,
  renderCommunicationTemplate,
} from "@jormall/domain/communications";
import { DomainError } from "@jormall/domain/errors";
import { normalizeJordanianPhone } from "@jormall/domain/jordan-phone";
import type {
  PermissionCode,
  PermissionScope,
  TenantAccessSnapshot,
} from "@jormall/domain/identity";

import {
  CommunicationChannel,
  ConsentStatus,
  DeliveryState,
  InboxEventStatus,
  MessageAttemptStatus,
  MessageDirection,
  MessageStatus,
  OrganizationStatus,
  OutboxEventStatus,
  PlatformRole,
  Prisma,
  ProviderConnectionStatus,
  type PrismaClient,
  type MockProviderBehavior,
  type SupportedLocale,
} from "./generated/prisma/client";
import { runInTenant, type TenantTransaction } from "./tenant-context";

const communicationConsentPurpose = "appointment_messages";
const maximumDeliveryAttempts = 4;
const systemActorId = "00000000-0000-0000-0000-000000000000";

export type OutboundMessageInput = Readonly<{
  appointmentId?: string;
  channel: Extract<CommunicationChannelValue, "SMS" | "WHATSAPP">;
  customerId: string;
  locale: SupportedLocale;
  templateKey: CommunicationTemplateKey;
}>;

export type NormalizedWebhookEvent = Readonly<{
  body?: string | undefined;
  eventId: string;
  from?: string | undefined;
  occurredAt: string;
  providerMessageId?: string | undefined;
  voiceNote?: Readonly<{ mediaReference: string; mockTranscript?: string | undefined }> | undefined;
  type:
    "message.received" | "message.sent" | "message.delivered" | "message.read" | "message.failed";
}>;

type ClaimedOutbox = Readonly<{ id: string; organizationId: string }>;

function requireGrant(access: TenantAccessSnapshot, permission: PermissionCode): PermissionScope {
  const ranks: Readonly<Record<PermissionScope, number>> = {
    ORGANIZATION: 3,
    ASSIGNED_BRANCHES: 2,
    SELF: 1,
  };
  const scope = access.grants
    .filter((grant) => grant.code === permission)
    .toSorted((left, right) => ranks[right.scope] - ranks[left.scope])[0]?.scope;
  if (!scope) {
    throw new DomainError({
      code: "FORBIDDEN",
      message: "The communication permission is missing.",
    });
  }
  return scope;
}

function assertMessageResource(
  access: TenantAccessSnapshot,
  permission: PermissionCode,
  appointment: { branchId: string; providerId: string } | null,
): void {
  const scope = requireGrant(access, permission);
  if (scope === "ORGANIZATION") return;
  if (
    scope === "ASSIGNED_BRANCHES" &&
    appointment &&
    access.assignedBranchIds.includes(appointment.branchId)
  )
    return;
  if (scope === "SELF" && appointment && access.staffProfileId === appointment.providerId) return;
  throw new DomainError({
    code: "FORBIDDEN",
    message: "This communication is outside the granted scope.",
  });
}

async function assertOrganizationActive(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<void> {
  const organization = await transaction.organization.findUnique({
    select: { status: true },
    where: { id: organizationId },
  });
  if (organization?.status === OrganizationStatus.SUSPENDED) {
    throw new DomainError({
      code: "ORGANIZATION_SUSPENDED",
      message: "Organization is suspended.",
    });
  }
  if (organization?.status !== OrganizationStatus.ACTIVE) {
    throw new DomainError({ code: "FORBIDDEN", message: "Organization is not active." });
  }
}

async function audit(
  transaction: TenantTransaction,
  access: TenantAccessSnapshot,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      action,
      actorUserId: access.actorUserId,
      organizationId: access.organizationId,
      supportAccessId: access.supportAccessId ?? null,
      targetId,
      targetType,
    },
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deliveryRank(state: DeliveryState): number {
  return { FAILED: 0, SENT: 1, DELIVERED: 2, READ: 3 }[state];
}

function stateForWebhook(type: NormalizedWebhookEvent["type"]): DeliveryState {
  return {
    "message.delivered": DeliveryState.DELIVERED,
    "message.failed": DeliveryState.FAILED,
    "message.read": DeliveryState.READ,
    "message.received": DeliveryState.DELIVERED,
    "message.sent": DeliveryState.SENT,
  }[type];
}

export class CommunicationRepository {
  constructor(readonly client: PrismaClient) {}

  async createOutboundMessage(access: TenantAccessSnapshot, input: OutboundMessageInput) {
    return runInTenant(this.client, access, async (transaction) => {
      await assertOrganizationActive(transaction, access.organizationId);
      const appointment = input.appointmentId
        ? await transaction.appointment.findFirst({
            include: { service: true },
            where: { id: input.appointmentId, organizationId: access.organizationId },
          })
        : null;
      if (input.appointmentId && (!appointment || appointment.customerId !== input.customerId)) {
        throw new DomainError({
          code: "NOT_FOUND",
          message: "Appointment was not found for this customer.",
        });
      }
      assertMessageResource(access, "messages.send", appointment);
      const [customer, preference, latestConsent, template, connection] = await Promise.all([
        transaction.customer.findFirst({
          include: { contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } },
          where: { id: input.customerId, organizationId: access.organizationId, isArchived: false },
        }),
        transaction.communicationPreference.findUnique({
          where: {
            organizationId_customerId_channel: {
              channel: input.channel as CommunicationChannel,
              customerId: input.customerId,
              organizationId: access.organizationId,
            },
          },
        }),
        transaction.consent.findFirst({
          orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
          where: {
            customerId: input.customerId,
            organizationId: access.organizationId,
            purpose: communicationConsentPurpose,
          },
        }),
        transaction.messageTemplate.findFirst({
          orderBy: { version: "desc" },
          where: {
            channel: input.channel as CommunicationChannel,
            isActive: true,
            key: input.templateKey,
            locale: input.locale,
            organizationId: access.organizationId,
          },
        }),
        transaction.providerConnection.findFirst({
          orderBy: { createdAt: "asc" },
          where: {
            channel: input.channel as CommunicationChannel,
            organizationId: access.organizationId,
            status: ProviderConnectionStatus.ACTIVE,
          },
        }),
      ]);
      if (!customer || !template || !connection) {
        throw new DomainError({
          code: "NOT_FOUND",
          message: "Communication configuration was not found.",
        });
      }
      if (!preference?.isEnabled || latestConsent?.status !== ConsentStatus.GRANTED) {
        throw new DomainError({
          code: "CONSENT_REQUIRED",
          message: "The customer has not enabled this channel with current consent.",
        });
      }
      const contact = customer.contacts.find((item) => item.normalizedPhoneE164);
      if (!contact?.normalizedPhoneE164) {
        throw new DomainError({
          code: "VALIDATION_FAILED",
          message: "A normalized customer phone is required.",
        });
      }
      const startsAt = appointment
        ? appointment.startsAt.toLocaleString(input.locale === "ar" ? "ar-JO" : "en-JO", {
            timeZone: appointment.timezone,
          })
        : "—";
      const body = renderCommunicationTemplate(template.body, {
        customerName: customer.displayName,
        serviceName: appointment
          ? input.locale === "ar"
            ? appointment.service.nameAr
            : appointment.service.nameEn
          : "—",
        startsAt,
      });
      let conversation = await transaction.conversation.findFirst({
        where: {
          appointmentId: input.appointmentId ?? null,
          channel: input.channel as CommunicationChannel,
          customerId: customer.id,
          organizationId: access.organizationId,
          status: "OPEN",
        },
      });
      conversation ??= await transaction.conversation.create({
        data: {
          appointmentId: input.appointmentId ?? null,
          channel: input.channel as CommunicationChannel,
          customerId: customer.id,
          organizationId: access.organizationId,
          subject: input.templateKey,
        },
      });
      const message = await transaction.message.create({
        data: {
          appointmentId: input.appointmentId ?? null,
          body,
          channel: input.channel as CommunicationChannel,
          consentId: latestConsent.id,
          consentPurpose: communicationConsentPurpose,
          conversationId: conversation.id,
          createdByUserId: access.actorUserId,
          customerId: customer.id,
          direction: MessageDirection.OUTBOUND,
          locale: input.locale,
          organizationId: access.organizationId,
          providerConnectionId: connection.id,
          status: MessageStatus.QUEUED,
          templateId: template.id,
        },
      });
      const outbox = await transaction.outboxEvent.create({
        data: {
          aggregateId: message.id,
          aggregateType: "Message",
          aggregateVersion: message.version,
          deduplicationKey: `message:${message.id}:send:v${message.version}`,
          eventType: "MESSAGE_SEND_REQUESTED",
          organizationId: access.organizationId,
          payload: { messageId: message.id },
        },
      });
      await transaction.conversation.update({
        data: { lastMessageAt: message.createdAt, version: { increment: 1 } },
        where: { id: conversation.id },
      });
      await audit(transaction, access, "message.queued", "Message", message.id);
      return { message, outbox };
    });
  }

  async setCommunicationPreference(
    access: TenantAccessSnapshot,
    input: Readonly<{
      channel: Extract<CommunicationChannelValue, "SMS" | "WHATSAPP">;
      customerId: string;
      enabled: boolean;
      reason?: string | undefined;
    }>,
  ) {
    requireGrant(access, "communication_preferences.manage");
    return runInTenant(this.client, access, async (transaction) => {
      await assertOrganizationActive(transaction, access.organizationId);
      const customer = await transaction.customer.findFirst({
        where: { id: input.customerId, organizationId: access.organizationId },
      });
      if (!customer) throw new DomainError({ code: "NOT_FOUND", message: "Customer not found." });
      const preference = await transaction.communicationPreference.upsert({
        create: {
          changedByUserId: access.actorUserId,
          channel: input.channel as CommunicationChannel,
          customerId: customer.id,
          isEnabled: input.enabled,
          organizationId: access.organizationId,
          reason: input.reason ?? null,
        },
        update: {
          changedByUserId: access.actorUserId,
          isEnabled: input.enabled,
          reason: input.reason ?? null,
          version: { increment: 1 },
        },
        where: {
          organizationId_customerId_channel: {
            channel: input.channel as CommunicationChannel,
            customerId: customer.id,
            organizationId: access.organizationId,
          },
        },
      });
      await audit(
        transaction,
        access,
        "communication_preference.changed",
        "CommunicationPreference",
        preference.id,
      );
      return preference;
    });
  }

  async listInbox(access: TenantAccessSnapshot) {
    const scope = requireGrant(access, "messages.read");
    return runInTenant(this.client, access, (transaction) =>
      transaction.conversation.findMany({
        include: {
          customer: true,
          messages: {
            include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        take: 100,
        where: {
          organizationId: access.organizationId,
          ...(scope === "SELF"
            ? { appointment: { providerId: access.staffProfileId ?? systemActorId } }
            : {}),
          ...(scope === "ASSIGNED_BRANCHES"
            ? { appointment: { branchId: { in: [...access.assignedBranchIds] } } }
            : {}),
        },
      }),
    );
  }

  async listCustomerMessages(access: TenantAccessSnapshot, customerId: string) {
    requireGrant(access, "messages.read");
    return runInTenant(this.client, access, async (transaction) => {
      const messages = await transaction.message.findMany({
        include: {
          attempts: { orderBy: { attemptNumber: "asc" } },
          deliveryReceipts: { orderBy: { providerTimestamp: "asc" } },
        },
        orderBy: { createdAt: "desc" },
        where: { customerId, organizationId: access.organizationId },
      });
      for (const message of messages) {
        const appointment = message.appointmentId
          ? await transaction.appointment.findUnique({
              select: { branchId: true, providerId: true },
              where: { id: message.appointmentId },
            })
          : null;
        assertMessageResource(access, "messages.read", appointment);
      }
      return messages;
    });
  }

  async listCustomerPreferences(access: TenantAccessSnapshot, customerId: string) {
    requireGrant(access, "messages.read");
    return runInTenant(this.client, access, (transaction) =>
      transaction.communicationPreference.findMany({
        orderBy: { channel: "asc" },
        where: { customerId, organizationId: access.organizationId },
      }),
    );
  }

  async listAppointmentMessages(access: TenantAccessSnapshot, appointmentId: string) {
    const appointment = await runInTenant(this.client, access, (transaction) =>
      transaction.appointment.findFirst({
        select: { branchId: true, providerId: true },
        where: { id: appointmentId, organizationId: access.organizationId },
      }),
    );
    if (!appointment)
      throw new DomainError({ code: "NOT_FOUND", message: "Appointment not found." });
    assertMessageResource(access, "messages.read", appointment);
    return runInTenant(this.client, access, (transaction) =>
      transaction.message.findMany({
        include: {
          attempts: { orderBy: { attemptNumber: "asc" } },
          deliveryReceipts: { orderBy: { providerTimestamp: "asc" } },
        },
        orderBy: { createdAt: "desc" },
        where: { appointmentId, organizationId: access.organizationId },
      }),
    );
  }

  async listConfiguration(access: TenantAccessSnapshot) {
    requireGrant(access, "messages.read");
    const canReadConnections = access.grants.some(
      (grant) => grant.code === "provider_credentials.manage",
    );
    return runInTenant(this.client, access, async (transaction) => ({
      connections: canReadConnections
        ? await transaction.providerConnection.findMany({
            orderBy: { createdAt: "asc" },
            select: {
              adapterKey: true,
              channel: true,
              id: true,
              mockBehavior: true,
              name: true,
              status: true,
              updatedAt: true,
            },
          })
        : [],
      templates: await transaction.messageTemplate.findMany({
        orderBy: [{ key: "asc" }, { locale: "asc" }, { channel: "asc" }],
        select: {
          body: true,
          channel: true,
          id: true,
          isActive: true,
          key: true,
          locale: true,
          version: true,
        },
      }),
    }));
  }

  async retryMessage(access: TenantAccessSnapshot, messageId: string) {
    requireGrant(access, "messages.retry");
    return runInTenant(this.client, access, async (transaction) => {
      await assertOrganizationActive(transaction, access.organizationId);
      const message = await transaction.message.findFirst({
        include: { appointment: { select: { branchId: true, providerId: true } } },
        where: { id: messageId, organizationId: access.organizationId },
      });
      if (!message) throw new DomainError({ code: "NOT_FOUND", message: "Message not found." });
      assertMessageResource(access, "messages.retry", message.appointment);
      if (message.status !== MessageStatus.FAILED && message.status !== MessageStatus.DEAD_LETTER) {
        throw new DomainError({
          code: "CONFLICT",
          message: "Only failed messages may be retried.",
        });
      }
      const version = message.version + 1;
      await transaction.message.update({
        data: {
          failedAt: null,
          lastErrorCategory: null,
          lastErrorCode: null,
          status: MessageStatus.QUEUED,
          version,
        },
        where: { id: message.id },
      });
      const outbox = await transaction.outboxEvent.create({
        data: {
          aggregateId: message.id,
          aggregateType: "Message",
          aggregateVersion: version,
          deduplicationKey: `message:${message.id}:retry:${randomUUID()}`,
          eventType: "MESSAGE_SEND_REQUESTED",
          organizationId: access.organizationId,
          payload: { messageId: message.id },
        },
      });
      await audit(transaction, access, "message.retry_requested", "Message", message.id);
      return outbox;
    });
  }

  async setMockProviderBehavior(
    access: TenantAccessSnapshot,
    connectionId: string,
    behavior: MockProviderBehavior,
  ) {
    requireGrant(access, "provider_credentials.manage");
    return runInTenant(this.client, access, async (transaction) => {
      await assertOrganizationActive(transaction, access.organizationId);
      const changed = await transaction.providerConnection.updateMany({
        data: { mockBehavior: behavior },
        where: {
          adapterKey: { in: ["MOCK_SMS", "MOCK_WHATSAPP", "MOCK_VOICE"] },
          id: connectionId,
          organizationId: access.organizationId,
        },
      });
      if (changed.count !== 1) {
        throw new DomainError({ code: "NOT_FOUND", message: "Provider connection not found." });
      }
      await audit(
        transaction,
        access,
        "provider_connection.mock_behavior_changed",
        "ProviderConnection",
        connectionId,
      );
    });
  }

  async resolveWebhookConnection(connectionId: string) {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_webhook_router"');
      return transaction.providerConnection.findUnique({
        select: {
          adapterKey: true,
          channel: true,
          id: true,
          organizationId: true,
          status: true,
          webhookSecretReference: true,
        },
        where: { id: connectionId },
      });
    });
  }

  async storeVerifiedWebhook(
    connection: Readonly<{ id: string; organizationId: string }>,
    event: NormalizedWebhookEvent,
    rawBody: string,
  ): Promise<{ duplicate: boolean; inboxEventId?: string }> {
    return runInTenant(
      this.client,
      { actorUserId: systemActorId, organizationId: connection.organizationId },
      async (transaction) => {
        await assertOrganizationActive(transaction, connection.organizationId);
        const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "inbox_events" (
            "organization_id", "provider_connection_id", "provider_event_id", "event_type",
            "payload_digest", "payload", "status", "received_at"
          ) VALUES (
            ${connection.organizationId}::uuid, ${connection.id}::uuid, ${event.eventId}, ${event.type},
            ${digest(rawBody)}, CAST(${JSON.stringify(event)} AS jsonb), 'RECEIVED', CURRENT_TIMESTAMP
          )
          ON CONFLICT ("provider_connection_id", "provider_event_id") DO NOTHING
          RETURNING "id"
        `);
        const row = rows[0];
        if (!row) return { duplicate: true };
        await transaction.outboxEvent.create({
          data: {
            aggregateId: row.id,
            aggregateType: "InboxEvent",
            aggregateVersion: 1,
            deduplicationKey: `inbox:${row.id}:process`,
            eventType: "INBOX_PROCESS_REQUESTED",
            organizationId: connection.organizationId,
            payload: { inboxEventId: row.id },
          },
        });
        return { duplicate: false, inboxEventId: row.id };
      },
    );
  }

  async claimOutboxEvents(workerId: string, limit = 25): Promise<ClaimedOutbox[]> {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_relay"');
      return transaction.$queryRaw<ClaimedOutbox[]>(Prisma.sql`
        WITH candidate AS (
          SELECT "id" FROM "outbox_events"
          WHERE (
            ("status" = 'PENDING' AND "available_at" <= CURRENT_TIMESTAMP)
            OR ("status" = 'CLAIMED' AND "claimed_at" < CURRENT_TIMESTAMP - INTERVAL '2 minutes')
          )
          ORDER BY "created_at"
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE "outbox_events" AS event
        SET "status" = 'CLAIMED', "claimed_at" = CURRENT_TIMESTAMP, "claimed_by" = ${workerId}, "updated_at" = CURRENT_TIMESTAMP
        FROM candidate
        WHERE event."id" = candidate."id"
        RETURNING event."id", event."organization_id" AS "organizationId"
      `);
    });
  }

  async getOutboxWorkState(organizationId: string, outboxEventId: string) {
    return runInTenant(
      this.client,
      { actorUserId: systemActorId, organizationId },
      async (transaction) => {
        const event = await transaction.outboxEvent.findFirst({
          select: { eventType: true, status: true },
          where: { id: outboxEventId, organizationId },
        });
        if (!event) {
          throw new DomainError({ code: "NOT_FOUND", message: "Outbox event not found." });
        }
        return {
          eventType: event.eventType,
          processed: event.status === OutboxEventStatus.PROCESSED,
        };
      },
    );
  }

  async markOutboxEnqueued(outboxEventId: string): Promise<void> {
    await this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_relay"');
      await transaction.outboxEvent.updateMany({
        data: { enqueuedAt: new Date(), status: OutboxEventStatus.ENQUEUED },
        where: { id: outboxEventId, status: OutboxEventStatus.CLAIMED },
      });
    });
  }

  async processOutboxEvent(
    organizationId: string,
    outboxEventId: string,
    adapters: ReadonlyMap<string, MessageProviderAdapter>,
  ): Promise<"processed" | "retry"> {
    const work = await runInTenant(
      this.client,
      { actorUserId: systemActorId, organizationId },
      async (transaction) => {
        await assertOrganizationActive(transaction, organizationId);
        const locked = await transaction.$queryRaw<
          Array<{ eventType: string; status: OutboxEventStatus; aggregateId: string }>
        >(Prisma.sql`
          SELECT "event_type" AS "eventType", "status", "aggregate_id" AS "aggregateId"
          FROM "outbox_events"
          WHERE "id" = ${outboxEventId}::uuid AND "organization_id" = ${organizationId}::uuid
          FOR UPDATE
        `);
        const event = locked[0];
        if (!event)
          throw new DomainError({ code: "NOT_FOUND", message: "Outbox event not found." });
        if (event.status === OutboxEventStatus.PROCESSED) return { kind: "done" as const };
        if (event.eventType === "INBOX_PROCESS_REQUESTED")
          return { aggregateId: event.aggregateId, kind: "inbox" as const };
        if (event.eventType !== "MESSAGE_SEND_REQUESTED")
          throw new DomainError({
            code: "VALIDATION_FAILED",
            message: "Unknown outbox event type.",
          });
        const message = await transaction.message.findFirst({
          include: {
            customer: {
              include: { contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } },
            },
            providerConnection: true,
          },
          where: { id: event.aggregateId, organizationId },
        });
        if (!message?.providerConnection)
          throw new DomainError({ code: "NOT_FOUND", message: "Message provider was not found." });
        const attemptNumber =
          (await transaction.messageAttempt.count({
            where: { messageId: message.id, organizationId },
          })) + 1;
        await transaction.message.update({
          data: { status: MessageStatus.SENDING },
          where: { id: message.id },
        });
        await transaction.outboxEvent.update({
          data: { deliveryAttempts: attemptNumber },
          where: { id: outboxEventId },
        });
        return { attemptNumber, kind: "message" as const, message };
      },
    );
    if (work.kind === "done") return "processed";
    if (work.kind === "inbox") {
      await this.processInboxEvent(organizationId, outboxEventId, work.aggregateId);
      return "processed";
    }
    const providerConnection = work.message.providerConnection;
    if (!providerConnection) {
      throw new DomainError({ code: "NOT_FOUND", message: "Message provider was not found." });
    }
    const adapter = adapters.get(providerConnection.adapterKey);
    const recipient = work.message.customer.contacts.find(
      (item) => item.normalizedPhoneE164,
    )?.normalizedPhoneE164;
    if (!adapter || !recipient) {
      await this.recordDeliveryFailure(
        organizationId,
        outboxEventId,
        work.message.id,
        providerConnection.id,
        work.attemptNumber,
        {
          category: "CONFIGURATION",
          code: "PROVIDER_MISCONFIGURED",
          retryable: false,
          safeMessage: "The provider adapter or recipient is not configured.",
        },
      );
      return "processed";
    }
    const startedAt = new Date();
    try {
      const result = await adapter.send({
        attemptNumber: work.attemptNumber,
        channel: work.message.channel as CommunicationChannelValue,
        idempotencyKey: outboxEventId,
        messageBody: work.message.body,
        mockBehavior: providerConnection.mockBehavior,
        recipient,
      });
      await runInTenant(
        this.client,
        { actorUserId: systemActorId, organizationId },
        async (transaction) => {
          await transaction.messageAttempt.create({
            data: {
              attemptNumber: work.attemptNumber,
              durationMs: Date.now() - startedAt.getTime(),
              finishedAt: new Date(),
              idempotencyKey: outboxEventId,
              messageId: work.message.id,
              organizationId,
              providerConnectionId: providerConnection.id,
              providerMessageId: result.providerMessageId,
              startedAt,
              status: MessageAttemptStatus.SUCCEEDED,
            },
          });
          await transaction.message.update({
            data: {
              providerMessageId: result.providerMessageId,
              sentAt: result.acceptedAt,
              status: MessageStatus.SENT,
            },
            where: { id: work.message.id },
          });
          await transaction.outboxEvent.update({
            data: { processedAt: new Date(), status: OutboxEventStatus.PROCESSED },
            where: { id: outboxEventId },
          });
        },
      );
      return "processed";
    } catch (error) {
      const normalized =
        error instanceof ProviderAdapterError
          ? error.normalized
          : {
              category: "TRANSIENT" as const,
              code: "PROVIDER_ERROR",
              retryable: true,
              safeMessage: "The provider request failed.",
            };
      return this.recordDeliveryFailure(
        organizationId,
        outboxEventId,
        work.message.id,
        providerConnection.id,
        work.attemptNumber,
        normalized,
        startedAt,
      );
    }
  }

  async deadLetterOutbox(
    organizationId: string,
    outboxEventId: string,
    errorCode: string,
  ): Promise<void> {
    await runInTenant(
      this.client,
      { actorUserId: systemActorId, organizationId },
      async (transaction) => {
        const event = await transaction.outboxEvent.findFirst({
          where: { id: outboxEventId, organizationId },
        });
        if (!event || event.status === OutboxEventStatus.PROCESSED) return;
        await transaction.outboxEvent.update({
          data: {
            deadLetterAt: new Date(),
            lastErrorCategory: "WORKER",
            lastErrorCode: errorCode.slice(0, 100),
            status: OutboxEventStatus.DEAD_LETTER,
          },
          where: { id: event.id },
        });
        if (event.aggregateType === "InboxEvent") {
          await transaction.inboxEvent.updateMany({
            data: { errorCode: errorCode.slice(0, 100), status: InboxEventStatus.FAILED },
            where: { id: event.aggregateId, organizationId },
          });
        }
        if (event.aggregateType === "CallEvent") {
          await transaction.callEvent.updateMany({
            data: { errorCode: errorCode.slice(0, 100), status: "FAILED" },
            where: { id: event.aggregateId, organizationId },
          });
        }
      },
    );
  }

  private async recordDeliveryFailure(
    organizationId: string,
    outboxEventId: string,
    messageId: string,
    providerConnectionId: string,
    attemptNumber: number,
    error: Readonly<{ category: string; code: string; retryable: boolean; safeMessage: string }>,
    startedAt = new Date(),
  ): Promise<"processed" | "retry"> {
    const retry = error.retryable && attemptNumber < maximumDeliveryAttempts;
    await runInTenant(
      this.client,
      { actorUserId: systemActorId, organizationId },
      async (transaction) => {
        await transaction.messageAttempt.create({
          data: {
            attemptNumber,
            durationMs: Date.now() - startedAt.getTime(),
            errorCategory: error.category,
            errorCode: error.code,
            finishedAt: new Date(),
            idempotencyKey: `${outboxEventId}:${attemptNumber}`,
            messageId,
            nextRetryAt: retry
              ? new Date(Date.now() + boundedExponentialBackoff(attemptNumber))
              : null,
            organizationId,
            providerConnectionId,
            safeErrorMessage: error.safeMessage,
            startedAt,
            status:
              error.category === "TIMEOUT"
                ? MessageAttemptStatus.TIMEOUT
                : retry
                  ? MessageAttemptStatus.RETRYABLE_FAILURE
                  : MessageAttemptStatus.PERMANENT_FAILURE,
          },
        });
        await transaction.message.update({
          data: {
            failedAt: new Date(),
            lastErrorCategory: error.category,
            lastErrorCode: error.code,
            status: retry ? MessageStatus.FAILED : MessageStatus.DEAD_LETTER,
          },
          where: { id: messageId },
        });
        await transaction.outboxEvent.update({
          data: {
            deadLetterAt: retry ? null : new Date(),
            lastErrorCategory: error.category,
            lastErrorCode: error.code,
            status: retry ? OutboxEventStatus.ENQUEUED : OutboxEventStatus.DEAD_LETTER,
          },
          where: { id: outboxEventId },
        });
      },
    );
    return retry ? "retry" : "processed";
  }

  private async processInboxEvent(
    organizationId: string,
    outboxEventId: string,
    inboxEventId: string,
  ): Promise<void> {
    await runInTenant(
      this.client,
      { actorUserId: systemActorId, organizationId },
      async (transaction) => {
        const inbox = await transaction.inboxEvent.findFirst({
          include: { providerConnection: true },
          where: { id: inboxEventId, organizationId },
        });
        if (!inbox) throw new DomainError({ code: "NOT_FOUND", message: "Inbox event not found." });
        if (inbox.status === InboxEventStatus.PROCESSED) {
          await transaction.outboxEvent.update({
            data: { processedAt: new Date(), status: OutboxEventStatus.PROCESSED },
            where: { id: outboxEventId },
          });
          return;
        }
        const event = inbox.payload as NormalizedWebhookEvent;
        if (event.type === "message.received") {
          const normalized = normalizeJordanianPhone(event.from ?? "");
          if (!normalized || (!event.body && !event.voiceNote))
            throw new DomainError({
              code: "VALIDATION_FAILED",
              message: "Inbound sender is invalid.",
            });
          const contact = await transaction.customerContact.findFirst({
            include: { customer: { select: { preferredLocale: true } } },
            where: { normalizedPhoneE164: normalized, organizationId },
          });
          if (!contact)
            throw new DomainError({
              code: "NOT_FOUND",
              message: "Inbound customer was not matched.",
            });
          let conversation = await transaction.conversation.findFirst({
            where: {
              channel: CommunicationChannel.WHATSAPP,
              customerId: contact.customerId,
              organizationId,
              status: "OPEN",
            },
          });
          conversation ??= await transaction.conversation.create({
            data: {
              channel: CommunicationChannel.WHATSAPP,
              customerId: contact.customerId,
              organizationId,
              subject: "Inbound WhatsApp",
            },
          });
          const message = await transaction.message.create({
            data: {
              body: event.body ?? "[WhatsApp voice note awaiting transcription]",
              channel: CommunicationChannel.WHATSAPP,
              conversationId: conversation.id,
              customerId: contact.customerId,
              direction: MessageDirection.INBOUND,
              locale: contact.customer.preferredLocale,
              organizationId,
              providerConnectionId: inbox.providerConnectionId,
              providerMessageId: event.providerMessageId ?? event.eventId,
              status: MessageStatus.DELIVERED,
            },
          });
          await transaction.conversation.update({
            data: { lastMessageAt: message.createdAt, version: { increment: 1 } },
            where: { id: conversation.id },
          });
          await transaction.outboxEvent.create({
            data: {
              aggregateId: message.id,
              aggregateType: "Message",
              aggregateVersion: message.version,
              deduplicationKey: `message:${message.id}:ai-whatsapp-turn`,
              eventType: "AI_WHATSAPP_TURN_REQUESTED",
              organizationId,
              payload: { inboxEventId: inbox.id, messageId: message.id },
            },
          });
        } else {
          if (!event.providerMessageId)
            throw new DomainError({
              code: "VALIDATION_FAILED",
              message: "Provider message ID is missing.",
            });
          const message = await transaction.message.findFirst({
            where: {
              organizationId,
              providerConnectionId: inbox.providerConnectionId,
              providerMessageId: event.providerMessageId,
            },
          });
          if (!message)
            throw new DomainError({
              code: "NOT_FOUND",
              message: "Delivery message was not found.",
            });
          const state = stateForWebhook(event.type);
          await transaction.deliveryReceipt.create({
            data: {
              inboxEventId: inbox.id,
              messageId: message.id,
              normalizedErrorCode:
                state === DeliveryState.FAILED ? "PROVIDER_DELIVERY_FAILED" : null,
              organizationId,
              providerConnectionId: inbox.providerConnectionId,
              providerMessageId: event.providerMessageId,
              providerTimestamp: new Date(event.occurredAt),
              state,
            },
          });
          const currentState =
            message.status === MessageStatus.DELIVERED
              ? DeliveryState.DELIVERED
              : message.status === MessageStatus.SENT
                ? DeliveryState.SENT
                : DeliveryState.FAILED;
          if (deliveryRank(state) >= deliveryRank(currentState) && state !== DeliveryState.FAILED) {
            await transaction.message.update({
              data: {
                deliveredAt:
                  state === DeliveryState.DELIVERED || state === DeliveryState.READ
                    ? new Date(event.occurredAt)
                    : message.deliveredAt,
                status: state === DeliveryState.SENT ? MessageStatus.SENT : MessageStatus.DELIVERED,
              },
              where: { id: message.id },
            });
          } else if (
            state === DeliveryState.FAILED &&
            deliveryRank(currentState) < deliveryRank(DeliveryState.DELIVERED)
          ) {
            await transaction.message.update({
              data: { failedAt: new Date(event.occurredAt), status: MessageStatus.FAILED },
              where: { id: message.id },
            });
          }
        }
        await transaction.inboxEvent.update({
          data: { processedAt: new Date(), status: InboxEventStatus.PROCESSED },
          where: { id: inbox.id },
        });
        await transaction.outboxEvent.update({
          data: { processedAt: new Date(), status: OutboxEventStatus.PROCESSED },
          where: { id: outboxEventId },
        });
      },
    );
  }

  async heartbeat(
    workerId: string,
    status: string,
    outcome?: "processed" | "failed",
  ): Promise<void> {
    await this.client.workerHeartbeat.upsert({
      create: {
        applicationVersion: "phase4-local",
        lastSeenAt: new Date(),
        queueName: "jormall-communications",
        status,
        workerId,
      },
      update: {
        ...(outcome === "failed" ? { failedCount: { increment: 1 } } : {}),
        ...(outcome ? { lastProcessedAt: new Date() } : {}),
        lastSeenAt: new Date(),
        ...(outcome === "processed" ? { processedCount: { increment: 1 } } : {}),
        status,
      },
      where: { workerId },
    });
  }

  async listWorkerHealth(actorUserId: string) {
    const actor = await this.client.user.findUnique({
      select: { platformRole: true },
      where: { id: actorUserId },
    });
    if (actor?.platformRole !== PlatformRole.JORMALL_SUPER_ADMIN) {
      throw new DomainError({ code: "FORBIDDEN", message: "Super Admin access is required." });
    }
    return this.client.workerHeartbeat.findMany({ orderBy: { lastSeenAt: "desc" }, take: 20 });
  }
}
