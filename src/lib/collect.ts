import { archiveStorms } from "./dailysnow/storm-store";
import { createFetchContext, type CollectorSecrets } from "./http";
import { runChannels, type ChannelsEnv } from "./dailysnow/channels";
import { FORECAST_AREAS, type ChannelId } from "./catalog";
import { regionalSnapshot } from "./dailysnow/regions";
import { advanceStormTracking } from "./dailysnow/storms";
import { buildDigest } from "./dailysnow/facts";
import { recordSnowLog } from "./snowlog/record";
import { SOURCES } from "./sources";
import { MINUTE, type SourceDefinition } from "./sources/types";
import { readSnapshot, writeSnapshot, type KVLike } from "./store";
import type { Snapshot, SourceId, SourceRecord } from "./types";

export interface CollectorEnv extends CollectorSecrets, ChannelsEnv {
  SNOW_KV: KVLike;
}

export interface CollectOptions {
  now?: Date;
  sources?: SourceDefinition[];
  fetchImpl?: typeof fetch;
  /** Restrict to specific sources (manual runs). */
  only?: SourceId[];
  /** Ask the model regardless of its schedule (manual runs). */
  channel?:ChannelId;
  /** Write the Daily Snow post regardless of its schedule (manual runs). */
  forceDailySnow?: boolean;
}

export interface CollectSummary {
  startedAt: string;
  durationMs: number;
  results: Array<{ id: SourceId; ok: boolean; error?: string; ms: number }>;
  /** Sources not due this run (collected recently; see SourceDefinition.intervalMs). */
  skipped: SourceId[];
  publications?:Awaited<ReturnType<typeof runChannels>>;

}

/**
 * Whether a source should be collected this run. Cron runs land on exact
 * 5-minute marks, so a minute of slack keeps e.g. a 15-minute source on
 * :00/:15/:30/:45 instead of slipping a run.
 */
export function isDue(def: SourceDefinition, prev: SourceRecord | undefined, now: Date): boolean {
  if (!def.intervalMs || !prev?.lastAttemptAt || prev.status !== "ok") return true;
  return now.getTime() - Date.parse(prev.lastAttemptAt) >= def.intervalMs - MINUTE;
}

function emptyRecord(id: SourceId): SourceRecord {
  return {
    id,
    lastAttemptAt: null,
    lastSuccessfulFetchAt: null,
    sourceUpdatedAt: null,
    status: "never",
    lastError: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    diagnostics: null,
    payload: null,
  };
}

/** Collect one source. Never throws: failures preserve the previous payload. */
export async function collectSource(
  def: SourceDefinition,
  previous: SourceRecord | undefined,
  env: CollectorSecrets,
  now: Date,
  fetchImpl?: typeof fetch,
  kv?: KVLike,
): Promise<SourceRecord> {
  const prev = previous ?? emptyRecord(def.id);
  const ctx = createFetchContext(env, now, fetchImpl, { kv, previous: prev.payload });
  const started = Date.now();
  const attemptAt = now.toISOString();
  try {
    const { payload, sourceUpdatedAt } = await def.collect(ctx);
    return {
      id: def.id,
      lastAttemptAt: attemptAt,
      lastSuccessfulFetchAt: attemptAt,
      sourceUpdatedAt,
      status: "ok",
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      diagnostics: { durationMs: Date.now() - started, upstream: ctx.calls },
      payload,
    };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      ...prev,
      id: def.id,
      lastAttemptAt: attemptAt,
      status: "error",
      lastError: message.slice(0, 500),
      lastErrorAt: attemptAt,
      consecutiveFailures: prev.consecutiveFailures + 1,
      diagnostics: { durationMs: Date.now() - started, upstream: ctx.calls },
      // payload, lastSuccessfulFetchAt and sourceUpdatedAt are preserved from prev.
    };
  }
}

/**
 * Where a collection run reads its previous snapshot and commits the new one.
 * Exactly one run at a time may use a store: production's CollectorObject
 * serializes its runs, and Node tooling runs one collection at a time.
 */
export interface SnapshotStore {
  read(): Promise<Snapshot | null>;
  write(snapshot: Snapshot): Promise<void>;
}

/** The KV snapshot itself as the store, for Node tooling and tests. */
export function kvSnapshotStore(kv: KVLike): SnapshotStore {
  return { read: () => readSnapshot(kv), write: async (s) => void (await writeSnapshot(kv, s)) };
}

export type CollectionOptions = Pick<CollectOptions, "now" | "sources" | "fetchImpl" | "only">;

/** One committed collection: its summary (without publications) and the stored snapshot. */
export interface CollectedSnapshot {
  summary: Omit<CollectSummary, "publications">;
  snapshot: Snapshot;
}

/**
 * Run every due source concurrently, derive storm memory, operating times and
 * the snow log, and commit one snapshot to `store`. Sources are isolated: one
 * failure (or throw) never affects another source's record. Publication is a
 * separate step (publishCollected), so a slow model call never holds the store.
 */
