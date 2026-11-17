// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HourlyForecast } from "@/components/weather/HourlyForecast";
import { buildHourlyWeather, hourlyFromNow, isSkiHour, precipForHour, skiDaySummary, type HourlyWeather } from "@/lib/hourlyWeather";
import { summarizeGrid } from "@/lib/sources/nws";
import { FIXTURE_NOW } from "./fixtureFetch";

const grid = JSON.parse(readFileSync(join(__dirname, "fixtures/nws-gridpoint-SLC-108-167.json"), "utf8"));
const TZ = "America/Denver";
afterEach(cleanup);

describe("hourly NWS series", () => {
  it("keeps the next 48 hours of every planning series from the grid", () => {
    const h = summarizeGrid(grid, FIXTURE_NOW).hourly!;
    expect(h.start).toBe(FIXTURE_NOW.toISOString());
    expect(h.hours).toBe(48);
    for (const k of ["tempF", "windChillF", "windMph", "gustMph", "windFromDeg", "skyPct", "popPct"] as const) {
      expect(h[k], k).toHaveLength(48);
      expect(h[k]!.every((v) => v === null || Number.isInteger(v)), k).toBe(true);
    }
    expect(h.tempF!.every((v) => v !== null && v > -40 && v < 80)).toBe(true);
    // The fixture storm builds from a slight chance of snow to definite snow, with no rain or thunder.
    expect(h.precip!.snow.slice(26, 36)).toEqual(["slight", "slight", "slight", "chance", "chance", "chance", "likely", "likely", "likely", "definite"]);
    for (const k of ["rain", "thunder", "ice"] as const) expect(h.precip![k].every((c) => c === "none"), k).toBe(true);
  });

  it("converts units and leaves out series the grid doesn't publish", () => {
    const t = "2026-11-03T12:00:00Z";
    const s = summarizeGrid({ properties: {
      temperature: { uom: "wmoUnit:degC", values: [{ validTime: `${t}/PT2H`, value: -10 }, { validTime: "2026-11-03T14:00:00Z/PT1H", value: null }] },
      windSpeed: { uom: "wmoUnit:km_h-1", values: [{ validTime: `${t}/PT3H`, value: 16.09344 }] },
      snowfallAmount: { uom: "wmoUnit:mm", values: [] },
    } }, new Date(t));
    expect(s.hourly!.tempF!.slice(0, 3)).toEqual([14, 14, null]);
    expect(s.hourly!.windMph!.slice(0, 4)).toEqual([10, 10, 10, null]);
    expect(s.hourly).not.toHaveProperty("skyPct");
    expect(s.hourly).not.toHaveProperty("precip");
  });

  it("folds NWS coverage words and weather types into four rows", () => {
    expect(precipForHour([{ coverage: null, weather: null }])).toEqual({ snow: "none", rain: "none", thunder: "none", ice: "none" });
    expect(precipForHour([
      { coverage: "scattered", weather: "snow_showers" },
      { coverage: "likely", weather: "snow" },
      { coverage: "isolated", weather: "thunderstorms" },
      { coverage: "areas", weather: "freezing_drizzle" },
      { coverage: "definite", weather: "fog" },
    ])).toEqual({ snow: "likely", rain: "none", thunder: "slight", ice: "chance" });
  });

  it("returns nothing when the grid has no planning data", () => {
    expect(buildHourlyWeather({}, FIXTURE_NOW)).toBeNull();
  });
});

