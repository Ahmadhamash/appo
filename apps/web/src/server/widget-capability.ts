import "server-only";

import { signPublicCapability, verifyPublicCapability } from "@jormall/auth/signed-capability";
import {
  widgetConfigurationTokenPayloadSchema,
  widgetSessionTokenPayloadSchema,
  type WidgetConfigurationTokenPayload,
  type WidgetSessionTokenPayload,
} from "@jormall/contracts/ai-channels";
import { parseWidgetSigningSecret } from "@jormall/config/environment";

function secret(): string {
  return parseWidgetSigningSecret(process.env.WIDGET_SIGNING_SECRET);
}

function isCurrent(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() > Date.now();
}

export function issueWidgetConfigurationToken(
  input: Readonly<{
    publicKey: string;
    version: number;
  }>,
): string {
  const issuedAt = new Date();
  return signPublicCapability(
    {
      expiresAt: new Date(issuedAt.getTime() + 180 * 24 * 60 * 60 * 1_000).toISOString(),
      issuedAt: issuedAt.toISOString(),
      kind: "widget_configuration",
      publicKey: input.publicKey,
      version: input.version,
    } satisfies WidgetConfigurationTokenPayload,
    secret(),
  );
}

export function verifyWidgetConfigurationToken(
  token: string,
): WidgetConfigurationTokenPayload | null {
  const parsed = widgetConfigurationTokenPayloadSchema.safeParse(
    verifyPublicCapability(token, secret()),
  );
  return parsed.success && isCurrent(parsed.data.expiresAt) ? parsed.data : null;
}

export function issueWidgetSessionToken(
  input: Omit<WidgetSessionTokenPayload, "expiresAt" | "issuedAt" | "kind">,
): string {
  const issuedAt = new Date();
  return signPublicCapability(
    {
      ...input,
      expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      issuedAt: issuedAt.toISOString(),
      kind: "widget_session",
    } satisfies WidgetSessionTokenPayload,
    secret(),
  );
}

export function verifyWidgetSessionToken(token: string): WidgetSessionTokenPayload | null {
  const parsed = widgetSessionTokenPayloadSchema.safeParse(verifyPublicCapability(token, secret()));
  return parsed.success && isCurrent(parsed.data.expiresAt) ? parsed.data : null;
}