export async function collectSnapshot(env: CollectorEnv, store: SnapshotStore, opts: CollectionOptions = {}): Promise<CollectedSnapshot> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const previous = await store.read();
  const selected = (opts.sources ?? SOURCES).filter((s) => !opts.only || opts.only.includes(s.id));
  // Manual runs (`only`) collect what was asked regardless of intervals.
  const defs = opts.only ? selected : selected.filter((s) => isDue(s, previous?.sources[s.id], now));
  const skipped = selected.filter((s) => !defs.includes(s)).map((s) => s.id);
  const records = await Promise.all(
    defs.map(async (def) => {
      const t = Date.now();
      const rec = await collectSource(def, previous?.sources[def.id], env, now, opts.fetchImpl, env.SNOW_KV);
      return { rec, ms: Date.now() - t };
    }),
  );
  const snapshot: Snapshot = {
    schemaVersion: 1,
    writtenAt: new Date().toISOString(),
    sources: {},
  };
  // Carry over records of sources not collected this run; records of sources
  // that no longer exist are dropped.
  for (const def of SOURCES) {
    const prev = previous?.sources[def.id];
    if (prev) snapshot.sources[def.id] = prev;
  }
  for (const { rec } of records) snapshot.sources[rec.id] = rec;
  // Storm memory is per forecast area. Mitchell's production starts with its own
  // empty KV (docs/EXPANSION_PLAN.md: no Cottonwoods import), so there is no
  // retired single-region stormTracking to migrate; it is never read here.
  snapshot.areaStorms={};
  snapshot.resortLastOperatingAt={...previous?.resortLastOperatingAt};
  for(const area of FORECAST_AREAS){
    try {
      const state=advanceStormTracking(previous?.areaStorms?.[area.id],regionalSnapshot(snapshot,area.region,area.id),now);
      for(const event of state.events)if(!event.id.startsWith(`${area.id}:`))event.id=`${area.id}:${event.id}`;
      snapshot.areaStorms[area.id]=state;
    } catch (err) {
      // One area's failure keeps its previous memory; collection and publication continue.
      const prior=previous?.areaStorms?.[area.id];
      if(prior)snapshot.areaStorms[area.id]=prior;
      console.error(`dailysnow: storm tracking failed for ${area.id}`, err);
    }
  }
  try {
    for(const resort of buildDigest(snapshot,snapshot.resortLastOperatingAt,now).resorts){
      if(resort.operatingNow)snapshot.resortLastOperatingAt[resort.id]=now.toISOString();
    }
  } catch (err) {
    console.error("dailysnow: operating-status bookkeeping failed", err);
  }
  try {
    snapshot.snowLog = recordSnowLog(previous?.snowLog, snapshot, now);
  } catch (err) {
    // The timeline's history is optional; collection continues without this run's entries.
    snapshot.snowLog = previous?.snowLog;
    console.error("snowlog: recording failed", err);
  }
  snapshot.writtenAt=new Date().toISOString();
  await store.write(snapshot);
  // Archive after the snapshot write: working records remain in the snapshot,
  // and the next run retries an area whose archive write failed.
  for(const [area,state] of Object.entries(snapshot.areaStorms??{})){
    try {
      await archiveStorms(env.SNOW_KV,{...snapshot,stormTracking:state},now);
    } catch (err) {
      console.error(`dailysnow: storm archive failed for ${area}`, err);
    }
  }
  return {
    summary: {
      startedAt: now.toISOString(),
      durationMs: Date.now() - started,
      results: records.map(({ rec, ms }) => ({ id: rec.id, ok: rec.status === "ok", ...(rec.status === "error" ? { error: rec.lastError ?? "unknown" } : {}), ms })),
      skipped,
    },
    snapshot,
  };
}

/** Run Daily Snow publication against a committed snapshot and complete the summary. */
export async function publishCollected(env: CollectorEnv, collected: CollectedSnapshot, opts: CollectOptions = {}): Promise<CollectSummary> {
  const started = Date.now();
  const now = opts.now ?? new Date(collected.summary.startedAt);
  const publications = await runChannels(env, collected.snapshot, now, { force: opts.forceDailySnow, channel: opts.channel, fetchImpl: opts.fetchImpl });
  return { ...collected.summary, durationMs: collected.summary.durationMs + (Date.now() - started), publications };
}

/**
 * Collect into the KV snapshot directly, then publish. For Node tooling and
 * tests, which run one collection at a time; the deployed Worker goes through
 * CollectorObject instead (src/worker/collection.ts).
 */
export async function runCollection(env: CollectorEnv, opts: CollectOptions = {}): Promise<CollectSummary> {
  return publishCollected(env, await collectSnapshot(env, kvSnapshotStore(env.SNOW_KV), opts), opts);
}
