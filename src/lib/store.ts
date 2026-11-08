import type { Snapshot } from "./types";

/** Minimal KV surface used here (Cloudflare KVNamespace satisfies it). */
export interface KVLike {
  get(key: string, type: "text"): Promise<string | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * All per-source records live in one KV value, the read copy of the
 * collector's snapshot. One write per five-minute run (288/day) stays well
 * inside KV's write limits and lets the API serve a consistent snapshot in
 * one read.
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
 * Store a snapshot. Production has a single writer, CollectorObject
 * (src/worker/collector-object.ts), which keeps the authoritative copy in
 * Durable Object storage and rewrites this key after every run; Node tooling
 * (one-off scripts, PR preview preparation) runs one collection at a time.
 * With one writer the stored value is always a whole snapshot, so nothing is
 * merged; readers may briefly see the previous run while KV propagates.
 */
export async function writeSnapshot(kv: KVLike, snapshot: Snapshot): Promise<Snapshot> {
  await kv.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return snapshot;
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
