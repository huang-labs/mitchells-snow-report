import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCollection } from "@/lib/collect";
import { emptyDailySnowState } from "@/lib/dailysnow";
import { ChannelPublisher, INTERRUPTED, MemoryChannelStorage, type PublisherDeps, type PublisherEnv } from "@/lib/dailysnow/publisher";
import { channelKV, channelStateKey } from "@/lib/dailysnow/regions";
import { dailySnowKey } from "@/lib/dailysnow";
import { MemoryKV, readSnapshot } from "@/lib/store";
import type { DailySnowState, Snapshot } from "@/lib/types";
import { createFixtureFetch } from "./fixtureFetch";

// 8 AM MST: inside Utah's 7–11 AM window.
const now = new Date("2026-11-05T15:00:00Z");
const iso = now.toISOString();
let base: Snapshot;
beforeAll(async () => {
  const kv = new MemoryKV();
  await runCollection({ SNOW_KV: kv }, { now, fetchImpl: createFixtureFetch().fetchImpl });
  base = (await readSnapshot(kv))!;
});
afterEach(() => vi.restoreAllMocks());

const reply = {
  title: "A Snow Outlook",
  summary: "Mountain weather varies across the tracked locations.",
  sections: [{ id: "update", paragraphs: [{ text: "Check the source times for the latest mountain forecast.", figure: "none" }] }],
};
function setup(opts: { env?: Partial<PublisherEnv>; deps?: Partial<PublisherDeps>; storage?: MemoryChannelStorage; kv?: MemoryKV } = {}) {
  const kv = opts.kv ?? new MemoryKV();
  const calls = { n: 0 };
  const env: PublisherEnv = {
    SNOW_KV: kv,
    AI: { async run() { calls.n++; return { response: JSON.stringify(reply) }; } },
    ...opts.env,
  };
  const storage = opts.storage ?? new MemoryChannelStorage();
  const publisher = new ChannelPublisher("utah", storage, env, { snapshot: async () => base, editions: async () => ({}), ...opts.deps });
  const kvState = async () => JSON.parse((await kv.get(channelStateKey("utah"), "text"))!) as DailySnowState;
  return { kv, env, calls, storage, publisher, kvState };
}

