import { CHANNELS } from "../../src/lib/catalog";
import { emptyDailySnowState } from "../../src/lib/dailysnow";
import { SNAPSHOT_KEY, type KVLike } from "../../src/lib/store";
import type { DailySnowState } from "../../src/lib/types";
import {
  Cloudflare,
  CloudflareApiError,
  PRODUCTION_KV,
  assertPreviewNamespace,
} from "./cloudflare";

export const SEED_KEY = "preview-workflow:seed:v1";
export const STATUS_KEY = "preview-workflow:status:v1";
export interface Key {
  name: string;
  expiration?: number;
}
/** A value held in memory until `PreviewKV.flush`; `expiration` is absolute Unix seconds. */
interface Entry {
  value: ArrayBuffer;
  expiration?: number;
}
/** KV's REST API rejects expirations less than 60 s away. */
const MIN_EXPIRATION_S = 60;

export function baselineKey(key: string): boolean {
  return (
    key === SNAPSHOT_KEY ||
    key.startsWith("plume-panel:") ||
    CHANNELS.some(
      ({ id }) =>
        key === `daily-state:v2:${id}` ||
        key.startsWith(`channel:v1:${id}:dailysnow:v1:`) ||
        key.startsWith(`channel:v1:${id}:dailysnow-fig:v1:`) ||
        key.startsWith(`channel:v1:${id}:dailysnow-fig:v2:`),
    )
  );
}

/** Copy edition/history content, never production reservations, failures or request counters. */
export function baselineValue(key: string, bytes: ArrayBuffer): ArrayBuffer {
  if (!key.startsWith("daily-state:v2:")) return bytes;
  const source = JSON.parse(new TextDecoder().decode(bytes)) as DailySnowState;
  return new TextEncoder().encode(
    JSON.stringify({
      ...emptyDailySnowState(),
      current: source.current,
      history: source.history,
    }),
  ).buffer;
}

const encode = (value: string) =>
  new TextEncoder().encode(value).buffer as ArrayBuffer;
const live = (expiration: number | undefined, nowMs: number) =>
  !expiration || expiration > nowMs / 1000 + MIN_EXPIRATION_S;

