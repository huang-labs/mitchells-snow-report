import { beforeAll, describe, expect, it } from "vitest";
import { planDailySnow } from "@/lib/dailysnow";
import { runCollection } from "@/lib/collect";
import { buildDailyDigest } from "@/lib/dailysnow/digest";
import { archiveStorms, trackStorms } from "@/lib/dailysnow/storm-store";
import { advanceStormTracking, mergeStormTracking, seedStormTracking, stormDigest, stormForPost, stormKey } from "@/lib/dailysnow/storms";
import { askDailySnow, buildModelInput, validateDailySnow } from "@/lib/dailysnow/llm";
import { PRIMARY_MODEL } from "@/lib/ai/model";
import { mergeSnapshot, MemoryKV, readSnapshot, writeSnapshot } from "@/lib/store";
import type { DailySnowPost, NwsPayload, PrimaryResortId, ResortCamsPayload, ResortReport, Snapshot } from "@/lib/types";
import { createFixtureFetch } from "./fixtureFetch";

const HOUR = 3_600_000;
const START = new Date("2026-11-01T13:00:00Z"); // DST fall-back morning, 6 AM Denver.
const at = (hours: number) => new Date(START.getTime() + hours * HOUR);
let base: Snapshot;
beforeAll(async () => {
  const kv = new MemoryKV();
  await runCollection({ SNOW_KV: kv }, { now: START, fetchImpl: createFixtureFetch().fetchImpl });
  base = (await readSnapshot(kv))!;
});

type Snow = { storm?: number; h24?: number; h48?: number; season?: number; reportTime?: string };
function snapshot(hours: number, snow: Partial<Record<PrimaryResortId, Snow>> = {}, forecastIn = 0): Snapshot {
  const sources: Snapshot["sources"] = {};
  for (const [id, amounts] of Object.entries(snow) as Array<[PrimaryResortId, Snow]>) {
    const source = structuredClone(base.sources[id]!);
    source.lastAttemptAt = source.lastSuccessfulFetchAt = at(hours).toISOString();
    const r = source.payload as ResortReport;
    r.reportTime = source.sourceUpdatedAt = amounts.reportTime ?? at(hours).toISOString();
    // Keep unrelated captured windows out of these synthetic storm observations.
    for (const key of ["overnight", "h12", "h72", "d7"] as const) r.snowfall[key] = { state: "unavailable", label: key };
    for (const key of ["storm", "h24", "h48", "season"] as const) {
      r.snowfall[key] = amounts[key] === undefined ? { state: "unavailable", label: key }
        : { state: "reported", label: key, unit: "in", value: amounts[key]! };
    }
    sources[id] = source;
  }
  const nws = structuredClone(base.sources.nws!);
  nws.lastSuccessfulFetchAt = nws.lastAttemptAt = at(hours).toISOString();
  for (const p of (nws.payload as NwsPayload).points) {
    p.gridUpdatedAt = p.lastCheckedAt = at(hours).toISOString();
    p.nextStorm = null;
    p.sixHourSnow = Array.from({ length: 8 }, (_, i) => ({ start: at(hours + 6 * i).toISOString(), snowIn: forecastIn, snowLevelFt: 6000 }));
  }
  sources.nws = nws;
  return { schemaVersion: 1, writtenAt: at(hours).toISOString(), sources };
}
const run = (s: Snapshot, state?: Snapshot["stormTracking"]) => advanceStormTracking(state, s, new Date(s.writtenAt));
const resort = (s: NonNullable<Snapshot["stormTracking"]>, id: PrimaryResortId) => s.events[0].resorts.find((r) => r.id === id)??{id,name:id,total:null,rolling:null};

