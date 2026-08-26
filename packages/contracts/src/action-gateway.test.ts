import { describe, expect, it } from "vitest";

import { actionGatewayRequestSchema } from "./action-gateway";

const validEnvelope = {
  actionName: "check_availability",
  actor: {
    id: "74ec5453-1cd6-457a-a919-0d69bd84f77f",
    type: "ai_receptionist",
  },
  authorization: {
    decisionId: "2442a779-77ad-45cc-85de-1690e7919474",
    requiredPermission: "appointments.availability.read",
  },
  channel: "voice",
  idempotencyKey: "call-123:tool-call-456",
  occurredAt: "2026-08-23T12:00:00.000Z",
  payload: {
    serviceId: "eb4b3521-3e55-40c7-b047-f2c6b7957974",
  },
  requestId: "b194e252-1f4f-4463-a2c7-a3324b133be7",
  tenant: {
    organizationId: "dd93d72b-f54f-4836-8131-d3c48e9f44b4",
  },
  version: 1,
} as const;

describe("actionGatewayRequestSchema", () => {
  it("accepts a fully scoped action request", () => {
    expect(actionGatewayRequestSchema.safeParse(validEnvelope).success).toBe(true);
  });

  it("rejects an action request without tenant context", () => {
    const unscopedEnvelope = { ...validEnvelope, tenant: undefined };
    expect(actionGatewayRequestSchema.safeParse(unscopedEnvelope).success).toBe(false);
  });
});
