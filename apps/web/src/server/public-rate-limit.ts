import "server-only";

import { createHash } from "node:crypto";

import { parseRedisUrl } from "@jormall/config/environment";
import { DomainError } from "@jormall/domain/errors";
import IORedis from "ioredis";

let redis: IORedis | undefined;
let initialConnection: Promise<IORedis> | undefined;

async function connection(): Promise<IORedis> {
  if (!redis || !initialConnection) {
    const client = new IORedis(parseRedisUrl(process.env.REDIS_URL), {
      connectTimeout: 2_000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    redis = client;
    initialConnection = client
      .connect()
      .then(() => client)
      .catch((error: unknown) => {
        client.disconnect();
        redis = undefined;
        initialConnection = undefined;
        throw error;
      });
  }
  return initialConnection;
}

export function publicClientAddress(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function enforcePublicRateLimit(
  scope: string,
  identity: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const safeIdentity = createHash("sha256").update(identity).digest("hex");
  const bucket = Math.floor(Date.now() / (windowSeconds * 1_000));
  const key = `jormall:public-ai:${scope}:${safeIdentity}:${bucket}`;
  try {
    const client = await connection();
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, windowSeconds + 1);
    if (count > limit) {
      throw new DomainError({ code: "RATE_LIMITED", message: "Public AI rate limit reached." });
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Public AI rate limiting is unavailable.",
    });
  }
}
