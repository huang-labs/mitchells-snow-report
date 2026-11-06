import { localDate, zonedToUtc } from "../time";
import type { SnowDayKey } from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A snow day runs from the previous morning's 6 AM to its key's 6 AM, locally. */
export function snowDayOf(t: number, timeZone: string): SnowDayKey {
  const key = localDate(new Date(t), timeZone);
  return t < snowDayEnd(key, timeZone) ? key : addDays(key, 1);
}

/** End of a snow day at 6 AM in the destination zone, epoch ms. */
export function snowDayEnd(key: SnowDayKey, timeZone: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return zonedToUtc(year, month, day, 6, 0, 0, timeZone).getTime();
}

export function snowDayStart(key: SnowDayKey, timeZone: string): number {
  return snowDayEnd(addDays(key, -1), timeZone);
}

export function addDays(key: SnowDayKey, n: number): SnowDayKey {
  return new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/**
 * Collections from 6 AM until 11 AM in the destination zone read
 * that day's morning report. Returns the day, or null outside the window.
 */
export const MORNING_WINDOW_MS = 5 * HOUR;
export function morningOf(t: number, timeZone: string): SnowDayKey | null {
  const key = localDate(new Date(t), timeZone);
  const since = t - snowDayEnd(key,timeZone);
  return since >= 0 && since < MORNING_WINDOW_MS ? key : null;
}

/**
 * Sum of an hourly series over a snow day, from `fromMs` when the day is under way:
 * the hour containing `fromMs` counts only its remaining fraction (NWS amounts are
 * spread evenly over their hours). Only a fully covered window is a total: a forecast
 * that ends mid-day, or a missing (null) hour, gives null.
 */
function sumForDay(hours: Array<{ start: string; value: number | null }>, key: SnowDayKey, fromMs: number, timeZone: string): number | null {
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

/** NWS snow-day total (inches, to 0.1) from hourly amounts, including DST days. */
export function forecastForDay(
  hourly: Array<{ start: string; snowIn: number }>,
  key: SnowDayKey,
  fromMs: number,
  timeZone: string,
): number | null {
  const total = sumForDay(hourly.map((h) => ({ start: h.start, value: h.snowIn })), key, fromMs,timeZone);
  return total === null ? null : Math.round(total * 10) / 10;
}

/** NWS snow-day liquid total (inches, to 0.01); `liquid` is index-aligned with `hourly`. */
export function liquidForDay(
  hourly: Array<{ start: string }>,
  liquid: Array<number | null>,
  key: SnowDayKey,
  fromMs: number,
  timeZone: string,
): number | null {
  if (liquid.length !== hourly.length) return null;
  const total = sumForDay(hourly.map((h, i) => ({ start: h.start, value: liquid[i] })), key, fromMs,timeZone);
  return total === null ? null : Math.round(total * 100) / 100;
}
