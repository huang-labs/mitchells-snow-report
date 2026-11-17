// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WeatherPage } from "@/components/sections/WeatherPage";
import {
  buildHourlyWeather,
  dayFacts,
  daySeries,
  daySnowIn,
  defaultDayIndex,
  forecastDays,
  isSkiHour,
  precipForHour,
  type HourlyWeather,
} from "@/lib/hourlyWeather";
import { buildReport } from "@/lib/report";
import { summarizeGrid } from "@/lib/sources/nws";
import type { PointForecast } from "@/lib/types";
import { FIXTURE_NOW } from "./fixtureFetch";

const HOUR = 3_600_000;
const grid = JSON.parse(readFileSync(join(__dirname, "fixtures/nws-gridpoint-SLC-108-167.json"), "utf8"));
const TZ = "America/Denver";
const iso = (t: number) => new Date(t).toISOString();
afterEach(cleanup);

describe("hourly NWS series", () => {
  it("keeps seven days of every planning series from the grid", () => {
    const h = summarizeGrid(grid, FIXTURE_NOW).hourly!;
    expect(h.start).toBe(FIXTURE_NOW.toISOString());
    expect(h.hours).toBe(168);
    for (const k of ["tempF", "windChillF", "windMph", "gustMph", "windFromDeg", "skyPct", "popPct", "snowLevelFt"] as const) {
      expect(h[k], k).toHaveLength(168);
      expect(h[k]!.every((v) => v === null || Number.isInteger(v)), k).toBe(true);
    }
    expect(h.tempF!.slice(0, 48).every((v) => v !== null && v > -40 && v < 80)).toBe(true);
    expect(h.snowLevelFt!.every((v) => v === null || v % 100 === 0)).toBe(true);
    // The fixture storm builds from a slight chance of snow to definite snow, with no rain or thunder.
    expect(h.precip!.snow.slice(26, 36)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4]);
    for (const k of ["rain", "thunder", "ice"] as const) expect(h.precip![k].every((c) => c === 0 || c === null), k).toBe(true);
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

  it("folds NWS coverage words and weather types into four steps per row", () => {
    expect(precipForHour([{ coverage: null, weather: null }])).toEqual({ snow: 0, rain: 0, thunder: 0, ice: 0 });
    expect(precipForHour([
      { coverage: "scattered", weather: "snow_showers" },
      { coverage: "likely", weather: "snow" },
      { coverage: "isolated", weather: "thunderstorms" },
      { coverage: "areas", weather: "freezing_drizzle" },
      { coverage: "definite", weather: "fog" },
    ])).toEqual({ snow: 3, rain: 0, thunder: 1, ice: 2 });
  });

  it("returns nothing when the grid has no planning data", () => {
    expect(buildHourlyWeather({}, FIXTURE_NOW)).toBeNull();
  });
});

describe("forecast days", () => {
  it("splits local days at midnight across the DST change", () => {
    const days = forecastDays(new Date("2026-10-31T16:00:00Z"), TZ, 3);
    expect(days.map((d) => [d.key, d.weekday, d.date])).toEqual([["2026-10-31", "Today", "10/31"], ["2026-11-01", "Sun", "11/1"], ["2026-11-02", "Mon", "11/2"]]);
    expect(iso(days[0].start)).toBe("2026-10-31T06:00:00.000Z");
    // Nov 1 has 25 hours: MDT midnight to MST midnight.
    expect([iso(days[1].start), iso(days[1].end)]).toEqual(["2026-11-01T06:00:00.000Z", "2026-11-02T07:00:00.000Z"]);
    expect(days[1].long).toBe("Sunday, Nov 1");
  });

  it("uses each region's own midnight", () => {
    expect(iso(forecastDays(new Date("2026-11-17T12:00:00Z"), "America/Los_Angeles", 1)[0].start)).toBe("2026-11-17T08:00:00.000Z");
  });

  it("opens on today until 4 PM local, then tomorrow", () => {
    expect(defaultDayIndex(new Date("2026-11-17T22:59:00Z"), TZ)).toBe(0); // 3:59 PM MST
    expect(defaultDayIndex(new Date("2026-11-17T23:00:00Z"), TZ)).toBe(1);
  });

  it("shades 9 AM–4 PM local on both sides of the DST change", () => {
    expect(isSkiHour("2026-10-31T15:00:00Z", TZ)).toBe(true);
    expect(isSkiHour("2026-10-31T14:00:00Z", TZ)).toBe(false);
    expect(isSkiHour("2026-11-01T16:00:00Z", TZ)).toBe(true);
    expect(isSkiHour("2026-11-01T22:00:00Z", TZ)).toBe(true);
    expect(isSkiHour("2026-11-01T23:00:00Z", TZ)).toBe(false);
  });
});

describe("a day's numbers", () => {
  const now = new Date("2026-11-17T18:30:00Z"); // 11:30 AM MST
  const t0 = Date.parse("2026-11-17T18:00:00Z");
  const snow = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ start: iso(t0 + i * HOUR), snowIn: f(i) }));
  const [today, tomorrow] = forecastDays(now, TZ, 2);

  it("totals the rest of today and a whole future day", () => {
    const s = snow(48, () => 0.1);
    expect(daySnowIn(s, today, now)).toBe(1.3); // 11 AM through 11 PM: 13 hours
    expect(daySnowIn(snow(48, (i) => (i < 13 ? 0 : 0.25)), tomorrow, now)).toBe(6);
  });

  it("gives no total for a day the grid doesn't fully cover", () => {
    expect(daySnowIn(snow(20, () => 0.1), tomorrow, now)).toBeNull();
    expect(daySnowIn(undefined, today, now)).toBeNull();
  });

  const hourly = (n: number, f: (i: number) => number | null): HourlyWeather => ({
    start: iso(t0), hours: n,
    tempF: Array.from({ length: n }, (_, i) => f(i)),
    windChillF: Array.from({ length: n }, (_, i) => { const v = f(i); return v === null ? null : v - 10; }),
    windMph: Array(n).fill(12), gustMph: Array.from({ length: n }, (_, i) => 20 + (i % 5)),
    snowLevelFt: Array(n).fill(5400),
  });

  it("reads temperature and wind over the ski hours still ahead", () => {
    const h = hourly(48, (i) => i);
    const s = daySeries(h, undefined, today, now);
    expect(s.times[0]).toBe(t0);
    const f = dayFacts(s, null, TZ);
    // 11 AM (index 0) through 3 PM (index 4).
    expect(f).toMatchObject({ skiHoursAhead: true, tempMinF: 0, tempMaxF: 4, windChillMinF: -10, windChillMaxF: -6, windMaxMph: 12, gustMaxMph: 24, snowLevelMinFt: 5400 });
  });

  it("falls back to the rest of the day once ski hours have passed", () => {
    const late = new Date("2026-11-18T00:30:00Z"); // 5:30 PM MST
    const [day] = forecastDays(late, TZ, 1);
    const f = dayFacts(daySeries(hourly(48, (i) => i), undefined, day, late), null, TZ);
    expect(f.skiHoursAhead).toBe(false);
    expect([f.tempMinF, f.tempMaxF]).toEqual([6, 12]); // 5 PM to 11 PM
  });

  it("leaves hours outside the grid empty", () => {
    const s = daySeries(hourly(6, (i) => (i === 2 ? null : i)), undefined, today, now);
    expect(s.tempF!.slice(0, 7)).toEqual([0, 1, null, 3, 4, 5, null]);
  });
});

