import { channelById, REGIONS, type ChannelId, type RegionId } from "../catalog";
import { localDate, zonedParts } from "../time";
import { denverDate } from "./facts";
import { DAILY_SNOW_TIMEOUT_MS } from "./llm";
import { denverParts } from "../time";
import type { DailySnowState } from "../types";

/**
 * When to write the Daily Snow. Checked on every collection cron (5 min) so
 * the post uses sources collected the same minute; working in each channel’s local
 * time keeps its start hour stable across daylight-saving changes (Cloudflare crons are UTC).
 *
 *  - From 7:00 AM region local time (7:15 AM Pacific for Western), once per day.
 *    Western then waits while a region's edition may still land (see
 *    westernWaitingOn), until 7:45 AM Pacific at the latest.
 *  - A failed attempt retries after 10 minutes, at most 3 attempts a day.
 *  - An attempt still running (or cut off) blocks new ones for IN_FLIGHT_MS.
 *  - From 11 AM local (noon Pacific for Western), no new attempts: the last edition stays up with a publication-delay notice when an edition is expected.
 */
export const POST_HOUR = 7;
export const LAST_ATTEMPT_HOUR = 11;
export const WESTERN_POST_MINUTES = 7 * 60 + 15;
export const WESTERN_LAST_ATTEMPT_HOUR = 12;
/** Western stops waiting for regional editions at 7:45 AM Pacific and runs with what it has. */
export const WESTERN_WAIT_UNTIL_MINUTES = 7 * 60 + 45;
export const RETRY_AFTER_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
/** Model requests reserved per day (two per attempt, manual runs included). */
export const DAILY_CALL_CAP = 6;
/** Longer than the worst case of one attempt (two model timeouts plus figure copies). */
export const IN_FLIGHT_MS = 2 * DAILY_SNOW_TIMEOUT_MS + 2 * 60_000;

export function attemptsToday(state: DailySnowState | undefined, now: Date, channel?:ChannelId): { count: number; calls: number } {
  const a = state?.attempts;
  return a && a.date === denverDate(now,channelById(channel??"utah")!.timeZone) ? { count: a.count, calls: a.calls } : { count: 0, calls: 0 };
}

export function inFlight(state: DailySnowState | undefined, now: Date): boolean {
  if (!state?.lastAttemptAt) return false;
  const started = Date.parse(state.lastAttemptAt);
  const finished = state.lastFinishedAt ? Date.parse(state.lastFinishedAt) : 0;
  return started > finished && now.getTime() - started < IN_FLIGHT_MS;
}

/** Returns the trigger name when a post should be written now, else null. */
export function shouldRunDailySnow(state: DailySnowState | undefined, now: Date, channel?:ChannelId): string | null {
  const zone=channelById(channel??"utah")!.timeZone;
  const p = zonedParts(now,zone);
  const postMinutes=channel==="western-us"?WESTERN_POST_MINUTES:POST_HOUR * 60;
  const lastAttemptHour=channel==="western-us"?WESTERN_LAST_ATTEMPT_HOUR:LAST_ATTEMPT_HOUR;
  const minutes = p.hour * 60 + p.minute;
  if (minutes < postMinutes || minutes >= lastAttemptHour * 60) return null;
  if (state?.current?.date === denverDate(now,zone)) return null;
  if (inFlight(state, now)) return null;
  const used = attemptsToday(state, now,channel);
  if (used.count >= MAX_ATTEMPTS || used.calls + 2 > DAILY_CALL_CAP) return null;
  if (used.count > 0 && state?.lastError) {
    if (state.lastAttemptAt && now.getTime() - Date.parse(state.lastAttemptAt) < RETRY_AFTER_MS) return null;
    return "retry";
  }
  return "morning";
}

/**
 * Regions whose edition may still land today: an attempt is running, or the
 * region expects to post (`worthPosting`), has not, and still has an attempt and
 * time before its cutoff. Western publishes once, so a region that lands after it
 * stays "missing" for the day; waiting for these covers a regional retry.
 */
export function regionsStillPublishing(
  states: Partial<Record<RegionId, DailySnowState | undefined>>,
  worthPosting: (region: RegionId) => boolean | undefined,
  now: Date,
): RegionId[] {
  return REGIONS.filter((r) => {
    const state = states[r.id];
    if (state?.current?.date === localDate(now, r.timeZone)) return false;
    if (inFlight(state, now)) return true;
    if (!worthPosting(r.id)) return false;
    const p = zonedParts(now, r.timeZone);
    if (p.hour >= LAST_ATTEMPT_HOUR) return false;
    const used = attemptsToday(state, now, r.id);
    return used.count < MAX_ATTEMPTS && used.calls + 2 <= DAILY_CALL_CAP;
  }).map((r) => r.id);
}

/** Regions a scheduled Western run should wait for now; empty once it is 7:45 AM Pacific. */
export function westernWaitingOn(
  states: Partial<Record<RegionId, DailySnowState | undefined>>,
  worthPosting: (region: RegionId) => boolean | undefined,
  now: Date,
): RegionId[] {
  const p = zonedParts(now, channelById("western-us")!.timeZone);
  if (p.hour * 60 + p.minute >= WESTERN_WAIT_UNTIL_MINUTES) return [];
  return regionsStillPublishing(states, worthPosting, now);
}
