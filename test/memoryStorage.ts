import { Collector, type CollectorStorage } from "@/lib/collector";
import type { CollectionOptions, CollectorEnv } from "@/lib/collect";
import { REGIONS, type ChannelId } from "@/lib/catalog";
import { ChannelPublisher, currentEditions, MemoryChannelStorage, type PublicationOutcome, type PublisherEnv } from "@/lib/dailysnow/publisher";
import type { ChannelNamespace, CollectorNamespace } from "@/worker/env";

/** Durable Object storage stand-in. Values are cloned, as the runtime serializes them. */
export class MemoryStorage implements CollectorStorage {
  readonly rows = new Map<string, unknown>();
  puts = 0;
  async list<T = unknown>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of [...this.rows].sort(([a], [b]) => a.localeCompare(b)))
      if (!options.prefix || k.startsWith(options.prefix)) out.set(k, structuredClone(v) as T);
    return out;
  }
  async put<T>(entries: Record<string, T>): Promise<void> {
    this.puts++;
    for (const [k, v] of Object.entries(entries)) this.rows.set(k, structuredClone(v));
  }
  async delete(keys: string[]): Promise<number> {
    return keys.filter((k) => this.rows.delete(k)).length;
  }
}

/** A COLLECTOR binding backed by one in-memory Collector, like the single Durable Object instance. */
export function memoryCollector(env: CollectorEnv, seams: Pick<CollectionOptions, "fetchImpl" | "sources"> = {}) {
  const storage = new MemoryStorage();
  const collector = new Collector(storage, env, seams);
  const names: string[] = [];
  const namespace: CollectorNamespace = {
    getByName: (name) => (names.push(name), collector),
  };
  return { storage, collector, namespace, names };
}

/**
 * A CHANNEL binding backed by in-memory ChannelPublishers, one per channel id,
 * like ChannelObject instances. A reserved attempt runs as a background "alarm";
 * `settle()` waits for every alarm started so far.
 */
export function memoryChannels(env: PublisherEnv & { COLLECTOR?: CollectorNamespace }, seams: { fetchImpl?: typeof fetch } = {}) {
  const publishers = new Map<ChannelId, ChannelPublisher>();
  const alarms: Promise<unknown>[] = [];
  const outcomes: PublicationOutcome[] = [];
  const publisher = (id: ChannelId): ChannelPublisher => {
    let p = publishers.get(id);
    if (!p) {
      p = new ChannelPublisher(id, new MemoryChannelStorage(), env, {
        snapshot: () => env.COLLECTOR!.getByName("snapshot").latest(),
        editions: async (now) => currentEditions(Object.fromEntries(await Promise.all(REGIONS.map(async (r) => [r.id, await publisher(r.id).state()]))), REGIONS, now),
        fetchImpl: seams.fetchImpl,
      });
      publishers.set(id, p);
    }
    return p;
  };
  const namespace: ChannelNamespace = {
    getByName: (name) => {
      const p = publisher(name as ChannelId);
      return {
        request: async (_channel, request) => {
          const outcome = await p.request(request);
          if (outcome?.scheduled) alarms.push(p.runPending().then((o) => o && outcomes.push(o)));
          return outcome;
        },
        state: () => p.state(),
        status: async () => ({ state: await p.state(), pending: await p.hasPending() }),
        seed: (_channel, state) => p.seed(state),
      };
    },
  };
  return { namespace, publisher, outcomes, settle: async () => { while (alarms.length) await alarms.shift(); } };
}
