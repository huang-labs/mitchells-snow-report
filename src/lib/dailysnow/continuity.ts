import { localTime, RESORTS } from "./facts";
import { HOUR } from "../sources/types";
import type { CanyonId, DailySnowHistoryEntry, DailySnowNumbers, DailySnowPhase, DailySnowPost } from "../types";

/**
 * What the Daily Snow knows about its own earlier posts, computed in code:
 * the last post's text for continuity, how the phase moved, how the forecast
 * for the coming storm changed from post to post, and what we forecast for the
 * storm that just ended next to what the resorts reported.
 *
 * Past forecasts are compared only when they describe the same storm window,
 * never by their rolling "next 24 h" totals: each post's 24 hours start at a
 * different time.
 */

/** Recent posts sent to the model (titles, phases and the forecasts they carried). */
export const HISTORY_IN_PROMPT = 5;
/** Storm windows from different posts are the same storm when they overlap, allowing for this much timing drift. */
export const STORM_MATCH_SLACK_MS = 6 * HOUR;
/** A storm whose forecast window ended this recently gets a forecast-versus-reported comparison. */
export const RECENT_STORM_MS = 48 * HOUR;

type CanyonForecast = DailySnowHistoryEntry["forecast"][number];
type Window = { start: string; end: string };

export interface ContinuityDigest {
  /**
   * Our last post before today, for continuity only. Its amounts are out of
   * date; the validator does not accept them as data.
   */
  previousPost: { date: string; weekday: string; title: string; summary: string; paragraphs: string[] } | null;
  /** How the phase moved since the last post, e.g. "storm (Sunday's post) → post-storm (today)". */
  phaseChange: string | null;
  recentPosts: Array<{ date: string; title: string; phase: DailySnowPhase; forecast: string[] }>;
  /** The coming or current storm, as each earlier post and today's NWS forecast saw it. Oldest first. */
  stormTrend: Array<{ canyon: CanyonId; forecasts: string[] }>;
  /** The storm that ended in the last 48 hours: what we forecast and what the resorts reported. */
  lastStorm: Array<{ canyon: CanyonId; window: string; forecasts: string[]; reported: string[] }>;
}

export function historyEntry(post: DailySnowPost): DailySnowHistoryEntry {
  return {
    date: post.date,
    title: post.title,
    phase: post.phase,
    postedAt: post.generatedAt,
    forecast: post.numbers.canyons.map((c) => ({
      canyon: c.canyon,
      next24In: c.next24In,
      next72In: c.next72In,
      stormIn: c.nextStorm?.totalSnowIn ?? null,
      storm: c.nextStorm ? { start: c.nextStorm.start, end: c.nextStorm.end } : null,
    })),
  };
}

const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "long" });
/** Weekday of a YYYY-MM-DD Denver date (noon UTC is the same calendar day in Denver). */
const weekdayOf = (date: string) => weekdayFmt.format(new Date(`${date}T12:00:00Z`));

const overlaps = (a: Window, b: Window, slack = STORM_MATCH_SLACK_MS) =>
  Date.parse(a.start) - slack < Date.parse(b.end) && Date.parse(b.start) - slack < Date.parse(a.end);

function windowText(w: Window, now: Date, zone="America/Denver"): string {
  return `${localTime(w.start, now,zone)} to ${localTime(w.end, now,zone)}`;
}

/** "our post at 6:05 AM yesterday" (or "our Sunday post" for entries stored before posting times were kept). */
function postLabel(h: DailySnowHistoryEntry, now: Date, zone="America/Denver"): string {
  return h.postedAt ? `our post at ${localTime(h.postedAt, now,zone)}` : `our ${weekdayOf(h.date)} post`;
}

function forecastLine(h: DailySnowHistoryEntry, f: CanyonForecast, now: Date, zone="America/Denver"): string {
  const from = h.postedAt ? `from ${localTime(h.postedAt, now,zone)}` : `from ${weekdayOf(h.date)} morning`;
  const parts = [`${f.next24In ?? "?"}″ in the 24 h and ${f.next72In ?? "?"}″ in the 72 h ${from}`];
  if (f.stormIn !== null) parts.push(`next storm ${f.stormIn}″${f.storm ? ` (${windowText(f.storm, now,zone)})` : ""}`);
  return `${f.canyon}: ${parts.join("; ")}`;
}

