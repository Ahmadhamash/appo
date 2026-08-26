import { describe, expect, it } from "vitest";

import { parseServerEnvironment, serverEnvironmentSchema } from "./environment";

describe("serverEnvironmentSchema", () => {
  it("accepts explicit non-placeholder local configuration", () => {
    const result = parseServerEnvironment({
      AUTH_SECRET: "local-auth-secret-with-at-least-32-characters",
      CREDENTIAL_ENCRYPTION_KEY: "local-encryption-key-with-at-least-32-characters",
      DATABASE_URL: "postgresql://jormall:secret@localhost:5432/jormall",
      NODE_ENV: "test",
      OTEL_SERVICE_NAME: "jormall-test",
      REDIS_URL: "redis://:secret@localhost:6379/0",
    });

    expect(result.NODE_ENV).toBe("test");
  });

  it("rejects example placeholder secrets", () => {
    const result = serverEnvironmentSchema.safeParse({
      AUTH_SECRET: "replace-with-a-long-random-auth-secret",
      CREDENTIAL_ENCRYPTION_KEY: "replace-with-a-long-random-encryption-key",
      DATABASE_URL: "postgresql://jormall:secret@localhost:5432/jormall",
      REDIS_URL: "redis://:secret@localhost:6379/0",
    });

    expect(result.success).toBe(false);
  });
});
