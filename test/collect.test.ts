import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectSource, runCollection } from "@/lib/collect";
import { buildReport, classify, STALE_AFTER_MS } from "@/lib/report";
import { SOURCES } from "@/lib/sources";
import type { SourceDefinition } from "@/lib/sources/types";
import { mergeSnapshot, MemoryKV, readSnapshot } from "@/lib/store";
import type { DailySnowState, Snapshot, SourceId, SourceRecord } from "@/lib/types";
import { createFixtureFetch, FAKE_TOKENS, FIXTURE_NOW } from "./fixtureFetch";

const MIN = 60_000;
// Newest source capture: CPC 8–14-day outlook issued 3 PM EST Nov 4. Older captures remain valid parser fixtures.
const ALL_SOURCES_NOW = new Date("2026-11-04T21:00:00Z");

function fakeSource(id: "alta" | "snowbird", impl: () => Promise<{ payload: unknown; sourceUpdatedAt: string | null }>): SourceDefinition {
  return { id, label: id, category: "resort", required: true, attribution: "", sourceUrl: "", reportMaxAgeMs: 26 * 60 * MIN, collect: impl };
}

describe("collection with independent failure handling", () => {
  let kv: MemoryKV;
  beforeEach(() => {
    kv = new MemoryKV();
  });

  it("collects every real-source adapter against captured fixtures", async () => {
    const { fetchImpl } = createFixtureFetch();
    const summary = await runCollection({ SNOW_KV: kv }, { now: ALL_SOURCES_NOW, fetchImpl });
    const failed = summary.results.filter((r) => !r.ok);
    expect(failed).toEqual([]);
    expect(summary.results.map((r) => r.id).sort()).toEqual(SOURCES.map((s) => s.id).sort());
  });

  it("preserves the last good payload when a source fails, and other sources keep updating", async () => {
    let altaFails = false;
    let n = 0;
    const sources = [
      fakeSource("alta", async () => {
        if (altaFails) throw new Error("upstream 500");
        return { payload: { v: "alta-1" }, sourceUpdatedAt: "2026-10-30T13:00:00.000Z" };
      }),
      fakeSource("snowbird", async () => ({ payload: { v: `snowbird-${++n}` }, sourceUpdatedAt: null })),
    ];
    const t1 = new Date("2026-10-30T14:00:00Z");
    await runCollection({ SNOW_KV: kv }, { now: t1, sources });
    altaFails = true;
    const t2 = new Date(t1.getTime() + 5 * MIN);
    const summary = await runCollection({ SNOW_KV: kv }, { now: t2, sources });
    expect(summary.results.find((r) => r.id === "alta")).toMatchObject({ ok: false, error: "Error: upstream 500" });

    const snap = (await readSnapshot(kv))!;
    const alta = snap.sources.alta!;
    expect(alta.status).toBe("error");
    expect(alta.payload).toEqual({ v: "alta-1" });
    expect(alta.lastSuccessfulFetchAt).toBe(t1.toISOString());
    expect(alta.lastAttemptAt).toBe(t2.toISOString());
    expect(alta.sourceUpdatedAt).toBe("2026-10-30T13:00:00.000Z");
    expect(alta.consecutiveFailures).toBe(1);
    expect(snap.sources.snowbird!.payload).toEqual({ v: "snowbird-2" });
    expect(snap.sources.snowbird!.lastSuccessfulFetchAt).toBe(t2.toISOString());
  });

  it("treats a validation failure in one feed as that source's failure only", async () => {
    const { fetchImpl } = createFixtureFetch([[/alta\.com/, () => new Response("<html>maintenance</html>")]]);
    const summary = await runCollection({ SNOW_KV: kv }, { now: ALL_SOURCES_NOW, fetchImpl });
    expect(summary.results.find((r) => r.id === "alta")).toMatchObject({ ok: false });
    expect(summary.results.find((r) => r.id === "alta")!.error).toMatch(/ValidationError/);
    expect(summary.results.filter((r) => r.ok).length).toBe(SOURCES.length - 1);
  });

  it("degrades optional sub-feeds inside a source without failing it", async () => {
    const { fetchImpl } = createFixtureFetch([[/api\.snowbird\.com\/api\/v1\/dor\/drupal\/lifts/, () => new Response("err", { status: 502 })]]);
    const rec = await collectSource(SOURCES.find((s) => s.id === "snowbird")!, undefined, {}, FIXTURE_NOW, fetchImpl);
    expect(rec.status).toBe("ok");
    expect((rec.payload as { missingSections?: string[] }).missingSections).toEqual(["lifts"]);
    expect(rec.diagnostics?.upstream.some((u) => u.status === 502)).toBe(true);
  });

  it("does not leak upstream tokens or query strings through the public API", async () => {
    const { fetchImpl } = createFixtureFetch();
    await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl });
    const raw = (await kv.get("snapshot:v1", "text"))!;
    expect(raw).not.toContain(FAKE_TOKENS.solitude); // redacted even in stored diagnostics
    const api = JSON.stringify(buildReport(await readSnapshot(kv), FIXTURE_NOW));
    expect(api).not.toContain(FAKE_TOKENS.solitude);
    expect(api).not.toContain("bearer_token");
  });
});