describe("persistent storm observations", () => {
  it("keeps 15 inches when the 48-hour window shrinks to 12 and Alta resets to zero", () => {
    const monday = run(snapshot(24, { alta: { storm: 15, h24: 10, season: 20 }, snowbird: { h48: 15, h24: 9, season: 30 } }));
    const tuesday = run(snapshot(48, { alta: { storm: 0, h24: 3, season: 20 }, snowbird: { h48: 12, h24: 1, season: 30 } }), monday);
    expect(tuesday.events[0].id).toBe(monday.events[0].id);
    expect(resort(tuesday, "alta").total?.amountIn).toBe(15);
    expect(resort(tuesday, "snowbird").total).toBeNull();
    expect(resort(tuesday, "snowbird").rolling).toMatchObject({ amountIn: 15, window: "48h", collectedAt: at(24).toISOString() });
    expect(tuesday.events[0].status).toBe("closed");
    expect(tuesday.events[0].lastSnowAt).toBe(at(24).toISOString());
  });

  it("tracks a three-day storm, updates 15 to 16, and never adds overlapping totals", () => {
    let state = run(snapshot(0, { alta: { storm: 5, h24: 5, season: 10 } }, 1));
    const id = state.events[0].id;
    state = run(snapshot(24, { alta: { storm: 15, h24: 10, season: 20 } }, 1), state);
    state = run(snapshot(48, { alta: { storm: 16, h24: 1, season: 21 } }), state);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].id).toBe(id);
    expect(resort(state, "alta").total).toMatchObject({ amountIn: 16, previousAmountIn: 15 });
    expect(run(snapshot(48, { alta: { storm: 16, h24: 1, season: 21 } }), state)).toEqual(state);
  });

  it("keeps a short lull in the same storm and resumes when more snow is observed", () => {
    let state = run(snapshot(0, { alta: { storm: 5, season: 10 } }));
    const id = state.events[0].id;
    state = run(snapshot(13, { alta: { storm: 5, season: 10 } }), state);
    expect(state.events[0].status).toBe("wrapping-up");
    state = run(snapshot(20, { alta: { storm: 8, season: 13 } }), state);
    expect(state.events[0]).toMatchObject({ id, status: "active", lastSnowAt: at(20).toISOString() });
  });

  it("bridges a lull longer than a day when the next 18 hours still contain snow", () => {
    const first = run(snapshot(0, { alta: { storm: 5, season: 10 } }));
    const lull = run(snapshot(25, { alta: { storm: 5, season: 10 } }, 1), first);
    expect(lull.events[0].status).toBe("active");
    const more = run(snapshot(30, { alta: { storm: 8, season: 13 } }), lull);
    expect(more.events).toHaveLength(1);
  });

  it("exits recap mode and stays quiet despite repeated old positive totals", () => {
    let state = run(snapshot(0, { alta: { storm: 15, h24: 10, season: 20 } }));
    state = run(snapshot(24, { alta: { storm: 15, h24: 10, season: 20 } }), state);
    expect(stormForPost(state, at(59))).not.toBeNull();
    expect(stormForPost(state, at(60))).toBeNull();
    for (const hours of [60, 84, 108]) state = run(snapshot(hours, { alta: { storm: 15, h24: 10, season: 20 } }), state);
    expect(state.events).toHaveLength(1);
    const s = snapshot(108, { alta: { storm: 15, h24: 10, season: 20 } });
    s.stormTracking = state;
    const build = buildDailyDigest(s, null, [], at(108));
    expect(build.digest.phase).toBe("quiet");
    expect(build.stormRecap).toBeNull();
    expect(build.figures.some((f) => f.figure.kind === "storm-recap")).toBe(false);
  });

  it("starts a separate storm after closure without borrowing a different resort's old rolling snow", () => {
    let state = run(snapshot(0, { alta: { storm: 15, season: 20 }, snowbird: { h48: 15, season: 30 } }));
    state = run(snapshot(24, { alta: { storm: 0, season: 20 }, snowbird: { h48: 12, season: 30 } }), state);
    const old = state.events[0].id;
    state = run(snapshot(30, { alta: { storm: 3, season: 23 }, snowbird: { h48: 9, season: 30 } }), state);
    expect(state.events).toHaveLength(2);
    expect(state.events[0].id).not.toBe(old);
    expect(resort(state, "alta").total?.amountIn).toBe(3);
    expect(resort(state, "snowbird").rolling).toBeNull();
    state = run(snapshot(35, { alta: { storm: 3, season: 23 }, snowbird: { h48: 6, season: 30 } }), state);
    expect(resort(state, "snowbird").rolling).toBeNull();
  });

  it("retains a later positive downward source correction, but not a zero reset", () => {
    let state = run(snapshot(0, { alta: { storm: 15, season: 20 } }));
    state = run(snapshot(5, { alta: { storm: 14, season: 19 } }), state);
    expect(resort(state, "alta").total).toMatchObject({ amountIn: 14, previousAmountIn: 15 });
    state = run(snapshot(6, { alta: { storm: 0, season: 19 } }), state);
    expect(resort(state, "alta").total?.amountIn).toBe(14);
  });

  it("keeps a counter restart within a multi-day storm distinct from a downward correction", () => {
    let state = run(snapshot(0, { alta: { storm: 15, season: 20 } }, 1));
    state = run(snapshot(12, { alta: { storm: 0, season: 20 } }, 1), state);
    state = run(snapshot(24, { alta: { storm: 3, season: 23 } }, 1), state);
    expect(state.events).toHaveLength(1);
    expect(resort(state, "alta")).toMatchObject({ total: { amountIn: 15 }, latestSegment: { amountIn: 3 }, counterResetAt: at(12).toISOString() });
  });

  it("accepts a delayed closing-inch update after closure without opening another storm", () => {
    let state = run(snapshot(0, { alta: { storm: 15, season: 20 } }));
    state = run(snapshot(24, { alta: { storm: 15, season: 20 } }), state);
    state = run(snapshot(26, { alta: { storm: 16, season: 21 } }), state);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].status).toBe("closed");
    expect(resort(state, "alta").total?.amountIn).toBe(16);
  });

  it("does not invent zeros or events from missing, failed, old, or future-dated reports", () => {
    const s = snapshot(0, { alta: { storm: 15 } });
    s.sources.alta!.status = "error";
    expect(run(s).events).toEqual([]);
    expect(run(snapshot(30, { alta: { storm: 15, reportTime: at(0).toISOString() } })).events).toEqual([]);
    expect(run(snapshot(0, { alta: { storm: 15, reportTime: at(1).toISOString() } })).events).toEqual([]);
    expect(run(snapshot(0, { alta: { storm: 0, h24: 0 } })).events).toEqual([]);
    const state = run(snapshot(0, { alta: { storm: 15 } }));
    expect(resort(state, "brighton").total).toBeNull();
    expect(resort(state, "brighton").rolling).toBeNull();
  });

  it("does not call missing, stale or incomplete forecasts dry, and eventually expires unknown weather", () => {
    const state = run(snapshot(0, { alta: { storm: 15 } }));
    const missing = snapshot(24);
    delete missing.sources.nws;
    const incomplete = snapshot(24);
    (incomplete.sources.nws!.payload as NwsPayload).points[0].sixHourSnow = [];
    for (const s of [missing, incomplete]) expect(run(s, state).events[0].status).toBe("active");
    const expired = run(snapshot(48, {}, 1), state);
    expect(expired.events[0]).toMatchObject({ status: "closed", closureReason: "no-new-evidence" });
  });

  it("ignores out-of-order collection and source timestamps", () => {
    const current = run(snapshot(5, { alta: { storm: 16, season: 21 } }));
    expect(run(snapshot(0, { alta: { storm: 15, season: 20 } }), current)).toEqual(current);
    const olderReport = run(snapshot(6, { alta: { storm: 18, reportTime: at(0).toISOString() } }), current);
    expect(resort(olderReport, "alta").total?.amountIn).toBe(16);
  });

  it("merges overlapping writers per resort without reverting newer observations or a closed event", () => {
    const start = run(snapshot(0, { alta: { storm: 10, season: 10 } }));
    const a = run(snapshot(2, { alta: { storm: 12, season: 12 } }), start);
    const b = run(snapshot(3, { snowbird: { h48: 15, season: 15 } }), start);
    const merged = mergeStormTracking(a, b)!;
    expect(resort(merged, "alta").total?.amountIn).toBe(12);
    expect(resort(merged, "snowbird").rolling?.amountIn).toBe(15);
    expect(mergeStormTracking(a, b)).toEqual(mergeStormTracking(b, a));
    const closed = run(snapshot(30), merged);
    expect(mergeStormTracking(closed, a)!.events[0].status).toBe("closed");
    const latest = { ...snapshot(30), stormTracking: closed };
    const incoming = { ...snapshot(2), stormTracking: a };
    expect(mergeSnapshot(latest, incoming).stormTracking?.events[0].status).toBe("closed");
  });

  it("archives records once per material change, for 30 days from the last change", async () => {
    const kv = new MemoryKV();
    const state = run(snapshot(0, { alta: { storm: 15 } }));
    const s = { ...snapshot(0), stormTracking: state };
    const ttls: unknown[] = [];
    const first = kv.put.bind(kv);
    kv.put = async (k: string, v: string | ArrayBuffer, o?: { expirationTtl?: number }) => { ttls.push(o?.expirationTtl); return first(k, v); };
    await archiveStorms(kv, s, at(0));
    expect(ttls).toEqual([30 * 86_400]);
    const key = stormKey(state.events[0].id);
    expect(JSON.parse((await kv.get(key, "text"))!).resorts[0].total.amountIn).toBe(15);
    let puts = 0;
    const put = kv.put.bind(kv);
    kv.put = async (k, v) => { puts++; return put(k, v); };
    await archiveStorms(kv, s, at(1));
    expect(puts).toBe(0);
  });

  it("does not resurrect an expired archive for an unchanged event left in the working set", async () => {
    const kv = new MemoryKV();
    const state = run(snapshot(0, { alta: { storm: 15 } }));
    const s = { ...snapshot(0), stormTracking: state };
    const updated = Date.parse(state.events[0].updatedAt);
    const ttls: unknown[] = [];
    const put = kv.put.bind(kv);
    kv.put = async (k: string, v: string | ArrayBuffer, o?: { expirationTtl?: number }) => { ttls.push(o?.expirationTtl); return put(k, v); };
    // The key is missing (expired or never written): recreate it only for the time it has left.
    await archiveStorms(kv, s, new Date(updated + 20 * 86_400_000));
    expect(ttls).toEqual([10 * 86_400]);
    // Past retention with no material change: skip, even though the key is gone.
    kv.data.clear();
    await archiveStorms(kv, s, new Date(updated + 30 * 86_400_000));
    expect(ttls).toHaveLength(1);
    expect(kv.data.size).toBe(0);
  });

  it("does not let a stale branch close a storm when another branch observed new snow", () => {
    const initial = run(snapshot(0, { alta: { storm: 10, season: 10 } }));
    const staleClosure = run(snapshot(30), initial);
    const newSnow = run(snapshot(25, { alta: { storm: 12, season: 12 } }), initial);
    expect(mergeStormTracking(staleClosure, newSnow)!.events[0]).toMatchObject({ status: "active", closedAt: null, lastSnowAt: at(25).toISOString() });
  });

  it("coalesces overlapping first discoveries and attaches a late resort report to the closed recap", () => {
    const a = run(snapshot(0, { alta: { storm: 15 } }));
    const b = run(snapshot(0.1, { snowbird: { h48: 15 } }));
    const merged = mergeStormTracking(a, b)!;
    expect(merged.events).toHaveLength(1);
    expect(resort(merged, "alta").total?.amountIn).toBe(15);
    expect(resort(merged, "snowbird").rolling?.amountIn).toBe(15);
    const closed = run(snapshot(25), merged);
    const late = run(snapshot(26, { solitude: { storm: 9 } }), closed);
    expect(late.events).toHaveLength(1);
    expect(late.events[0].status).toBe("closed");
    expect(resort(late, "solitude").total?.amountIn).toBe(9);
  });

  it("updates without AI and retains state through snapshot writes", async () => {
    const kv = new MemoryKV();
    await writeSnapshot(kv, snapshot(0, { alta: { storm: 15 } }));
    await runCollection({ SNOW_KV: kv }, { now: at(0), sources: [] });
    const stored = (await readSnapshot(kv))!;
    expect(stored.areaStorms?.LCC?.events[0].resorts[0].total?.amountIn).toBe(15);
    expect(stored.dailySnow).toBeUndefined();
    expect(await kv.get(stormKey(stored.areaStorms!.LCC!.events[0].id), "text")).not.toBeNull();
  });

  it("publishes the retained facts and figure together, survives a rewrite, and freezes the archive", async () => {
    const kv = new MemoryKV();
    const monday = run(snapshot(24, { alta: { storm: 15, season: 20 }, snowbird: { h48: 15, season: 30 } }));
    await writeSnapshot(kv, { ...snapshot(48, { alta: { storm: 0, h24: 3, season: 20 }, snowbird: { h48: 12, season: 30 } }), stormTracking: monday });
    const ai = { async run(_model: string, input: Record<string, unknown>) {
      const messages = input.messages as Array<{ content: string }>;
      if (!messages[1].content.includes("Write today's Daily Snow")) throw new Error("pick is not under test");
      return { response: JSON.stringify({ title: "A Dry Break", summary: "Alta reported 15″ for the storm. Dry weather follows.", sections: [{ id: "update", paragraphs: [{ text: "Alta's reported storm total remains 15″. The discussion expects dry weather.", figure: "none" }] }] }) };
    } };
    let state=await planDailySnow(undefined,{...snapshot(48,{alta:{storm:0,h24:3,season:20},snowbird:{h48:12,season:30}}),stormTracking:monday},{SNOW_KV:kv,AI:ai},at(48),{force:true})!.run!();
    const post=state.current!;
    expect(post.stormRecap?.resorts[0].total?.amountIn).toBe(15);
    expect(post.figures["storm-recap"]).toMatchObject({ kind: "storm-recap", storm: post.stormRecap });
    expect(post.sections[0].paragraphs[0].text).toContain("The discussion expects");
    state=await planDailySnow(state,{...snapshot(48,{alta:{storm:0,h24:3}}),stormTracking:monday},{SNOW_KV:kv,AI:ai},at(48),{force:true})!.run!();
    expect(state.current?.stormRecap?.id).toBe(post.stormRecap?.id);
    const archived = await kv.get(`dailysnow:v1:${post.date}`, "text");
    expect(JSON.parse(archived!).stormRecap).toEqual(post.stormRecap);
    await runCollection({ SNOW_KV: kv }, { now: at(49), sources: [] });
    expect(await kv.get(`dailysnow:v1:${post.date}`, "text")).toBe(archived);
  });

  it("grounds retained storm amounts after live resets and rejects unsupported final framing", () => {
    const state = run(snapshot(0, { alta: { storm: 15 } }));
    const s = { ...snapshot(24, { alta: { storm: 0 } }), stormTracking: run(snapshot(24, { alta: { storm: 0 } }), state) };
    const d = buildDailyDigest(s, null, [], at(24)).digest;
    const raw = { title: "A Break", summary: "Alta reported 15″ for the storm.", sections: [{ id: "update", paragraphs: [{ text: "The discussion expects a dry day.", figure: "storm-recap" }] }] };
    expect(validateDailySnow(raw, d).sections[0].paragraphs[0].text).toBe("The discussion expects a dry day.");
    expect(() => validateDailySnow({ ...raw, summary: "The final numbers are in." }, d)).toThrow(/final storm totals/);
    expect(() => validateDailySnow({ ...raw, summary: "Alta reported 99″ for the storm." }, d)).toThrow(/not in the data/);
    expect(JSON.stringify(buildModelInput("test", d))).toContain("storm-recap");
  });

  it("keeps the primary model when prose distinguishes a rolling observation from a storm total", async () => {
    const s = snapshot(0, { snowbird: { h48: 15 } });
    s.stormTracking = run(s);
    const d = buildDailyDigest(s, null, [], at(0)).digest;
    expect(d.stormRecap?.resorts.find((r) => r.name === "Snowbird")).toMatchObject({
      total: null, rolling: { amountIn: 15, window: "48h" },
    });
    const text = "Snowbird reported 15″ over 48 hours during the storm; this is a rolling observation rather than a storm total.";
    const raw = { title: "A Break", summary: "Earlier observations put the storm in context.", sections: [{ id: "update", paragraphs: [{ text, figure: "storm-recap" }] }] };
    const calls: string[] = [];
    const result = await askDailySnow({ async run(model) {
      calls.push(model);
      return { response: JSON.stringify(raw) };
    } }, d, undefined);
    expect(calls).toEqual([PRIMARY_MODEL]);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.value.sections[0].paragraphs[0].text).toBe(text);
    expect(() => validateDailySnow({ ...raw, summary: "Snowbird reported 99″ over 48 hours." }, d)).toThrow(/not in the data/);
  });

  it("preserves both the storm recap and required plume within the six-figure budget", async () => {
    const kv = new MemoryKV();
    const s = snapshot(0, { alta: { storm: 15 } }, 1);
    s.sources.plumes = structuredClone(base.sources.plumes);
    s.sources.resortcams = structuredClone(base.sources.resortcams);
    for (const cam of (s.sources.resortcams!.payload as ResortCamsPayload).cameras) {
      if (cam.kind === "image") cam.capturedAt = START.toISOString();
    }
    s.stormTracking = run(s);
    for (const c of buildDailyDigest(s, null, [], START).figures) {
      if (c.source?.kind === "kv") await kv.put(c.source.key, new Uint8Array([1, 2, 3]).buffer);
    }
    await writeSnapshot(kv, s);
    const ids = ["nws-snow-lcc", "nws-snow-bcc", "nws-snow-level", "plume-slr-cln", "plume-slr-pkcu1", "stake-alta"];
    const ai = { async run() { return { response: JSON.stringify({ title: "Storm Recap", summary: "Alta reported 15″ for the storm.", sections: [{ id: "update", paragraphs: ids.map((figure) => ({ text: "Forecast guidance:", figure })) }] }) }; } };
    const p=(await planDailySnow(undefined,s,{SNOW_KV:kv,AI:ai},START,{force:true})!.run!()).current!;
    expect(Object.keys(p.figures)).toHaveLength(6);
    expect(p.figures["storm-recap"]).toBeDefined();
    expect(p.figures["plume-snow-cln"]).toBeDefined();
  });

  it.each(["2026-03-08T12:00:00Z", "2026-11-01T13:00:00Z"])("supplies Denver observation times across DST (%s)", (iso) => {
    const event = run(snapshot(0, { alta: { storm: 15 } })).events[0];
    event.resorts[0].total!.reportTime = iso;
    event.resorts[0].total!.collectedAt = iso;
    const digest = stormDigest(event, new Date(iso));
    expect(digest.resorts[0].total).toMatchObject({ reportLocal: expect.stringMatching(/6:00 AM (MST|MDT)/), checkedLocal: expect.stringMatching(/6:00 AM (MST|MDT)/), amountIn: 15 });
    expect(JSON.stringify(digest)).not.toContain(iso);
  });
});

