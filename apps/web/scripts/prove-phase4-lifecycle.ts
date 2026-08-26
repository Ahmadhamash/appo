import { randomUUID } from "node:crypto";

import { createWebhookSignature } from "@jormall/auth/webhook-signature";
import { prisma } from "@jormall/db/client";
import { CommunicationRepository } from "@jormall/db/communication-repository";
import { IdentityRepository } from "@jormall/db/identity-repository";
import { runInTenant } from "@jormall/db/tenant-context";

if (process.env.NODE_ENV === "production") {
  throw new Error("The mocked lifecycle proof is disabled in production.");
}

const webhookSecret = process.env.MOCK_WHATSAPP_WEBHOOK_SECRET;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
if (!webhookSecret) throw new Error("MOCK_WHATSAPP_WEBHOOK_SECRET is required.");

const identity = new IdentityRepository(prisma);
const communications = new CommunicationRepository(prisma);

async function waitForMessage(
  organizationId: string,
  actorUserId: string,
  messageId: string,
  expectedStatus: "SENT" | "DELIVERED",
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const message = await runInTenant(prisma, { actorUserId, organizationId }, (transaction) =>
      transaction.message.findUnique({ where: { id: messageId } }),
    );
    if (message?.status === expectedStatus) return message;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Message did not reach ${expectedStatus} within 20 seconds.`);
}

async function main(): Promise<void> {
  const owner = await prisma.user.findUnique({ where: { email: "owner@example.invalid" } });
  const organization = await prisma.organization.findUnique({
    where: { slug: "development-clinic-a" },
  });
  if (!owner || !organization) throw new Error("Run the development seed first.");
  const membership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: organization.id, userId: owner.id } },
  });
  if (!membership) throw new Error("Development owner membership is missing.");
  const access = await identity.loadTenantAccess(
    owner.id,
    { activeMembershipId: membership.id, activeOrganizationId: organization.id },
    {},
  );
  const appointment = await runInTenant(prisma, access, (transaction) =>
    transaction.appointment.findFirst({ orderBy: { startsAt: "desc" } }),
  );
  if (!appointment) throw new Error("Development appointment is missing.");
  const queued = await communications.createOutboundMessage(access, {
    appointmentId: appointment.id,
    channel: "WHATSAPP",
    customerId: appointment.customerId,
    locale: "en",
    templateKey: "APPOINTMENT_CONFIRMATION",
  });
  const sent = await waitForMessage(organization.id, owner.id, queued.message.id, "SENT");
  if (!sent.providerConnectionId || !sent.providerMessageId) {
    throw new Error("Mock provider identifiers were not recorded.");
  }
  const event = {
    eventId: `mock-delivery-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    providerMessageId: sent.providerMessageId,
    type: "message.delivered",
  } as const;
  const rawBody = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const response = await fetch(
    `${appUrl}/api/webhooks/whatsapp/${encodeURIComponent(sent.providerConnectionId)}`,
    {
      body: rawBody,
      headers: {
        "content-type": "application/json",
        "x-jormall-signature": createWebhookSignature(webhookSecret, timestamp, rawBody),
        "x-jormall-timestamp": timestamp,
      },
      method: "POST",
    },
  );
  if (response.status !== 202) {
    throw new Error(`Mock webhook returned ${response.status}.`);
  }
  const delivered = await waitForMessage(organization.id, owner.id, queued.message.id, "DELIVERED");
  process.stdout.write(
    `${JSON.stringify({
      lifecycle: ["QUEUED", "SENT", "DELIVERED"],
      messageId: delivered.id,
      outboxEventId: queued.outbox.id,
      providerMessageId: delivered.providerMessageId,
      webhookStatus: response.status,
    })}\n`,
  );
}

await main().finally(() => prisma.$disconnect());
