import { RESORTS, FORECAST_AREAS, resortTimeZone, regionById, resortById } from "../catalog";
import type { CanyonId, Metric, NwsPayload, PrimaryResortId, ResortReport, Snapshot } from "../types";
import { addDays, forecastForDay, liquidForDay, morningOf, snowDayOf, snowDayWindow } from "./days";
import type { DayAheadForecast, MorningReading, SnowDayKey, SnowLogState } from "./types";

export const SNOW_LOG_RESORTS: PrimaryResortId[] = RESORTS.map(r=>r.id);
export const RESORT_CANYON = Object.fromEntries(RESORTS.map(r=>[r.id,r.canyon])) as Record<PrimaryResortId,CanyonId>;

/** Days kept, counting back from the current snow day. The homepage shows 7. */
export const SNOW_LOG_RETENTION_DAYS = 14;

/**
 * A morning's 24 h figure must end after ~8–9 PM the evening before (9 h before the
 * snow day ends). An older window is yesterday's report, and recording it again would
 * count the same snow twice. Alta and Brighton publish around 1 AM; Solitude near 7 AM.
 * Snowbird is no exception: its 24 h is recomputed at fetch time, but only from the
 * reports it has published, so with no new report it reads 0 even after snow. Its
 * publication time is what shows whether the morning's figure is real.
 */
const MAX_WINDOW_LEAD_MS = 9 * 3_600_000;

/** Morning reports win over "no fresh report"; otherwise the later collection wins (corrections). */
export function preferReading(a: MorningReading | undefined, b: MorningReading | undefined): MorningReading | undefined {
  if (!a) return b;
  if (!b) return a;
  const rank = (r: MorningReading) => (r.state === "no_report" ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b;
  return Date.parse(b.collectedAt) >= Date.parse(a.collectedAt) ? b : a;
}

/** Of two forecasts for one day, the later collection is closer to the day's start. */
export function preferForecast(a: DayAheadForecast | undefined, b: DayAheadForecast | undefined): DayAheadForecast | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.collectedAt) >= Date.parse(a.collectedAt) ? b : a;
}

function reading(id: PrimaryResortId, report: ResortReport, collectedAt: string, day: SnowDayKey): MorningReading {
  const m: Metric = report.snowfall.h24;
  const def=resortById(id)!;
  const reportingLocation={...(report.reportingLocation??{name:def.station,elevationFt:def.elevationFt})};
  const windowEnd = report.reportTime;
  const window = snowDayWindow(day, resortTimeZone(id));
  const fresh = windowEnd !== null && Date.parse(windowEnd) <= Date.parse(collectedAt)+120000 && Date.parse(windowEnd) >= window.end - MAX_WINDOW_LEAD_MS;
  if (!fresh) return { state: "no_report", label: m.label, windowEnd, collectedAt, reportingLocation };
  if (m.state === "reported") return { state: "reported", valueIn: m.value, label: m.label, windowEnd, collectedAt, reportingLocation };
  return { state: m.state, label: m.label, windowEnd, collectedAt, reportingLocation };
}

function canyonOf(name: string): CanyonId | null {
  return /\(LCC\)/.test(name) ? "LCC" : /\(BCC\)/.test(name) ? "BCC" : null;
}

function prune<T>(days: Record<SnowDayKey, T> | undefined, oldest: SnowDayKey): Record<SnowDayKey, T> {
  return Object.fromEntries(Object.entries(days ?? {}).filter(([k]) => k >= oldest));
}

function oldestDay(now: Date, timeZone: string): SnowDayKey {
  return addDays(snowDayOf(now.getTime(), timeZone), -SNOW_LOG_RETENTION_DAYS);
}

/**
 * Advance the log from this run's snapshot. Resorts collected during a morning window
 * record that morning's 24 h figure; every NWS collection records its whole-day snow
 * and liquid totals for days that haven't begun yet, so the last one before a day
 * starts is what stays.
 * Pure: the caller stores the result in the snapshot.
 */
