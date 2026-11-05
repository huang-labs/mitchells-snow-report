import { addDays, forecastForDay, snowDayEnd, snowDayOf } from "@/lib/snowlog/days";
import { formatDenver, formatLocal } from "@/lib/time";
import type { MorningReading, SnowLogState } from "@/lib/snowlog/types";
import type { CanyonId, Metric, PointForecast, PrimaryResortId, ResortReport } from "@/lib/types";

/** Days shown on each side of the last 24 hours. */
export const TIMELINE_DAYS = 7;
/** Shared bar scale bounds (inches): small totals don't fill the plot; huge ones clip. */
export const SCALE_MIN_IN = 6;
export const SCALE_MAX_IN = 18;

export type TimelineDayState =
  | "reported" | "not_reported" | "unavailable" | "no_report" | "not_recorded" // past
  | "forecast" | "no_forecast"; // future

export interface TimelineDay {
  key: string;
  kind: "past" | "forecast";
  weekday: string;
  dayOfMonth: string;
  weekend: boolean;
  state: TimelineDayState;
  /** Bar amount; null when there is no bar. */
  amountIn: number | null;
  /** Past days: what NWS forecast for that day when it began. */
  forecastIn: number | null;
  /** Forecast day already under way (only its remaining hours count). */
  partial: boolean;
  /** One-line description for the detail line and screen readers. */
  detail: string;
}

export interface SnowTimelineModel {
  past: TimelineDay[];
  future: TimelineDay[];
  last24: { metric: Metric | null; reportTime: string | null; detail: string };
  canyon: CanyonId;
  /** The resort's IANA zone; report times display in it. */
  timeZone?: string;
}

const tz = "America/Denver";
const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" });
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });

/** A report time within a day's description: the clock time, plus the date when it falls on another day. */
function reportAt(iso: string, key: string, zone=tz): string {
  const t = new Date(iso);
  const ymdFmt=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"});
  const timeFmt=new Intl.DateTimeFormat("en-US",{timeZone:zone,hour:"numeric",minute:"2-digit"});
  const dateFmt=new Intl.DateTimeFormat("en-US",{timeZone:zone,month:"short",day:"numeric"});
  return ymdFmt.format(t) === key ? timeFmt.format(t) : `${dateFmt.format(t)}, ${timeFmt.format(t)}`;
}
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" });

/** Whole inches for bar labels: "<1" keeps a trace distinct from a reported zero. */
export function barLabel(v: number): string {
  if (v === 0) return "0";
  if (v < 1) return "<1";
  return String(Math.round(v));
}

