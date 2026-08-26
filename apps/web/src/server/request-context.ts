import "server-only";

import type { RequestAuditDetails } from "@jormall/db/identity-repository";
import { headers } from "next/headers";

export async function requestAuditDetails(): Promise<RequestAuditDetails> {
  const requestHeaders = await headers();
  const forwardedFor = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  const userAgent = requestHeaders.get("user-agent") ?? undefined;
  return {
    ...(forwardedFor ? { ipAddress: forwardedFor } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}
