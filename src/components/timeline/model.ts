import { snowfallIssues, usableSnowReport } from "@/lib/snowfall-quality";
import { addDays, forecastForDay, morningOf, snowDayWindow, snowDayOf } from "@/lib/snowlog/days";
import { consecutive, newSnow, type NewSnow } from "@/lib/snowlog/overlap";
import { cachedDateFormat, formatLocal } from "@/lib/time";
import type { MorningReading, SnowDayKey, SnowLogState } from "@/lib/snowlog/types";
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
  /** Snow-log key: the morning the day ends. Labels name the day it starts (`weekday`, `dayOfMonth`). */
  key: string;
  kind: "past" | "forecast";
  weekday: string;
  dayOfMonth: string;
  weekend: boolean;
  state: TimelineDayState;
  /** Bar amount; null when there is no bar. */
  amountIn: number | null;
  /** Forecast day already under way (only its remaining hours count); the strip marks it as now. */
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

/** A report time within a day's description: the clock time, plus the date when it falls on another day than `ymd`. */
function reportAt(iso: string, day: string, zone: string): string {
  const t = new Date(iso);
  const time = cachedDateFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(t);
  const ymd = cachedDateFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  return ymd === day ? time : `${cachedDateFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(t)}, ${time}`;
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

/** Labels for a snow day, named for the day it starts: the day its snow falls. */
function dayLabels(start: number, zone:string) {
  const t = new Date(start);
  const timeZone = zone;
  const weekday = cachedDateFormat("en-US", { timeZone, weekday: "short" }).format(t);
  return {
    weekday,
    dayOfMonth: cachedDateFormat("en-US", { timeZone, day: "numeric" }).format(t),
    weekend: weekday === "Sat" || weekday === "Sun",
    date: cachedDateFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(t),
  };
}

/** How a published 24 h total that repeats earlier snow reads: "1″ new; Brighton’s 24 h total of 5″ repeats 4″ …". */
function repeatNote(net: NewSnow, name: string): string {
  return net.kind === "new"
    ? `${inches(net.valueIn)} new; ${name}’s 24 h total of ${inches(net.publishedIn)} repeats ${inches(net.repeatedIn)} from the previous morning’s report`
    : `${name}’s 24 h total (${inches(net.publishedIn)}) and 48 h total (${inches(net.h48In)}) conflict with the previous morning’s ${inches(net.previousIn)}`;
}

function pastDay(key: string, name: string, reading: MorningReading | undefined, net: NewSnow | undefined, awaiting: boolean, zone:string): TimelineDay {
  const start = snowDayWindow(key, zone).start;
  const { date, ...labels } = dayLabels(start,zone);
  const base = { key, kind: "past" as const, ...labels, partial: false };
  // The morning this day ends has begun, but its report hasn't been collected yet.
  if (!reading && awaiting) return { ...base, state: "no_report", amountIn: null, detail: `${date} · Awaiting this morning’s report from ${name}` };
  if (!reading) return { ...base, state: "not_recorded", amountIn: null, detail: `${date} · Not recorded` };
  const report = reading.windowEnd ? ` at ${reportAt(reading.windowEnd, cachedDateFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(start),zone)}` : "";
  switch (reading.state) {
    case "reported":
      if (net?.kind === "conflict") return { ...base, state: "unavailable", amountIn: null, detail: `${date} · ${repeatNote(net, name)} (“${reading.label}”${report})` };
      if (net?.repeatedIn) return { ...base, state: "reported", amountIn: net.valueIn, detail: `${date} · ${repeatNote(net, name)} (“${reading.label}”${report})` };
      return { ...base, state: "reported", amountIn: reading.valueIn!, detail: `${date} · ${inches(reading.valueIn!)} reported by ${name} (“${reading.label}”${report})` };
    case "not_reported":
      return { ...base, state: "not_reported", amountIn: null, detail: `${date} · ${name} left its 24 h total empty` };
    case "unavailable":
      return { ...base, state: "unavailable", amountIn: null, detail: `${date} · ${reading.qualityNote ? reading.qualityNote : `${name} doesn’t publish a 24 h total`}` };
    default:
      return { ...base, state: "no_report", amountIn: null, detail: `${date} · No new morning report from ${name}` };
  }
}

function futureDay(key: string, canyon: CanyonId, hourly: PointForecast["hourlySnow"], now: Date, zone:string): TimelineDay {
  const window = snowDayWindow(key, zone);
  const { date, ...labels } = dayLabels(window.start,zone);
  const partial = now.getTime() >= window.start && now.getTime() < window.end;
  const amountIn = hourly ? forecastForDay(hourly, window, partial ? now.getTime() : -Infinity) : null;
  const span = partial
    ? `now to ${boundaryAt(window.end,zone)}`
    : `${boundaryAt(window.start,zone)} to ${boundaryAt(window.end,zone)} local time`;
  const base = { key, kind: "forecast" as const, ...labels, partial };
  return amountIn === null
    ? { ...base, state: "no_forecast", amountIn: null, detail: `${date} · No NWS forecast for this day` }
    : { ...base, state: "forecast", amountIn, detail: `${date} · ${inches(amountIn)} NWS forecast, ${span} (${canyon} grid point)` };
}

const sum = (days: TimelineDay[]) => Math.round(days.reduce((total, d) => total + d.amountIn!, 0) * 10) / 10;
const dayCount = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * Sum of the past days the resort reported. Days without a report are left out (never
 * counted as zero); the label stays "Past 7 days" for a quick read, while the hover
 * text and screen-reader description say how many days the total covers.
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
  // The window's end: "6 AM Sat" for the day named Friday.
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
 * Each reported morning's new snow, oldest first, so a morning that repeated earlier snow
 * is compared with the previous morning's net figure. A reading recorded before 48 h
 * totals were kept takes its 48 h from the live report when that is the same report.
 */
function netSnow(readings: Record<SnowDayKey, MorningReading>, report: ResortReport | null): Map<SnowDayKey, NewSnow> {
  const live48 = usableSnowReport(report)?.snowfall.h48;
  const net = new Map<SnowDayKey, NewSnow>();
  let previous: { valueIn: number; windowEnd: string | null } | null = null;
  for (const key of Object.keys(readings).sort()) {
    const r = readings[key];
    if (r.state !== "reported" || r.valueIn === undefined) continue;
    const h48In = r.h48In ?? (live48?.state === "reported" && r.windowEnd !== null && r.windowEnd === report?.reportTime ? live48.value : undefined);
    const n = newSnow({ valueIn: r.valueIn, h48In, windowEnd: r.windowEnd }, previous);
    net.set(key, n);
    // A conflicting morning can't bound the next one.
    previous = n.kind === "new" ? { valueIn: n.valueIn, windowEnd: r.windowEnd } : null;
  }
  return net;
}

/** The live report's 24 h figure, net of snow the morning reading before it already counted. */
function last24Net(metric: Metric | null, report: ResortReport | null, readings: Record<SnowDayKey, MorningReading>, net: Map<SnowDayKey, NewSnow>): NewSnow | null {
  if (metric?.state !== "reported" || !report?.reportTime) return null;
  const h48 = usableSnowReport(report)?.snowfall.h48;
  const before = Object.keys(readings).sort().reverse().find((k) => consecutive(report.reportTime, readings[k].windowEnd));
  const prior = before ? net.get(before) : undefined;
  const previous = prior?.kind === "new" ? { valueIn: prior.valueIn, windowEnd: readings[before!].windowEnd } : null;
  return newSnow({ valueIn: metric.value, h48In: h48?.state === "reported" ? h48.value : undefined, windowEnd: report.reportTime }, previous);
}

/**
 * One resort's timeline: the 7 snow days before the current one (each resort's morning
 * report), its latest 24 h figure, then 7 days of NWS forecast starting with the current
 * snow day's remaining hours. Each 6 AM-to-6 AM day is named for the day it starts, the
 * day its snow falls; the log keys it by the morning it ends, when resorts report it.
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
  const net = netSnow(readings, report);
  const past = Array.from({ length: TIMELINE_DAYS }, (_, i) => {
    const key = addDays(current, i - TIMELINE_DAYS);
    return pastDay(key, name, readings[key], net.get(key), morningOf(now.getTime(), timeZone) === key, timeZone);
  });
  const future = Array.from({ length: TIMELINE_DAYS }, (_, i) => futureDay(addDays(current, i), canyon, forecast?.hourlySnow, now,timeZone));
  const totals = { pastTotal: pastTotal(past, name), nextTotal: forecastTotal(future, canyon, timeZone) };
  const published = usableSnowReport(report)?.snowfall.h24 ?? null;
  const repeat = last24Net(published, report, readings, net);
  // Snow the previous morning already counted isn't new: show what is, or withhold a conflict.
  const metric: Metric | null = published?.state === "reported" && repeat?.kind === "conflict"
    ? { state: "unavailable", label: published.label, note: `Withheld: ${repeatNote(repeat, name)}` }
    : published?.state === "reported" && repeat?.kind === "new" && repeat.repeatedIn ? { ...published, value: repeat.valueIn } : published;
  // The date matters here: an old report would otherwise read like today's.
  const at = report?.reportTime ? `, report ${formatLocal(report.reportTime, now,timeZone)}` : "";
  const detail = !metric
    ? `Last 24 h · No report from ${name}`
    : repeat && (repeat.kind === "conflict" || repeat.repeatedIn)
      ? `Last 24 h · ${repeatNote(repeat, name)} (“${metric.label}”${at})`
    : metric.state === "reported"
      ? `Last 24 h · ${inches(metric.value)} reported by ${name} (“${metric.label}”${at})`
      : metric.state === "not_reported"
        ? `Last 24 h · ${name} left its 24 h total empty${at}`
        : `Last 24 h · ${metric.note?.startsWith("Withheld:") ? metric.note : `${name} doesn’t publish a 24 h total`}`;
  return { past, future, ...totals, last24: { metric, reportTime: report?.reportTime ?? null, detail, ...(report && snowfallIssues(report.snowfall).length ? { warning: "Resort snowfall data warning: affected totals are withheld. See the resort report for published figures." } : {}) }, canyon, timeZone };
}

/** One scale for timelines shown together, so equal amounts draw equal bars. The last 24 h is a figure, not a bar. */
export function timelineScale(models: SnowTimelineModel[]): number {
  const amounts = models.flatMap((m) => [...m.past, ...m.future].map((d) => d.amountIn ?? 0));
  return Math.min(SCALE_MAX_IN, Math.max(SCALE_MIN_IN, ...amounts));
}
