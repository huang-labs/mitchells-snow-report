import { zonedParts } from "./time";

/**
 * Hour-by-hour NWS gridpoint forecast for planning a ski day: temperature, wind
 * chill, wind, sky cover, chance of precipitation and precipitation type, like the
 * first four panels of the weather.gov hourly graph.
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
  /** NWS weather coverage per hour; absent when the grid publishes no weather series. */
  precip?: Record<PrecipKind, Array<PrecipCoverage | null>>;
}

export type PrecipKind = "snow" | "rain" | "thunder" | "ice";
/** NWS coverage words in four steps; "none" is a reported hour with no such weather. */
export type PrecipCoverage = "none" | "slight" | "chance" | "likely" | "definite";

export const PRECIP_KINDS: ReadonlyArray<{ kind: PrecipKind; label: string }> = [
  { kind: "snow", label: "Snow" },
  { kind: "rain", label: "Rain" },
  { kind: "thunder", label: "Thunder" },
  { kind: "ice", label: "Freezing" },
];

export const COVERAGE_LABEL: Record<Exclude<PrecipCoverage, "none">, string> = {
  slight: "slight chance",
  chance: "chance",
  likely: "likely",
  definite: "definite",
};

export const COVERAGE_RANK: Record<PrecipCoverage, number> = { none: 0, slight: 1, chance: 2, likely: 3, definite: 4 };

/** NWS `weather[].coverage` values, folded to four steps (probability terms and their areal equivalents). */
const COVERAGE: Record<string, Exclude<PrecipCoverage, "none">> = {
  slight_chance: "slight", isolated: "slight", patchy: "slight", brief: "slight",
  chance: "chance", scattered: "chance", areas: "chance", intermittent: "chance",
  likely: "likely", numerous: "likely", occasional: "likely", periods: "likely",
  definite: "definite", widespread: "definite", frequent: "definite",
};

/** NWS `weather[].weather` values for each row. Fog, haze, smoke and blowing snow aren't precipitation. */
const KIND: Record<string, PrecipKind> = {
  snow: "snow", snow_showers: "snow",
  rain: "rain", rain_showers: "rain", drizzle: "rain",
  thunderstorms: "thunder",
  freezing_rain: "ice", freezing_drizzle: "ice", sleet: "ice", ice_pellets: "ice",
};

export interface GridWeatherEntry { coverage: string | null; weather: string | null }

/** Coverage per kind for one hour's NWS weather entries; every kind is "none" unless an entry names it. */
export function precipForHour(entries: GridWeatherEntry[]): Record<PrecipKind, PrecipCoverage> {
  const out: Record<PrecipKind, PrecipCoverage> = { snow: "none", rain: "none", thunder: "none", ice: "none" };
  for (const e of entries) {
    const kind = e.weather ? KIND[e.weather] : undefined;
    // A named type without a coverage word is still forecast; treat it as the weakest step.
    const cov = e.coverage ? COVERAGE[e.coverage] ?? "slight" : "slight";
    if (kind && COVERAGE_RANK[cov] > COVERAGE_RANK[out[kind]]) out[kind] = cov;
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
  weather: Map<number, GridWeatherEntry[]>;
}

export const HOURLY_HOURS = 48;

/** The next {@link HOURLY_HOURS} hours from the current hour, rounded for display. Empty maps are left out. */
export function buildHourlyWeather(maps: Partial<HourlyMaps>, now: Date, hours = HOURLY_HOURS): HourlyWeather | null {
  const HOUR = 3_600_000;
  const t0 = Math.floor(now.getTime() / HOUR) * HOUR;
  const times = Array.from({ length: hours }, (_, i) => t0 + i * HOUR);
  const series = (m: Map<number, number> | undefined) =>
    m && m.size ? times.map(t => (m.has(t) ? Math.round(m.get(t)!) : null)) : undefined;
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
  };
  if (maps.weather?.size) {
    const precip: Record<PrecipKind, Array<PrecipCoverage | null>> = { snow: [], rain: [], thunder: [], ice: [] };
    for (const t of times) {
      const entries = maps.weather.get(t);
      const hour = entries ? precipForHour(entries) : null;
      for (const { kind } of PRECIP_KINDS) precip[kind].push(hour ? hour[kind] : null);
    }
    out.precip = precip;
  }
  for (const k of Object.keys(out) as Array<keyof HourlyWeather>) if (out[k] === undefined) delete out[k];
  const anyValue = ["tempF", "windChillF", "windMph", "gustMph", "skyPct", "popPct"].some(k => (out[k as "tempF"] ?? []).some(v => v !== null));
  return anyValue || out.precip ? out : null;
}

