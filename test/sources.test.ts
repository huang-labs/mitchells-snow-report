import { describe, expect, it } from "vitest";
import { parseAlta } from "@/lib/sources/alta";
import { parseBrighton } from "@/lib/sources/brighton";
import { parseMtnPowder } from "@/lib/sources/mtnpowder";
import { expandHourly, findNextStorm, summarizeGrid } from "@/lib/sources/nws";
import { forecastHoursFromPath, parsePlumePage, runCodeToIso } from "@/lib/sources/plumes";
import { parseSnowbird, snowbirdSensorTime } from "@/lib/sources/snowbird";
import { SOLITUDE_OPTIONS } from "@/lib/sources/solitude";
import { ValidationError } from "@/lib/sources/types";
import { fromField, parseNumber } from "@/lib/metric";
import { FIXTURE_NOW, fixture } from "./fixtureFetch";

const j = (name: string) => JSON.parse(fixture(name));

describe("metric semantics", () => {
  it("distinguishes zero, not reported and sentinels", () => {
    expect(fromField("0", "in", "24h")).toEqual({ state: "reported", value: 0, unit: "in", label: "24h" });
    expect(fromField("--", "in", "24h").state).toBe("not_reported");
    expect(fromField(null, "in", "24h").state).toBe("not_reported");
    expect(parseNumber("-7999")).toBeNull();
    expect(parseNumber("34   3.3")).toBe(34);
  });
});

describe("Alta (window.Alta blob)", () => {
  const { report, sourceUpdatedAt } = parseAlta(fixture("alta-lift-terrain-status.html"));
  it("keeps Alta's own windows and does not invent overnight/48h", () => {
    expect(sourceUpdatedAt).toBe("2026-10-30T23:00:00.000Z");
    expect(report.snowfall.h12).toMatchObject({ state: "reported", value: 0, label: "Last 12 hrs" });
    expect(report.snowfall.h24).toMatchObject({ state: "reported", value: 0 });
    expect(report.snowfall.storm).toMatchObject({ state: "reported", value: 0 });
    expect(report.snowfall.overnight.state).toBe("unavailable");
    expect(report.snowfall.h48.state).toBe("unavailable");
    expect(report.base).toMatchObject({ state: "reported", value: 2 });
  });
  it("lists individual lifts, terrain areas and gates", () => {
    expect(report.lifts?.map((l) => l.name)).toEqual(["Sunnyside", "Supreme", "Sugarloaf", "Collins", "Wildcat"]);
    expect(report.lifts?.find((l) => l.name === "Collins")?.note).toBe("OPEN FOR EMPLOYEE SKI DAY");
    expect(report.terrain?.some((t) => t.kind === "access gate" && t.name === "Keyhole")).toBe(true);
    expect(report.terrain?.some((t) => t.kind === "terrain area" && t.name === "Ballroom")).toBe(true);
  });
  it("does not attribute the unsited wind value to a station", () => {
    const wind = report.observations.find((o) => o.location.startsWith("Wind"));
    expect(wind?.wind.state).toBe("reported");
    expect(report.observations.find((o) => o.location === "Top")?.wind.state).toBe("unavailable");
  });
  it("rejects pages without the data blob", () => {
    expect(() => parseAlta("<html></html>")).toThrow(ValidationError);
  });
});

