import { describe, expect, it } from "vitest";
import { cachedDateFormat, denverToUtc, formatAge, formatDenver, formatLocalRelative, inferYearDenver, parseDenverDateTime, parseOffsetIso, zonedToUtc } from "@/lib/time";
import { currentBlockStart } from "@/lib/sources/nws";

describe("America/Denver conversions", () => {
  it("handles MDT and MST offsets", () => {
    expect(denverToUtc(2026, 10, 30, 17, 0).toISOString()).toBe("2026-10-30T23:00:00.000Z"); // MDT (-6)
    expect(denverToUtc(2026, 12, 15, 7, 0).toISOString()).toBe("2026-12-15T14:00:00.000Z"); // MST (-7)
  });

  it("resolves times on the fall-back day", () => {
    // Nov 1 2026: 2 AM MDT -> 1 AM MST. 6 AM is unambiguous MST.
    expect(denverToUtc(2026, 11, 1, 6, 0).toISOString()).toBe("2026-11-01T13:00:00.000Z");
  });

  it("parses resort local timestamps and offset ISO strings", () => {
    expect(parseDenverDateTime("2026-10-30 17:00:00")).toBe("2026-10-30T23:00:00.000Z");
    expect(parseDenverDateTime("garbage")).toBeNull();
    expect(parseOffsetIso("2026-10-27T15:56:57-0600")).toBe("2026-10-27T21:56:57.000Z");
    expect(parseOffsetIso("--")).toBeNull();
  });

  it("infers the year of a year-less date as the most recent occurrence", () => {
    const now = new Date("2026-01-03T15:00:00Z");
    expect(inferYearDenver(12, 31, 9, 0, now)).toBe("2025-12-31T16:00:00.000Z");
    expect(inferYearDenver(1, 2, 9, 0, now)).toBe("2026-01-02T16:00:00.000Z");
  });
});

describe("display formatting", () => {
  const now = new Date("2026-10-31T01:00:00Z"); // Fri Oct 30, 7 PM MDT

  it("labels yesterday's report as yesterday, not current", () => {
    expect(formatDenver("2026-10-30T13:00:00Z", now)).toBe("Today 7:00 AM");
    expect(formatDenver("2026-10-29T13:00:00Z", now)).toBe("Yesterday 7:00 AM");
    expect(formatDenver("2026-10-26T15:30:30Z", now)).toMatch(/Mon, Oct 26/);
    expect(formatDenver(null, now)).toBe("unknown");
  });

  it("formats ages", () => {
    expect(formatAge("2026-10-31T00:55:00Z", now)).toBe("5 min ago");
    expect(formatAge(null, now)).toBe("never");
  });

  it("computes day/night block starts in Denver time", () => {
    expect(currentBlockStart(now).toISOString()).toBe("2026-10-31T00:00:00.000Z"); // 6 PM MDT
    expect(currentBlockStart(new Date("2026-10-30T14:00:00Z")).toISOString()).toBe("2026-10-30T12:00:00.000Z"); // 6 AM
    expect(currentBlockStart(new Date("2026-10-30T10:00:00Z")).toISOString()).toBe("2026-10-30T00:00:00.000Z"); // 4 AM -> prev 6 PM
  });
});

describe("cachedDateFormat", () => {
  it("shares one formatter per locale and options, keyed by zone", () => {
    const a = cachedDateFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric" });
    expect(cachedDateFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric" })).toBe(a);
    const b = cachedDateFormat("en-US", { timeZone: "America/Denver", hour: "numeric" });
    expect(b).not.toBe(a);
    const t = new Date("2026-11-05T15:00:00Z");
    expect([a.format(t), b.format(t)]).toEqual(["7 AM", "8 AM"]);
  });
});

describe.each(["America/Denver", "America/Los_Angeles"])("relative calendar dates in %s", (zone) => {
  it.each([
    [2026, 11, 1, 23, 30, 2026, 10, 31, "Yesterday"],
    [2026, 3, 7, 23, 30, 2026, 3, 8, "Tomorrow"],
    [2026, 3, 9, 0, 30, 2026, 3, 8, "Yesterday"],
    [2026, 11, 1, 0, 30, 2026, 11, 2, "Tomorrow"],
    [2027, 1, 1, 0, 30, 2026, 12, 31, "Yesterday"],
    [2026, 12, 31, 23, 30, 2027, 1, 1, "Tomorrow"],
  ] as const)("keeps adjacent dates relative at %i-%i-%i %i:%i", (y, m, d, h, min, ry, rm, rd, label) => {
    const now = zonedToUtc(y, m, d, h, min, 0, zone);
    const report = zonedToUtc(ry, rm, rd, 12, 0, 0, zone).toISOString();
    expect(formatLocalRelative(report, now, zone)).toBe(`${label} 12:00 PM`);
    if (zone === "America/Denver") expect(formatDenver(report, now)).toBe(`${label} 12:00 PM`);
  });

  it("keeps today's label, older dates and missing timestamps", () => {
    const now = zonedToUtc(2026, 11, 1, 23, 30, 0, zone);
    expect(formatLocalRelative(zonedToUtc(2026, 11, 1, 12, 0, 0, zone).toISOString(), now, zone)).toBe("Today 12:00 PM");
    expect(formatLocalRelative(zonedToUtc(2026, 10, 29, 12, 0, 0, zone).toISOString(), now, zone)).toBe("Oct 29, 12:00 PM");
    expect(formatLocalRelative(null, now, zone)).toBe("unknown");
  });
});
