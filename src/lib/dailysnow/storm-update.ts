import { channelById, RESORTS, type ChannelId } from "../catalog";
import { classify } from "../report";
import { snowfallIssues, usableSnowReport } from "../snowfall-quality";
import { SOURCE_BY_ID } from "../sources";
import { HOUR } from "../sources/types";
import { formatLocal, localDate, zonedParts } from "../time";
import type { DailySnowPost, DailySnowState, PrimaryResortId, ResortReport, Snapshot, SnowfallSet } from "../types";
import { attemptsToday, DAILY_CALL_CAP, inFlight, LAST_ATTEMPT_HOUR, MAX_ATTEMPTS, POST_HOUR, RETRY_AFTER_MS } from "./schedule";

/**
 * Storm-cycle timing for regional editions, computed from the collected
 * snapshot and today's edition. Both rules use the same validated resort view
 * as the edition itself (usableSnowReport, current reports only).
 *
 *  - Settling: a morning edition waits, until SETTLE_UNTIL_MINUTES local, while
 *    a resort's report published today shows a snowfall conflict that its
 *    previous morning did not. Resorts publish their morning numbers field by
 *    field; a conflict that persists from day to day (a stuck source field), or
 *    one in a report from an earlier day (or with no report time) that cannot
 *    settle before the deadline, never holds an edition.
 *  - Storm update: once per local day, before the regional cutoff, today's
 *    edition is rewritten when some resort's reported new snow has risen by at
 *    least STORM_UPDATE_MIN_IN since the edition froze its observations. It uses
 *    the channel's existing attempt and request caps.
 */
export const STORM_UPDATE_MIN_IN = 3;
export const STORM_UPDATE_TRIGGER = "storm-update";
/** 8 AM local: the latest a morning edition waits for resort reports to settle. */
export const SETTLE_UNTIL_MINUTES = POST_HOUR * 60 + 60;

/** What a scheduled request knows about a region's resort reports right now. */
export interface RegionalSignals {
  /** Reported new snow (largest of overnight, 12 h and 24 h) per resort with a current, usable report. */
  newSnow: Partial<Record<PrimaryResortId, number>>;
  /** Resorts whose current report newly conflicts (names, for the skip log). */
  settling: string[];
}

const value = (m: SnowfallSet[keyof SnowfallSet] | undefined) =>
  m?.state === "reported" && Number.isFinite(m.value) && m.value >= 0 ? m.value : null;

/** Same windows as the regional activity gate. Null when none is reported. */
export function newSnowIn(snowfall: SnowfallSet | undefined): number | null {
  if (!snowfall) return null;
  const xs = [value(snowfall.overnight), value(snowfall.h12), value(snowfall.h24)].filter((x): x is number => x !== null);
  return xs.length ? Math.max(...xs) : null;
}

/** Only a report the resort published today can still be mid-update this morning. */
function publishedToday(report: ResortReport, today: string, zone: string): boolean {
  const at = report.reportTime ? new Date(report.reportTime) : null;
  return !!at && Number.isFinite(at.getTime()) && localDate(at, zone) === today;
}

/** `snapshot` is a regional snapshot (regionalSnapshot). */
export function regionalSignals(snapshot: Snapshot, now: Date): RegionalSignals {
  const zone = channelById(snapshot.region ?? "utah")!.timeZone;
  const today = localDate(now, zone);
  const yesterday = localDate(new Date(now.getTime() - 24 * HOUR), zone);
  const signals: RegionalSignals = { newSnow: {}, settling: [] };
  for (const r of RESORTS) {
    const record = snapshot.sources[r.id];
    if (record?.status !== "ok" || classify(SOURCE_BY_ID[r.id], record, now).freshness !== "current") continue;
    const raw = record.payload as ResortReport | null;
    const amount = newSnowIn(usableSnowReport(raw)?.snowfall);
    if (amount !== null) signals.newSnow[r.id] = amount;
    const before = snapshot.snowLog?.resorts[r.id]?.[yesterday];
    if (raw && publishedToday(raw, today, zone) && snowfallIssues(raw.snowfall).length && !before?.qualityNote) signals.settling.push(r.name);
  }
  return signals;
}

/** Whether a scheduled morning edition should wait for resort reports to settle. */
export function settlingHold(signals: RegionalSignals | undefined, now: Date, channel: ChannelId): string | null {
  if (channel === "western-us" || !signals?.settling.length) return null;
  const p = zonedParts(now, channelById(channel)!.timeZone);
  return p.hour * 60 + p.minute < SETTLE_UNTIL_MINUTES ? `Waiting for resort reports to settle: ${signals.settling.join(", ")}` : null;
}

/** Each resort's new snow as today's edition froze it; a resort it had no usable report for counts as 0. */
function frozenNewSnow(post: DailySnowPost, id: PrimaryResortId): number {
  const r = post.numbers.resorts.find((x) => x.id === id);
  return r?.snowfall ? (newSnowIn(r.snowfall) ?? 0) : (r?.h24 ?? 0);
}

/** New reports since today's edition, e.g. "Alta 5″ (1″ in this morning's edition)". Empty when none qualifies. */
export function newSnowSince(post: DailySnowPost, signals: RegionalSignals): string[] {
  return RESORTS.flatMap((r) => {
    const now = signals.newSnow[r.id];
    if (now === undefined) return [];
    const before = frozenNewSnow(post, r.id);
    return now - before >= STORM_UPDATE_MIN_IN ? [`${r.name} ${now}″ (${before}″ in this morning's edition)`] : [];
  });
}

/** Why today's regional edition should be rewritten now, or null. */
export function stormUpdateDue(
  state: DailySnowState | undefined,
  signals: RegionalSignals | undefined,
  now: Date,
  channel: ChannelId,
): string | null {
  if (channel === "western-us" || !signals) return null;
  const zone = channelById(channel)!.timeZone;
  const post = state?.current;
  if (!post || post.date !== localDate(now, zone) || post.trigger === STORM_UPDATE_TRIGGER) return null;
  const p = zonedParts(now, zone);
  const minutes = p.hour * 60 + p.minute;
  if (minutes < POST_HOUR * 60 || minutes >= LAST_ATTEMPT_HOUR * 60) return null;
  if (inFlight(state, now)) return null;
  const used = attemptsToday(state, now, channel);
  if (used.count >= MAX_ATTEMPTS || used.calls + 2 > DAILY_CALL_CAP) return null;
  // A failed update attempt retries on the same schedule as a failed morning attempt.
  if (state.lastError && state.lastAttemptAt && now.getTime() - Date.parse(state.lastAttemptAt) < RETRY_AFTER_MS) return null;
  if (signals.settling.length) return null;
  const reports = newSnowSince(post, signals);
  return reports.length ? `New snow reported since ${formatLocal(post.generatedAt, now, zone)}: ${reports.join("; ")}` : null;
}
