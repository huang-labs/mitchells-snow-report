import type { Snapshot, SourceId, SourceRecord } from "./types";
import { mergeStormTracking } from "./dailysnow/storms";
import { mergeSnowLog } from "./snowlog/record";

/** Minimal KV surface used here (Cloudflare KVNamespace satisfies it). */
export interface KVLike {
  get(key: string, type: "text"): Promise<string | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * All per-source records live in one KV value. One write per five-minute run
 * (288/day) stays well inside KV's write limits, including the free tier's
 * 1,000 writes/day, and lets the API serve a consistent snapshot in one read.
 */
export const SNAPSHOT_KEY = "snapshot:v1";

export async function readSnapshot(kv: KVLike): Promise<Snapshot | null> {
  const raw = await kv.get(SNAPSHOT_KEY, "text");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Snapshot;
    return parsed.schemaVersion === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reconcile a snapshot built from an older read against the latest one stored
 * by a concurrent run (a cron overlapping a manual collect, or a slow model
 * call spanning the next trigger). KV has no compare-and-swap, so instead of
 * the last write winning wholesale, each stored record keeps whichever copy
 * has the newer attempt: per source, the newer lastAttemptAt wins; AI states
 * advance attempt bookkeeping separately from last-good publication, preferring
 * completion over reservation for the same attempt.
 * Sources absent from the incoming snapshot (removed from the code) still drop.
 */
const attemptMs = (r: SourceRecord | undefined): number => (r?.lastAttemptAt ? Date.parse(r.lastAttemptAt) : -1);

interface PublicationState {
  lastAttemptAt: string | null;
  lastFinishedAt?: string | null;
  current: { generatedAt: string } | null;
}
const timestamp = (t: string | null | undefined): number => t && Number.isFinite(Date.parse(t)) ? Date.parse(t) : -1;
const publicationMs = (s: PublicationState): number => timestamp(s.current?.generatedAt);
const stateAttemptMs = (s: PublicationState): number => Math.max(timestamp(s.lastAttemptAt), publicationMs(s));
function completed(s: PublicationState): boolean {
  const attempt = timestamp(s.lastAttemptAt);
  return (attempt >= 0 && timestamp(s.lastFinishedAt) >= attempt)
    || (publicationMs(s) >= 0 && publicationMs(s) >= attempt);
}

/** Attempt bookkeeping and last-good publication advance independently. */
function newerState<T extends PublicationState>(latest: T | undefined, incoming: T | undefined): T | undefined {
  if (!latest) return incoming;
  if (!incoming) return latest;
  const delta = stateAttemptMs(incoming) - stateAttemptMs(latest);
  const state = delta > 0 || (delta === 0 && completed(incoming) && !completed(latest)) ? incoming : latest;
  // A later reservation/failure may still carry a stale output from its initial read.
  const published = publicationMs(incoming) > publicationMs(latest) ? incoming : latest;
  return { ...state, current: published.current };
}

export function mergeSnapshot(latest: Snapshot | null, incoming: Snapshot): Snapshot {
  if (!latest) return incoming;
  const sources: Snapshot["sources"] = {};
  for (const id of Object.keys(incoming.sources) as SourceId[]) {
    const incomingRecord = incoming.sources[id];
    if (!incomingRecord) continue;
    const latestRecord = latest.sources[id];
    sources[id] = !latestRecord || attemptMs(incomingRecord) >= attemptMs(latestRecord) ? incomingRecord : latestRecord;
  }
  const merged: Snapshot = { schemaVersion: incoming.schemaVersion, writtenAt: incoming.writtenAt, sources };
  const dailySnow = newerState(latest.dailySnow, incoming.dailySnow);
  if (dailySnow) {
    // A reservation's older history must not remove a concurrently published edition.
    const entries = [...(latest.dailySnow?.history ?? []), ...(incoming.dailySnow?.history ?? [])];
    const history = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) {
      const prev = history.get(entry.date);
      if (!prev || timestamp(entry.postedAt) > timestamp(prev.postedAt)) history.set(entry.date, entry);
    }
    merged.dailySnow = { ...dailySnow, history: [...history.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, Math.max(latest.dailySnow?.history?.length ?? 0, incoming.dailySnow?.history?.length ?? 0)) };
  }
  const stormTracking = mergeStormTracking(latest.stormTracking, incoming.stormTracking);
  if (stormTracking) merged.stormTracking = stormTracking;
  const snowLog = mergeSnowLog(latest.snowLog, incoming.snowLog, new Date(incoming.writtenAt));
  if (snowLog) merged.snowLog = snowLog;
  merged.resortLastOperatingAt={...latest.resortLastOperatingAt,...incoming.resortLastOperatingAt};
  merged.areaStorms={};
  for(const key of new Set([...Object.keys(latest.areaStorms??{}),...Object.keys(incoming.areaStorms??{})])) {
    const area=key as keyof NonNullable<Snapshot["areaStorms"]>;
    merged.areaStorms[area]=mergeStormTracking(latest.areaStorms?.[area],incoming.areaStorms?.[area]);
  }
  return merged;
}

/**
 * Store a snapshot, merging it with whatever a concurrent collection run wrote
 * since this run read the snapshot. The merge read narrows the lost-update
 * window from a whole run (source collection plus model calls) to the gap
 * between that read and the put; KV's eventual propagation leaves a small
 * residual window, which is accepted rather than serialized with a lock KV
 * cannot make atomic.
 */
export async function writeSnapshot(kv: KVLike, snapshot: Snapshot): Promise<Snapshot> {
  const latest = await readSnapshot(kv);
  const merged = mergeSnapshot(latest, snapshot);
  await kv.put(SNAPSHOT_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * Cropped plume panels (PNG). Keyed by station, model run and panel, so a
 * snapshot always references images of its own run; they expire on their own
 * once newer runs have replaced them.
 */
export const plumePanelKey = (station: string, runCode: string, panel: string) =>
  `plume-panel:v1:${station}:${runCode}:${panel}`;
export { PLUME_PANEL_TTL_S } from "./plumePanels";

/** In-memory KV for tests and the one-off local collection script. */
export class MemoryKV implements KVLike {
  readonly data = new Map<string, string | ArrayBuffer>();
  get(key: string, type: "text"): Promise<string | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  async get(key: string, type: "text" | "arrayBuffer"): Promise<string | ArrayBuffer | null> {
    const v = this.data.get(key);
    if (v === undefined) return null;
    if (type === "text") return typeof v === "string" ? v : new TextDecoder().decode(v);
    return typeof v === "string" ? (new TextEncoder().encode(v).buffer as ArrayBuffer) : v;
  }
  async put(key: string, value: string | ArrayBuffer) {
    this.data.set(key, value);
  }
}
