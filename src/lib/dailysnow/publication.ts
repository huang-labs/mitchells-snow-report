import { channelById, type ChannelId } from "../catalog";
import { localDate, zonedParts, zonedToUtc } from "../time";
import { denverDate } from "./facts";
import { denverParts, denverToUtc } from "../time";
import type { DailySnowPublicationStatus, DailySnowState } from "../types";
import { attemptsToday, DAILY_CALL_CAP, inFlight, LAST_ATTEMPT_HOUR, MAX_ATTEMPTS, POST_HOUR, WESTERN_POST_MINUTES, WESTERN_LAST_ATTEMPT_HOUR } from "./schedule";

/** Publication availability, separate from the age of an immutable edition. */
export function dailySnowPublicationStatus(
  editionDate: string | null,
  state: DailySnowState | undefined,
  now: Date,
  expected: boolean,
  channel?:ChannelId,
): DailySnowPublicationStatus {
  const zone=channelById(channel??"utah")!.timeZone;
  if (editionDate && editionDate >= localDate(now,zone)) return "current";
  if (!expected) return "paused";
  const p = zonedParts(now,zone);
  const yesterday = localDate(zonedToUtc(p.year,p.month,p.day-1,12,0,0,zone),zone);
  // A missed previous edition remains a delay overnight, even before today's window.
  if (editionDate && editionDate < yesterday) return "delayed";
  if (p.hour * 60 + p.minute < (channel==="western-us"?WESTERN_POST_MINUTES:POST_HOUR * 60)) return "scheduled";
  // A final attempt started before the cutoff can still finish after it.
  if (inFlight(state, now)) return "pending";
  const used = attemptsToday(state, now,channel);
  if (p.hour >= (channel==="western-us"?WESTERN_LAST_ATTEMPT_HOUR:LAST_ATTEMPT_HOUR) || used.count >= MAX_ATTEMPTS || used.calls + 2 > DAILY_CALL_CAP) return "delayed";
  return "pending";
}
