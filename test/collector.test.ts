import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredSnapshot, writeStoredSnapshot } from "@/lib/collector";
import type { SourceDefinition } from "@/lib/sources/types";
import { MemoryKV, readSnapshot, SNAPSHOT_KEY, writeSnapshot } from "@/lib/store";
import type { Snapshot, SourceId, SourceRecord } from "@/lib/types";
import { collectAndPublish, COLLECTOR_NAME } from "@/worker/collection";
import type { WorkerEnv } from "@/worker/env";
import { MemoryStorage, memoryChannels, memoryCollector } from "./memoryStorage";

const MIN = 60_000;
const T0 = new Date("2026-10-30T14:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN).toISOString();

type Impl = () => Promise<{ payload: unknown; sourceUpdatedAt: string | null }>;
function fakeSource(id: SourceId, impl: Impl): SourceDefinition {
  return { id, label: id, category: "resort", required: true, attribution: "", sourceUrl: "", reportMaxAgeMs: 26 * 60 * MIN, collect: impl };
}
const value = (v: string): Impl => async () => ({ payload: { v }, sourceUpdatedAt: null });
function record(id: SourceId, attempt: string, v: string): SourceRecord {
  return { id, lastAttemptAt: attempt, lastSuccessfulFetchAt: attempt, sourceUpdatedAt: null, status: "ok", lastError: null, lastErrorAt: null, consecutiveFailures: 0, diagnostics: null, payload: { v } };
}
const payloadOf = (s: Snapshot | null, id: SourceId) => s?.sources[id]?.payload;

afterEach(() => vi.restoreAllMocks());

describe("Collector (the single snapshot writer)", () => {
  it("queues overlapping runs, so a held run cannot revert a newer one", async () => {
    // Before CollectorObject, run B's stale copy of snowbird had to be merged away.
    const kv = new MemoryKV();
    let releaseB: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseB = resolve));
    let snowbird = "snowbird-1";
    const sources = [
      fakeSource("alta", async () => {
        if (snowbird !== "snowbird-1") await gate; // only run B waits
        return { payload: { v: `alta-${snowbird}` }, sourceUpdatedAt: null };
      }),
      fakeSource("snowbird", async () => ({ payload: { v: snowbird }, sourceUpdatedAt: null })),
    ];
    const { collector, storage } = memoryCollector({ SNOW_KV: kv }, { sources });
    await collector.collect({ now: at(0) });

    snowbird = "snowbird-B";
    const runB = collector.collect({ now: at(1), only: ["alta"] });
    snowbird = "snowbird-C";
    let cDone = false;
    const runC = collector.collect({ now: at(2), only: ["snowbird"] }).then((r) => ((cDone = true), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(cDone).toBe(false); // C waits for B rather than racing it
    releaseB();
    await Promise.all([runB, runC]);

    const stored = await readStoredSnapshot(storage);
    expect(payloadOf(stored, "alta")).toEqual({ v: "alta-snowbird-C" });
    expect(payloadOf(stored, "snowbird")).toEqual({ v: "snowbird-C" });
    expect(stored!.sources.snowbird!.lastAttemptAt).toBe(at(2));
    // The KV read copy is the same whole snapshot.
    expect(await readSnapshot(kv)).toEqual(stored);
  });

  it("lets a cron request join a waiting cron run instead of queueing another", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sources = [fakeSource("alta", async () => (calls++, await gate, { payload: { v: "x" }, sourceUpdatedAt: null }))];
    const { collector } = memoryCollector({ SNOW_KV: new MemoryKV() }, { sources });
    const first = collector.collect({ now: at(0), scheduled: true });
    await vi.waitFor(() => expect(calls).toBe(1)); // running, held at the gate
    const second = collector.collect({ now: at(5), scheduled: true }); // waiting
    const third = collector.collect({ now: at(10), scheduled: true }); // joins the waiting one
    release();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(calls).toBe(2);
    expect(a.joined).toBeUndefined();
    expect(b.joined).toBeUndefined();
    expect(c.joined).toBe(true);
    expect(c.summary.startedAt).toBe(b.summary.startedAt);
  });

  it("never coalesces manual runs, which may ask for specific sources", async () => {
    let calls = 0;
    const sources = [fakeSource("alta", async () => (calls++, { payload: {}, sourceUpdatedAt: null }))];
    const { collector } = memoryCollector({ SNOW_KV: new MemoryKV() }, { sources });
    await Promise.all([collector.collect({ only: ["alta"] }), collector.collect({ only: ["alta"] }), collector.collect({ only: ["alta"] })]);
    expect(calls).toBe(3);
  });

  it("starts from the KV copy when its storage is empty, then reads only its own storage", async () => {
    const kv = new MemoryKV();
    await writeSnapshot(kv, { schemaVersion: 1, writtenAt: at(0), sources: { snowbird: record("snowbird", at(0), "from-kv") }, snowLog: { resorts: {}, forecasts: {} } });
    const { collector, storage } = memoryCollector({ SNOW_KV: kv }, { sources: [fakeSource("alta", value("a1")), fakeSource("snowbird", value("s1"))] });
    await collector.collect({ now: at(1), only: ["alta"] });
    let stored = await readStoredSnapshot(storage);
    expect(payloadOf(stored, "snowbird")).toEqual({ v: "from-kv" });
    expect(payloadOf(stored, "alta")).toEqual({ v: "a1" });

    // A later KV value (an old Worker version finishing, a manual edit) is not read back.
    await writeSnapshot(kv, { schemaVersion: 1, writtenAt: at(2), sources: {} });
    const restarted = memoryCollector({ SNOW_KV: kv }, { sources: [fakeSource("alta", value("a2"))] });
    for (const [k, v] of storage.rows) restarted.storage.rows.set(k, v); // same storage, fresh instance
    await restarted.collector.collect({ now: at(3), only: ["alta"] });
    stored = await readStoredSnapshot(restarted.storage);
    expect(payloadOf(stored, "snowbird")).toEqual({ v: "from-kv" });
    expect(payloadOf(stored, "alta")).toEqual({ v: "a2" });
    expect(payloadOf(await readSnapshot(kv), "snowbird")).toEqual({ v: "from-kv" });
  });

  it("keeps the committed snapshot when the KV read copy fails, and rewrites KV next run", async () => {
    const kv = new MemoryKV();
    const put = vi.spyOn(kv, "put").mockRejectedValueOnce(new Error("KV unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { collector, storage } = memoryCollector({ SNOW_KV: kv }, { sources: [fakeSource("alta", value("a1")), fakeSource("snowbird", value("s1"))] });
    await collector.collect({ now: at(0) });
    expect(kv.data.has(SNAPSHOT_KEY)).toBe(false);
    expect(payloadOf(await readStoredSnapshot(storage), "alta")).toEqual({ v: "a1" });
    put.mockRestore();
    await collector.collect({ now: at(1), only: ["snowbird"] });
    const copy = await readSnapshot(kv);
    expect(payloadOf(copy, "alta")).toEqual({ v: "a1" });
    expect(copy?.sources.snowbird?.lastAttemptAt).toBe(at(1));
  });

  it("keeps serving later runs after one fails to commit", async () => {
    const { collector, storage } = memoryCollector({ SNOW_KV: new MemoryKV() }, { sources: [fakeSource("alta", value("a1"))] });
    vi.spyOn(storage, "put").mockRejectedValueOnce(new Error("storage reset"));
    await expect(collector.collect({ now: at(0) })).rejects.toThrow("storage reset");
    await collector.collect({ now: at(1) });
    expect((await readStoredSnapshot(storage))?.sources.alta?.lastAttemptAt).toBe(at(1));
  });
});

describe("Collector storage rows", () => {
  const snapshot = (sources: Snapshot["sources"]): Snapshot => ({ schemaVersion: 1, writtenAt: at(0), sources, snowLog: { resorts: {}, forecasts: {} }, areaStorms: {} });

  it("stores one row per source and per field, and round-trips the snapshot", async () => {
    const storage = new MemoryStorage();
    const s = snapshot({ alta: record("alta", at(0), "a"), snowbird: record("snowbird", at(0), "s") });
    await writeStoredSnapshot(storage, s, null);
    expect([...storage.rows.keys()].sort()).toEqual(["field:areaStorms", "field:snowLog", "meta", "source:alta", "source:snowbird"]);
    expect(storage.puts).toBe(1);
    expect(await readStoredSnapshot(storage)).toEqual(s);
  });

  it("deletes the rows of sources and fields the new snapshot no longer has", async () => {
    const storage = new MemoryStorage();
    const before = snapshot({ alta: record("alta", at(0), "a"), snowbird: record("snowbird", at(0), "s") });
    await writeStoredSnapshot(storage, before, null);
    const { snowLog: _dropped, ...rest } = snapshot({ alta: record("alta", at(1), "a2") });
    await writeStoredSnapshot(storage, rest, before);
    expect([...storage.rows.keys()].sort()).toEqual(["field:areaStorms", "meta", "source:alta"]);
    expect(await readStoredSnapshot(storage)).toEqual(rest);
  });

  it("reads an uninitialized store as empty", async () => {
    expect(await readStoredSnapshot(new MemoryStorage())).toBeNull();
  });
});

describe("collectAndPublish (Worker side)", () => {
  function env() {
    const e: WorkerEnv = { SNOW_KV: new MemoryKV(), ASSETS: { fetch: vi.fn() } };
    return e;
  }

  it("routes every run to the one named collector instance", async () => {
    const e = env();
    const c = memoryCollector(e, { sources: [fakeSource("alta", value("a"))] });
    e.COLLECTOR = c.namespace;
    const summary = await collectAndPublish(e, { now: T0 });
    expect(c.names).toEqual([COLLECTOR_NAME]);
    expect(summary.results.map((r) => r.id)).toEqual(["alta"]);
    expect(summary.publications).toEqual([]); // no AI binding
  });

  it("does not publish for a cron that joined another cron's run", async () => {
    const e = env();
    e.AI = { run: vi.fn() };
    const c = memoryCollector(e, { sources: [fakeSource("alta", value("a"))] });
    const channels = memoryChannels(e);
    e.CHANNEL = channels.namespace;
    const asked = vi.spyOn(channels.namespace, "getByName");
    e.COLLECTOR = { getByName: () => ({ collect: async (r) => ({ ...(await c.collector.collect(r)), joined: true }), latest: () => c.collector.latest(), seed: (x) => c.collector.seed(x) }) };
    expect((await collectAndPublish(e, { now: T0, scheduled: true })).publications).toEqual([]);
    expect(asked).not.toHaveBeenCalled();
    // The run that started the work asks every channel.
    e.COLLECTOR = c.namespace;
    await collectAndPublish(e, { now: T0, scheduled: true });
    expect(asked).toHaveBeenCalledTimes(9);
  });

  it("fails clearly when the Durable Object binding is missing", async () => {
    await expect(collectAndPublish(env())).rejects.toThrow("COLLECTOR Durable Object binding is not configured");
  });
});

describe("Collector isolation between runs", () => {
  it("does not let a run that failed to commit leak changes to what it read", async () => {
    let mode: "init" | "mutate" | "echo" = "init";
    const alta: SourceDefinition = {
      ...fakeSource("alta", value("unused")),
      collect: async (ctx) => {
        const previous = ctx.previous as { v: string } | null;
        if (mode === "mutate") previous!.v = "mutated";
        return { payload: mode === "echo" ? { ...previous } : { v: "a" }, sourceUpdatedAt: null };
      },
    };
    const { collector, storage } = memoryCollector({ SNOW_KV: new MemoryKV() }, { sources: [alta] });
    await collector.collect({ now: at(0) });
    mode = "mutate";
    vi.spyOn(storage, "put").mockRejectedValueOnce(new Error("storage reset"));
    await expect(collector.collect({ now: at(1) })).rejects.toThrow("storage reset");
    mode = "echo";
    const third = await collector.collect({ now: at(2) });
    expect(third.snapshot.sources.alta!.payload).toEqual({ v: "a" });
  });
});
