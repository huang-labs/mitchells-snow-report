import { cachedDateFormat } from "@/lib/time";
import type { SixHourSnow } from "@/lib/types";
const HOUR = 3600000;
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
export const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short" });
export const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", month: "numeric", day: "numeric" });
export const timeLabel = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "numeric" });
export const zonedTimeLabel = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "numeric", timeZoneName: "short" });
interface SnowfallSlot { start: string; snowIn: number | null }
/** Preserve each UTC-aligned six-hour period; pad missing slots, never amounts. */
export function snowfallDays(bars: SixHourSnow[], timeZone="America/Denver") {
  const date=cachedDateFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"});
  if (!bars.length) return [];
  const sorted = [...bars].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const slots = new Map(sorted.map(b => [Date.parse(b.start), b]));
  const groups = new Map<string, { start: string; slots: SnowfallSlot[] }>();
  const first = Date.parse(sorted[0].start), last = Date.parse(sorted.at(-1)!.start);
  const firstDate = date.format(first), lastDate = date.format(last);
  // Enumerate real UTC slots so local midnight and DST never shift source amounts.
  for (let t = first - 24 * HOUR; t <= last + 24 * HOUR; t += 6 * HOUR) {
    const key = date.format(t);
    if (key < firstDate || key > lastDate) continue;
    const start = new Date(t).toISOString();
    const group = groups.get(key) ?? { start, slots: [] };
    group.slots.push({ start, snowIn: slots.get(t)?.snowIn ?? null });
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, g]) => ({ ...g, key }));
}
