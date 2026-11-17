import { beforeAll, describe, expect, it } from "vitest";
import { FORECAST_AREAS, PLUME_LOCATIONS, REGIONS, RESORTS, CHANNELS } from "@/lib/catalog";
import { collectSource, runCollection } from "@/lib/collect";
import { regionalSnapshot } from "@/lib/dailysnow/regions";
import { buildDailyDigest } from "@/lib/dailysnow/digest";
import { REGION_ALIASES } from "@/lib/dailysnow/western-timing";
import { usableSnowReport } from "@/lib/snowfall-quality";
import { recordSnowLog } from "@/lib/snowlog/record";
import { parseTaos, taosSource, TAOS_TIME_NOTE, type TaosConditions } from "@/lib/sources/taos";
import { SOURCE_BY_ID } from "@/lib/sources";
import { MemoryKV, readSnapshot } from "@/lib/store";
import type { AfdPayload, NwsPayload, ResortCamsPayload, ResortReport, Snapshot } from "@/lib/types";
import { createFixtureFetch, fixture } from "./fixtureFetch";

// Captured from https://www.skitaos.com/api/conditions on 2026-11-17 00:29 UTC.
const feed = (): TaosConditions => JSON.parse(fixture("taos-conditions.json"));
const now = new Date("2026-11-17T13:30:00Z"); // 6:30 AM MST

describe("Taos Ski Valley official conditions", () => {
  it("reads the published windows, base, season and lift counts, keeping zero distinct from missing", () => {
    const r = parseTaos(feed(), null, now);
    expect(r.resort).toBe("Taos Ski Valley");
    expect(r.sourceUrl).toBe("https://www.skitaos.com/weather");
    expect(r.snowfall.h24).toMatchObject({ state: "reported", value: 0 });
    expect(r.snowfall.h48).toMatchObject({ state: "reported", value: 0 });
    expect(r.snowfall.h72).toMatchObject({ state: "reported", value: 8 });
    expect(r.snowfall.d7).toMatchObject({ state: "reported", value: 8 });
    expect(r.snowfall.overnight).toMatchObject({ state: "reported", value: 6.25 });
    expect(r.snowfall.season).toMatchObject({ state: "reported", value: 15.75 });
    expect(r.base).toMatchObject({ state: "reported", value: 13 });
    expect(r.snowfall.h12.state).toBe("unavailable");
    expect(r.snowfall.storm.state).toBe("unavailable");
    expect([r.liftsOpen, r.liftsTotal]).toEqual([0, 13]);
    expect(r.reportingLocation).toEqual({ name: "Official snow report", elevationFt: null, note: TAOS_TIME_NOTE });
    // Third-party forecast and current-weather blocks are not resort observations.
    expect(r.observations).toEqual([]);
    const missing = parseTaos({ ...feed(), snowData: { ...feed().snowData, last48Hours: null } }, null, now);
    expect(missing.snowfall.h48.state).toBe("not_reported");
    const { last72Hours: _, ...withoutField } = feed().snowData!;
    expect(parseTaos({ ...feed(), snowData: withoutField }, null, now).snowfall.h72.state).toBe("unavailable");
  });

  it("withholds the captured overnight-versus-24 h contradiction from derived use", () => {
    // The capture's overnight 6.25″ exceeds its 0″ 24 and 48 h windows.
    const usable = usableSnowReport(parseTaos(feed(), null, now))!;
    expect(usable.snowfall.overnight.state).not.toBe("reported");
    expect(usable.snowfall.h24.state).not.toBe("reported");
  });

  it("rejects a payload without a snow report", () => {
    expect(() => parseTaos({ liftsOpen: 0 }, null, now)).toThrow(/snowData/);
    expect(() => parseTaos({ snowData: { base: 10 } }, null, now)).toThrow(/24 h/);
  });

  it("times the report by when its figures change, never by an unchanged fetch", () => {
    // No earlier figures: an unchanged report may be yesterday's, so the time is unknown.
    const first = parseTaos(feed(), null, now);
    expect(first.reportTime).toBeNull();
    const later = new Date(now.getTime() + 5 * 60_000);
    // Same figures: no new report, whatever was known stays.
    expect(parseTaos(feed(), first, later).reportTime).toBeNull();
    const dated = { ...first, reportTime: "2026-11-16T13:05:00.000Z" };
    expect(parseTaos(feed(), dated, later).reportTime).toBe("2026-11-16T13:05:00.000Z");
    // Lift counts alone are operations, not a new snow report.
    expect(parseTaos({ ...feed(), liftsOpen: 4 }, dated, later).reportTime).toBe("2026-11-16T13:05:00.000Z");
    // Any changed snow figure is a new report seen at this collection.
    const fresh = parseTaos({ ...feed(), snowData: { ...feed().snowData, overnight: 0, last24Hours: 3 } }, dated, later);
    expect(fresh.reportTime).toBe(later.toISOString());
    expect(parseTaos({ ...feed(), snowData: { ...feed().snowData, base: 14 } }, dated, later).reportTime).toBe(later.toISOString());
  });

  it("collects through the official route and carries the change time across runs", async () => {
    let body = feed();
    const { fetchImpl, calls } = createFixtureFetch([[/skitaos\.com\/api\/conditions/, () => Response.json(body)]]);
    const first = await collectSource(taosSource, undefined, {}, now, fetchImpl);
    expect(first.status).toBe("ok");
    expect(first.sourceUpdatedAt).toBeNull();
    expect(calls).toEqual(["https://www.skitaos.com/api/conditions?season=winter"]);
    body = { ...body, snowData: { ...body.snowData, overnight: 0, last24Hours: 4, last48Hours: 4 } };
    const at = new Date(now.getTime() + 5 * 60_000);
    const second = await collectSource(taosSource, first, {}, at, fetchImpl);
    expect(second.sourceUpdatedAt).toBe(at.toISOString());
    const third = await collectSource(taosSource, second, {}, new Date(at.getTime() + 5 * 60_000), fetchImpl);
    expect(third.sourceUpdatedAt).toBe(at.toISOString());
  });

  it("records a morning's 24 h only once the figures have changed that morning", () => {
    const report = (r: ResortReport, at: Date): Snapshot => ({
      schemaVersion: 1,
      writtenAt: at.toISOString(),
      sources: {
        "taos-ski-valley": {
          id: "taos-ski-valley", status: "ok", payload: r, lastAttemptAt: at.toISOString(),
          lastSuccessfulFetchAt: at.toISOString(), sourceUpdatedAt: r.reportTime, lastError: null,
          lastErrorAt: null, consecutiveFailures: 0, diagnostics: null,
        },
      },
    } as Snapshot);
    const unchanged = parseTaos(feed(), { ...parseTaos(feed(), null, now), reportTime: "2026-11-16T13:05:00.000Z" }, now);
    expect(recordSnowLog(undefined, report(unchanged, now), now).resorts["taos-ski-valley"]?.["2026-11-17"]?.state).toBe("no_report");
    const changed = parseTaos({ ...feed(), snowData: { ...feed().snowData, overnight: 2, last24Hours: 2, last48Hours: 2, last72Hours: 10, last7Days: 10 } }, unchanged, now);
    expect(recordSnowLog(undefined, report(changed, now), now).resorts["taos-ski-valley"]?.["2026-11-17"]).toMatchObject({ state: "reported", valueIn: 2 });
  });
});

