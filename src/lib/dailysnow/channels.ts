import { CHANNELS, REGIONS, type ChannelId, type RegionId } from "../catalog";
import { localDate } from "../time";
import type { DailySnowPost, DailySnowState, Snapshot } from "../types";
import type { KVLike } from "../store";
import { emptyDailySnowState, planDailySnow, type DailySnowEnv } from ".";
import { dailySnowActivity } from "./digest";
import { channelKV, channelStateKey, regionalSnapshot } from "./regions";
import { attemptsToday, DAILY_CALL_CAP, inFlight, MAX_ATTEMPTS, shouldRunDailySnow } from "./schedule";
import { writeWestern } from "./western";

export type ChannelsEnv = DailySnowEnv;
/** Regional generations allowed at once, across overlapping cron runs. */
export const MAX_CONCURRENT_CHANNELS = 4;
export async function readChannelStates(kv: KVLike): Promise<Partial<Record<ChannelId, DailySnowState>>> {
  return Object.fromEntries(
    (
      await Promise.all(
        CHANNELS.map(async (c) => {
          const raw = await kv.get(channelStateKey(c.id), "text");
          return raw ? [c.id, JSON.parse(raw) as DailySnowState] : null;
        }),
      )
    ).filter((x): x is [ChannelId, DailySnowState] => x !== null),
  );
}
export async function runChannels(
  env: ChannelsEnv,
  snapshot: Snapshot,
  now: Date,
  opts: { force?: boolean; channel?: ChannelId; fetchImpl?: typeof fetch } = {},
) {
  if (!env.AI || env.AI_ENABLED === "false") return [];
  const states = await readChannelStates(env.SNOW_KV);
  const outcomes: Array<{ channel: ChannelId; error?: string; published?: string; skipped?: string }> = [];
  async function run(channel: ChannelId) {
    if (opts.channel && channel !== opts.channel) return;
    const definition = CHANNELS.find((c) => c.id === channel)!;
    const base = states[channel] ?? emptyDailySnowState();
    if (!opts.force && !shouldRunDailySnow(base, now, channel)) return;
    // Scheduled runs pass these checks in shouldRunDailySnow; forced runs must too.
    if (opts.force && inFlight(base, now)) {
      outcomes.push({ channel, skipped: "in-flight" });
      return;
    }
    const used = attemptsToday(base, now, channel);
    if (opts.force && (used.count >= MAX_ATTEMPTS || used.calls + 2 > DAILY_CALL_CAP)) {
      outcomes.push({ channel, skipped: "channel daily cap" });
      return;
    }
    const scoped = channel === "western-us" ? snapshot : regionalSnapshot(snapshot, channel);
    const editions = Object.fromEntries(
      REGIONS.flatMap((r) => {
        const p = states[r.id]?.current;
        return p && p.date === localDate(now, r.timeZone) ? [[r.id, p]] : [];
      }),
    ) as Partial<Record<RegionId, DailySnowPost>>;
    if (channel === "western-us" && !Object.keys(editions).length) {
      outcomes.push({ channel, skipped: "No current regional editions" });
      return;
    }
    if (channel !== "western-us" && !opts.force && !dailySnowActivity(scoped, now).worthPosting) {
      outcomes.push({ channel, skipped: "off-season or inputs unavailable" });
      return;
    }
    let attemptAt: string | null = null;
    // A run that outlived IN_FLIGHT_MS may have been superseded by a newer
    // attempt; it must not overwrite that attempt's state or edition. Only a
    // strictly newer attempt counts: a stale KV read of our own write is ours.
    const ours = async () => {
      if (!attemptAt) return true;
      const raw = await env.SNOW_KV.get(channelStateKey(channel), "text");
      const latest = raw ? (JSON.parse(raw) as DailySnowState).lastAttemptAt : null;
      return !latest || latest <= attemptAt;
    };
    const beforePublish = async () => {
      if (!(await ours())) throw new Error("Publication attempt superseded");
    };
    const scopedEnv: DailySnowEnv = {
      ...env,
      SNOW_KV: channelKV(env.SNOW_KV, channel),
      DAILY_SNOW_CHANNEL: channel,
      beforePublish,
    };
    let state = base;
    try {
      if (channel === "western-us") {
        state = {
          ...base,
          lastAttemptAt: now.toISOString(),
          attempts: {
            date: localDate(now, definition.timeZone),
            count: base.attempts.date === localDate(now, definition.timeZone) ? base.attempts.count + 1 : 1,
            calls: base.attempts.date === localDate(now, definition.timeZone) ? base.attempts.calls + 2 : 2,
          },
        };
        attemptAt = state.lastAttemptAt;
        await env.SNOW_KV.put(channelStateKey(channel), JSON.stringify(state));
        state = await writeWestern(state, snapshot, editions, scopedEnv, now);
      } else {
        const plan = planDailySnow(base, scoped, scopedEnv, now, { force: opts.force, fetchImpl: opts.fetchImpl });
        if (!plan?.run) {
          outcomes.push({ channel, skipped: plan?.skipped ?? "not due" });
          return;
        }
        state = plan.state;
        attemptAt = state.lastAttemptAt;
        await env.SNOW_KV.put(channelStateKey(channel), JSON.stringify(state));
        state = await plan.run();
      }
      await beforePublish();
      await env.SNOW_KV.put(channelStateKey(channel), JSON.stringify(state));
      states[channel] = state;
      outcomes.push({
        channel,
        ...(state.lastError ? { error: state.lastError } : { published: state.current?.date }),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (await ours()) {
        state = {
          ...state,
          lastError: error.slice(0, 500),
          lastFinishedAt: new Date().toISOString(),
          consecutiveFailures: base.consecutiveFailures + 1,
        };
        await env.SNOW_KV.put(channelStateKey(channel), JSON.stringify(state));
        states[channel] = state;
      }
      outcomes.push({ channel, error });
    }
  }
  // Scheduled runs give Western its own cron once regional editions exist: two
  // back-to-back primary/fallback jobs could otherwise exceed the 15-minute cron
  // deadline. Forced runs never take this path; they run the requested channels.
  const westernDue = !opts.force && !opts.channel && shouldRunDailySnow(states["western-us"], now, "western-us");
  if (westernDue && REGIONS.some((r) => states[r.id]?.current?.date === localDate(now, r.timeZone))) {
    await run("western-us");
    return outcomes;
  }
  // Up to four regional attempts run at once, counting attempts still running
  // from an earlier cron; later crons pick up the rest.
  const running = REGIONS.filter((r) => inFlight(states[r.id], now));
  const due = REGIONS.filter(
    (r) =>
      (!opts.channel || opts.channel === r.id) &&
      !running.includes(r) &&
      (opts.force || shouldRunDailySnow(states[r.id], now, r.id)),
  );
  if (opts.force)
    for (const r of running)
      if (!opts.channel || opts.channel === r.id) outcomes.push({ channel: r.id, skipped: "in-flight" });
  const slots = Math.max(0, MAX_CONCURRENT_CHANNELS - running.length);
  for (const r of due.slice(slots)) outcomes.push({ channel: r.id, skipped: "generation concurrency limit" });
  await Promise.all(due.slice(0, slots).map((r) => run(r.id)));
  // A forced Western run follows any forced regional runs, so it sees their editions.
  if (opts.force ? !opts.channel || opts.channel === "western-us" : !due.length) await run("western-us");
  return outcomes;
}