/** REST access to one PR's namespace. Production is only ever read. */
export class PreviewStorage {
  constructor(
    private cf: Cloudflare,
    readonly namespace: { id: string; title: string },
    pr: number,
  ) {
    assertPreviewNamespace(namespace, pr);
  }
  async get(key: string, namespace = this.namespace.id) {
    const response = await this.cf.response(
      `/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}`,
      {},
      true,
    );
    return response.status === 404 ? null : response.arrayBuffer();
  }
  async put(key: string, value: ArrayBuffer | string, expiration?: number) {
    const query = expiration ? `?expiration=${expiration}` : "";
    for (let attempt = 0; ; attempt++) {
      try {
        await this.cf.response(
          `/storage/kv/namespaces/${this.namespace.id}/values/${encodeURIComponent(key)}${query}`,
          { method: "PUT", body: value },
        );
        return;
      } catch (error) {
        // Namespace creation can succeed before KV's write path recognizes it.
        // Only this idempotent preview write is retried; auth and other failures are not.
        if (
          !(error instanceof CloudflareApiError) ||
          error.status !== 404 ||
          !error.issues.some(
            (issue) =>
              issue.code === 10013 &&
              /namespace not found/i.test(issue.message),
          ) ||
          attempt >= 5
        )
          throw error;
        const delay = 1000 * 2 ** attempt;
        console.log(
          `Preview KV namespace not ready; retrying write in ${delay / 1000}s (${attempt + 1}/5)`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  /** The allowlisted production baseline, read into memory. Nothing is written. */
  async baseline(now = Date.now()): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>();
    let cursor = "";
    do {
      const response = await this.cf.response(
        `/storage/kv/namespaces/${PRODUCTION_KV}/keys?limit=1000&cursor=${encodeURIComponent(cursor)}`,
      );
      const page = (await response.json()) as {
        success: boolean;
        result: Key[];
        result_info: { cursor?: string };
      };
      if (!page.success)
        throw new Error("Production baseline key listing failed");
      const keys = page.result.filter(
        (k) => baselineKey(k.name) && live(k.expiration, now),
      );
      for (let i = 0; i < keys.length; i += 4) {
        await Promise.all(
          keys.slice(i, i + 4).map(async (key) => {
            const bytes = await this.get(key.name, PRODUCTION_KV);
            if (!bytes) return; // Expired while listing.
            entries.set(key.name, {
              value: baselineValue(key.name, bytes),
              expiration: key.expiration,
            });
          }),
        );
      }
      cursor = page.result_info.cursor ?? "";
    } while (cursor);
    return entries;
  }
}

/**
 * The PR namespace as the preview tooling sees it. Reads fall through to the
 * PR namespace over REST; a first run's production baseline stays in memory
 * until `writeChanged` stores it once. The Preview's Durable Objects then own
 * the snapshot and channel states (seeded from these values, never from an
 * edge KV read that may not see them yet); this class only writes the
 * baseline, the status record and the seed marker.
 */
export class PreviewKV implements KVLike {
  private cache = new Map<string, Entry | null>();
  private dirty = new Set<string>();
  /** Production values copied into this run, or null when the namespace was already seeded. */
  readonly copied: number | null = null;
  private constructor(private storage: PreviewStorage) {}

  /** A never-seeded PR namespace starts from the production baseline. */
  static async open(storage: PreviewStorage, now = Date.now()) {
    const kv = new PreviewKV(storage);
    if ((await storage.get(SEED_KEY)) !== null) return kv;
    const baseline = await storage.baseline(now);
    for (const [key, entry] of baseline) kv.set(key, entry);
    return Object.assign(kv, { copied: baseline.size });
  }

  private set(key: string, entry: Entry) {
    this.cache.set(key, entry);
    this.dirty.add(key);
  }
  private async entry(key: string) {
    if (!this.cache.has(key)) {
      const value = await this.storage.get(key);
      this.cache.set(key, value ? { value } : null);
    }
    return this.cache.get(key)!;
  }

  get(key: string, type: "text"): Promise<string | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  async get(key: string, type: "text" | "arrayBuffer") {
    const entry = await this.entry(key);
    if (!entry) return null;
    return type === "text"
      ? new TextDecoder().decode(entry.value)
      : entry.value.slice(0);
  }
  async put(
    key: string,
    value: string | ArrayBuffer,
    options?: { expirationTtl?: number },
  ) {
    this.set(key, {
      value: typeof value === "string" ? encode(value) : value.slice(0),
      expiration: options?.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : undefined,
    });
  }
  async json<T>(key: string): Promise<T | null> {
    const text = await this.get(key, "text");
    return text ? (JSON.parse(text) as T) : null;
  }

  /** Store every value changed since the last write (a first run's production baseline). */
  async writeChanged(now = Date.now()) {
    const keys = [...this.dirty].filter((k) =>
      live(this.cache.get(k)!.expiration, now),
    );
    for (let i = 0; i < keys.length; i += 4)
      await Promise.all(
        keys.slice(i, i + 4).map((key) => {
          const { value, expiration } = this.cache.get(key)!;
          return this.storage.put(key, value, expiration);
        }),
      );
    this.dirty.clear();
    return keys.length;
  }

  /** Store the status, then (first run only) the seed marker. */
  async finish(status: unknown, now = Date.now()) {
    await this.storage.put(STATUS_KEY, JSON.stringify(status));
    // Without the marker, a later run re-seeds from production rather than
    // trusting a partially written namespace.
    if (this.copied !== null)
      await this.storage.put(
        SEED_KEY,
        JSON.stringify({ seededAt: new Date(now).toISOString(), copied: this.copied }),
      );
  }

  /** Store every changed value, then the status, then (first run only) the seed marker. */
  async flush(status: unknown, now = Date.now()) {
    const written = await this.writeChanged(now);
    await this.finish(status, now);
    return written;
  }
}