describe("New Mexico region", () => {
  let base: Snapshot;
  beforeAll(async () => {
    const kv = new MemoryKV();
    // Plume scoping is covered by the plume tests; their image cropping is the slow part of a full run.
    await runCollection({ SNOW_KV: kv }, { now: new Date("2026-11-17T00:35:00Z"), fetchImpl: createFixtureFetch().fetchImpl, only: ["taos-ski-valley", "winter-park", "steamboat", "telluride", "nws", "nwsafd", "resortcams"] });
    base = (await readSnapshot(kv))!;
  });

  it("follows Telluride and Colorado in the fixed lists", () => {
    const ids = RESORTS.map((r) => r.id);
    expect(ids.indexOf("taos-ski-valley")).toBe(ids.indexOf("telluride") + 1);
    const regions = REGIONS.map((r) => r.id);
    expect(regions.indexOf("new-mexico")).toBe(regions.indexOf("colorado") + 1);
    expect(CHANNELS.find((c) => c.id === "new-mexico")).toMatchObject({ name: "New Mexico", timeZone: "America/Denver" });
    expect(FORECAST_AREAS.find((a) => a.id === "taos-ski-valley")?.region).toBe("new-mexico");
    expect(PLUME_LOCATIONS.filter((p) => p.region === "new-mexico").map((p) => p.code)).toEqual(["TAONM"]);
    expect(SOURCE_BY_ID["taos-ski-valley"]).toBe(taosSource);
    expect(REGION_ALIASES["new-mexico"].test("Snow reaches Taos Ski Valley tonight")).toBe(true);
    expect(REGION_ALIASES.colorado.test("Snow reaches Taos Ski Valley tonight")).toBe(false);
  });

  it("scopes its own resort, NWS Albuquerque point and discussion, and cameras", () => {
    const nm = regionalSnapshot(base, "new-mexico");
    expect(Object.keys(nm.sources).filter((id) => RESORTS.some((r) => r.id === id))).toEqual(["taos-ski-valley"]);
    const points = (nm.sources.nws?.payload as NwsPayload).points;
    expect(points.map((p) => [p.id, p.gridId, p.gridX, p.gridY])).toEqual([["taos-ski-valley", "ABQ", 147, 185]]);
    expect((nm.sources.nwsafd?.payload as AfdPayload).discussions!.map((d) => d.office)).toEqual(["ABQ"]);
    expect(new Set((nm.sources.resortcams?.payload as ResortCamsPayload).cameras.map((c) => c.resort))).toEqual(new Set(["taos-ski-valley"]));
    // Colorado keeps its own points and offices.
    const co = regionalSnapshot(base, "colorado");
    expect((co.sources.nws?.payload as NwsPayload).points.map((p) => p.id)).not.toContain("taos-ski-valley");
    expect((co.sources.nwsafd?.payload as AfdPayload).discussions!.map((d) => d.office)).not.toContain("ABQ");
  });

  it("builds a regional Daily Snow digest for Taos", () => {
    const d = buildDailyDigest(regionalSnapshot(base, "new-mexico"), null, [], new Date("2026-11-17T00:35:00Z"));
    expect(d.digest.areas?.map((a) => a.id)).toEqual(["taos-ski-valley"]);
  });
});
