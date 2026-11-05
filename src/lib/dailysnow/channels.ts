import { CHANNELS, REGIONS, type ChannelId, type RegionId } from "../catalog";
import { localDate } from "../time";
import type { DailySnowPost, DailySnowState, Snapshot } from "../types";
import type { KVLike } from "../store";
import { emptyDailySnowState, planDailySnow, type DailySnowEnv } from ".";
import { dailySnowActivity } from "./digest";
import { channelKV, channelStateKey, regionalSnapshot } from "./regions";
import { shouldRunDailySnow } from "./schedule";
import type { CoordinatorClient } from "./reservations";
import { writeWestern } from "./western";

export interface ChannelsEnv extends DailySnowEnv {
  PUBLICATIONS?: { getByName(name: string): CoordinatorClient };
}
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
  if (!env.PUBLICATIONS)
    return [{ channel: "western-us", error: "Publication coordinator binding missing; generation disabled" }];
  const coordinator = env.PUBLICATIONS.getByName("daily-snow-v1");
  const states = await readChannelStates(env.SNOW_KV);
  const outcomes: Array<{ channel: ChannelId; error?: string; published?: string; skipped?: string }> = [];
  async function run(channel: ChannelId) {
    if (opts.channel && channel !== opts.channel) return;
    const definition = CHANNELS.find((c) => c.id === channel)!;
    const base = states[channel] ?? emptyDailySnowState();
    if (!opts.force && !shouldRunDailySnow(base, now, channel)) return;
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
    const claim = await coordinator.reserve({ channel, date: localDate(now, definition.timeZone), now: now.getTime() });
    if (!claim.ok || !claim.token) {
      outcomes.push({ channel, skipped: claim.reason });
      return;
    }
    const token = claim.token;
    const beforePublish = async () => {
      if (!(await coordinator.valid(channel, token))) throw new Error("Publication lease superseded");
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
        await env.SNOW_KV.put(channelStateKey(channel), JSON.stringify(state));
        state = await writeWestern(state, snapshot, editions, scopedEnv, now);
      } else {
        const plan = planDailySnow(base, scoped, scopedEnv, now, { force: opts.force, fetchImpl: opts.fetchImpl });
        if (!plan?.run) {
          outcomes.push({ channel, skipped: plan?.skipped ?? "not due" });
          return;
        }
        state = plan.state;
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
      if (await coordinator.valid(channel, token)) {
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
    } finally {
      await coordinator.finish(channel, token);
    }
  }
  // Western gets its own cron once regional editions exist. Two back-to-back
  // primary/fallback jobs could otherwise exceed the 15-minute cron deadline.
  const westernDue =
    (!opts.channel || opts.channel === "western-us") &&
    (opts.force || shouldRunDailySnow(states["western-us"], now, "western-us"));
  if (westernDue && REGIONS.some((r) => states[r.id]?.current?.date === localDate(now, r.timeZone))) {
    await run("western-us");
    return outcomes;
  }
  // Up to four regional attempts run together; later crons pick up the rest.
  const due = REGIONS.filter(
    (r) => (!opts.channel || opts.channel === r.id) && (opts.force || shouldRunDailySnow(states[r.id], now, r.id)),
  );
  await Promise.all(due.slice(0, 4).map((r) => run(r.id)));
  if (!due.length) await run("western-us");
  return outcomes;
}
