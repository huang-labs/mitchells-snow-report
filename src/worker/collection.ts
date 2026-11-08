import { publishCollected, type CollectOptions, type CollectSummary } from "../lib/collect";
import type { CollectorRequest } from "../lib/collector";
import type { WorkerEnv } from "./env";

/** The one CollectorObject instance; production and each Preview have their own namespace. */
export const COLLECTOR_NAME = "snapshot";

/**
 * Collect through CollectorObject, then publish Daily Snow here in the calling
 * invocation. Publication stays outside the collector's queue, so a model call
 * of several minutes never delays the next cron's source collection.
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
  return publishCollected(env, collected, { ...opts, now });
}