describe("ski-day summary", () => {
  const series = (start: string, n: number, f: (i: number) => number | null): HourlyWeather => ({
    start, hours: n,
    tempF: Array.from({ length: n }, (_, i) => f(i)),
    windChillF: Array.from({ length: n }, (_, i) => { const v = f(i); return v === null ? null : v - 10; }),
    windMph: Array(n).fill(12), gustMph: Array.from({ length: n }, (_, i) => 20 + (i % 5)),
  });

  it("shades 9 AM–4 PM local on both sides of the DST change", () => {
    // Oct 31 is MDT (UTC−6); Nov 1 is MST (UTC−7).
    expect(isSkiHour("2026-10-31T15:00:00Z", TZ)).toBe(true);
    expect(isSkiHour("2026-10-31T14:00:00Z", TZ)).toBe(false);
    expect(isSkiHour("2026-11-01T16:00:00Z", TZ)).toBe(true);
    expect(isSkiHour("2026-11-01T15:00:00Z", TZ)).toBe(false);
    expect(isSkiHour("2026-11-01T22:00:00Z", TZ)).toBe(true);
    expect(isSkiHour("2026-11-01T23:00:00Z", TZ)).toBe(false);
  });

  it("summarizes the rest of today's ski hours before 4 PM", () => {
    const h = series("2026-11-01T14:00:00Z", 48, (i) => i);
    const s = skiDaySummary(h, new Date("2026-11-01T18:30:00Z"), TZ)!; // 11:30 AM MST
    expect(s.day).toBe("Today");
    // 11 AM (index 4) through 3 PM (index 8).
    expect(s).toMatchObject({ tempMinF: 4, tempMaxF: 8, windChillMinF: -6, windChillMaxF: -2, windMaxMph: 12, gustMaxMph: 24 });
  });

  it("moves to tomorrow after 4 PM and ignores missing hours", () => {
    const h = series("2026-11-01T14:00:00Z", 48, (i) => (i === 26 ? null : i));
    const s = skiDaySummary(h, new Date("2026-11-01T23:30:00Z"), TZ)!; // 4:30 PM MST
    expect(s.day).toBe("Tomorrow");
    expect(s.tempMinF).toBe(26 + 1); // 9 AM Nov 2 is index 26, left empty
    expect(s.tempMaxF).toBe(32);
  });

  it("drops hours before now from an older snapshot", () => {
    const h = series("2026-11-01T14:00:00Z", 48, (i) => i);
    const later = hourlyFromNow(h, new Date("2026-11-01T17:10:00Z"));
    expect(later.start).toBe("2026-11-01T17:00:00.000Z");
    expect(later.hours).toBe(45);
    expect(later.tempF![0]).toBe(3);
  });
});

describe("hourly charts", () => {
  it("draws four labeled panels with the ski-day summary and grid caveat", () => {
    const h = summarizeGrid(grid, FIXTURE_NOW).hourly!;
    const { container } = render(<HourlyForecast hourly={h} now={new Date("2026-10-31T16:00:00Z")} timeZone={TZ} name="Alta / Snowbird (LCC)" elevationFt={9800} />);
    expect([...container.querySelectorAll(".hourly__title")].map((e) => e.textContent)).toEqual([
      "Temperature · °F", "Wind · mph", "Sky and precipitation chance · %", "Precipitation type",
    ]);
    expect(screen.getByText("Today, 9 AM–4 PM")).toBeTruthy();
    expect(screen.getByText(/NWS grid cell at 9,800 ft; summits run colder/)).toBeTruthy();
    expect(container.querySelectorAll(".hourly__ski").length).toBeGreaterThan(0);
    // Freezing rain gets no row when the grid forecasts none.
    expect(screen.queryByText("Freezing")).toBeNull();
    expect(screen.getAllByRole("img", { name: /Alta \/ Snowbird/ })).toHaveLength(4);
  });

  it("shows one no-data mark for a panel the grid doesn't publish", () => {
    const h: HourlyWeather = { start: "2026-11-01T14:00:00Z", hours: 24, tempF: Array(24).fill(20), windMph: Array(24).fill(null) };
    const { container } = render(<HourlyForecast hourly={h} now={new Date("2026-11-01T14:00:00Z")} timeZone={TZ} name="Test" elevationFt={null} />);
    expect(container.querySelectorAll(".hourly__none")).toHaveLength(3);
    expect(screen.getAllByLabelText("no data")).toHaveLength(3);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText(/Wind to — mph, gusts —/)).toBeTruthy();
  });
});
