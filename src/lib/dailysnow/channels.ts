import { CHANNELS, REGIONS, type ChannelId } from "../catalog";
import type { DailySnowState, Snapshot } from "../types";
import type { KVLike } from "../store";
import { dailySnowActivity } from "./digest";
import { channelStateKey, regionalSnapshot } from "./regions";
import { ChannelPublisher, currentEditions, MemoryChannelStorage, type PublicationOutcome, type PublisherEnv } from "./publisher";

export type ChannelsEnv = PublisherEnv;

/** Every channel's state from its KV read copy (written by the channel's publisher). */
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

/** Whether a region has anything to report; the Western overview decides from regional editions instead. */
export function channelWorthPosting(snapshot: Snapshot, channel: ChannelId, now: Date): boolean | undefined {
  return channel === "western-us" ? undefined : dailySnowActivity(regionalSnapshot(snapshot, channel), now).worthPosting;
}

/**
 * Publish in-process, for Node tooling and tests: each requested channel is
 * decided and, when due, run to completion before the next, regions before the
 * Western overview so it sees their editions. Each call starts every channel
 * from its KV state, as a fresh Durable Object would. The deployed Worker uses
 * one ChannelObject per channel instead (src/worker/publication.ts).
 */
export async function runChannels(
  env: ChannelsEnv,
  snapshot: Snapshot,
  now: Date,
  opts: { force?: boolean; channel?: ChannelId; fetchImpl?: typeof fetch } = {},
): Promise<PublicationOutcome[]> {
  if (!env.AI || env.AI_ENABLED === "false") return [];
  const outcomes: PublicationOutcome[] = [];
  const deps = {
    snapshot: async () => snapshot,
    editions: async (at: Date) => currentEditions(await readChannelStates(env.SNOW_KV), REGIONS, at),
    regionStates: () => readChannelStates(env.SNOW_KV),
    fetchImpl: opts.fetchImpl,
  };
  const channels: ChannelId[] = [...REGIONS.map((r) => r.id), "western-us"];
  for (const channel of channels.filter((c) => !opts.channel || c === opts.channel)) {
    const publisher = new ChannelPublisher(channel, new MemoryChannelStorage(), env, deps);
    const requested = await publisher.request({ now: now.toISOString(), force: opts.force, worthPosting: channelWorthPosting(snapshot, channel, now) });
    if (!requested) continue;
    if (!requested.scheduled) {
      outcomes.push(requested);
      continue;
    }
    const done = await publisher.runPending();
    if (done) outcomes.push(done);
  }
  return outcomes;
}
