import { z } from "zod";

export const aiActionNameSchema = z.enum([
  "get_business_information",
  "list_branches",
  "list_services",
  "list_providers",
  "check_availability",
  "find_customer_safely",
  "create_booking",
  "reschedule_booking",
  "cancel_booking",
  "join_waitlist",
  "check_booking_status",
  "request_human_handoff",
]);

const referenceSchema = z.uuid();
const localeInputSchema = z
  .object({
    locale: z.enum(["en", "ar"]).optional(),
  })
  .strict();
const localDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/);

export const getBusinessInformationInputSchema = localeInputSchema;
export const listBranchesInputSchema = localeInputSchema;
export const listServicesInputSchema = localeInputSchema.extend({
  branchReference: referenceSchema.optional(),
});
export const listProvidersInputSchema = localeInputSchema.extend({
  branchReference: referenceSchema.optional(),
  serviceReference: referenceSchema.optional(),
});
export const checkAvailabilityInputSchema = z
  .object({
    branchReference: referenceSchema,
    endsOn: z.iso.date(),
    providerReference: referenceSchema.optional(),
    serviceReference: referenceSchema,
    startsOn: z.iso.date(),
  })
  .strict();
export const findCustomerSafelyInputSchema = z
  .object({
    displayName: z.string().trim().min(2).max(160).optional(),
    phoneOrEmail: z.string().trim().min(3).max(320),
  })
  .strict();
export const createBookingInputSchema = z
  .object({
    branchReference: referenceSchema,
    customerReference: referenceSchema.optional(),
    providerReference: referenceSchema,
    serviceReference: referenceSchema,
    startsAtLocal: localDateTimeSchema,
  })
  .strict();
export const rescheduleBookingInputSchema = z
  .object({
    bookingReference: referenceSchema,
    expectedVersion: z.number().int().positive(),
    startsAtLocal: localDateTimeSchema,
  })
  .strict();
export const cancelBookingInputSchema = z
  .object({
    bookingReference: referenceSchema,
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(2).max(500),
  })
  .strict();
export const joinWaitlistInputSchema = z
  .object({
    branchReferences: z.array(referenceSchema).min(1).max(10),
    customerReference: referenceSchema.optional(),
    preferredEndDate: z.iso.date(),
    preferredEndMinute: z.number().int().min(1).max(1440),
    preferredStartDate: z.iso.date(),
    preferredStartMinute: z.number().int().min(0).max(1439),
    providerReferences: z.array(referenceSchema).max(20).optional(),
    serviceReference: referenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.preferredEndMinute <= value.preferredStartMinute) {
      context.addIssue({
        code: "custom",
        message: "The preferred end time must be after the preferred start time.",
        path: ["preferredEndMinute"],
      });
    }
  });
export const checkBookingStatusInputSchema = z
  .object({ bookingReference: referenceSchema })
  .strict();
export const requestHumanHandoffInputSchema = z
  .object({
    reasonCode: z.enum([
      "AMBIGUOUS_REQUEST",
      "CUSTOMER_REQUEST",
      "LOW_CONFIDENCE",
      "PROMPT_INJECTION",
      "UNSUPPORTED_REQUEST",
    ]),
    summary: z.string().trim().min(2).max(500).optional(),
  })
  .strict();

export const initialAIActionInputSchemas = {
  cancel_booking: cancelBookingInputSchema,
  check_availability: checkAvailabilityInputSchema,
  check_booking_status: checkBookingStatusInputSchema,
  create_booking: createBookingInputSchema,
  find_customer_safely: findCustomerSafelyInputSchema,
  get_business_information: getBusinessInformationInputSchema,
  join_waitlist: joinWaitlistInputSchema,
  list_branches: listBranchesInputSchema,
  list_providers: listProvidersInputSchema,
  list_services: listServicesInputSchema,
  request_human_handoff: requestHumanHandoffInputSchema,
  reschedule_booking: rescheduleBookingInputSchema,
} as const;

export const actionActorTypeSchema = z.enum([
  "authenticated_user",
  "customer",
  "ai_receptionist",
  "system",
]);

export const actionChannelSchema = z.enum([
  "dashboard",
  "public_booking",
  "website_chat",
  "whatsapp",
  "voice",
  "worker",
  "internal",
  "evaluation",
]);

export const actionGatewayRequestSchema = z
  .object({
    actionName: aiActionNameSchema,
    actor: z
      .object({
        id: z.uuid(),
        type: actionActorTypeSchema,
      })
      .strict(),
    authorization: z
      .object({
        decisionId: z.uuid(),
        requiredPermission: z.string().min(3).max(120),
      })
      .strict(),
    channel: actionChannelSchema,
    confirmation: z
      .object({
        confirmedAt: z.iso.datetime(),
        confirmationId: z.uuid(),
        summaryHash: z.string().min(32).max(128),
      })
      .strict()
      .optional(),
    idempotencyKey: z.string().min(16).max(200),
    occurredAt: z.iso.datetime(),
    payload: z.unknown(),
    requestId: z.uuid(),
    tenant: z
      .object({
        branchId: z.uuid().optional(),
        organizationId: z.uuid(),
      })
      .strict(),
    version: z.literal(1),
  })
  .strict();

export const actionGatewayResponseSchema = z
  .object({
    actionExecutionId: z.uuid(),
    auditEventId: z.uuid(),
    outcome: z.enum(["completed", "rejected", "requires_confirmation"]),
    payload: z.unknown(),
    requestId: z.uuid(),
  })
  .strict();

export type ActionGatewayRequest = z.infer<typeof actionGatewayRequestSchema>;
export type ActionGatewayResponse = z.infer<typeof actionGatewayResponseSchema>;
export type AIActionName = z.infer<typeof aiActionNameSchema>;
