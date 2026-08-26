import type { Prisma, PrismaClient } from "./generated/prisma/client";

export type TenantTransaction = Prisma.TransactionClient;

export type TenantDatabaseContext = Readonly<{
  actorUserId: string;
  organizationId: string;
  supportAccessId?: string;
}>;

export async function runInTenant<T>(
  client: PrismaClient,
  context: TenantDatabaseContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('SET LOCAL ROLE "jormall_app"');
    await transaction.$executeRaw`SELECT set_config('app.organization_id', ${context.organizationId}, true)`;
    await transaction.$executeRaw`SELECT set_config('app.actor_user_id', ${context.actorUserId}, true)`;
    await transaction.$executeRaw`SELECT set_config('app.support_access_id', ${context.supportAccessId ?? ""}, true)`;
    return operation(transaction);
  });
}
