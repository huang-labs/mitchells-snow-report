import { zonedParts, zonedToUtc } from "./time";

const HOUR = 3_600_000;

/**
 * Hour-by-hour NWS gridpoint forecast for planning a ski day: temperature, wind
 * chill, wind, sky cover, chance and type of precipitation, and snow level.
 *
 * Every series is index-aligned with hour `i` starting at `start + i h`. A series is
 * left out when the grid doesn't publish it at all; a `null` entry is an hour the grid
 * left empty. Neither is a reported zero.
 */
export interface HourlyWeather {
  /** First hour (UTC ISO, top of the hour). */
  start: string;
  hours: number;
  tempF?: Array<number | null>;
  windChillF?: Array<number | null>;
  windMph?: Array<number | null>;
  gustMph?: Array<number | null>;
  /** Direction the wind blows from, degrees true. */
  windFromDeg?: Array<number | null>;
  skyPct?: Array<number | null>;
  popPct?: Array<number | null>;
  /** Rounded to 100 ft. */
  snowLevelFt?: Array<number | null>;
  /** NWS weather coverage per hour as a {@link Coverage} step; absent when the grid publishes no weather series. */
  precip?: Record<PrecipKind, Array<Coverage | null>>;
}

export type PrecipKind = "snow" | "rain" | "thunder" | "ice";
/**
 * NWS coverage words in four steps: 1 slight chance, 2 chance, 3 likely, 4 definite.
 * 0 is a reported hour with no such weather. Stored as numbers to keep 7 days small.
 */
export type Coverage = 0 | 1 | 2 | 3 | 4;

export const PRECIP_KINDS: ReadonlyArray<{ kind: PrecipKind; label: string }> = [
  { kind: "snow", label: "Snow" },
  { kind: "rain", label: "Rain" },
  { kind: "thunder", label: "Thunder" },
  { kind: "ice", label: "Freezing" },
];

export const COVERAGE_LABEL: Record<Coverage, string> = { 0: "none", 1: "slight chance", 2: "chance", 3: "likely", 4: "definite" };

/** NWS `weather[].coverage` values, folded to four steps (probability terms and their areal equivalents). */
const COVERAGE: Record<string, Exclude<Coverage, 0>> = {
  slight_chance: 1, isolated: 1, patchy: 1, brief: 1,
  chance: 2, scattered: 2, areas: 2, intermittent: 2,
  likely: 3, numerous: 3, occasional: 3, periods: 3,
  definite: 4, widespread: 4, frequent: 4,
};

/** NWS `weather[].weather` values for each row. Fog, haze, smoke and blowing snow aren't precipitation. */
const KIND: Record<string, PrecipKind> = {
  snow: "snow", snow_showers: "snow",
  rain: "rain", rain_showers: "rain", drizzle: "rain",
  thunderstorms: "thunder",
  freezing_rain: "ice", freezing_drizzle: "ice", sleet: "ice", ice_pellets: "ice",
};

export interface GridWeatherEntry { coverage: string | null; weather: string | null }

/** Coverage per kind for one hour's NWS weather entries; every kind is 0 unless an entry names it. */
export function precipForHour(entries: GridWeatherEntry[]): Record<PrecipKind, Coverage> {
  const out: Record<PrecipKind, Coverage> = { snow: 0, rain: 0, thunder: 0, ice: 0 };
  for (const e of entries) {
    const kind = e.weather ? KIND[e.weather] : undefined;
    // A named type without a coverage word is still forecast; treat it as the weakest step.
    const cov = e.coverage ? COVERAGE[e.coverage] ?? 1 : 1;
    if (kind && cov > out[kind]) out[kind] = cov;
  }
  return out;
}

export interface HourlyMaps {
  tempF: Map<number, number>;
  windChillF: Map<number, number>;
  windMph: Map<number, number>;
  gustMph: Map<number, number>;
  windFromDeg: Map<number, number>;
  skyPct: Map<number, number>;
  popPct: Map<number, number>;
  snowLevelFt: Map<number, number>;
  weather: Map<number, GridWeatherEntry[]>;
}

/** Seven days, the length of the NWS grid. */
export const HOURLY_HOURS = 7 * 24;