export function recordSnowLog(previous: SnowLogState | undefined, snapshot: Snapshot, now: Date): SnowLogState {
  const log: SnowLogState = { resorts: {}, forecasts: {} };
  for (const id of SNOW_LOG_RESORTS) {
    const days = prune(previous?.resorts[id], oldestDay(now, resortTimeZone(id)));
    const rec = snapshot.sources[id];
    const report = rec?.payload as ResortReport | null | undefined;
    const collectedAt = rec?.lastSuccessfulFetchAt;
    const day = collectedAt ? morningOf(Date.parse(collectedAt),resortTimeZone(id)) : null;
    if (report && collectedAt && day) days[day] = preferReading(days[day], reading(id, report, collectedAt, day))!;
    if (Object.keys(days).length) log.resorts[id] = days;
  }
  const nws = snapshot.sources.nws;
  const payload = nws?.payload as NwsPayload | null | undefined;
  const collectedAt = nws?.lastSuccessfulFetchAt;
  for (const area of FORECAST_AREAS) {
    const canyon=area.id; const zone=regionById(area.region)!.timeZone;
    const days = prune(previous?.forecasts[canyon], oldestDay(now, zone));
    const point = payload?.points.find((p) => (p.id??canyonOf(p.name)) === canyon);
    if (point?.hourlySnow && collectedAt && !point.lastError) {
      const t = Date.parse(collectedAt);
      // Days that haven't started at collection time: whole-day forecasts only.
      for (let key = addDays(snowDayOf(t,zone), 1); ; key = addDays(key, 1)) {
        const window = snowDayWindow(key, zone);
        if (window.start - t >= 8 * 86_400_000) break;
        const snowIn = forecastForDay(point.hourlySnow, window);
        // An incomplete day (a missing hour, or the forecast's end) is skipped; later
        // complete days are still recorded.
        if (snowIn === null) continue;
        const liquidIn = point.hourlyLiquidIn ? liquidForDay(point.hourlySnow, point.hourlyLiquidIn, window) : null;
        days[key] = preferForecast(days[key], { snowIn, ...(liquidIn === null ? {} : { liquidIn }), issuedAt: point.gridUpdatedAt, collectedAt })!;
      }
    }
    if (Object.keys(days).length) log.forecasts[canyon] = days;
  }
  return log;
}

/**
 * Merge two runs' logs (see store.ts): each day keeps its preferred entry, and days
 * past retention at `now` are dropped. The stored log still holds days a run has just
 * pruned, so retention must apply here too or the union would restore them.
 */
export function mergeSnowLog(a: SnowLogState | undefined, b: SnowLogState | undefined, now: Date): SnowLogState | undefined {
  if (!a && !b) return undefined;
  const out: SnowLogState = { resorts: {}, forecasts: {} };
  for (const id of new Set([...Object.keys(a?.resorts ?? {}), ...Object.keys(b?.resorts ?? {})]) as Set<PrimaryResortId>) {
    const oldest = oldestDay(now, resortTimeZone(id));
    const days = prune(a?.resorts[id], oldest);
    for (const [k, v] of Object.entries(prune(b?.resorts[id], oldest))) days[k] = preferReading(days[k], v)!;
    if (Object.keys(days).length) out.resorts[id] = days;
  }
  for (const c of new Set([...Object.keys(a?.forecasts ?? {}), ...Object.keys(b?.forecasts ?? {})]) as Set<CanyonId>) {
    const area = FORECAST_AREAS.find((area) => area.id === c)!;
    const oldest = oldestDay(now, regionById(area.region)!.timeZone);
    const days = prune(a?.forecasts[c], oldest);
    for (const [k, v] of Object.entries(prune(b?.forecasts[c], oldest))) days[k] = preferForecast(days[k], v)!;
    if (Object.keys(days).length) out.forecasts[c] = days;
  }
  return out;
}
