import type { CanyonId, PrimaryResortId, ResortReport } from "../types";

/**
 * A snow day, keyed by the morning it ends: `2026-11-06` is the 24 hours ending at
 * 6 AM in the destination time zone on Nov 6. Local snow days can be 23 or
 * 25 hours across DST; source reporting windows remain unchanged.
 */
export type SnowDayKey = string;

/** What a resort's 24 h total said on the morning a snow day ended. */
export interface MorningReading {
  /**
   * `reported`, `not_reported` and `unavailable` mirror the resort's own Metric.
   * `no_report`: the resort was checked that morning, but its 24 h window didn't end
   * recently enough to be that morning's report (it would repeat an earlier day).
   */
  state: "reported" | "not_reported" | "unavailable" | "no_report";
  /** Present when `state` is `reported`. */
  valueIn?: number;
  /** The resort's own label for the window ("Last 24 hrs", "24 Hour"). */
  label: string;
  /** When the resort's window ends: its report time, or the fetch for sources that compute it then. */
  windowEnd: string | null;
  collectedAt: string;
  reportingLocation?: ResortReport["reportingLocation"];
}

/** The NWS grid forecast for a whole snow day, as it stood when that day began. */
export interface DayAheadForecast {
  snowIn: number;
  /**
   * NWS liquid (QPF) for the same day, inches to 0.01, for a future snow-to-liquid
   * ratio (snowIn / liquidIn). Absent when the forecast had no full day of liquid, and
   * on entries recorded before it was added.
   */
  liquidIn?: number;
  /** NWS grid update time of the forecast used. */
  issuedAt: string | null;
  collectedAt: string;
}

/** A rolling record of recent snow days, kept in the snapshot (see `recordSnowLog`). */
export interface SnowLogState {
  resorts: Partial<Record<PrimaryResortId, Record<SnowDayKey, MorningReading>>>;
  forecasts: Partial<Record<CanyonId, Record<SnowDayKey, DayAheadForecast>>>;
}