describe("freshness semantics", () => {
  const def = { reportMaxAgeMs: 26 * 60 * MIN };
  const now = new Date("2026-10-31T01:00:00Z");
  const rec = (over: Partial<SourceRecord>): SourceRecord => ({
    id: "alta",
    lastAttemptAt: now.toISOString(),
    lastSuccessfulFetchAt: now.toISOString(),
    sourceUpdatedAt: now.toISOString(),
    status: "ok",
    lastError: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    diagnostics: null,
    payload: {},
    ...over,
  });

  it("a fresh fetch of an old report is an old report, not current", () => {
    expect(classify(def, rec({ sourceUpdatedAt: "2026-10-29T13:00:00Z" }), now).freshness).toBe("old-report");
    expect(classify(def, rec({}), now).freshness).toBe("current");
  });
  it("unknown publication time stays unknown", () => {
    expect(classify(def, rec({ sourceUpdatedAt: null }), now).freshness).toBe("time-unknown");
    expect(classify({ reportMaxAgeMs: null }, rec({}), now).freshness).toBe("time-unknown");
  });
  it("failing collection becomes stale after the threshold", () => {
    const last = new Date(now.getTime() - STALE_AFTER_MS - MIN).toISOString();
    const r = rec({ lastSuccessfulFetchAt: last, status: "error", consecutiveFailures: 5 });
    expect(classify(def, r, now).freshness).toBe("stale");
    const recent = rec({ lastSuccessfulFetchAt: new Date(now.getTime() - 10 * MIN).toISOString(), status: "error", consecutiveFailures: 2 });
    expect(classify(def, recent, now).freshness).toBe("current");
  });
  it("describes a delayed check without assuming the source or collector failed", () => {
    const last = new Date(now.getTime() - STALE_AFTER_MS - MIN).toISOString();
    expect(classify(def, rec({ lastSuccessfulFetchAt: last }), now)).toEqual({
      freshness: "stale", note: "No successful check within the expected collection window; showing last successful data",
    });
  });
  it("never-collected sources are unavailable and required ones are reported missing", () => {
    expect(classify(def, undefined, now).freshness).toBe("unavailable");
    const report = buildReport(null, now);
    expect(report.requiredMissing.sort()).toEqual(["alta", "big-sky", "brighton", "crystal-mountain", "deer-valley", "jackson-hole", "mammoth-mountain", "mt-bachelor", "palisades-tahoe", "park-city", "plumes", "snowbasin", "snowbird", "solitude", "steamboat", "telluride", "winter-park"]);
    expect(report.sources.nws.freshness).toBe("unavailable");
    expect(report.sources.nws.payload).toBeNull();
  });
});