describe("archive bootstrap and attribution", () => {
  function oldPost(hours: number, storm: number, h48: number): DailySnowPost {
    return {
      date: at(hours).toISOString().slice(0, 10), title: "Old", summary: "999 inches of invented prose is never imported.",
      phase: "post-storm", generatedAt: at(hours).toISOString(), model: "test", trigger: "manual", sections: [],
      numbers: { canyons: [], resorts: [
        { id: "alta", name: "Alta", storm, h24: 3, reportTime: at(hours).toISOString() },
        { id: "snowbird", name: "Snowbird", storm: null, h24: 1, reportTime: at(hours).toISOString() },
      ] },
      figures: { "resort-totals": { id: "resort-totals", kind: "totals", caption: "Old", rows: [{ name: "Snowbird", h24: 1, h48, storm: null }] } },
    };
  }

  it("recovers structured observations from the previous edition before processing today's reset", async () => {
    const monday = oldPost(24, 15, 15);
    const tuesday = { ...oldPost(48, 0, 12), older: { date: monday.date, title: monday.title } };
    const seeded = seedStormTracking([tuesday, monday], at(49))!;
    expect(resort(seeded, "alta").total?.amountIn).toBe(15);
    expect(resort(seeded, "snowbird").rolling?.amountIn).toBe(15);
    expect(JSON.stringify(seeded)).not.toContain("999");
    const kv = new MemoryKV();
    await kv.put(`dailysnow:v1:${monday.date}`, JSON.stringify(monday));
    const previous = { ...snapshot(49), dailySnow: { current: tuesday } } as Snapshot;
    const current = snapshot(49, { alta: { storm: 0, h24: 2 } });
    await trackStorms(kv, previous, current, at(49));
    expect(resort(current.stormTracking!, "alta").total?.amountIn).toBe(15);
  });

  it("does not bootstrap unrelated old storms and retries missing archives", async () => {
    expect(seedStormTracking([oldPost(0, 15, 15)], at(100))).toBeUndefined();
    const p = { ...oldPost(24, 15, 15), older: { date: "2026-11-01", title: "Missing" } };
    const previous = { ...snapshot(25), dailySnow: { current: p } } as Snapshot;
    await expect(trackStorms(new MemoryKV(), previous, snapshot(25), at(25))).rejects.toThrow("missing archive");
  });

  it("uses the archive index when legacy editions have no older link", async () => {
    const kv = new MemoryKV();
    const monday = oldPost(24, 15, 15);
    const tuesday = oldPost(48, 0, 12);
    await kv.put(`dailysnow:v1:${monday.date}`, JSON.stringify(monday));
    const previous = { ...snapshot(49), dailySnow: { current: tuesday, history: [
      { date: tuesday.date }, { date: monday.date },
    ] } } as Snapshot;
    const current = snapshot(49);
    await trackStorms(kv, previous, current, at(49));
    expect(resort(current.stormTracking!, "alta").total?.amountIn).toBe(15);
  });
});
