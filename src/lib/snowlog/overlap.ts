/**
 * Repeated 24 h reports. A resort's morning 24 h total can still hold snow its previous
 * morning's report already counted: Brighton reported 4″ at 7:09 AM on 2026-11-14 while
 * the storm was ending, then 24 h = 48 h = 72 h = 7 days = 5″ on 2026-11-15. Adding
 * the two 24 h figures counts one 5″ storm as 9″.
 *
 * When the same report also publishes a 48 h total and the previous reading ended about
 * a day earlier, the 48 h total bounds the two days together: anything beyond it is
 * snow the earlier morning already counted. This rule only removes that excess. It
 * never adds snow, and resorts without a 48 h total keep their published 24 h figure.
 */

const HOUR = 3_600_000;
/** Consecutive morning reports end about a day apart; report times drift by a few hours. */
const MIN_GAP_MS = 18 * HOUR;
const MAX_GAP_MS = 30 * HOUR;

/** One morning's published 24 h total, with the same report's 48 h total when there is one. */
export interface DailyFigure {
  valueIn: number;
  h48In?: number;
  /** When the resort's 24 h window ends. */
  windowEnd: string | null;
}

/** The previous morning's 24 h figure, already net of anything it repeated. */
export interface PreviousFigure {
  valueIn: number;
  windowEnd: string | null;
}

export type NewSnow =
  /** `repeatedIn` > 0 when part of the published 24 h total was the previous morning's snow. */
  | { kind: "new"; valueIn: number; publishedIn: number; repeatedIn: number }
  /** The 48 h total is below the previous morning's 24 h total: the figures conflict. */
  | { kind: "conflict"; publishedIn: number; h48In: number; previousIn: number };

const round = (v: number) => Math.round(v * 10) / 10;

/** Whether `previous` is the report immediately before one ending at `windowEnd`. */
export function consecutive(windowEnd: string | null, previous: string | null): boolean {
  if (!windowEnd || !previous) return false;
  const gap = Date.parse(windowEnd) - Date.parse(previous);
  return gap >= MIN_GAP_MS && gap <= MAX_GAP_MS;
}

/** The snow a morning's 24 h total adds beyond what the previous morning reported. */
export function newSnow(day: DailyFigure, previous: PreviousFigure | null): NewSnow {
  const published = { kind: "new" as const, valueIn: day.valueIn, publishedIn: day.valueIn, repeatedIn: 0 };
  if (day.h48In === undefined || !previous || !consecutive(day.windowEnd, previous.windowEnd)) return published;
  const repeatedIn = round(day.valueIn + previous.valueIn - day.h48In);
  if (repeatedIn <= 0) return published;
  if (repeatedIn > day.valueIn) return { kind: "conflict", publishedIn: day.valueIn, h48In: day.h48In, previousIn: previous.valueIn };
  return { kind: "new", valueIn: round(day.valueIn - repeatedIn), publishedIn: day.valueIn, repeatedIn };
}