/** The next {@link HOURLY_HOURS} hours from the current hour, rounded for display. Empty maps are left out. */
export function buildHourlyWeather(maps: Partial<HourlyMaps>, now: Date, hours = HOURLY_HOURS): HourlyWeather | null {
  const t0 = Math.floor(now.getTime() / HOUR) * HOUR;
  const times = Array.from({ length: hours }, (_, i) => t0 + i * HOUR);
  const series = (m: Map<number, number> | undefined, round = (v: number) => Math.round(v)) =>
    m && m.size ? times.map(t => (m.has(t) ? round(m.get(t)!) : null)) : undefined;
  const out: HourlyWeather = {
    start: new Date(t0).toISOString(),
    hours,
    tempF: series(maps.tempF),
    windChillF: series(maps.windChillF),
    windMph: series(maps.windMph),
    gustMph: series(maps.gustMph),
    windFromDeg: series(maps.windFromDeg),
    skyPct: series(maps.skyPct),
    popPct: series(maps.popPct),
    snowLevelFt: series(maps.snowLevelFt, v => Math.round(v / 100) * 100),
  };
  if (maps.weather?.size) {
    const precip: Record<PrecipKind, Array<Coverage | null>> = { snow: [], rain: [], thunder: [], ice: [] };
    for (const t of times) {
      const entries = maps.weather.get(t);
      const hour = entries ? precipForHour(entries) : null;
      for (const { kind } of PRECIP_KINDS) precip[kind].push(hour ? hour[kind] : null);
    }
    out.precip = precip;
  }
  for (const k of Object.keys(out) as Array<keyof HourlyWeather>) if (out[k] === undefined) delete out[k];
  const anyValue = (["tempF", "windChillF", "windMph", "gustMph", "skyPct", "popPct"] as const).some(k => (out[k] ?? []).some(v => v !== null));
  return anyValue || out.precip ? out : null;
}

/** Local hours shaded and summarized as ski hours: 9 AM up to 4 PM. */
export const SKI_HOURS = { from: 9, to: 16 } as const;

export const isSkiHour = (t: string | number, timeZone: string) => {
  const h = zonedParts(new Date(t), timeZone).hour;
  return h >= SKI_HOURS.from && h < SKI_HOURS.to;
};

/** One local calendar day of the forecast. */
export interface ForecastDay {
  /** Local date, YYYY-MM-DD. */
  key: string;
  /** Local midnight to the next local midnight (23 or 25 hours across DST), epoch ms. */
  start: number;
  end: number;
  /** "Today", "Tue". */
  weekday: string;
  /** "11/17". */
  date: string;
  /** "Today, Tuesday, Nov 17" / "Wednesday, Nov 18". */
  long: string;
  today: boolean;
}

/** The next `count` local calendar days from today, DST-safe. */
export function forecastDays(now: Date, timeZone: string, count = 7): ForecastDay[] {
  const p = zonedParts(now, timeZone);
  const days: ForecastDay[] = [];
  for (let i = 0; i < count; i++) {
    // Noon UTC-of-wall-date never crosses a date boundary, so day arithmetic is safe.
    const wall = new Date(Date.UTC(p.year, p.month - 1, p.day + i, 12));
    const [y, m, d] = [wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate()];
    const next = new Date(Date.UTC(y, m - 1, d + 1, 12));
    const start = zonedToUtc(y, m, d, 0, 0, 0, timeZone).getTime();
    const end = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, timeZone).getTime();
    const mid = new Date(start + 12 * HOUR);
    const weekdayLong = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(mid);
    const monthDay = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(mid);
    days.push({
      key: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      start, end,
      weekday: i === 0 ? "Today" : weekdayLong.slice(0, 3),
      date: `${m}/${d}`,
      long: i === 0 ? `Today, ${weekdayLong}, ${monthDay}` : `${weekdayLong}, ${monthDay}`,
      today: i === 0,
    });
  }
  return days;
}

/** Today until ski hours end locally, then tomorrow. */
export function defaultDayIndex(now: Date, timeZone: string): number {
  return zonedParts(now, timeZone).hour >= SKI_HOURS.to ? 1 : 0;
}

/** Hours of `day` still ahead of `now` (whole day for future days). */
export function hoursAhead(day: ForecastDay, now: Date): number[] {
  const from = Math.max(day.start, Math.floor(now.getTime() / HOUR) * HOUR);
  const out: number[] = [];
  for (let t = from; t < day.end; t += HOUR) out.push(t);
  return out;
}

