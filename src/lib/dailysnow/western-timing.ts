import type { RegionId } from "../catalog";
import { HOUR } from "../sources/types";
import { zonedParts, zonedToUtc } from "../time";
import type { PointForecast } from "../types";

/**
 * When NWS snow first appears at each point, computed in code for the United
 * States West article, plus a conservative check that its prose does not have
 * snow arriving in a region well before any of that region's points forecast it
 * (2026-11-14: "the Sierra … will catch the first snowfall Saturday night" when
 * Palisades' first forecast snow began Sunday afternoon).
 */

/** Hourly bars at or above this count as snow (0.1″ over six hours is about 0.017″ an hour); smaller allocations are traces. */
export const FIRST_SNOW_MIN_HOURLY_IN = 0.01;
/** A stated time must end at least this long before the first forecast snow to be rejected. */
export const TIMING_SLACK_MS = 3 * HOUR;
const WEEK_MS = 7 * 24 * HOUR;

/** Start of the first hour with forecast snow in the next 7 days; null when none or no hourly coverage. */
export function firstSnowAt(p: PointForecast, now: Date): string | null {
  const t = now.getTime();
  const bar = (p.hourlySnow ?? []).find((b) => {
    const start = Date.parse(b.start);
    return start + HOUR > t && start < t + WEEK_MS && b.snowIn >= FIRST_SNOW_MIN_HOURLY_IN;
  });
  return bar ? new Date(Math.max(Date.parse(bar.start), t)).toISOString() : null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "now", "Sunday afternoon (from about 4 PM PST)" or "Saturday night (from about 11 PM PST)". Night after midnight names the previous evening. */
export function firstSnowLabel(at: string | null, now: Date, timeZone: string): string {
  if (!at) return "no forecast snow in the next 7 days";
  if (Date.parse(at) <= now.getTime()) return "now (forecast snow in the current hour)";
  const d = new Date(at);
  const p = zonedParts(d, timeZone);
  const night = p.hour < 5 || p.hour >= 21;
  const dayOf = p.hour < 5 ? zonedToUtc(p.year, p.month, p.day - 1, 12, 0, 0, timeZone) : d;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(dayOf);
  const part = night ? "night" : p.hour < 12 ? "morning" : p.hour < 17 ? "afternoon" : "evening";
  const clock = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", timeZoneName: "short" }).format(d);
  return `${weekday} ${part} (from about ${clock})`;
}

/** Names a sentence may use for each region; shared names (Sierra, Cascades) cover every region they describe. */
export const REGION_ALIASES: Record<RegionId, RegExp> = {
  utah: /\b(?:utah|wasatch|cottonwoods?|alta|snowbird|solitude|brighton|park city|deer valley|snowbasin)\b/i,
  tahoe: /\b(?:tahoe|sierra(?: nevada)?|palisades)\b/i,
  mammoth: /\b(?:mammoth|sierra(?: nevada)?)\b/i,
  tetons: /\b(?:tetons?|jackson(?: hole)?|wyoming)\b/i,
  montana: /\b(?:montana|big sky)\b/i,
  colorado: /\b(?:colorado|winter park|steamboat|telluride|san juans?)\b/i,
  "new-mexico": /\b(?:new mexico|taos(?: ski valley)?|sangre de cristo)\b/i,
  washington: /\b(?:washington|crystal(?: mountain)?|cascades?)\b/i,
  oregon: /\b(?:oregon|(?:mt\.?|mount) bachelor|bachelor|cascades?)\b/i,
};

/** Words saying when snow starts, not how much falls or when it ends. */
const ARRIVAL = /\b(?:first|arriv\w*|begins?|beginning|starts?|starting|onset|catch(?:es)?|reach(?:es)?|moves? in|spreads?|returns?|kicks? off|develops?)\b/gi;
/** Only the first time phrase this soon after an arrival word is read as the arrival time. */
const ARRIVAL_REACH = 80;
const PHRASE = /\b(?:(sun|mon|tues|wednes|thurs|fri|satur)day(?:\s+(morning|afternoon|evening|night))?|(tonight)|this\s+(morning|afternoon|evening))\b/gi;

/** The local window a phrase names, generously: an unqualified weekday runs into the following night. */
function phraseWindow(m: RegExpMatchArray, now: Date, timeZone: string): { start: number; end: number } {
  const today = zonedParts(now, timeZone);
  const todayIndex = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  let offset = 0;
  let part: string | undefined;
  if (m[1]) {
    const target = WEEKDAYS.findIndex((w) => w.toLowerCase().startsWith(m[1].toLowerCase()));
    offset = (target - todayIndex + 7) % 7;
    part = m[2]?.toLowerCase();
  } else if (m[3]) part = "night";
  else part = m[4].toLowerCase();
  const [from, to] = part === "morning" ? [5, 12] : part === "afternoon" ? [12, 17] : part === "evening" ? [17, 21] : part === "night" ? [18, 30] : [0, 30];
  const at = (h: number) => zonedToUtc(today.year, today.month, today.day + offset, h, 0, 0, timeZone).getTime();
  return { start: at(from), end: at(to) };
}

export interface RegionFirstSnow {
  region: RegionId;
  name: string;
  /** The region's IANA zone: its first-snow label and the prose day-parts about it use local time. */
  timeZone: string;
  /** Earliest first forecast snow over the region's points; null when none forecast snow. */
  at: string | null;
}

/**
 * Sentences that put a region's first snow in a window ending well before every
 * mentioned region's first forecast snow, each read in that region's local time.
 * Only arrival sentences with an explicit weekday/part-of-day are checked;
 * regions without forecast snow are ignored.
 */
export function westernTimingIssues(texts: string[], regions: RegionFirstSnow[], now: Date): string[] {
  const issues: string[] = [];
  for (const sentence of texts.flatMap((t) => t.split(/(?<=[.!?])\s+/))) {
    const mentioned = regions.filter((r) => r.at && REGION_ALIASES[r.region].test(sentence));
    if (!mentioned.length) continue;
    const phrases = [...sentence.matchAll(PHRASE)];
    const arrivals = new Set(
      [...sentence.matchAll(ARRIVAL)].flatMap((a) => {
        const after = a.index! + a[0].length;
        const m = phrases.find((p) => p.index! >= after && p.index! - after <= ARRIVAL_REACH);
        return m ? [m] : [];
      }),
    );
    for (const m of arrivals) {
      // Too early for every region the sentence names, each in its own local time.
      if (mentioned.every((r) => phraseWindow(m, now, r.timeZone).end + TIMING_SLACK_MS <= Date.parse(r.at!)))
        issues.push(`"${m[0]}" is before the first forecast snow for ${mentioned.map((r) => r.name).join("/")}`);
    }
  }
  return issues;
}