/** Local hours shaded and summarized as ski hours: 9 AM up to 4 PM. */
export const SKI_HOURS = { from: 9, to: 16 } as const;

export const isSkiHour = (iso: string | number, timeZone: string) => {
  const h = zonedParts(new Date(iso), timeZone).hour;
  return h >= SKI_HOURS.from && h < SKI_HOURS.to;
};

/** `hourly` from the current hour on, so a snapshot collected earlier never shows past hours. */
export function hourlyFromNow(h: HourlyWeather, now: Date): HourlyWeather {
  const skip = Math.max(0, Math.floor((now.getTime() - Date.parse(h.start)) / 3_600_000));
  if (!skip) return h;
  const cut = <T,>(a: T[] | undefined) => a?.slice(skip);
  return {
    ...h,
    start: new Date(Date.parse(h.start) + skip * 3_600_000).toISOString(),
    hours: Math.max(0, h.hours - skip),
    tempF: cut(h.tempF), windChillF: cut(h.windChillF), windMph: cut(h.windMph), gustMph: cut(h.gustMph),
    windFromDeg: cut(h.windFromDeg), skyPct: cut(h.skyPct), popPct: cut(h.popPct),
    precip: h.precip && {
      snow: h.precip.snow.slice(skip), rain: h.precip.rain.slice(skip),
      thunder: h.precip.thunder.slice(skip), ice: h.precip.ice.slice(skip),
    },
  };
}

export interface SkiDaySummary {
  /** "Today", "Tomorrow" or a weekday. */
  day: string;
  tempMinF: number | null;
  tempMaxF: number | null;
  windChillMinF: number | null;
  windChillMaxF: number | null;
  windMaxMph: number | null;
  gustMaxMph: number | null;
}

/**
 * Ranges over the next ski-hours window that hasn't ended: the rest of today's
 * when it's before 4 PM local, otherwise tomorrow's. Null when no hour of it is in range.
 */
export function skiDaySummary(h: HourlyWeather, now: Date, timeZone: string): SkiDaySummary | null {
  const HOUR = 3_600_000;
  const today = zonedParts(now, timeZone);
  const idx: number[] = [];
  let dayKey: string | null = null;
  for (let i = 0; i < h.hours; i++) {
    const t = Date.parse(h.start) + i * HOUR;
    if (t + HOUR <= now.getTime() || !isSkiHour(t, timeZone)) continue;
    const p = zonedParts(new Date(t), timeZone);
    const key = `${p.year}-${p.month}-${p.day}`;
    dayKey ??= key;
    if (key !== dayKey) break;
    idx.push(i);
  }
  if (!idx.length) return null;
  const first = new Date(Date.parse(h.start) + idx[0] * HOUR);
  const p = zonedParts(first, timeZone);
  const tomorrow = zonedParts(new Date(now.getTime() + 24 * HOUR), timeZone);
  const day = p.day === today.day && p.month === today.month ? "Today"
    : p.day === tomorrow.day && p.month === tomorrow.month ? "Tomorrow"
    : new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(first);
  const pick = (a: Array<number | null> | undefined) => idx.map(i => a?.[i]).filter((v): v is number => typeof v === "number");
  const lo = (a: number[]) => (a.length ? Math.min(...a) : null);
  const hi = (a: number[]) => (a.length ? Math.max(...a) : null);
  const temp = pick(h.tempF), chill = pick(h.windChillF);
  return {
    day,
    tempMinF: lo(temp), tempMaxF: hi(temp),
    windChillMinF: lo(chill), windChillMaxF: hi(chill),
    windMaxMph: hi(pick(h.windMph)), gustMaxMph: hi(pick(h.gustMph)),
  };
}
