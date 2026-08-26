import { z } from "zod";

export const predictiveQueuePayloadSchema = z
  .object({
    jobId: z.uuid(),
    leaseToken: z.uuid(),
    organizationId: z.uuid(),
    version: z.literal(1),
  })
  .strict();

export type PredictiveQueuePayload = z.infer<typeof predictiveQueuePayloadSchema>;
