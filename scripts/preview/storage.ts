import { CHANNELS } from "../../src/lib/catalog";
import { emptyDailySnowState } from "../../src/lib/dailysnow";
import { SNAPSHOT_KEY } from "../../src/lib/store";
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

export class PreviewStorage {
  constructor(
    private cf: Cloudflare,
    readonly namespace: { id: string; title: string },
    pr: number,
  ) {
    assertPreviewNamespace(namespace, pr);
  }
  async get(key: string): Promise<ArrayBuffer | null> {
    const response = await this.cf.response(
      `/storage/kv/namespaces/${this.namespace.id}/values/${encodeURIComponent(key)}`,
      {},
      true,
    );
    return response.status === 404 ? null : response.arrayBuffer();
  }
  async json<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    return value ? (JSON.parse(new TextDecoder().decode(value)) as T) : null;
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
  async seed(now = Date.now()): Promise<number> {
    if (await this.get(SEED_KEY)) return 0;
    let copied = 0;
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
      // Bounded API concurrency; finish all writes before committing the seed marker.
      const keys = page.result.filter(
        (k) =>
          baselineKey(k.name) &&
          (!k.expiration || k.expiration * 1000 > now + 60_000),
      );
      for (let i = 0; i < keys.length; i += 4) {
        const results = await Promise.allSettled(
          keys.slice(i, i + 4).map(async (key) => {
            // Resume interrupted initialization without overwriting already copied/edited preview data.
            if (await this.get(key.name)) return;
            const source = await this.cf.response(
              `/storage/kv/namespaces/${PRODUCTION_KV}/values/${encodeURIComponent(key.name)}`,
              {},
              true,
            );
            if (source.status === 404) return; // May expire while copying.
            const bytes = await source.arrayBuffer();
            if (key.expiration && key.expiration * 1000 <= Date.now() + 60_000)
              return;
            await this.put(
              key.name,
              baselineValue(key.name, bytes),
              key.expiration,
            );
            copied++;
          }),
        );
        const failed = results.find((r) => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      cursor = page.result_info.cursor ?? "";
    } while (cursor);
    await this.put(
      SEED_KEY,
      JSON.stringify({ seededAt: new Date(now).toISOString(), copied }),
    );
    return copied;
  }
}
