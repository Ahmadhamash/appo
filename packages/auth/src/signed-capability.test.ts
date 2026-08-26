import { describe, expect, it } from "vitest";

import { signPublicCapability, verifyPublicCapability } from "./signed-capability";

describe("signed public capabilities", () => {
  it("round trips with the same secret and rejects tampering", () => {
    const secret = "local-test-secret-that-is-more-than-32-characters";
    const token = signPublicCapability({ kind: "fixture", version: 1 }, secret);
    expect(verifyPublicCapability(token, secret)).toEqual({ kind: "fixture", version: 1 });
    expect(verifyPublicCapability(`${token.slice(0, -1)}x`, secret)).toBeNull();
    expect(verifyPublicCapability(token, `${secret}-wrong`)).toBeNull();
  });
});
