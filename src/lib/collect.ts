import { planDailySnow, type DailySnowPlan } from "./dailysnow";
import { archiveStorms, trackStorms } from "./dailysnow/storm-store";
import { createFetchContext, type CollectorSecrets } from "./http";
import { runChannels, type ChannelsEnv } from "./dailysnow/channels";
import { FORECAST_AREAS, RESORTS, type ChannelId } from "./catalog";
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
 * Run every source concurrently and persist one snapshot. Sources are isolated:
 * one failure (or throw) never affects another source's record.
 */
export async function runCollection(env: CollectorEnv, opts: CollectOptions = {}): Promise<CollectSummary> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const previous = await readSnapshot(env.SNOW_KV);
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
  // Carry over records of sources not collected this run (manual `only` runs);
  // records of sources that no longer exist are dropped. writeSnapshot merges
  // this snapshot with whatever a concurrent run wrote since `previous` was
  // read, keeping the newer attempt per source (see store.ts).
  for (const def of SOURCES) {
    const prev = previous?.sources[def.id];
    if (prev) snapshot.sources[def.id] = prev;
  }
  for (const { rec } of records) snapshot.sources[rec.id] = rec;
  snapshot.areaStorms={};
  snapshot.resortLastOperatingAt={...previous?.resortLastOperatingAt};
  for(const area of FORECAST_AREAS){
    const areaSnapshot=regionalSnapshot(snapshot,area.region,area.id);
    const state=advanceStormTracking(previous?.areaStorms?.[area.id],areaSnapshot,now);
    for(const event of state.events)if(!event.id.startsWith(`${area.id}:`))event.id=`${area.id}:${event.id}`;
    snapshot.areaStorms[area.id]=state;
    await archiveStorms(env.SNOW_KV,{...areaSnapshot,stormTracking:state},now);
  }
  for(const resort of buildDigest(snapshot,snapshot.resortLastOperatingAt,now).resorts){
    if(resort.operatingNow)snapshot.resortLastOperatingAt[resort.id]=now.toISOString();
  }
  try {
    snapshot.snowLog = recordSnowLog(previous?.snowLog, snapshot, now);
  } catch (err) {
    // The timeline's history is optional; collection continues without this run's entries.
    snapshot.snowLog = previous?.snowLog;
    console.error("snowlog: recording failed", err);
  }
  snapshot.writtenAt=new Date().toISOString();
  const stored=await writeSnapshot(env.SNOW_KV,snapshot);
  const publications=await runChannels(env,stored,now,{force:opts.forceDailySnow,channel:opts.channel,fetchImpl:opts.fetchImpl});
  return {
    startedAt:now.toISOString(),durationMs:Date.now()-started,
    results:records.map(({rec,ms})=>({id:rec.id,ok:rec.status==="ok",...(rec.status==="error"?{error:rec.lastError??"unknown"}:{}),ms})),
    skipped,publications,
  };
}