describe("GET /api/report", () => {
  it("returns the stored snapshot without collecting", async () => {
    const kv = new MemoryKV();
    const { fetchImpl } = createFixtureFetch();
    await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl });
    const spy = vi.spyOn(globalThis, "fetch");
    const { report } = await import("@/worker/report");
    const res = await report({ SNOW_KV: kv });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { sources: { alta: { payload: { resort: string } }; plumes: { payload: { runCode: string } } } };
    expect(body.sources.alta.payload.resort).toBe("Alta");
    expect(body.sources.plumes.payload.runCode).toBe("2026103012");
    expect(spy).not.toHaveBeenCalled(); // API reads never trigger upstream collection
    spy.mockRestore();
  });

  it("returns 503 when KV reads fail", async () => {
    const { report } = await import("@/worker/report");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const kv = new MemoryKV();
    vi.spyOn(kv, "get").mockRejectedValue(new Error("KV unavailable"));
    const res = await report({ SNOW_KV: kv });
    expect(res.status).toBe(503);
    err.mockRestore();
  });
});

describe("per-source collection intervals", () => {
  const at = (min: number) => new Date(FIXTURE_NOW.getTime() + min * MIN);
  const run = async (kv: MemoryKV, min: number) =>
    runCollection({ SNOW_KV: kv }, { now: at(min), fetchImpl: createFixtureFetch().fetchImpl });

  it("collects slow sources on their own cadence and everything else every run", async () => {
    const kv = new MemoryKV();
    const collected: Record<number, string[]> = {};
    for (const min of [0, 5, 10, 15, 20, 25, 30]) {
      collected[min] = (await run(kv, min)).results.map((r) => r.id);
    }
    const has = (min: number, id: string) => collected[min].includes(id);
    expect([0, 5, 10, 15, 20, 25, 30].filter((m) => has(m, "alta"))).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect([0, 5, 10, 15, 20, 25, 30].filter((m) => has(m, "nws"))).toEqual([0, 15, 30]);
    expect(Object.values(collected).flat()).not.toContain("traveltimes");
    expect([0, 5, 10, 15, 20, 25, 30].filter((m) => has(m, "plumes"))).toEqual([0, 30]);
    // Skipped sources keep their record (and payload) in the snapshot.
    const snap = (await readSnapshot(kv))!;
    expect(snap.sources.plumes?.status).toBe("ok");
  });

  it("retries a failed slow source on the very next run", async () => {
    const kv = new MemoryKV();
    const failing = createFixtureFetch([[/weather\.utah\.edu/, () => new Response("down", { status: 503 })]]).fetchImpl;
    await runCollection({ SNOW_KV: kv }, { now: at(0), fetchImpl: failing, only: ["plumes"] });
    const summary = await run(kv, 5);
    expect(summary.results.map((r) => r.id)).toContain("plumes");
    expect(summary.skipped).not.toContain("plumes");
  });

  it("does not call a slow source stale between its scheduled runs", () => {
    const plumes = SOURCES.find((s) => s.id === "plumes")!;
    const now = at(0);
    const rec = (ago: number): SourceRecord => ({
      id: "plumes",
      lastAttemptAt: null,
      lastSuccessfulFetchAt: new Date(now.getTime() - ago * MIN).toISOString(),
      sourceUpdatedAt: now.toISOString(),
      status: "ok",
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      diagnostics: null,
      payload: {},
    });
    expect(classify(plumes, rec(29), now).freshness).toBe("current");
    expect(classify(plumes, rec(46), now).freshness).toBe("current"); // 30-min interval + 22-min margin − 5
    expect(classify(plumes, rec(48), now).freshness).toBe("stale");
  });
});

