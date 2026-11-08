import { Collector, type CollectorStorage } from "@/lib/collector";
import type { CollectionOptions, CollectorEnv } from "@/lib/collect";
import type { CollectorNamespace } from "@/worker/env";

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
