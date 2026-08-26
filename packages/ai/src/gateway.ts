import { createHash } from "node:crypto";

import {
  actionGatewayRequestSchema,
  cancelBookingInputSchema,
  checkAvailabilityInputSchema,
  checkBookingStatusInputSchema,
  createBookingInputSchema,
  findCustomerSafelyInputSchema,
  getBusinessInformationInputSchema,
  joinWaitlistInputSchema,
  listBranchesInputSchema,
  listProvidersInputSchema,
  listServicesInputSchema,
  requestHumanHandoffInputSchema,
  rescheduleBookingInputSchema,
  type ActionGatewayResponse,
} from "@jormall/contracts/action-gateway";
import type {
  AIActionCommand,
  AIActionName,
  AIActionRuntimePort,
  AITrustedContext,
} from "@jormall/domain/ai-foundation";
import { redactAISensitiveFields } from "@jormall/domain/ai-safety";

export type ConfirmationPolicy = "none" | "explicit_customer";

export type ActionDefinition = Readonly<{
  confirmationPolicy: ConfirmationPolicy;
  name: AIActionName;
  requiredPermission: string;
}>;

export const initialActionDefinitions: Readonly<Record<AIActionName, ActionDefinition>> = {
  cancel_booking: {
    confirmationPolicy: "explicit_customer",
    name: "cancel_booking",
    requiredPermission: "appointments.cancel",
  },
  check_availability: {
    confirmationPolicy: "none",
    name: "check_availability",
    requiredPermission: "appointments.availability.read",
  },
  check_booking_status: {
    confirmationPolicy: "none",
    name: "check_booking_status",
    requiredPermission: "appointments.read",
  },
  create_booking: {
    confirmationPolicy: "explicit_customer",
    name: "create_booking",
    requiredPermission: "appointments.create",
  },
  find_customer_safely: {
    confirmationPolicy: "none",
    name: "find_customer_safely",
    requiredPermission: "customers.read",
  },
  get_business_information: {
    confirmationPolicy: "none",
    name: "get_business_information",
    requiredPermission: "organization.read",
  },
  join_waitlist: {
    confirmationPolicy: "none",
    name: "join_waitlist",
    requiredPermission: "waitlist.manage",
  },
  list_branches: {
    confirmationPolicy: "none",
    name: "list_branches",
    requiredPermission: "branches.read",
  },
  list_providers: {
    confirmationPolicy: "none",
    name: "list_providers",
    requiredPermission: "staff.read",
  },
  list_services: {
    confirmationPolicy: "none",
    name: "list_services",
    requiredPermission: "services.read",
  },
  request_human_handoff: {
    confirmationPolicy: "none",
    name: "request_human_handoff",
    requiredPermission: "conversations.handoff",
  },
  reschedule_booking: {
    confirmationPolicy: "explicit_customer",
    name: "reschedule_booking",
    requiredPermission: "appointments.reschedule",
  },
};

export const redactSensitiveFields = redactAISensitiveFields;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entryValue]) => [entryKey, canonicalize(entryValue)]),
    );
  }
  return value;
}

export function fingerprintActionInput(actionName: AIActionName, payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ actionName, payload })))
    .digest("hex");
}

function parseCommand(actionName: AIActionName, payload: unknown): AIActionCommand {
  switch (actionName) {
    case "get_business_information":
      return { input: getBusinessInformationInputSchema.parse(payload), name: actionName };
    case "list_branches":
      return { input: listBranchesInputSchema.parse(payload), name: actionName };
    case "list_services":
      return { input: listServicesInputSchema.parse(payload), name: actionName };
    case "list_providers":
      return { input: listProvidersInputSchema.parse(payload), name: actionName };
    case "check_availability":
      return { input: checkAvailabilityInputSchema.parse(payload), name: actionName };
    case "find_customer_safely":
      return { input: findCustomerSafelyInputSchema.parse(payload), name: actionName };
    case "create_booking":
      return { input: createBookingInputSchema.parse(payload), name: actionName };
    case "reschedule_booking":
      return { input: rescheduleBookingInputSchema.parse(payload), name: actionName };
    case "cancel_booking":
      return { input: cancelBookingInputSchema.parse(payload), name: actionName };
    case "join_waitlist":
      return { input: joinWaitlistInputSchema.parse(payload), name: actionName };
    case "check_booking_status":
      return { input: checkBookingStatusInputSchema.parse(payload), name: actionName };
    case "request_human_handoff":
      return { input: requestHumanHandoffInputSchema.parse(payload), name: actionName };
  }
}

export interface ActionGateway {
  execute(trustedContext: AITrustedContext, input: unknown): Promise<ActionGatewayResponse>;
}

export class SafeActionGateway implements ActionGateway {
  constructor(private readonly runtime: AIActionRuntimePort) {}

  async execute(trustedContext: AITrustedContext, input: unknown): Promise<ActionGatewayResponse> {
    const request = actionGatewayRequestSchema.parse(input);
    const definition = initialActionDefinitions[request.actionName];
    const fingerprint = fingerprintActionInput(request.actionName, request.payload);
    const reject = async (errorCode: string): Promise<ActionGatewayResponse> => {
      const result = await this.runtime.rejectAction({
        actionName: request.actionName,
        errorCode,
        idempotencyKey: request.idempotencyKey,
        inputFingerprint: fingerprint,
        occurredAt: request.occurredAt,
        rawInputRedacted: redactSensitiveFields(request.payload),
        requestId: request.requestId,
        requiredPermission: definition.requiredPermission,
        trustedContext,
      });
      return {
        actionExecutionId: result.actionId,
        auditEventId: result.auditEventId,
        outcome: result.outcome,
        payload: result.payload,
        requestId: request.requestId,
      };
    };
    if (
      request.tenant.organizationId !== trustedContext.organizationId ||
      request.actor.id !== trustedContext.actorId ||
      request.actor.type !== trustedContext.actorType
    ) {
      return reject("UNTRUSTED_CONTEXT");
    }
    if (request.authorization.requiredPermission !== definition.requiredPermission) {
      return reject("AUTHORIZATION_CLAIM_MISMATCH");
    }
    let command: AIActionCommand;
    try {
      command = parseCommand(request.actionName, request.payload);
    } catch {
      return reject("INVALID_TOOL_INPUT");
    }
    const result = await this.runtime.executeAction({
      command,
      ...(request.confirmation ? { confirmation: request.confirmation } : {}),
      idempotencyKey: request.idempotencyKey,
      inputFingerprint: fingerprint,
      occurredAt: request.occurredAt,
      rawInputRedacted: redactSensitiveFields(request.payload),
      requestId: request.requestId,
      requiredPermission: definition.requiredPermission,
      trustedContext,
      validatedInputRedacted: redactSensitiveFields(command.input),
    });
    return {
      actionExecutionId: result.actionId,
      auditEventId: result.auditEventId,
      outcome: result.outcome,
      payload: result.payload,
      requestId: request.requestId,
    };
  }
}
