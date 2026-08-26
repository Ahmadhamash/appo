import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";

describe("DomainError", () => {
  it("retains a stable machine-readable error code", () => {
    const error = new DomainError({
      code: "TENANT_SCOPE_VIOLATION",
      message: "The requested record is outside the active organization.",
    });

    expect(error.code).toBe("TENANT_SCOPE_VIOLATION");
    expect(error.retryable).toBe(false);
  });
});
