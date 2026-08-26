import { describe, expect, it } from "vitest";

import { findAvailableSlots, intervalsOverlap, type AvailabilitySnapshot } from "./availability";

function snapshot(timezone: string): AvailabilitySnapshot {
  return {
    branchHours: [
      { endMinuteLocal: 1440, startMinuteLocal: 0, weekday: "SUNDAY" },
      { endMinuteLocal: 1440, startMinuteLocal: 0, weekday: "MONDAY" },
    ],
    bufferAfterMins: 0,
    bufferBeforeMins: 0,
    durationMins: 30,
    providers: [
      {
        id: "provider-1",
        reservations: [],
        rules: [
          { endMinuteLocal: 1440, startMinuteLocal: 0, weekday: "SUNDAY" },
          { endMinuteLocal: 1440, startMinuteLocal: 0, weekday: "MONDAY" },
        ],
        timeOff: [],
      },
    ],
    requirements: [],
    timezone,
  };
}

describe("availability engine", () => {
  it("skips nonexistent and ambiguous local times at daylight-saving boundaries", () => {
    const spring = findAvailableSlots(
      {
        branchId: "branch",
        endsOn: "2026-03-08",
        intervalMins: 30,
        localEndMinute: 240,
        localStartMinute: 60,
        serviceId: "service",
        startsOn: "2026-03-08",
      },
      snapshot("America/New_York"),
    );
    expect(spring.map(({ startsAtLocal }) => startsAtLocal)).not.toContain("2026-03-08T02:00");
    expect(spring.map(({ startsAtLocal }) => startsAtLocal)).toContain("2026-03-08T03:00");

    const autumn = findAvailableSlots(
      {
        branchId: "branch",
        endsOn: "2026-11-01",
        intervalMins: 30,
        localEndMinute: 180,
        localStartMinute: 60,
        serviceId: "service",
        startsOn: "2026-11-01",
      },
      snapshot("America/New_York"),
    );
    expect(autumn.map(({ startsAtLocal }) => startsAtLocal)).not.toContain("2026-11-01T01:00");
  });

  it("stores Amman slot instants in UTC while retaining the branch timezone", () => {
    const slots = findAvailableSlots(
      {
        branchId: "branch",
        endsOn: "2026-08-24",
        intervalMins: 30,
        limit: 1,
        localEndMinute: 600,
        localStartMinute: 540,
        serviceId: "service",
        startsOn: "2026-08-24",
      },
      snapshot("Asia/Amman"),
    );
    expect(slots[0]).toMatchObject({
      startsAtLocal: "2026-08-24T09:00",
      timezone: "Asia/Amman",
    });
    expect(slots[0]?.startsAt.toISOString()).toBe("2026-08-24T06:00:00.000Z");
  });

  it("honors resource capacity and half-open buffer intervals", () => {
    const occupied = {
      endsAt: new Date("2026-08-24T07:00:00.000Z"),
      startsAt: new Date("2026-08-24T06:00:00.000Z"),
    };
    const withResource: AvailabilitySnapshot = {
      ...snapshot("Asia/Amman"),
      requirements: [
        {
          groupId: "rooms",
          quantity: 1,
          resources: [{ id: "room-1", reservations: [occupied], rules: [] }],
        },
      ],
    };
    const slots = findAvailableSlots(
      {
        branchId: "branch",
        endsOn: "2026-08-24",
        intervalMins: 30,
        localEndMinute: 660,
        localStartMinute: 540,
        serviceId: "service",
        startsOn: "2026-08-24",
      },
      withResource,
    );
    expect(slots.map(({ startsAtLocal }) => startsAtLocal)).not.toContain("2026-08-24T09:00");
    expect(slots.map(({ startsAtLocal }) => startsAtLocal)).toContain("2026-08-24T10:00");
    expect(
      intervalsOverlap(occupied, {
        endsAt: new Date("2026-08-24T07:30:00.000Z"),
        startsAt: occupied.endsAt,
      }),
    ).toBe(false);
  });
});
