import { predictiveCapabilities } from "@jormall/domain/predictive";

import type { TenantTransaction } from "./tenant-context";

export async function createPredictiveDefaults(
  transaction: TenantTransaction,
  organizationId: string,
  actorUserId: string,
): Promise<void> {
  await transaction.predictiveCapabilitySetting.createMany({
    data: predictiveCapabilities.map((capability) => ({
      capability,
      enabled: false,
      organizationId,
      updatedByUserId: actorUserId,
    })),
    skipDuplicates: true,
  });
}
