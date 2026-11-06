import type { DailySnowPhase } from "../types";
import type { StormRecord } from "./storm-types";
import type { FigureCandidate } from "./digest";
import { isSnowPlume } from "./plume";

/**
 * Which figures a regional post may show. Code decides relevance from the same
 * numbers as the phase, so a sunny day doesn't get snow-level or snow-to-liquid
 * charts and a 1″ dusting isn't presented as a storm.
 */

/** A tracked event shows as a storm once any resort reported at least this much (inches). */
export const STORM_RECAP_MIN_IN = 2;
/** NWS six-hour bars for a point: its forecast snow over the next 7 days (inches). */
export const SNOW_BARS_MIN_IN = 1;
/** Snow level matters once liquid is forecast in the next 72 h at a point (inches)... */
export const SNOW_LEVEL_LIQUID_72H_IN = 0.1;
/** ...or once a point's 7-day chart carries snow (inches). */
export const SNOW_LEVEL_SNOW_7D_IN = 1;
/** Resort totals chart: largest reported overnight / 24 h / 48 h / storm amount (inches). */
export const RESORT_TOTALS_MIN_IN = 1;
/** Snow stake photo: snow reported in the last 24 h (inches), or a storm in progress or just ended. */
export const STAKE_RECENT_MIN_IN = 1;
/** Snow-to-liquid plume: largest 72 h point forecast (inches), or a storm in progress. */
export const SLR_NEXT72_MIN_IN = 3;

/** Most figures a post carries in each phase, including the code-placed plume. */
export const FIGURE_LIMIT: Record<DailySnowPhase, number> = { quiet: 3, "pre-storm": 5, storm: 6, "post-storm": 5 };

/** Largest amount any resort reported for a tracked event. Rolling and total observations are compared, never added. */
export function stormMaxIn(storm: StormRecord): number {
  return Math.max(
    0,
    ...storm.resorts.flatMap((r) => [r.total?.amountIn ?? 0, r.rolling?.amountIn ?? 0, r.latestSegment?.amountIn ?? 0]),
  );
}

export const significantStorm = (storm: StormRecord | null | undefined): storm is StormRecord =>
  !!storm && stormMaxIn(storm) >= STORM_RECAP_MIN_IN;

export interface FigureFacts {
  phase: DailySnowPhase;
  /** Largest 24 h / overnight resort report (inches). */
  recentIn: number;
  /** Largest 72 h point forecast, null when unknown. */
  next72In: number | null;
  /** Per point id (lower-case forecast area): forecast snow over 7 days and liquid in 72 h. */
  points: Array<{ id: string; chartSnowIn: number; liquid72In: number }>;
}

function relevant(c: FigureCandidate, f: FigureFacts): boolean {
  const fig = c.figure;
  const id = fig.id;
  if (isSnowPlume(id)) return true;
  if (id.startsWith("plume-slr-")) return (f.next72In ?? 0) >= SLR_NEXT72_MIN_IN || f.phase === "storm";
  if (id.startsWith("stake-")) return f.recentIn >= STAKE_RECENT_MIN_IN || f.phase === "storm" || f.phase === "post-storm";
  switch (fig.kind) {
    case "snow-bars":
      return (f.points.find((p) => p.id === fig.canyon.toLowerCase())?.chartSnowIn ?? 0) >= SNOW_BARS_MIN_IN;
    case "snow-level":
      return f.points.some((p) => p.liquid72In >= SNOW_LEVEL_LIQUID_72H_IN || p.chartSnowIn >= SNOW_LEVEL_SNOW_7D_IN);
    case "totals":
      return (
        f.recentIn >= RESORT_TOTALS_MIN_IN ||
        fig.rows.some((r) => Math.max(r.h24 ?? 0, r.h48 ?? 0, r.storm ?? 0) >= RESORT_TOTALS_MIN_IN)
      );
    case "storm-recap":
      return significantStorm(fig.storm);
    default:
      return true;
  }
}

/** Candidates worth showing today, in their original order. */
export function relevantFigures(candidates: FigureCandidate[], facts: FigureFacts): FigureCandidate[] {
  return candidates.filter((c) => relevant(c, facts));
}

/** Figures the model may place. The accumulated-snow plume is placed by code at the end of the post. */
export const modelPlaceable = (id: string) => !isSnowPlume(id);
