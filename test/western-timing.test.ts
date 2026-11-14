import { describe, expect, it } from "vitest";
import { validateWestern, type buildWesternInput } from "@/lib/dailysnow/western";
import { firstSnowAt, firstSnowLabel, westernTimingIssues, type RegionFirstSnow } from "@/lib/dailysnow/western-timing";
import type { PointForecast } from "@/lib/types";

// The 2026-11-14 United States West edition: posted 7:15 AM PST.
const now = new Date("2026-11-14T15:15:00Z");
const zone = "America/Los_Angeles";
const HOUR = 3_600_000;
const hourly = (from: string, amounts: number[]) =>
  ({ hourlySnow: amounts.map((snowIn, i) => ({ start: new Date(Date.parse(from) + i * HOUR).toISOString(), snowIn })) }) as unknown as PointForecast;

describe("first forecast snow", () => {
  it("starts at the first hour with measurable snow, ignoring trace allocations", () => {
    const p = hourly("2026-11-15T22:00:00Z", [0, 0.005, 0, 0.017, 0.07]);
    expect(firstSnowAt(p, now)).toBe("2026-11-16T01:00:00.000Z");
    expect(firstSnowAt(hourly("2026-11-14T15:00:00Z", [0.3]), now)).toBe(now.toISOString());
    expect(firstSnowAt(hourly("2026-11-14T15:00:00Z", [0, 0]), now)).toBeNull();
    expect(firstSnowAt({ sixHourSnow: [] } as unknown as PointForecast, now)).toBeNull();
  });

  it("names the local day and part of day; snow after midnight belongs to the night before", () => {
    expect(firstSnowLabel("2026-11-16T00:00:00.000Z", now, zone)).toBe("Sunday afternoon (from about 4 PM PST)");
    expect(firstSnowLabel("2026-11-15T10:00:00.000Z", now, zone)).toBe("Saturday night (from about 2 AM PST)");
    expect(firstSnowLabel(now.toISOString(), now, zone)).toBe("now (forecast snow in the current hour)");
    expect(firstSnowLabel(null, now, zone)).toBe("no forecast snow in the next 7 days");
  });
});

describe("Western snow timing", () => {
  const regions: RegionFirstSnow[] = [
    { region: "utah", name: "Utah", at: now.toISOString() },
    { region: "tahoe", name: "Tahoe", at: "2026-11-16T00:00:00.000Z" }, // Sunday 4 PM PST
    { region: "mammoth", name: "Mammoth", at: "2026-11-16T18:00:00.000Z" },
    { region: "colorado", name: "Colorado", at: null },
  ];
  const issues = (text: string) => westernTimingIssues([text], regions, now, zone);

  it("rejects the published sentence that had the Sierra's first snow on Saturday night", () => {
    expect(issues("The Sierra, represented by Palisades Tahoe, remains dry today but will catch the first snowfall Saturday night, with snow levels dropping into the mid-elevations.")).toEqual([
      '"Saturday night" is before the first forecast snow for Tahoe/Mammoth',
    ]);
    expect(issues("Snow arrives at Mammoth tonight.")).toHaveLength(1);
  });

  it("accepts arrival times that match the forecast, and ignores other day references", () => {
    expect(issues("The Sierra will catch its first snowfall Sunday afternoon.")).toEqual([]);
    expect(issues("Snow returns to Tahoe on Sunday after a dry Saturday.")).toEqual([]);
    expect(issues("Snow returns to Tahoe Sunday night after a dry Saturday.")).toEqual([]);
    expect(issues("Mammoth stays sunny and dry through Sunday.")).toEqual([]);
    expect(issues("Utah's Wasatch is already under snow this morning.")).toEqual([]);
    // A region without forecast snow, or no region at all, cannot be checked.
    expect(issues("Snow arrives in Colorado Saturday night.")).toEqual([]);
    expect(issues("The first flakes arrive Saturday night.")).toEqual([]);
  });

  it("gives the fallback model a turn when prose times snow too early", () => {
    const forecast = (area: "palisades-tahoe", firstSnow: string | null) => ({
      area, name: "Palisades Tahoe", source: "NWS", issuedAt: now.toISOString(), issuedLocal: "", start: now.toISOString(),
      next24In: 0, next72In: 4.4, next7dIn: 24, days4to7In: 19.7, firstSnowAt: firstSnow, firstSnowLocal: "",
    });
    const input = {
      asOf: now.toISOString(), asOfLocal: "", timeZone: zone, coverage: "", patternOutlook: null,
      regions: [{ id: "tahoe" as const, name: "Tahoe", edition: {} as never, observations: [], forecasts: [forecast("palisades-tahoe", "2026-11-16T00:00:00.000Z")] }],
    } satisfies ReturnType<typeof buildWesternInput>;
    const raw = (text: string) => ({
      title: "Storms Line Up", summary: "A wetter pattern builds across the West.",
      sections: [
        { id: "update", paragraphs: [{ text: "A trough deepens off the coast." }] },
        { id: "short-term", paragraphs: [{ text }] },
        { id: "extended", paragraphs: [{ text: "Longer-range guidance is unavailable." }] },
      ],
    });
    expect(() => validateWestern(raw("Tahoe catches its first snow Saturday night."), input)).toThrow(/times snow before its forecast/);
    expect(validateWestern(raw("Tahoe catches its first snow Sunday afternoon."), input).shortTerm).toEqual(["Tahoe catches its first snow Sunday afternoon."]);
  });
});