const inches = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}″`;
/** "5 AM" in winter, "6 AM" in summer: the local time a snow day ends. */
const endsAt = (key: string, zone?:string) => new Intl.DateTimeFormat("en-US",{timeZone:zone??tz,hour:"numeric"}).format(snowDayEnd(key,zone)).replace(":00", "");

function dayLabels(key: string, zone?:string) {
  const t = new Date(snowDayEnd(key,zone));
  const weekdayFmt=new Intl.DateTimeFormat("en-US",{timeZone:zone??tz,weekday:"short"});
  const dayFmt=new Intl.DateTimeFormat("en-US",{timeZone:zone??tz,day:"numeric"});
  const dateFmt=new Intl.DateTimeFormat("en-US",{timeZone:zone??tz,weekday:"short",month:"short",day:"numeric"});
  const weekday = weekdayFmt.format(t);
  return { weekday, dayOfMonth: dayFmt.format(t), weekend: weekday === "Sat" || weekday === "Sun", date: dateFmt.format(t) };
}

function pastDay(key: string, name: string, reading: MorningReading | undefined, forecastIn: number | null, zone?:string): TimelineDay {
  const { date, ...labels } = dayLabels(key,zone);
  const ghost = forecastIn === null ? "" : ` · NWS forecast ${inches(forecastIn)}`;
  const base = { key, kind: "past" as const, ...labels, forecastIn, partial: false };
  if (!reading) return { ...base, state: "not_recorded", amountIn: null, detail: `${date} · Not recorded${ghost}` };
  const report = reading.windowEnd ? ` at ${reportAt(reading.windowEnd, key,zone)}` : "";
  switch (reading.state) {
    case "reported":
      return { ...base, state: "reported", amountIn: reading.valueIn!, detail: `${date} · ${inches(reading.valueIn!)} reported by ${name} (“${reading.label}”${report})${ghost}` };
    case "not_reported":
      return { ...base, state: "not_reported", amountIn: null, detail: `${date} · ${name} left its 24 h total empty${ghost}` };
    case "unavailable":
      return { ...base, state: "unavailable", amountIn: null, detail: `${date} · ${name} doesn’t publish a 24 h total${ghost}` };
    default:
      return { ...base, state: "no_report", amountIn: null, detail: `${date} · No new morning report from ${name}${ghost}` };
  }
}

function futureDay(key: string, canyon: CanyonId, hourly: PointForecast["hourlySnow"], now: Date, zone?:string): TimelineDay {
  const { date, ...labels } = dayLabels(key,zone);
  const partial = snowDayOf(now.getTime(),zone) === key;
  const amountIn = hourly ? forecastForDay(hourly, key, partial ? now.getTime() : -Infinity,zone) : null;
  const span = partial ? `now to ${endsAt(key,zone)}` : `24 h to ${endsAt(key,zone)}`;
  const base = { key, kind: "forecast" as const, ...labels, forecastIn: null, partial };
  return amountIn === null
    ? { ...base, state: "no_forecast", amountIn: null, detail: `${date} · No NWS forecast for this day` }
    : { ...base, state: "forecast", amountIn, detail: `${date} · ${inches(amountIn)} NWS forecast, ${span} (${canyon} grid point)` };
}

/**
 * One resort's timeline: the 7 snow days before the current one (each resort's morning
 * report), its latest 24 h figure, then 7 days of NWS forecast starting with the current
 * snow day's remaining hours. A day is labeled by the morning it ends.
 */
export function buildSnowTimeline(input: {
  resort: PrimaryResortId;
  name: string;
  canyon: CanyonId;
  report: ResortReport | null;
  log: SnowLogState | null | undefined;
  forecast: PointForecast | null;
  now: Date;
  timeZone?: string;
}): SnowTimelineModel {
  const { resort, name, canyon, report, log, forecast, now, timeZone } = input;
  const current = snowDayOf(now.getTime(),timeZone);
  const readings = log?.resorts[resort] ?? {};
  const ghosts = log?.forecasts[canyon] ?? {};
  const past = Array.from({ length: TIMELINE_DAYS }, (_, i) => {
    const key = addDays(current, i - TIMELINE_DAYS);
    return pastDay(key, name, readings[key], ghosts[key]?.snowIn ?? null,timeZone);
  });
  const future = Array.from({ length: TIMELINE_DAYS }, (_, i) => futureDay(addDays(current, i), canyon, forecast?.hourlySnow, now,timeZone));
  const metric = report?.snowfall.h24 ?? null;
  // The date matters here: an old report would otherwise read like today's.
  const at = report?.reportTime ? `, report ${formatLocal(report.reportTime, now,timeZone)}` : "";
  const detail = !metric
    ? `Last 24 h · No report from ${name}`
    : metric.state === "reported"
      ? `Last 24 h · ${inches(metric.value)} reported by ${name} (“${metric.label}”${at})`
      : metric.state === "not_reported"
        ? `Last 24 h · ${name} left its 24 h total empty${at}`
        : `Last 24 h · ${name} doesn’t publish a 24 h total`;
  return { past, future, last24: { metric, reportTime: report?.reportTime ?? null, detail }, canyon, timeZone };
}

/** One scale for timelines shown together, so equal amounts draw equal bars. */
export function timelineScale(models: SnowTimelineModel[]): number {
  const amounts = models.flatMap((m) => [
    ...[...m.past, ...m.future].flatMap((d) => [d.amountIn ?? 0, d.forecastIn ?? 0]),
    m.last24.metric?.state === "reported" ? m.last24.metric.value : 0,
  ]);
  return Math.min(SCALE_MAX_IN, Math.max(SCALE_MIN_IN, ...amounts));
}
