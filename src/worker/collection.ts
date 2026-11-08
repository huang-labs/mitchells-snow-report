import type { CollectOptions, CollectSummary } from "../lib/collect";
import type { CollectorRequest } from "../lib/collector";
import { CHANNELS, REGIONS, type ChannelId } from "../lib/catalog";
import { channelWorthPosting } from "../lib/dailysnow/channels";
import type { PublicationOutcome } from "../lib/dailysnow/publisher";
import type { Snapshot } from "../lib/types";
import type { WorkerEnv } from "./env";

/** The one CollectorObject instance; production and each Preview have their own namespace. */
export const COLLECTOR_NAME = "snapshot";

/**
 * Collect through CollectorObject, then ask each channel's ChannelObject
 * whether to publish. A channel that reserves an attempt runs it from its own
 * alarm, so this returns as soon as attempts are reserved and no model call
 * ever holds a cron or an admin request open.
 */
export async function collectAndPublish(
  env: WorkerEnv,
  opts: Omit<CollectOptions, "sources" | "fetchImpl"> & { scheduled?: boolean } = {},
): Promise<CollectSummary> {
  if (!env.COLLECTOR) throw new Error("COLLECTOR Durable Object binding is not configured");
  const now = opts.now ?? new Date();
  const request: CollectorRequest = { now: now.toISOString(), only: opts.only, scheduled: opts.scheduled };
  const { joined, ...collected } = await env.COLLECTOR.getByName(COLLECTOR_NAME).collect(request);
  // A cron that joined a waiting run leaves publication to the cron that started it.
  if (joined) return { ...collected.summary, publications: [] };
  const started = Date.now();
  const publications = await requestPublications(env, collected.snapshot, now, { force: opts.forceDailySnow, channel: opts.channel });
  return { ...collected.summary, durationMs: collected.summary.durationMs + (Date.now() - started), publications };
}

/** Ask every (or one) channel to decide; regions and the Western overview decide independently. */
export async function requestPublications(
  env: WorkerEnv,
  snapshot: Snapshot,
  now: Date,
  opts: { force?: boolean; channel?: ChannelId } = {},
): Promise<PublicationOutcome[]> {
  if (!env.AI || env.AI_ENABLED === "false") return [];
  if (!opts.force && env.DAILY_SNOW_AUTOMATIC === "false") return [];
  if (!env.CHANNEL) throw new Error("CHANNEL Durable Object binding is not configured");
  const channels = CHANNELS.map((c) => c.id).filter((c) => !opts.channel || c === opts.channel);
  const ask = (channel: ChannelId) =>
    env.CHANNEL!.getByName(channel).request(channel, {
      now: now.toISOString(),
      force: opts.force,
      worthPosting: channelWorthPosting(snapshot, channel, now),
    });
  // Regions first: a forced Western overview in the same request then sees their editions
  // once they publish (its own attempt reads them when its alarm runs).
  const regional = await Promise.all(channels.filter((c) => REGIONS.some((r) => r.id === c)).map(ask));
  const western = channels.includes("western-us") ? [await ask("western-us")] : [];
  return [...regional, ...western].filter((o): o is PublicationOutcome => o !== null);
}
