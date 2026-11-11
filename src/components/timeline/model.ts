import { snowfallIssues, usableSnowReport } from "@/lib/snowfall-quality";
import { addDays, forecastForDay, snowDayWindow, snowDayOf } from "@/lib/snowlog/days";
import { cachedDateFormat, formatLocal } from "@/lib/time";
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

/**
 * A week's total, shown beside its span label: the past 7 days' reported snow or the
 * next 7 days' NWS forecast. Null when no day in the span has an amount.
 */
export interface SpanTotal {
  amountIn: number;
  /** Days with an amount; the label says so when it is fewer than 7. */
  days: number;
  /** Span label: "Past 7 days", "Next 6 days". */
  label: string;
  /** Hover text naming what the total covers. */
  title: string;
  /** Screen-reader description. */
  detail: string;
}

export interface SnowTimelineModel {
  past: TimelineDay[];
  future: TimelineDay[];
  pastTotal: SpanTotal | null;
  nextTotal: SpanTotal | null;
  last24: { metric: Metric | null; reportTime: string | null; detail: string; warning?: string };
  canyon: CanyonId;
  /** The resort's IANA zone; report times display in it. */
  timeZone: string;
}

/** A report time within a day's description: the clock time, plus the date when it falls on another day. */
function reportAt(iso: string, key: string, zone: string): string {
  const t = new Date(iso);
  const time = cachedDateFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(t);
  const ymd = cachedDateFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  return ymd === key ? time : `${cachedDateFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(t)}, ${time}`;
}

/** Whole inches for bar labels: "<1" keeps a trace distinct from a reported zero. */
export function barLabel(v: number): string {
  if (v === 0) return "0";
  if (v < 1) return "<1";
  return String(Math.round(v));
}

const inches = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}″`;
/** The destination-local 6 AM boundary, independent of daylight saving time. */
const boundaryAt = (instant: number, zone: string) =>
  cachedDateFormat("en-US", { timeZone: zone, hour: "numeric" }).format(instant).replace(":00", "");

function dayLabels(end: number, zone:string) {
  const t = new Date(end);
  const timeZone = zone;
  const weekday = cachedDateFormat("en-US", { timeZone, weekday: "short" }).format(t);
  return {
    weekday,
    dayOfMonth: cachedDateFormat("en-US", { timeZone, day: "numeric" }).format(t),
    weekend: weekday === "Sat" || weekday === "Sun",
    date: cachedDateFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(t),
  };
}

function pastDay(key: string, name: string, reading: MorningReading | undefined, forecastIn: number | null, zone:string): TimelineDay {
  const { date, ...labels } = dayLabels(snowDayWindow(key, zone).end,zone);
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
      return { ...base, state: "unavailable", amountIn: null, detail: `${date} · ${reading.qualityNote ? reading.qualityNote : `${name} doesn’t publish a 24 h total`}${ghost}` };
    default:
      return { ...base, state: "no_report", amountIn: null, detail: `${date} · No new morning report from ${name}${ghost}` };
  }
}

function futureDay(key: string, canyon: CanyonId, hourly: PointForecast["hourlySnow"], now: Date, zone:string): TimelineDay {
  const window = snowDayWindow(key, zone);
  const { date, ...labels } = dayLabels(window.end,zone);
  const partial = now.getTime() >= window.start && now.getTime() < window.end;
  const amountIn = hourly ? forecastForDay(hourly, window, partial ? now.getTime() : -Infinity) : null;
  const span = partial
    ? `now to ${boundaryAt(window.end,zone)}`
    : `${boundaryAt(window.start,zone)} to ${boundaryAt(window.end,zone)} local time`;
  const base = { key, kind: "forecast" as const, ...labels, forecastIn: null, partial };
  return amountIn === null
    ? { ...base, state: "no_forecast", amountIn: null, detail: `${date} · No NWS forecast for this day` }
    : { ...base, state: "forecast", amountIn, detail: `${date} · ${inches(amountIn)} NWS forecast, ${span} (${canyon} grid point)` };
}

const sum = (days: TimelineDay[]) => Math.round(days.reduce((total, d) => total + d.amountIn!, 0) * 10) / 10;
const dayCount = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * Sum of the past days the resort reported. Days without a report are left out (never
 * counted as zero); the label stays "Past 7 days" for a quick read, while the hover
 * text and screen-reader description say how many days the total covers. The NWS
 * outlines are not included.
 */
export function pastTotal(past: TimelineDay[], name: string): SpanTotal | null {
  const days = past.filter((d) => d.state === "reported" && d.amountIn !== null);
  if (!days.length) return null;
  const amountIn = sum(days);
  const full = days.length === past.length;
  const covers = full ? "" : ` on ${days.length} of ${past.length} days`;
  return {
    amountIn,
    days: days.length,
    label: `Past ${dayCount(past.length)}`,
    title: full ? `Reported total, past ${past.length} days` : `Reported total${covers}; the other days have no report`,
    detail: `Past ${past.length} days · ${inches(amountIn)} reported by ${name}${covers}`,
  };
}

/**
 * Sum of the forecast days that have an NWS total, counting only the current day's
 * remaining hours. NWS often ends partway through the 7th day; that day is left out
 * and the label counts the days covered ("Next 6 days").
 */
export function forecastTotal(future: TimelineDay[], canyon: CanyonId, zone: string): SpanTotal | null {
  const days = future.filter((d) => d.state === "forecast" && d.amountIn !== null);
  if (!days.length) return null;
  const amountIn = sum(days);
  const through = dayLabels(snowDayWindow(days.at(-1)!.key, zone).end, zone).date;
  return {
    amountIn,
    days: days.length,
    label: `Next ${dayCount(days.length)}`,
    title: `NWS forecast total through 6 AM ${through}`,
    detail: `Next ${dayCount(days.length)} · ${inches(amountIn)} NWS forecast total, now to 6 AM ${through} (${canyon} grid point)`,
  };
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
  timeZone: string;
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
  const totals = { pastTotal: pastTotal(past, name), nextTotal: forecastTotal(future, canyon, timeZone) };
  const metric = usableSnowReport(report)?.snowfall.h24 ?? null;
  // The date matters here: an old report would otherwise read like today's.
  const at = report?.reportTime ? `, report ${formatLocal(report.reportTime, now,timeZone)}` : "";
  const detail = !metric
    ? `Last 24 h · No report from ${name}`
    : metric.state === "reported"
      ? `Last 24 h · ${inches(metric.value)} reported by ${name} (“${metric.label}”${at})`
      : metric.state === "not_reported"
        ? `Last 24 h · ${name} left its 24 h total empty${at}`
        : `Last 24 h · ${metric.note?.startsWith("Withheld:") ? metric.note : `${name} doesn’t publish a 24 h total`}`;
  return { past, future, ...totals, last24: { metric, reportTime: report?.reportTime ?? null, detail, ...(report && snowfallIssues(report.snowfall).length ? { warning: "Resort snowfall data warning: affected totals are withheld. See the resort report for published figures." } : {}) }, canyon, timeZone };
}

/** One scale for timelines shown together, so equal amounts draw equal bars. */
export function timelineScale(models: SnowTimelineModel[]): number {
  const amounts = models.flatMap((m) => [
    ...[...m.past, ...m.future].flatMap((d) => [d.amountIn ?? 0, d.forecastIn ?? 0]),
    m.last24.metric?.state === "reported" ? m.last24.metric.value : 0,
  ]);
  return Math.min(SCALE_MAX_IN, Math.max(SCALE_MIN_IN, ...amounts));
}
