import { collectSnapshot, type CollectedSnapshot, type CollectionOptions, type CollectorEnv, type SnapshotStore } from "./collect";
import { readSnapshot, writeSnapshot } from "./store";
import type { Snapshot, SourceId, SourceRecord } from "./types";

/**
 * The single writer of the source snapshot. CollectorObject (a Durable Object,
 * src/worker/collector-object.ts) wraps one instance; this module stays free of
 * Workers runtime imports so tests can drive it with in-memory storage.
 *
 * Runs are serialized here, not by the Durable Object runtime: a Durable
 * Object's input gate opens while it awaits network I/O, so two requests could
 * otherwise interleave their upstream fetches. With runs queued, each one reads
 * the previous run's committed snapshot and nothing has to be merged.
 */

/** The part of DurableObjectStorage the collector uses (SQLite-backed storage satisfies it). */
export interface CollectorStorage {
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
}

/** What the Worker asks for. `now` crosses RPC as an ISO string. */
export interface CollectorRequest {
  now?: string;
  only?: SourceId[];
  /** Cron runs coalesce: a cron request that arrives while another waits joins it. */
  scheduled?: boolean;
}

/** A run's result. `joined` marks a cron request that shared an already-waiting run. */
export type CollectorResult = CollectedSnapshot & { joined?: boolean };

/**
 * Storage layout: one row per source and per other snapshot field, so no value
 * nears the 2 MB per-value limit (the whole snapshot was ~350 KB in Nov 2026;
 * NWS, the largest source, ~180 KB). `meta` marks an initialized store.
 */
const META = "meta";
const SOURCE = "source:";
const FIELD = "field:";
/** DurableObjectStorage.put accepts at most 128 entries in one atomic call. */
const MAX_ROWS = 128;

type Meta = Pick<Snapshot, "schemaVersion" | "writtenAt">;

export function snapshotRows(snapshot: Snapshot): Record<string, unknown> {
  const { sources, schemaVersion, writtenAt, ...fields } = snapshot;
  const rows: Record<string, unknown> = { [META]: { schemaVersion, writtenAt } satisfies Meta };
  for (const [id, record] of Object.entries(sources)) if (record) rows[SOURCE + id] = record;
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) rows[FIELD + name] = value;
  return rows;
}

export async function readStoredSnapshot(storage: CollectorStorage): Promise<Snapshot | null> {
  const rows = await storage.list();
  const meta = rows.get(META) as Meta | undefined;
  if (!meta) return null;
  const snapshot: Snapshot = { schemaVersion: meta.schemaVersion, writtenAt: meta.writtenAt, sources: {} };
  for (const [key, value] of rows) {
    if (key.startsWith(SOURCE)) snapshot.sources[key.slice(SOURCE.length) as SourceId] = value as SourceRecord;
    else if (key.startsWith(FIELD)) (snapshot as unknown as Record<string, unknown>)[key.slice(FIELD.length)] = value;
  }
  return snapshot;
}

/** Commit `next` in one atomic put, then drop rows `previous` had that `next` doesn't. */
export async function writeStoredSnapshot(storage: CollectorStorage, next: Snapshot, previous: Snapshot | null): Promise<void> {
  const rows = snapshotRows(next);
  const keys = Object.keys(rows);
  if (keys.length > MAX_ROWS) throw new Error(`Snapshot has ${keys.length} rows; one atomic write holds ${MAX_ROWS}`);
  await storage.put(rows);
  // A row left behind by a failed delete belongs to a removed source or field;
  // collection ignores sources it no longer defines, and the next write retries.
  const stale = previous ? Object.keys(snapshotRows(previous)).filter((k) => !(k in rows)) : [];
  if (stale.length) await storage.delete(stale);
}

export class Collector {
  /** Last committed snapshot; undefined until the first run loads it. */
  private current: Snapshot | null | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private waitingCron: Promise<CollectedSnapshot> | null = null;

  constructor(
    private readonly storage: CollectorStorage,
    private readonly env: CollectorEnv,
    /** Test seams; the Durable Object passes neither. */
    private readonly seams: Pick<CollectionOptions, "fetchImpl" | "sources"> = {},
  ) {}

  collect(request: CollectorRequest = {}): Promise<CollectorResult> {
    // The joining caller must not publish too: the first caller does, once.
    if (request.scheduled && this.waitingCron) return this.waitingCron.then((r) => ({ ...r, joined: true }));
    const run: Promise<CollectedSnapshot> = this.tail.then(() => {
      if (this.waitingCron === run) this.waitingCron = null;
      return this.run(request);
    });
    if (request.scheduled) this.waitingCron = run;
    this.tail = run.catch(() => {});
    return run;
  }

  private run(request: CollectorRequest): Promise<CollectedSnapshot> {
    return collectSnapshot(this.env, this.store(), {
      now: request.now ? new Date(request.now) : new Date(),
      only: request.only?.length ? request.only : undefined,
      ...this.seams,
    });
  }

  private store(): SnapshotStore {
    return {
      read: async () => {
        // First run after a deploy (or eviction) loads storage once; an empty
        // store starts from the KV copy the previous writer left.
        if (this.current === undefined)
          this.current = (await readStoredSnapshot(this.storage)) ?? (await readSnapshot(this.env.SNOW_KV));
        // A copy, as a storage read would give: a run that mutates what it read
        // must not change the committed snapshot it is compared against.
        return structuredClone(this.current);
      },
      write: async (snapshot) => {
        await writeStoredSnapshot(this.storage, snapshot, this.current ?? null);
        this.current = snapshot;
        // KV is the read copy behind /api/report. The authoritative copy is
        // committed above, so a failed KV write only delays readers: the next
        // run writes the whole snapshot again.
        try {
          await writeSnapshot(this.env.SNOW_KV, snapshot);
        } catch (err) {
          console.error("collector: KV read copy not updated", err);
        }
      },
    };
  }
}
