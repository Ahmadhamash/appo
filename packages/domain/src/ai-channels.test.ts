import { describe, expect, it } from "vitest";

import {
  assertCallStatusTransition,
  classifyExplicitConfirmation,
  isCommunicationOptOut,
  voiceConfirmationIsReliable,
} from "./ai-channels";
import { DomainError } from "./errors";

describe("AI customer-channel safety policies", () => {
  it("accepts only explicit bounded confirmation phrases", () => {
    expect(classifyExplicitConfirmation("I confirm")).toBe("CONFIRM");
    expect(classifyExplicitConfirmation("نعم، أؤكد")).toBe("CONFIRM");
    expect(classifyExplicitConfirmation("sounds good maybe")).toBe("NONE");
    expect(classifyExplicitConfirmation("لا تكمل")).toBe("DECLINE");
  });

  it("requires a final, high-confidence voice confirmation", () => {
    expect(voiceConfirmationIsReliable({ confidence: 0.9, isFinal: true })).toBe(true);
    expect(voiceConfirmationIsReliable({ confidence: 0.84, isFinal: true })).toBe(false);
    expect(voiceConfirmationIsReliable({ confidence: 0.99, isFinal: false })).toBe(false);
  });

  it("detects Arabic and English opt-out commands without fuzzy guessing", () => {
    expect(isCommunicationOptOut("STOP")).toBe(true);
    expect(isCommunicationOptOut("إلغاء الرسائل")).toBe(true);
    expect(isCommunicationOptOut("stop by tomorrow")).toBe(false);
  });

  it("enforces the voice call state machine", () => {
    expect(() => assertCallStatusTransition("RINGING", "ACTIVE")).not.toThrow();
    expect(() => assertCallStatusTransition("ACTIVE", "HUMAN_TRANSFER")).not.toThrow();
    expect(() => assertCallStatusTransition("COMPLETED", "ACTIVE")).toThrowError(DomainError);
  });
});
