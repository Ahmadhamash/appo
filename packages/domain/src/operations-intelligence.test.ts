import { describe, expect, it } from "vitest";

import {
  assertCsvHeaders,
  csvCell,
  parseCsvChunks,
  ratio,
  reliableRevenueMinor,
} from "./operations-intelligence";

describe("Phase 7 operations intelligence", () => {
  it("parses quoted CSV incrementally across chunks", async () => {
    const records = [];
    async function* chunks() {
      yield 'name,note\r\n"Ah';
      yield 'mad","line 1\nline 2"\r\n';
    }
    for await (const record of parseCsvChunks(chunks(), {
      maxColumns: 8,
      maxRows: 10,
      maxValueLength: 100,
    })) {
      records.push(record);
    }
    expect(records).toEqual([
      { rowNumber: 1, values: ["name", "note"] },
      { rowNumber: 2, values: ["Ahmad", "line 1\nline 2"] },
    ]);
  });

  it("neutralizes spreadsheet formulas and defines zero-denominator ratios", () => {
    expect(csvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
    expect(ratio(1, 0)).toBeNull();
  });

  it("accepts a UTF-8 BOM header and rejects characters after a quoted value", async () => {
    expect(() =>
      assertCsvHeaders("CUSTOMERS", [
        "\uFEFFexternal_key",
        "display_name",
        "phone",
        "preferred_locale",
      ]),
    ).not.toThrow();
    async function* malformedChunks() {
      yield 'external_key,display_name,phone,preferred_locale\n1,"Name"x,0799000000,en';
    }
    const collect = async () => {
      for await (const unused of parseCsvChunks(malformedChunks(), {
        maxColumns: 8,
        maxRows: 10,
        maxValueLength: 100,
      })) {
        void unused;
      }
    };
    await expect(collect()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("only estimates revenue when every completed booking has reliable pricing", () => {
    expect(
      reliableRevenueMinor([
        { priceMinor: 1_000, status: "COMPLETED" },
        { priceMinor: 2_000, status: "COMPLETED" },
      ]),
    ).toBe(3_000);
    expect(reliableRevenueMinor([{ priceMinor: null, status: "COMPLETED" }])).toBeNull();
  });
});
