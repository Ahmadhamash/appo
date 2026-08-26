import { randomUUID } from "node:crypto";

import { AIChannelRepository } from "@jormall/db/ai-channel-repository";
import { createPrismaClient } from "@jormall/db/client";
import { CommunicationRepository } from "@jormall/db/communication-repository";
import { CrmAppointmentRepository } from "@jormall/db/crm-appointment-repository";
import { OrganizationStatus, PlatformRole } from "@jormall/db/generated/enums";
import { IdentityRepository } from "@jormall/db/identity-repository";
import { runInTenant } from "@jormall/db/tenant-context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  processCommunicationJob,
  startCommunicationsWorker,
} from "../../apps/worker/src/communications-worker";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  throw new Error("PostgreSQL and Redis URLs are required for worker integration tests.");
}

const client = createPrismaClient(databaseUrl);
const identity = new IdentityRepository(client);
const crm = new CrmAppointmentRepository(client);
const communications = new CommunicationRepository(client);
const aiChannels = new AIChannelRepository(client);
const suffix = randomUUID().slice(0, 8);
let fixture: Awaited<ReturnType<typeof createFixture>>;
let runtime: Awaited<ReturnType<typeof startCommunicationsWorker>>;

async function createFixture() {
  const [superAdmin, owner] = await Promise.all([
    client.user.create({
      data: {
        email: `worker-super-${suffix}@example.invalid`,
        name: "Worker Super Admin",
        platformRole: PlatformRole.JORMALL_SUPER_ADMIN,
      },
    }),
    client.user.create({
      data: { email: `worker-owner-${suffix}@example.invalid`, name: "Worker Owner" },
    }),
  ]);
  const created = await identity.createOrganization(superAdmin.id, {
    businessSector: "CLINIC",
    nameAr: `عامل ${suffix}`,
    nameEn: `Worker ${suffix}`,
    ownerEmail: owner.email,
    slug: `worker-${suffix}`,
  });
  const accepted = await identity.acceptInvitation(owner.id, owner.email, created.invitationToken);
  await identity.setOrganizationStatus(
    superAdmin.id,
    accepted.organizationId,
    OrganizationStatus.ACTIVE,
  );
  const access = await identity.loadTenantAccess(
    owner.id,
    { activeMembershipId: accepted.membershipId, activeOrganizationId: accepted.organizationId },
    {},
  );
  await identity.createService(access, {
    currency: "JOD",
    defaultDurationMins: 30,
    defaultPriceMinor: 2500,
    nameAr: "استشارة",
    nameEn: "Consultation",
  });
  const customer = await crm.createCustomer(access, {
    displayName: `Worker customer ${suffix}`,
    phoneOriginal: "+962799998888",
    preferredLocale: "en",
  });
  await crm.recordConsent(access, {
    channel: "STAFF",
    customerId: customer.customer.id,
    purpose: "appointment_messages",
    source: "STAFF",
    status: "GRANTED",
    textVersion: "worker-test-v1",
  });
  await communications.setCommunicationPreference(access, {
    channel: "SMS",
    customerId: customer.customer.id,
    enabled: true,
  });
  await communications.setCommunicationPreference(access, {
    channel: "WHATSAPP",
    customerId: customer.customer.id,
    enabled: true,
  });
  await runInTenant(client, access, (transaction) =>
    transaction.providerConnection.updateMany({
      data: { mockBehavior: "TRANSIENT_ONCE" },
      where: { adapterKey: "MOCK_SMS" },
    }),
  );
  const connections = await runInTenant(client, access, (transaction) =>
    transaction.providerConnection.findMany(),
  );
  const whatsAppConnection = connections.find(({ channel }) => channel === "WHATSAPP");
  const voiceConnection = connections.find(({ channel }) => channel === "VOICE");
  if (!whatsAppConnection || !voiceConnection?.providerAccountId) {
    throw new Error("Mock AI provider connections are missing.");
  }
  return { access, customer: customer.customer, owner, voiceConnection, whatsAppConnection };
}

async function waitForSent(messageId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const message = await runInTenant(client, fixture.access, (transaction) =>
      transaction.message.findUnique({
        include: { attempts: { orderBy: { attemptNumber: "asc" } } },
        where: { id: messageId },
      }),
    );
    if (message?.status === "SENT") return message;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("BullMQ message did not reach SENT within 15 seconds.");
}