describe("ChannelPublisher (one channel's single writer)", () => {
  it("reserves without calling the model, then publishes when the attempt runs", async () => {
    const { publisher, calls, storage, kvState, kv } = setup();
    expect(await publisher.request({ now: iso, worthPosting: true })).toEqual({ channel: "utah", scheduled: iso });
    expect(calls.n).toBe(0);
    expect(await publisher.hasPending()).toBe(true);
    // The reservation is visible to readers before the model runs.
    expect((await kvState()).lastAttemptAt).toBe(iso);
    expect(await publisher.runPending()).toEqual({ channel: "utah", published: "2026-11-05" });
    expect(calls.n).toBeGreaterThan(0);
    const state = await publisher.state();
    expect(state.current?.date).toBe("2026-11-05");
    expect(state.attempts).toEqual({ date: "2026-11-05", count: 1, calls: 2 });
    expect(await kvState()).toEqual(state);
    expect(storage.rows.has("pending")).toBe(false);
    expect(await channelKV(kv, "utah").get(dailySnowKey("2026-11-05"), "text")).not.toBeNull();
    // Published today: the next cron has nothing to do.
    expect(await publisher.request({ now: new Date(+now + 5 * 60000).toISOString(), worthPosting: true })).toBeNull();
  });

  it("lets only one of two concurrent requests reserve, even on its first load", async () => {
    const storage = new MemoryChannelStorage();
    const { publisher, kv } = setup({ storage });
    // Slow I/O is where a Durable Object's input gate opens: the first KV read (the
    // cutover import) and, for the purpose of this test, storage writes.
    const delay = () => new Promise((r) => setTimeout(r, 5));
    const get = kv.get.bind(kv) as (k: string, t: "text") => Promise<string | null>;
    vi.spyOn(kv, "get").mockImplementation((async (k: string, t: "text") => (await delay(), get(k, t))) as never);
    const put = storage.put.bind(storage);
    vi.spyOn(storage, "put").mockImplementation(async (entries) => (await delay(), put(entries)));
    const results = await Promise.all([
      publisher.request({ now: iso, worthPosting: true }),
      publisher.request({ now: iso, worthPosting: true }),
      publisher.request({ now: iso, force: true }),
    ]);
    expect(results.filter((r) => r?.scheduled)).toHaveLength(1);
    // One shared load: a second load finishing late would overwrite the reservation in memory.
    expect(vi.mocked(kv.get).mock.calls.filter(([k]) => k === channelStateKey("utah"))).toHaveLength(1);
    expect(results).toContainEqual({ channel: "utah", skipped: "in-flight" });
    expect((await publisher.state()).attempts.count).toBe(1);
  });

  it("refuses a forced run while an attempt is reserved, and enforces the daily cap", async () => {
    const { publisher } = setup();
    await publisher.request({ now: iso, force: true });
    expect(await publisher.request({ now: iso, force: true })).toEqual({ channel: "utah", skipped: "in-flight" });
    await publisher.runPending();
    for (let i = 1; i < 3; i++) {
      expect((await publisher.request({ now: new Date(+now + i * 60000).toISOString(), force: true }))?.scheduled).toBeTruthy();
      await publisher.runPending();
    }
    expect(await publisher.request({ now: new Date(+now + 9 * 60000).toISOString(), force: true })).toEqual({ channel: "utah", skipped: "channel daily cap" });
  });

  it("does not call the model again when a retried alarm finds its attempt already started", async () => {
    const storage = new MemoryChannelStorage();
    const first = setup({ storage });
    await first.publisher.request({ now: iso, worthPosting: true });
    // The alarm marks the attempt started, then the object is evicted mid-call.
    await storage.put({ pending: { ...(await storage.get<object>("pending")), started: true } });
    const restarted = setup({ storage, kv: first.kv });
    expect(await restarted.publisher.runPending()).toEqual({ channel: "utah", error: INTERRUPTED });
    expect(restarted.calls.n).toBe(0);
    const state = await restarted.publisher.state();
    expect(state).toMatchObject({ lastError: INTERRUPTED, consecutiveFailures: 1, attempts: { count: 1 } });
    expect(await restarted.publisher.hasPending()).toBe(false);
  });

  it("refunds a reserved attempt when the inputs no longer have anything to post", async () => {
    const empty: Snapshot = { schemaVersion: 1, writtenAt: iso, sources: {} };
    const { publisher, calls } = setup({ deps: { snapshot: async () => empty } });
    await publisher.request({ now: iso, worthPosting: true });
    expect(await publisher.runPending()).toEqual({ channel: "utah", skipped: "off-season" });
    expect(calls.n).toBe(0);
    expect((await publisher.state()).attempts.count).toBe(0);
  });

  it("records a failed generation and keeps serving requests", async () => {
    const { publisher } = setup({ deps: { snapshot: async () => { throw new Error("collector unavailable"); } } });
    await publisher.request({ now: iso, worthPosting: true });
    expect(await publisher.runPending()).toEqual({ channel: "utah", error: "collector unavailable" });
    expect(await publisher.state()).toMatchObject({ lastError: "collector unavailable", consecutiveFailures: 1 });
    // Retries follow the schedule: ten minutes later.
    expect(await publisher.request({ now: new Date(+now + 5 * 60000).toISOString(), worthPosting: true })).toBeNull();
    expect((await publisher.request({ now: new Date(+now + 10 * 60000).toISOString(), worthPosting: true }))?.scheduled).toBeTruthy();
  });

  it("skips scheduled runs for a region with nothing to report, and when automatic publication is off", async () => {
    expect(await setup().publisher.request({ now: iso, worthPosting: false })).toEqual({ channel: "utah", skipped: "off-season or inputs unavailable" });
    const manual = setup({ env: { DAILY_SNOW_AUTOMATIC: "false" } });
    expect(await manual.publisher.request({ now: iso, worthPosting: true })).toBeNull();
    expect((await manual.publisher.request({ now: iso, force: true }))?.scheduled).toBe(iso);
    expect(await setup({ env: { AI_ENABLED: "false" } }).publisher.request({ now: iso, force: true })).toBeNull();
  });

  it("starts from the KV state when its storage is empty; seeding only fills an empty store", async () => {
    const kv = new MemoryKV();
    const imported = { ...emptyDailySnowState(), lastError: "from KV", consecutiveFailures: 2 };
    await kv.put(channelStateKey("utah"), JSON.stringify(imported));
    const { publisher, storage } = setup({ kv });
    expect(await publisher.state()).toEqual(imported);
    expect(await publisher.seed({ ...emptyDailySnowState(), lastError: "seeded" })).toBe(true);
    expect((await publisher.state()).lastError).toBe("seeded");
    expect(await publisher.seed({ ...emptyDailySnowState(), lastError: "again" })).toBe(false);
    expect((await storage.get<DailySnowState>("state"))?.lastError).toBe("seeded");
  });

  it("keeps its own state when the KV read copy fails, and repairs the copy on the next request", async () => {
    const { publisher, kv, kvState } = setup();
    const put = vi.spyOn(kv, "put").mockRejectedValueOnce(new Error("KV unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await publisher.request({ now: iso, worthPosting: true });
    expect(await kv.get(channelStateKey("utah"), "text")).toBeNull();
    put.mockRestore();
    await publisher.request({ now: iso, worthPosting: true }); // in flight: not due, but the copy is rewritten
    expect((await kvState()).lastAttemptAt).toBe(iso);
  });
});

describe("Western overview", () => {
  const western = (editions: PublisherDeps["editions"]) =>
    new ChannelPublisher("western-us", new MemoryChannelStorage(), { SNOW_KV: new MemoryKV(), AI: { run: vi.fn() } }, { snapshot: async () => base, editions });
  // 9 AM PST: inside Western's 7:15 AM–noon window.
  const westernNow = "2026-11-05T17:00:00.000Z";

  it("waits for a regional edition, and reads editions after the decision", async () => {
    const editions = vi.fn(async () => ({}));
    const w = western(editions);
    expect(await w.request({ now: "2026-11-05T15:00:00.000Z" })).toBeNull(); // 7 AM PST: not due, no reads
    expect(editions).not.toHaveBeenCalled();
    expect(await w.request({ now: westernNow })).toEqual({ channel: "western-us", skipped: "No current regional editions" });
    expect((await w.state()).attempts.count).toBe(0);
  });

  it("reserves once a regional edition exists", async () => {
    const utah = setup();
    await utah.publisher.request({ now: iso, worthPosting: true });
    await utah.publisher.runPending();
    const post = (await utah.publisher.state()).current!;
    const w = western(async () => ({ utah: post }));
    expect(await w.request({ now: westernNow })).toEqual({ channel: "western-us", scheduled: westernNow });
  });
});