describe("Snowbird API", () => {
  const input = {
    snowReports: j("snowbird-snow-reports.json"),
    lifts: j("snowbird-lifts.json"),
    terrains: j("snowbird-terrains.json"),
    sensors: j("snowbird-sensors.json"),
    parking: j("snowbird-parking.json"),
  };
  const { report, sourceUpdatedAt } = parseSnowbird(input, FIXTURE_NOW);
  it("uses the newest Primary report and its publish time", () => {
    expect(sourceUpdatedAt).toBe("2026-10-26T15:30:30.000Z");
    expect(report.reportTimeLabel).toContain("2026-10-26 09:00:00");
    expect(report.snowfall.overnight).toMatchObject({ state: "reported", value: 0 });
    expect(report.base).toMatchObject({ state: "reported", value: 3 });
  });
  it("labels rolling totals as computed by Snowbird", () => {
    expect(report.snowfall.h48.state).toBe("reported");
    expect(report.snowfall.h48.note).toMatch(/computed by Snowbird/);
    expect(report.snowfall.storm.state).toBe("unavailable");
  });
  it("parses sensors with their own timestamps", () => {
    expect(snowbirdSensorTime({ date: "10 30", time: "1600" }, FIXTURE_NOW)).toBe("2026-10-30T22:00:00.000Z");
    const peak = report.observations.find((o) => o.location === "Hidden Peak");
    expect(peak?.temperature).toMatchObject({ value: 30 });
    expect(peak?.gust).toMatchObject({ value: 17 });
  });
  it("excludes summer-only lifts and keeps raw status", () => {
    expect(report.lifts?.length).toBeGreaterThan(5);
    expect(report.lifts?.every((l) => l.rawStatus)).toBe(true);
    expect(report.terrain?.some((t) => t.name === "Mineral Basin")).toBe(true);
  });
  it("records missing optional sections without failing", () => {
    const r = parseSnowbird({ snowReports: input.snowReports, missingSections: ["lifts"] }, FIXTURE_NOW).report;
    expect(r.lifts).toBeNull();
    expect(r.missingSections).toEqual(["lifts"]);
  });
});

describe("Mountain Powder feed (Solitude)", () => {
  const { report, sourceUpdatedAt } = parseMtnPowder(j("mtnpowder-solitude.json"), SOLITUDE_OPTIONS);
  it("reads the preferred (mid) reporting location", () => {
    expect(sourceUpdatedAt).toBe("2026-10-27T21:56:57.000Z");
    expect(report.snowfall.overnight).toMatchObject({ value: 0, label: "Since lifts closed" });
    expect(report.snowfall.d7).toMatchObject({ value: 1 });
    expect(report.snowfall.storm).toMatchObject({ state: "reported", value: 0 });
    expect(report.base).toMatchObject({ value: 1 });
  });
  it("lists named terrain trail-by-trail, not inferred from counts", () => {
    expect(report.terrain?.some((t) => t.kind === "Honeycomb Canyon" && t.name === "Black Bess")).toBe(true);
    expect(report.lifts?.some((l) => l.name === "Summit Express")).toBe(true);
  });
});

describe("Brighton reportpal", () => {
  const { report, sourceUpdatedAt } = parseBrighton(j("brighton-reportpal.json"));
  it("keeps Brighton's labels and windows", () => {
    expect(sourceUpdatedAt).toBe("2026-10-30T13:00:00.000Z");
    expect(report.snowfall.overnight).toMatchObject({ value: 0, label: "Snow Overnight" });
    expect(report.snowfall.h48).toMatchObject({ value: 0, label: "Snow 48 Hrs." });
    expect(report.snowfall.storm.state).toBe("unavailable");
    expect(report.lifts?.length).toBe(8);
    expect(report.terrain).toBeNull();
    expect(report.notices.some((n) => n.text.includes("no uphill"))).toBe(true);
  });
});

describe("Utah plumes", () => {
  it("discovers the latest run and chart from the page", () => {
    const p = parsePlumePage(fixture("utah-plume-CLN.html"), "CLN");
    expect(p.runCode).toBe("2026103012");
    expect(p.imagePath).toBe("20261030/images/models/ensgefsds/ENSGEFSDSPL_CLN2026103012F240.png");
    expect(p.product).toBe("Utah Snow Ensemble");
    expect(runCodeToIso(p.runCode)).toBe("2026-10-30T12:00:00.000Z");
  });
  it("reads the forecast length from the chart file name", () => {
    expect(forecastHoursFromPath("20261101/images/models/ensgefsds/ENSGEFSDSPL_CLN2026110100F240.png")).toBe(240);
    expect(forecastHoursFromPath("x.png")).toBeNull();
  });
  it("rejects an unavailable product", () => {
    const html = fixture("utah-plume-CLN.html").replace(/images_vis:\s*\[[\s\S]*?\]/, "images_vis: []");
    expect(() => parsePlumePage(html, "CLN")).toThrow(/not available/);
  });
});