async function waitForWhatsAppAssistant() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const message = await runInTenant(client, fixture.access, (transaction) =>
      transaction.message.findFirst({
        orderBy: { createdAt: "desc" },
        where: {
          body: { contains: "Consultation" },
          channel: "WHATSAPP",
          customerId: fixture.customer.id,
          direction: "OUTBOUND",
          status: "SENT",
        },
      }),
    );
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("WhatsApp AI response did not reach SENT within 15 seconds.");
}

async function waitForCallEvent(providerEventId: string, status: "FAILED" | "PROCESSED") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const event = await runInTenant(client, fixture.access, (transaction) =>
      transaction.callEvent.findFirst({ where: { providerEventId } }),
    );
    if (event?.status === status) return event;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Voice event did not reach ${status} within 15 seconds.`);
}

beforeAll(async () => {
  fixture = await createFixture();
  runtime = await startCommunicationsWorker(redisUrl);
});

afterAll(async () => {
  await runtime.close();
  await client.$disconnect();
});

describe("Redis/BullMQ communications worker", () => {
  it("relays a stable outbox job and retries a transient provider failure", async () => {
    const queued = await communications.createOutboundMessage(fixture.access, {
      channel: "SMS",
      customerId: fixture.customer.id,
      locale: "en",
      templateKey: "APPOINTMENT_REMINDER",
    });
    const sent = await waitForSent(queued.message.id);
    expect(sent.providerMessageId).toContain(queued.outbox.id);
    expect(sent.attempts.map(({ status }) => status)).toEqual(["RETRYABLE_FAILURE", "SUCCEEDED"]);
    const job = await runtime.queue.getJob(queued.outbox.id);
    expect(job?.id).toBe(queued.outbox.id);
    expect(await job?.getState()).toBe("completed");
  });

  it("processes one idempotent WhatsApp voice-note lifecycle through the shared AI worker", async () => {
    const event = {
      eventId: `wa-${randomUUID()}`,
      from: "+962799998888",
      occurredAt: new Date().toISOString(),
      type: "message.received" as const,
      voiceNote: {
        mediaReference: `fixture://${suffix}/services`,
        mockTranscript: "Which services do you offer?",
      },
    };
    const rawBody = JSON.stringify(event);
    const route = {
      id: fixture.whatsAppConnection.id,
      organizationId: fixture.access.organizationId,
    };
    const stored = await communications.storeVerifiedWebhook(route, event, rawBody);
    const duplicate = await communications.storeVerifiedWebhook(route, event, rawBody);
    expect(stored.duplicate).toBe(false);
    expect(duplicate).toEqual({ duplicate: true });
    const response = await waitForWhatsAppAssistant();
    expect(response.body).toContain("Consultation");
    const inboundCount = await runInTenant(client, fixture.access, (transaction) =>
      transaction.inboxEvent.count({ where: { providerEventId: event.eventId } }),
    );
    expect(inboundCount).toBe(1);
    const aiOutbox = await runInTenant(client, fixture.access, (transaction) =>
      transaction.outboxEvent.findFirst({
        where: { eventType: "AI_WHATSAPP_TURN_REQUESTED", status: "PROCESSED" },
      }),
    );
    if (!aiOutbox) throw new Error("Processed WhatsApp AI outbox evidence is missing.");
    const job = await runtime.queue.getJob(aiOutbox.id);
    if (!job) throw new Error("Completed WhatsApp AI job is missing.");
    const beforeRedelivery = await runInTenant(client, fixture.access, (transaction) =>
      transaction.message.count({ where: { channel: "WHATSAPP", direction: "OUTBOUND" } }),
    );
    await processCommunicationJob(job);
    const afterRedelivery = await runInTenant(client, fixture.access, (transaction) =>
      transaction.message.count({ where: { channel: "WHATSAPP", direction: "OUTBOUND" } }),
    );
    expect(afterRedelivery).toBe(beforeRedelivery);
  });

  it("persists partial voice transcripts once and recovers a completed call summary", async () => {
    const providerCallId = `voice-${randomUUID()}`;
    const route = {
      id: fixture.voiceConnection.id,
      organizationId: fixture.access.organizationId,
      providerAccountId: fixture.voiceConnection.providerAccountId,
    };
    const store = async (event: Parameters<typeof aiChannels.storeVerifiedVoiceEvent>[1]) =>
      aiChannels.storeVerifiedVoiceEvent(route, event, JSON.stringify(event));
    const started = {
      eventId: `start-${randomUUID()}`,
      from: "+962799998888",
      locale: "en" as const,
      occurredAt: new Date().toISOString(),
      providerCallId,
      to: fixture.voiceConnection.providerAccountId,
      type: "call.started",
    };
    await store(started);
    await waitForCallEvent(started.eventId, "PROCESSED");
    const answered = {
      eventId: `answer-${randomUUID()}`,
      locale: "en" as const,
      occurredAt: new Date().toISOString(),
      providerCallId,
      to: fixture.voiceConnection.providerAccountId,
      type: "call.answered",
    };
    await store(answered);
    await waitForCallEvent(answered.eventId, "PROCESSED");
    const partial = {
      confidence: 0.65,
      eventId: `partial-${randomUUID()}`,
      isFinal: false,
      locale: "en" as const,
      occurredAt: new Date().toISOString(),
      providerCallId,
      sequence: 1,
      text: "Which servi",
      to: fixture.voiceConnection.providerAccountId,
      type: "transcript.partial",
    };
    const firstPartial = await store(partial);
    const duplicatePartial = await store(partial);
    expect(firstPartial.duplicate).toBe(false);
    expect(duplicatePartial).toEqual({ duplicate: true });
    await waitForCallEvent(partial.eventId, "PROCESSED");
    const beforeFinal = await runInTenant(client, fixture.access, (transaction) =>
      transaction.aIAction.count({ where: { channel: "voice" } }),
    );
    const final = {
      confidence: 0.99,
      eventId: `final-${randomUUID()}`,
      isFinal: true,
      locale: "en" as const,
      occurredAt: new Date().toISOString(),
      providerCallId,
      sequence: 2,
      text: "Which services do you offer?",
      to: fixture.voiceConnection.providerAccountId,
      type: "transcript.final",
    };
    await store(final);
    await waitForCallEvent(final.eventId, "PROCESSED");
    const voiceEvidence = await runInTenant(client, fixture.access, (transaction) =>
      transaction.call.findFirst({
        include: {
          events: true,
          summary: true,
          transcripts: { orderBy: { createdAt: "asc" } },
        },
        where: { providerCallId },
      }),
    );
    expect(voiceEvidence?.transcripts.filter(({ speaker }) => speaker === "CUSTOMER")).toHaveLength(
      2,
    );
    expect(voiceEvidence?.transcripts.some(({ speaker }) => speaker === "ASSISTANT")).toBe(true);
    const afterFinal = await runInTenant(client, fixture.access, (transaction) =>
      transaction.aIAction.count({ where: { channel: "voice" } }),
    );
    expect(afterFinal).toBe(beforeFinal + 1);

    const disconnected = {
      eventId: `disconnect-${randomUUID()}`,
      locale: "en" as const,
      occurredAt: new Date().toISOString(),
      providerCallId,
      to: fixture.voiceConnection.providerAccountId,
      type: "call.disconnected",
    };
    await store(disconnected);
    await waitForCallEvent(disconnected.eventId, "PROCESSED");
    const completed = await runInTenant(client, fixture.access, (transaction) =>
      transaction.call.findFirst({ include: { summary: true }, where: { providerCallId } }),
    );
    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.summary?.outcome).toBe("Call ended");
  });

  it("dead-letters a permanent voice provider failure without retrying it", async () => {
    await communications.setMockProviderBehavior(
      fixture.access,
      fixture.voiceConnection.id,
      "PERMANENT_FAILURE",
    );
    const providerCallId = `failure-${randomUUID()}`;
    const route = {
      id: fixture.voiceConnection.id,
      organizationId: fixture.access.organizationId,
      providerAccountId: fixture.voiceConnection.providerAccountId,
    };
    const start = {
      eventId: `start-${randomUUID()}`,
      from: "+962799998888",
      locale: "en" as const,
      occurredAt: new Date().toISOString(),
      providerCallId,
      to: fixture.voiceConnection.providerAccountId,
      type: "call.started",
    };
    await aiChannels.storeVerifiedVoiceEvent(route, start, JSON.stringify(start));
    await waitForCallEvent(start.eventId, "PROCESSED");
    const final = {
      confidence: 0.99,
      eventId: `failure-final-${randomUUID()}`,
      isFinal: true,
      locale: "en" as const,
      occurredAt: new Date().toISOString(),
      providerCallId,
      text: "Which services do you offer?",
      to: fixture.voiceConnection.providerAccountId,
      type: "transcript.final",
    };
    const stored = await aiChannels.storeVerifiedVoiceEvent(route, final, JSON.stringify(final));
    const failed = await waitForCallEvent(final.eventId, "FAILED");
    expect(failed.errorCode).toBe("PROVIDER_FAILURE");
    if (!stored.callEventId) throw new Error("Voice failure event was not stored.");
    const outbox = await runInTenant(client, fixture.access, (transaction) =>
      transaction.outboxEvent.findFirst({
        where: { aggregateId: stored.callEventId, aggregateType: "CallEvent" },
      }),
    );
    expect(outbox?.status).toBe("DEAD_LETTER");
    const job = outbox ? await runtime.queue.getJob(outbox.id) : null;
    expect(job?.attemptsMade).toBe(1);
    await communications.setMockProviderBehavior(
      fixture.access,
      fixture.voiceConnection.id,
      "SUCCESS",
    );
  });

  it("bounds voice timeout retries and reuses one Action Gateway idempotency key", async () => {
    await communications.setMockProviderBehavior(
      fixture.access,
      fixture.voiceConnection.id,
      "TIMEOUT",
    );
    const providerCallId = `timeout-${randomUUID()}`;
    const route = {
      id: fixture.voiceConnection.id,
      organizationId: fixture.access.organizationId,
      providerAccountId: fixture.voiceConnection.providerAccountId,
    };
    const start = {
      eventId: `timeout-start-${randomUUID()}`,
      from: "+962799998888",
      locale: "en" as const,
      occurredAt: new Date().toISOString(),
      providerCallId,
      to: fixture.voiceConnection.providerAccountId,
      type: "call.started",
    };
    await aiChannels.storeVerifiedVoiceEvent(route, start, JSON.stringify(start));
    await waitForCallEvent(start.eventId, "PROCESSED");
    const actionCountBefore = await runInTenant(client, fixture.access, (transaction) =>
      transaction.aIAction.count({ where: { channel: "voice" } }),
    );
    const final = {
      confidence: 0.99,
      eventId: `timeout-final-${randomUUID()}`,
      isFinal: true,
      locale: "en" as const,
      occurredAt: new Date().toISOString(),
      providerCallId,
      text: "Which services do you offer?",
      to: fixture.voiceConnection.providerAccountId,
      type: "transcript.final",
    };
    const stored = await aiChannels.storeVerifiedVoiceEvent(route, final, JSON.stringify(final));
    const failed = await waitForCallEvent(final.eventId, "FAILED");
    expect(failed.errorCode).toBe("PROVIDER_TIMEOUT");
    if (!stored.callEventId) throw new Error("Voice timeout event was not stored.");
    const outbox = await runInTenant(client, fixture.access, (transaction) =>
      transaction.outboxEvent.findFirst({
        where: { aggregateId: stored.callEventId, aggregateType: "CallEvent" },
      }),
    );
    if (!outbox) throw new Error("Voice timeout outbox evidence is missing.");
    expect(outbox.status).toBe("DEAD_LETTER");
    const job = await runtime.queue.getJob(outbox.id);
    expect(job?.attemptsMade).toBe(4);
    const actionCountAfter = await runInTenant(client, fixture.access, (transaction) =>
      transaction.aIAction.count({ where: { channel: "voice" } }),
    );
    expect(actionCountAfter).toBe(actionCountBefore + 1);
    await communications.setMockProviderBehavior(
      fixture.access,
      fixture.voiceConnection.id,
      "SUCCESS",
    );
  });
});