describe("concurrent snapshot writers", () => {
  let kv: MemoryKV;
  beforeEach(() => {
    kv = new MemoryKV();
  });

  it("keeps a concurrent run's fresher records instead of reverting them", async () => {
    const t1 = new Date("2026-10-30T14:00:00Z");
    await runCollection({ SNOW_KV: kv }, {
      now: t1,
      sources: [
        fakeSource("alta", async () => ({ payload: { v: "alta-1" }, sourceUpdatedAt: null })),
        fakeSource("snowbird", async () => ({ payload: { v: "snowbird-1" }, sourceUpdatedAt: null })),
      ],
    });

    // Run B reads the snapshot, collects alta, and is held before it writes.
    let releaseB: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseB = resolve));
    const t2 = new Date(t1.getTime() + MIN);
    const runB = runCollection({ SNOW_KV: kv }, {
      now: t2,
      sources: [
        fakeSource("alta", async () => {
          await gate;
          return { payload: { v: "alta-B" }, sourceUpdatedAt: null };
        }),
      ],
    });
    // While B is held, another run completes and refreshes snowbird.
    const t3 = new Date(t1.getTime() + 2 * MIN);
    await runCollection({ SNOW_KV: kv }, {
      now: t3,
      sources: [fakeSource("snowbird", async () => ({ payload: { v: "snowbird-C" }, sourceUpdatedAt: null }))],
    });
    releaseB();
    await runB;

    const snap = (await readSnapshot(kv))!;
    expect(snap.sources.alta!.payload).toEqual({ v: "alta-B" });
    expect(snap.sources.alta!.lastAttemptAt).toBe(t2.toISOString());
    // B still carried snowbird-1 from its initial read; the newer attempt survives.
    expect(snap.sources.snowbird!.payload).toEqual({ v: "snowbird-C" });
    expect(snap.sources.snowbird!.lastAttemptAt).toBe(t3.toISOString());
  });

  it("mergeSnapshot keeps the newest attempt per source record", () => {
    const tOld = "2026-10-30T14:00:00.000Z";
    const tNew = "2026-10-30T15:00:00.000Z";
    const rec = (id: SourceId, attempt: string, v: string): SourceRecord => ({
      id,
      lastAttemptAt: attempt,
      lastSuccessfulFetchAt: attempt,
      sourceUpdatedAt: null,
      status: "ok",
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      diagnostics: null,
      payload: { v },
    });
    const latest: Snapshot = {
      schemaVersion: 1,
      writtenAt: tNew,
      sources: { alta: rec("alta", tNew, "alta-latest") },
    };
    const incoming: Snapshot = {
      schemaVersion: 1,
      writtenAt: "2026-10-30T16:00:00.000Z",
      sources: { alta: rec("alta", tOld, "alta-stale"), snowbird: rec("snowbird", tOld, "snowbird-first") },
    };
    const merged = mergeSnapshot(latest, incoming);
    expect(merged.sources.alta!.payload).toEqual({ v: "alta-latest" });
    expect(merged.sources.snowbird!.payload).toEqual({ v: "snowbird-first" });
    expect(merged.writtenAt).toBe(incoming.writtenAt);
  });

  it("mergeSnapshot keeps the newest AI state and drops sources absent from the incoming snapshot", () => {
    const tOld = "2026-10-30T14:00:00.000Z";
    const tNew = "2026-10-30T15:00:00.000Z";
    const latest: Snapshot = {
      schemaVersion: 1,
      writtenAt: tOld,
      sources: { alta: { id: "alta", lastAttemptAt: tOld, lastSuccessfulFetchAt: null, sourceUpdatedAt: null, status: "never", lastError: null, lastErrorAt: null, consecutiveFailures: 0, diagnostics: null, payload: null } },
      dailySnow: { lastAttemptAt: tOld, current: { generatedAt: tOld } } as DailySnowState,
    };
    const incoming: Snapshot = {
      schemaVersion: 1,
      writtenAt: tNew,
      sources: {},
      dailySnow: { lastAttemptAt: tNew, current: { generatedAt: tNew } } as DailySnowState,
    };
    const merged = mergeSnapshot(latest, incoming);
    expect(merged.sources.alta).toBeUndefined(); // not in the incoming snapshot: treated as removed
    expect(merged.dailySnow?.lastAttemptAt).toBe(tNew);
    expect(merged.writtenAt).toBe(tNew);
  });
});
