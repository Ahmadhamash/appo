import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { aiChannelReplayFixtureSchema } from "./ai-channels";

describe("Phase 5B replay fixtures", () => {
  it.each(["website", "whatsapp", "voice"])("validates the %s replay", (channel) => {
    const url = new URL(`../../../tests/fixtures/ai-channels/${channel}.json`, import.meta.url);
    const parsed = aiChannelReplayFixtureSchema.parse(JSON.parse(readFileSync(url, "utf8")));
    expect(parsed.events.length).toBeGreaterThanOrEqual(5);
  });
});