/** Earlier posts' forecasts for the storm overlapping `w` in one canyon, oldest first. */
function forecastsFor(history: DailySnowHistoryEntry[], canyon: CanyonId, w: Window) {
  return history
    .flatMap((h) => {
      const f = h.forecast.find((x) => x.canyon === canyon);
      return f?.storm && f.stormIn !== null && overlaps(f.storm, w) ? [{ h, f: f as CanyonForecast & { storm: Window; stormIn: number } }] : [];
    })
    .reverse();
}

export function buildContinuity(
  previous: DailySnowPost | null,
  history: DailySnowHistoryEntry[],
  numbers: DailySnowNumbers,
  phase: DailySnowPhase,
  date: string,
  now: Date,
  zone="America/Denver",
): ContinuityDigest {
  const past = history.filter((h) => h.date < date);
  const prev = previous && previous.date < date ? previous : null;
  const t = now.getTime();

  const stormTrend: ContinuityDigest["stormTrend"] = [];
  const lastStorm: ContinuityDigest["lastStorm"] = [];
  for (const c of numbers.canyons) {
    const upcoming = c.nextStorm;
    if (upcoming) {
      const earlier = forecastsFor(past, c.canyon, upcoming);
      if (earlier.length) {
        stormTrend.push({
          canyon: c.canyon,
          forecasts: [
            ...earlier.map(({ h, f }) => `${postLabel(h, now,zone)}: ${f.stormIn}″ (${windowText(f.storm, now,zone)})`),
            `today's NWS forecast: ${upcoming.totalSnowIn}″ (${windowText(upcoming, now,zone)})`,
          ],
        });
      }
    }

    // The newest post's view of the most recent storm that has since ended.
    const ended = past
      .map((h) => h.forecast.find((x) => x.canyon === c.canyon)?.storm)
      .find((s): s is Window => !!s && Date.parse(s.end) <= t && Date.parse(s.end) >= t - RECENT_STORM_MS && !(upcoming && overlaps(s, upcoming)));
    if (ended) {
      const forecasts = forecastsFor(past, c.canyon, ended);
      // A post written mid-storm starts its window at posting time; the earliest start is the storm's.
      const start = Math.min(...forecasts.map(({ f }) => Date.parse(f.storm.start)));
      const reported = numbers.resorts
        .filter((r) => RESORTS.find((x) => x.id === r.id)?.canyon === c.canyon)
        .map((r) => {
          const amounts = [r.storm !== null ? `storm total ${r.storm}″` : null, r.h24 !== null ? `24 h ${r.h24}″` : null].filter(Boolean);
          return `${r.name}: ${amounts.length ? amounts.join(", ") : "no storm or 24 h total reported"}${r.reportTime ? ` (report ${localTime(r.reportTime, now,zone)})` : ""}`;
        });
      lastStorm.push({
        canyon: c.canyon,
        window: windowText({ start: new Date(start).toISOString(), end: ended.end }, now,zone),
        forecasts: forecasts.map(({ h, f }) => `${postLabel(h, now,zone)} (${h.postedAt && Date.parse(h.postedAt) < start ? "before it began" : "after it began"}): ${f.stormIn}″`),
        reported,
      });
    }
  }

  return {
    previousPost: prev
      ? { date: prev.date, weekday: weekdayOf(prev.date), title: prev.title, summary: prev.summary, paragraphs: prev.sections.flatMap((s) => s.paragraphs.map((p) => p.text)) }
      : null,
    phaseChange: past[0] ? `${past[0].phase} (${weekdayOf(past[0].date)}'s post) → ${phase} (today)` : null,
    recentPosts: past.slice(0, HISTORY_IN_PROMPT).map((h) => ({
      date: h.date,
      title: h.title,
      phase: h.phase,
      forecast: h.forecast.map((f) => forecastLine(h, f, now,zone)),
    })),
    stormTrend,
    lastStorm,
  };
}
