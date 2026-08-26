import { z } from "zod";

const secretSchema = z
  .string()
  .min(32)
  .refine((value) => !value.toLowerCase().includes("replace"), "Placeholder secrets are forbidden");

export const serverEnvironmentSchema = z
  .object({
    AUTH_SECRET: secretSchema,
    CREDENTIAL_ENCRYPTION_KEY: secretSchema,
    DATABASE_URL: z.string().startsWith("postgresql://"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    OTEL_SERVICE_NAME: z.string().min(1).default("jormall-platform"),
    REDIS_URL: z.string().startsWith("redis://"),
  })
  .strict();

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export const workerEnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().startsWith("postgresql://"),
    REDIS_URL: z.string().startsWith("redis://"),
  })
  .strict();

export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

export function parseServerEnvironment(environment: unknown): ServerEnvironment {
  return serverEnvironmentSchema.parse(environment);
}

export function parseWorkerEnvironment(environment: unknown): WorkerEnvironment {
  return workerEnvironmentSchema.parse(environment);
}

export function parseMockWebhookSecret(value: unknown): string {
  return secretSchema.parse(value);
}

export function parseWidgetSigningSecret(value: unknown): string {
  return secretSchema.parse(value);
}

export function parsePublicApplicationUrl(value: unknown): string {
  return z.url().parse(value);
}

export function parseRedisUrl(value: unknown): string {
  return z.string().startsWith("redis://").parse(value);
}
