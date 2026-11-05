import { localDate, zonedToUtc } from "../time";
import type { SnowDayKey } from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The snow day containing `t`: [D−1 12:00Z, D 12:00Z) belongs to D. */
export function snowDayOf(t: number, timeZone?: string): SnowDayKey {
  if(timeZone){const key=localDate(new Date(t),timeZone);return t<snowDayEnd(key,timeZone)?key:addDays(key,1);}
  return new Date(t + 12 * HOUR).toISOString().slice(0, 10);
}

/** End of a snow day (12:00 UTC on its key's date), epoch ms. */
export function snowDayEnd(key: SnowDayKey, timeZone?: string): number {
  if(timeZone){const [y,m,d]=key.split("-").map(Number);return zonedToUtc(y,m,d,6,0,0,timeZone).getTime();}
  return Date.parse(`${key}T12:00:00Z`);
}

export function snowDayStart(key: SnowDayKey, timeZone?: string): number {
  return timeZone?snowDayEnd(addDays(key,-1),timeZone):snowDayEnd(key) - DAY;
}

export function addDays(key: SnowDayKey, n: number): SnowDayKey {
  return new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/**
 * Collections in the five hours after a snow day ends (5–10 AM MST, 6–11 AM MDT) read
 * that day's morning report. Returns the day, or null outside the window.
 */
export const MORNING_WINDOW_MS = 5 * HOUR;
export function morningOf(t: number, timeZone?: string): SnowDayKey | null {
  const key = timeZone?localDate(new Date(t),timeZone):new Date(t).toISOString().slice(0, 10);
  const since = t - snowDayEnd(key,timeZone);
  return since >= 0 && since < MORNING_WINDOW_MS ? key : null;
}

/**
 * Sum of an hourly series over a snow day, from `fromMs` when the day is under way:
 * the hour containing `fromMs` counts only its remaining fraction (NWS amounts are
 * spread evenly over their hours). Only a fully covered window is a total: a forecast
 * that ends mid-day, or a missing (null) hour, gives null.
 */
function sumForDay(hours: Array<{ start: string; value: number | null }>, key: SnowDayKey, fromMs: number, timeZone?: string): number | null {
  const from = Math.max(snowDayStart(key,timeZone), fromMs);
  const start = Math.floor(from / HOUR) * HOUR;
  const end = snowDayEnd(key,timeZone);
  if (from >= end) return null;
  let total = 0;
  let count = 0;
  for (const h of hours) {
    const t = Date.parse(h.start);
    if (t < start || t >= end) continue;
    if (h.value === null) return null;
    total += t === start ? h.value * ((start + HOUR - from) / HOUR) : h.value;
    count++;
  }
  return count === (end - start) / HOUR ? total : null;
}

/** NWS 24 h snow total (inches, to 0.1) for a snow day from hourly amounts. */
export function forecastForDay(
  hourly: Array<{ start: string; snowIn: number }>,
  key: SnowDayKey,
  fromMs = -Infinity,
  timeZone?: string,
): number | null {
  const total = sumForDay(hourly.map((h) => ({ start: h.start, value: h.snowIn })), key, fromMs,timeZone);
  return total === null ? null : Math.round(total * 10) / 10;
}

/** NWS 24 h liquid total (inches, to 0.01) for a snow day; `liquid` is index-aligned with `hourly`. */
export function liquidForDay(
  hourly: Array<{ start: string }>,
  liquid: Array<number | null>,
  key: SnowDayKey,
  fromMs = -Infinity,
  timeZone?: string,
): number | null {
  if (liquid.length !== hourly.length) return null;
  const total = sumForDay(hourly.map((h, i) => ({ start: h.start, value: liquid[i] })), key, fromMs,timeZone);
  return total === null ? null : Math.round(total * 100) / 100;
}