describe("NWS gridpoints", () => {
  const grid = j("nws-gridpoint-SLC-108-167.json");
  it("summarizes day/night blocks across the DST change", () => {
    const s = summarizeGrid(grid, FIXTURE_NOW);
    expect(s.blocks[0].label).toBe("Fri night");
    expect(s.blocks[2]).toMatchObject({ label: "Sat night", start: "2026-11-01T00:00:00.000Z", end: "2026-11-01T13:00:00.000Z" });
    expect(s.blocks.every((b) => b.tempMinF !== null && b.snowLevelMinFt !== null)).toBe(true);
    expect(s.elevationFt).toBe(9800);
  });
  it("retains unrounded hourly allocation, reported zero, and missing coverage", () => {
    const start = new Date("2026-11-03T12:00:00Z");
    const summary = summarizeGrid({ properties: {
      temperature: { values: [] },
      snowfallAmount: { uom: "wmoUnit:mm", values: [
        { validTime: "2026-11-03T12:00:00Z/PT6H", value: 25.4 },
        { validTime: "2026-11-03T18:00:00Z/PT1H", value: 0 },
        { validTime: "2026-11-03T19:00:00Z/PT1H", value: null },
      ] },
    } }, start);
    expect(summary.hourlySnow).toHaveLength(7);
    expect(summary.hourlySnow![0].snowIn).toBeCloseTo(1 / 6, 12);
    expect(summary.hourlySnow![6]).toEqual({ start: "2026-11-03T18:00:00.000Z", snowIn: 0 });
    // No QPF series: liquid stays aligned with the snow hours, all unknown.
    expect(summary.hourlyLiquidIn).toEqual(Array(7).fill(null));
  });
  it("keeps hourly liquid index-aligned with hourly snow, to 0.0001 in", () => {
    const start = new Date("2026-11-03T12:00:00Z");
    const summary = summarizeGrid({ properties: {
      temperature: { values: [] },
      snowfallAmount: { uom: "wmoUnit:mm", values: [{ validTime: "2026-11-03T12:00:00Z/PT6H", value: 25.4 }] },
      quantitativePrecipitation: { uom: "wmoUnit:mm", values: [{ validTime: "2026-11-03T12:00:00Z/PT3H", value: 2.54 }] },
    } }, start);
    expect(summary.hourlyLiquidIn).toHaveLength(summary.hourlySnow!.length);
    expect(summary.hourlyLiquidIn).toEqual([0.0333, 0.0333, 0.0333, null, null, null]);
  });
  it("records liquid for every snow hour in the fixture grid", () => {
    const s = summarizeGrid(grid, FIXTURE_NOW);
    expect(s.hourlyLiquidIn).toHaveLength(s.hourlySnow!.length);
    expect(s.hourlyLiquidIn!.every((v) => v !== null && v >= 0)).toBe(true);
  });
  it("finds the next ≥1in storm with its minimum snow level", () => {
    const s = summarizeGrid(grid, FIXTURE_NOW);
    expect(s.nextStorm).not.toBeNull();
    expect(s.nextStorm!.totalSnowIn).toBeGreaterThan(10);
    expect(s.nextStorm!.start >= FIXTURE_NOW.toISOString()).toBe(true);
  });
  it("spreads accumulations over their validity interval", () => {
    const m = expandHourly({ values: [{ validTime: "2026-11-01T00:00:00+00:00/PT6H", value: 25.4 * 6 }] }, "accum", (v) => v / 25.4);
    expect([...m.values()].map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(findNextStorm(m, new Map(), new Date("2026-10-31T00:00:00Z"))).toMatchObject({ totalSnowIn: 6 });
  });
});