describe("Weather page", () => {
  const point = (over: Partial<PointForecast>): PointForecast => ({
    id: "LCC", name: "Alta / Snowbird (LCC)", gridId: "SLC", gridX: 108, gridY: 167, timeZone: "America/Denver",
    ...summarizeGrid(grid, FIXTURE_NOW), periods: [], ...over,
  });
  const page = (points: PointForecast[], now = FIXTURE_NOW) => {
    const source = { ...buildReport(null, now).sources.nws, payload: { points } };
    return render(<WeatherPage source={source} now={now} />);
  };

  it("leads with snow by day and drives every area from one chosen day", () => {
    // FIXTURE_NOW is 7 PM MDT on Fri Oct 30, past ski hours: the page opens on Saturday.
    const { container } = page([point({}), point({ id: "BCC", name: "Brighton / Solitude (BCC)", hourly: undefined })]);
    expect(container.querySelectorAll(".wxdays__table tbody tr")).toHaveLength(2);
    const picks = screen.getAllByRole("button", { pressed: false }).concat(screen.getAllByRole("button", { pressed: true }));
    expect(picks.filter((b) => b.classList.contains("wxdays__pick"))).toHaveLength(7);
    expect(screen.getByRole("button", { pressed: true }).textContent).toBe("Sat10/31");
    expect(container.querySelector(".wxday-bar__title")!.textContent).toBe("Saturday, Oct 31");
    expect([...container.querySelectorAll(".wxchart__title")].map((e) => e.textContent)).toEqual(["Temperature · °F", "Wind · mph", "Snow and sky"]);
    // The area without hourly data still has its day's snow, and says why the charts are missing.
    expect(screen.getByText(/Hourly forecast arrives with the next NWS collection/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Mon\s*11\/2/ }));
    expect(container.querySelector(".wxday-bar__title")!.textContent).toBe("Monday, Nov 2");
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(container.querySelector(".wxday-bar__title")!.textContent).toBe("Sunday, Nov 1");
    expect(screen.getByRole("button", { pressed: true }).textContent).toBe("Sun11/1");
    // Snow totals on the shared scale: a definite storm on Sunday.
    const sunday = container.querySelectorAll(".wxdays__table tbody tr")[0].querySelectorAll("td")[2];
    expect(parseFloat(sunday.textContent!)).toBeGreaterThan(5);
  });

  it("shows one no-data mark for a series the grid doesn't publish", () => {
    const base = summarizeGrid(grid, FIXTURE_NOW).hourly!;
    const { container } = page([point({ hourly: { start: base.start, hours: base.hours, tempF: base.tempF } })]);
    expect(container.querySelectorAll(".wxchart__none")).toHaveLength(1); // wind
    expect(container.querySelectorAll(".wxfacts .metric__na, .wxchart__none .metric__na").length).toBeGreaterThan(0);
    expect(screen.getByText(/gusts —/)).toBeTruthy();
  });
});