/**
 * Forecast snow for the rest of `day`, summed from the NWS hourly allocation. Null
 * unless every remaining hour of the day is in the grid, so a partial day never reads
 * as a total.
 */
export function daySnowIn(hourlySnow: Array<{ start: string; snowIn: number }> | undefined, day: ForecastDay, now: Date): number | null {
  if (!hourlySnow?.length) return null;
  const byHour = new Map(hourlySnow.map(h => [Date.parse(h.start), h.snowIn]));
  const hours = hoursAhead(day, now);
  if (!hours.length || hours.some(t => !byHour.has(t))) return null;
  return Math.round(hours.reduce((s, t) => s + byHour.get(t)!, 0) * 10) / 10;
}

/** One day's hourly series, index-aligned with `times`; hours outside the grid are null. */
export interface DaySeries {
  times: number[];
  snowIn: Array<number | null>;
  tempF?: Array<number | null>;
  windChillF?: Array<number | null>;
  windMph?: Array<number | null>;
  gustMph?: Array<number | null>;
  windFromDeg?: Array<number | null>;
  skyPct?: Array<number | null>;
  popPct?: Array<number | null>;
  snowLevelFt?: Array<number | null>;
  precip?: Record<PrecipKind, Array<Coverage | null>>;
}

export function daySeries(h: HourlyWeather | undefined, hourlySnow: Array<{ start: string; snowIn: number }> | undefined, day: ForecastDay, now: Date): DaySeries {
  const times = hoursAhead(day, now);
  const snow = new Map((hourlySnow ?? []).map(x => [Date.parse(x.start), x.snowIn]));
  const out: DaySeries = { times, snowIn: times.map(t => (snow.has(t) ? snow.get(t)! : null)) };
  if (!h) return out;
  const t0 = Date.parse(h.start);
  const idx = times.map(t => (t - t0) / HOUR);
  const pick = <T,>(a: Array<T | null> | undefined) => a && idx.map(i => (i >= 0 && i < a.length ? a[i] : null));
  for (const k of ["tempF", "windChillF", "windMph", "gustMph", "windFromDeg", "skyPct", "popPct", "snowLevelFt"] as const) {
    const v = pick(h[k]);
    if (v) out[k] = v;
  }
  if (h.precip) out.precip = { snow: pick(h.precip.snow)!, rain: pick(h.precip.rain)!, thunder: pick(h.precip.thunder)!, ice: pick(h.precip.ice)! };
  return out;
}

export interface DayFacts {
  snowIn: number | null;
  /** Ranges over the day's ski hours still ahead, or the rest of the day once they've passed. */
  tempMinF: number | null;
  tempMaxF: number | null;
  windChillMinF: number | null;
  windChillMaxF: number | null;
  windMaxMph: number | null;
  gustMaxMph: number | null;
  /** Range over the whole day. */
  snowLevelMinFt: number | null;
  snowLevelMaxFt: number | null;
  /** False once the day's ski hours have passed. */
  skiHoursAhead: boolean;
}

export function dayFacts(s: DaySeries, snowIn: number | null, timeZone: string): DayFacts {
  const ski = s.times.map((t, i) => (isSkiHour(t, timeZone) ? i : -1)).filter(i => i >= 0);
  const vals = (a: Array<number | null> | undefined, idx: number[]) => idx.map(i => a?.[i]).filter((v): v is number => typeof v === "number");
  const lo = (a: number[]) => (a.length ? Math.min(...a) : null);
  const hi = (a: number[]) => (a.length ? Math.max(...a) : null);
  const all = s.times.map((_, i) => i);
  // Once today's ski hours have passed, describe the rest of the day instead.
  const on = ski.length ? ski : all;
  return {
    snowIn,
    tempMinF: lo(vals(s.tempF, on)), tempMaxF: hi(vals(s.tempF, on)),
    windChillMinF: lo(vals(s.windChillF, on)), windChillMaxF: hi(vals(s.windChillF, on)),
    windMaxMph: hi(vals(s.windMph, on)), gustMaxMph: hi(vals(s.gustMph, on)),
    snowLevelMinFt: lo(vals(s.snowLevelFt, all)), snowLevelMaxFt: hi(vals(s.snowLevelFt, all)),
    skiHoursAhead: ski.length > 0,
  };
}
