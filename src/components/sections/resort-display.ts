import type { LiftStatus, SnowfallSet } from "@/lib/types";

const STATUS_ORDER: Record<LiftStatus, number> = {
  open: 0,
  hold: 1,
  scheduled: 2,
  unknown: 3,
  closed: 4,
};

/** Open and pending items first; preserve source order within each status. */
export function byStatus<T extends { status: LiftStatus }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  );
}

/** One label per measurement window, used on every resort and in the snowfall table. */
export const SNOW_LABEL: Record<keyof SnowfallSet, string> = {
  overnight: "Overnight",
  h12: "12 h",
  h24: "24 h",
  h48: "48 h",
  h72: "72 h",
  d7: "7 days",
  storm: "Storm",
  season: "Season",
};

const SAME_WINDOW: Record<keyof SnowfallSet, RegExp> = {
  overnight: /overnight/i,
  h12: /\b12\b/,
  h24: /\b24\b/,
  h48: /\b48\b/,
  h72: /\b72\b/,
  d7: /\b7\b/,
  storm: /storm/i,
  season: /season|year to date|ytd/i,
};

/**
 * The resort's own wording, but only when it says something our window label
 * doesn't (Solitude's "Since lifts closed"). "Snow 24 Hrs." and "24 Hour" are
 * just the 24 h window and return null.
 */
export function snowQualifier(key: keyof SnowfallSet, label: string): string | null {
  return SAME_WINDOW[key].test(label) ? null : label;
}

/** The window behind the Overnight tile: overnight where the resort reports it, else its 12-hour total (Alta). */
export function newSnowKey(snowfall: SnowfallSet): "overnight" | "h12" {
  return snowfall.overnight.state === "unavailable" && snowfall.h12.state !== "unavailable" ? "h12" : "overnight";
}
