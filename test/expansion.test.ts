import { beforeAll, describe, it, expect } from "vitest";
import { RESORTS, REGIONS, CHANNELS, FORECAST_AREAS, regionById } from "@/lib/catalog";
import { parseFavoriteHtml, parseBachelor, parseJackson, favoriteSources } from "@/lib/sources/favorites";
import { parseMtnPowder } from "@/lib/sources/mtnpowder";
import { runCollection } from "@/lib/collect";
import { MemoryKV, readSnapshot } from "@/lib/store";
import { buildDailyDigest } from "@/lib/dailysnow/digest";
import { regionalSnapshot, channelKV, channelStateKey } from "@/lib/dailysnow/regions";
import { runChannels, readChannelStates } from "@/lib/dailysnow/channels";
import { dailySnowKey, emptyDailySnowState, planDailySnow, dailySnowFigureKey } from "@/lib/dailysnow";
import { buildWesternInput, validateWestern } from "@/lib/dailysnow/western";
import { localDate, zonedToUtc } from "@/lib/time";
import { snowDayEnd, snowDayStart, forecastForDay } from "@/lib/snowlog/days";
import { shouldRunDailySnow } from "@/lib/dailysnow/schedule";
import { GLOBAL_CALL_CAP, LEASE_MS } from "@/lib/dailysnow/reservations";
import { PRIMARY_MODEL, FALLBACK_MODEL } from "@/lib/ai/model";
import type { Snapshot, NwsPayload, ResortReport, DailySnowPost, DailySnowState, PlumePayload } from "@/lib/types";
import { createFixtureFetch, fixture } from "./fixtureFetch";
import { MemoryCoordinator, coordinatorBinding } from "./publicationHelpers";
import { regionalSource } from "@/lib/regionalSource";
import { buildReport } from "@/lib/report";
import { dailySnowActivity } from "@/lib/dailysnow/digest";
import { validateDailySnow } from "@/lib/dailysnow/llm";
import { collectSource } from "@/lib/collect";
import { nwsSource } from "@/lib/sources/nws";
import { plumesSource } from "@/lib/sources/plumes";
import { dailySnowPublicationStatus } from "@/lib/dailysnow/publication";
import { recordSnowLog } from "@/lib/snowlog/record";
const now = new Date("2026-11-05T15:00:00Z");
const json = (name: string) => JSON.parse(fixture(name));
let base: Snapshot;
beforeAll(async () => {
  const kv = new MemoryKV();
  await runCollection({ SNOW_KV: kv }, { now, fetchImpl: createFixtureFetch().fetchImpl });
  base = (await readSnapshot(kv))!;
});
const reply = (name = "A Snow Outlook", figure = "none") => ({
  title: name,
  summary: "Mountain weather varies across the tracked locations.",
  sections: [
    { id: "update", paragraphs: [{ text: "Check the source times for the latest mountain forecast.", figure }] },
  ],
});

describe("partial failures and editorial eligibility", () => {
  it("distinguishes the first scheduled edition, pending work, a delay and an intentional pause",()=>{
    expect(dailySnowPublicationStatus(null,undefined,new Date("2026-11-05T12:00:00Z"),true,"utah")).toBe("scheduled");
    expect(dailySnowPublicationStatus(null,undefined,new Date("2026-11-05T14:00:00Z"),true,"utah")).toBe("pending");
    expect(dailySnowPublicationStatus(null,undefined,new Date("2026-11-05T18:00:00Z"),true,"utah")).toBe("delayed");
    expect(dailySnowPublicationStatus(null,undefined,new Date("2026-11-05T18:00:00Z"),false,"utah")).toBe("paused");
  });
  it("keeps official lift counts and independent timestamps, degrading only the optional feed", async () => {
    const clean = createFixtureFetch().fetchImpl;
    for (const id of ["jackson-hole", "mt-bachelor"] as const) {
      const source = favoriteSources.find((s) => s.id === id)!;
      const result = await collectSource(source, undefined, {}, now, clean);
      const report = result.payload as ResortReport;
      expect(report.liftsTotal).toBe(id === "jackson-hole" ? 13 : 14);
      expect(report.liftsOpen).toBe(0);
      expect(report.operationsUpdatedAt).toBeTruthy();
      expect(report.lifts?.some((l) => /summer/i.test(l.name))).toBe(false);
      const broken = createFixtureFetch([
        [/api\/trail-lift\.json|drupal\/lifts/, () => new Response("down", { status: 503 })],
      ]).fetchImpl;
      const failed = await collectSource(source, undefined, {}, now, broken);
      expect(failed.status).toBe("ok");
      expect((failed.payload as ResortReport).missingSections).toContain("lifts");
      expect((failed.payload as ResortReport).liftsOpen).toBeNull();
    }
  });
  it("cannot record a future-dated snow report as this morning's snowfall", () => {
    const at = new Date("2026-11-05T13:00:00Z");
    const s = structuredClone(base);
    const source = s.sources.alta!;
    source.lastSuccessfulFetchAt = at.toISOString();
    const report = source.payload as ResortReport;
    report.reportTime = "2026-11-06T13:00:00Z";
    report.snowfall.h24 = { state: "reported", value: 12, unit: "in", label: "24 hours" };
    const log = recordSnowLog(undefined, s, at);
    expect(log.resorts.alta?.["2026-11-05"].state).toBe("no_report");
  });
  it("retains a failed NWS point without making neighboring regions fail", async () => {
    const fetchImpl = createFixtureFetch([
      [/gridpoints\/BOU\/36,69$/, () => new Response("down", { status: 503 })],
    ]).fetchImpl;
    const result = await collectSource(nwsSource, base.sources.nws, {}, now, fetchImpl);
    const points = (result.payload as NwsPayload).points;
    expect(result.status).toBe("ok");
    expect(points.find((p) => p.id === "winter-park")?.lastError).toMatch(/503/);
    expect(points.find((p) => p.id === "steamboat")?.lastError).toBeNull();
    const source = buildReport({ ...base, sources: { ...base.sources, nws: result } }, now).sources.nws;
    expect((regionalSource(source, "utah", now).payload as NwsPayload).failures).toEqual([]);
    expect((regionalSource(source, "colorado", now).payload as NwsPayload).failures).toHaveLength(1);
    const first = await collectSource(nwsSource, undefined, {}, now, fetchImpl);
    expect((first.payload as NwsPayload).points.some((p) => p.id === "winter-park")).toBe(false);
    expect((first.payload as NwsPayload).failures).toHaveLength(1);
  });
  it("retains a failed plume station and keeps other regions' footers independent", async () => {
    const fetchImpl = createFixtureFetch([[/r=PALT(?:&|$)/, () => new Response("down", { status: 503 })]]).fetchImpl;
    const result = await collectSource(plumesSource, base.sources.plumes, {}, now, fetchImpl);
    const payload = result.payload as PlumePayload;
    expect(payload.charts).toHaveLength(12);
    expect(payload.charts.find((c) => c.stationCode === "PALT")?.lastError).toMatch(/503/);
    expect(payload.charts.find((c) => c.stationCode === "MTH04")?.lastError).toBeNull();
    const source = buildReport({ ...base, sources: { ...base.sources, plumes: result } }, now).sources.plumes;
    expect((regionalSource(source, "mammoth", now).payload as PlumePayload).failures).toEqual([]);
    expect((regionalSource(source, "tahoe", now).payload as PlumePayload).failures).toHaveLength(1);
  });
  it("withholds future-dated forecasts and stale resort observations from model facts and totals figures", () => {
    const s = structuredClone(regionalSnapshot(base, "tahoe"));
    const point = (s.sources.nws!.payload as NwsPayload).points[0];
    point.gridUpdatedAt = new Date(+now + 3600000).toISOString();
    const result = buildDailyDigest(s, null, [], now);
    expect(result.numbers.canyons).toEqual([]);
    expect(result.digest.areas?.[0].forecastAvailable).toBe(false);
    expect(result.digest.observationCoverage?.currentResorts).toEqual([]);
    expect(result.figures.find((f) => f.figure.id === "resort-totals")).toBeUndefined();
    const text = reply();
    text.sections[0].paragraphs[0].text = "The resort reported 0″ in the last 24 hours.";
    expect(() => validateDailySnow(text, result.digest)).toThrow(/observations unavailable/);
    text.sections[0].paragraphs[0].text = "The University of Utah plume shows a wide spread in snowfall.";
    expect(() => validateDailySnow(text, result.digest)).toThrow(/unseen plume/);
  });
  it("publishes a quiet winter edition at first deployment while distinguishing missing inputs from a pause", () => {
    const s = structuredClone(regionalSnapshot(base, "utah"));
    for (const r of RESORTS.filter((r) => r.region === "utah")) {
      const source = s.sources[r.id]!;
      source.status = "ok";
      source.sourceUpdatedAt = now.toISOString();
      const payload = source.payload as ResortReport;
      payload.reportTime = now.toISOString();
      payload.operatingStatus = null;
      payload.lifts = [];
      payload.liftsOpen = 0;
      for (const metric of Object.values(payload.snowfall)) if (metric.state === "reported") metric.value = 0;
    }
    expect(dailySnowActivity(s, now).worthPosting).toBe(true);
    for (const r of RESORTS.filter((r) => r.region === "utah"))
      (s.sources[r.id]!.payload as ResortReport).operatingStatus = "Closed for the season";
    for (const p of (s.sources.nws!.payload as NwsPayload).points) {
      p.gridUpdatedAt = now.toISOString();
      p.sixHourSnow = [];
      p.hourlySnow = [];
    }
    s.sources.nws!.sourceUpdatedAt = now.toISOString();
    expect(dailySnowActivity(s, now)).toMatchObject({ worthPosting: false, publicationExpected: false });
    delete s.sources.nws;
    expect(dailySnowActivity(s, now)).toMatchObject({ worthPosting: false, publicationExpected: true });
  });
  it("keeps local collection free of inference when generation is disabled", async () => {
    let calls = 0;
    const ai = {
      async run() {
        calls++;
        throw new Error("unexpected");
      },
    };
    await runChannels(
      { SNOW_KV: new MemoryKV(), AI: ai, AI_ENABLED: "false", PUBLICATIONS: coordinatorBinding() },
      base,
      now,
      { channel: "utah", force: true },
    );
    expect(calls).toBe(0);
  });
});

describe("fixed favorites and measured source locations", () => {
  it("keeps exactly the approved 14 favorites and eight regions", () => {
    expect(RESORTS.map((r) => r.name)).toEqual([
      "Alta",
      "Snowbird",
      "Solitude",
      "Brighton",
      "Snowbasin",
      "Palisades Tahoe",
      "Mammoth Mountain",
      "Jackson Hole",
      "Big Sky",
      "Winter Park",
      "Steamboat",
      "Telluride",
      "Crystal Mountain",
      "Mt. Bachelor",
    ]);
    expect(REGIONS).toHaveLength(8);
    expect(CHANNELS).toHaveLength(9);
  });
  it.each([
    ["palisades-tahoe", "Palisades Mid-Mountain", 8000, 0],
    ["mammoth", "McCoy Station", 9600, 15],
    ["winter-park", "Mid-Mountain", null, 0],
    ["steamboat", "Mid-Mountain", 9080, 0],
    ["crystal-mountain", "Mid-Mountain", null, 0],
  ])("selects the mid-mountain series in %s instead of the feed default", (slug, name, _elev, depth) => {
    const r = parseMtnPowder(json(`mtnpowder-${slug}.json`), {
      resort: String(slug),
      sourceUrl: "https://example.test",
      reportingArea: "mid",
    }).report;
    expect(r.reportingLocation?.name).toContain(name);
    expect(r.base).toMatchObject({ state: "reported", value: depth });
    expect(r.snowfall.h24).toMatchObject({ state: "reported", value: 0 });
  });
  it("preserves mountain-wide ranges separately from the selected station depth", () => {
    const r = parseMtnPowder(json("mtnpowder-mammoth.json"), {
      resort: "Mammoth Mountain",
      sourceUrl: "https://example.test",
      reportingArea: "mid",
    }).report;
    expect(r.base).toMatchObject({ value: 15 });
    expect(r.mountainBaseRange).toEqual({ minIn: 12, maxIn: 20 });
  });
  it.each(["snowbasin", "telluride"] as const)(
    "parses the measured %s HTML without third-party editorial content",
    (id) => {
      const r = parseFavoriteHtml(
        id,
        fixture(id === "snowbasin" ? "snowbasin-mountain-report.html" : "telluride-snow-report.html"),
        now,
      );
      expect(r.snowfall.h24).toMatchObject({ state: "reported", value: 0 });
      expect(r.reportTime).toBeTruthy();
      expect(r.lifts?.length).toBeGreaterThan(10);
      expect(r.narrative).toBeNull();
    },
  );
  it("distinguishes absent Jackson windows from reported zero and ignores response/altitude defaults", () => {
    const r = parseJackson(json("jackson-feed.json"));
    expect(r.snowfall.h24).toMatchObject({ state: "reported", value: 0 });
    expect(r.snowfall.h72.state).toBe("unavailable");
    expect(r.reportingLocation?.elevationFt).toBe(8180);
    expect(r.reportTime).toBe("2026-11-02T22:34:00.000Z");
  });
  it("uses Bachelor's explicit modification epoch and Primary report, not its timezone-free date", () => {
    const r = parseBachelor(json("bachelor-feed.json"));
    expect(r.reportTime).toBe("2026-11-04T16:21:09.000Z");
    expect(r.snowfall.d7).toMatchObject({ value: 3 });
    expect(r.snowfall.storm.state).toBe("unavailable");
    expect(() => parseBachelor([{ ...json("bachelor-feed.json")[0], unit_of_measurement: "cm" }])).toThrow(/units/);
  });
  it("collects all ten new feeds with publication time and location provenance", () => {
    expect(favoriteSources).toHaveLength(10);
    for (const source of favoriteSources) {
      const r = base.sources[source.id];
      expect(r?.status, `${source.id}: ${r?.lastError}`).toBe("ok");
      expect((r!.payload as ResortReport).reportingLocation?.name).toBeTruthy();
    }
  });
});

describe("regional boundaries and calendars", () => {
  it("isolates editorial regions without conflating Colorado forecast areas", () => {
    const colorado = regionalSnapshot(base, "colorado");
    expect(Object.keys(colorado.sources).filter((id) => RESORTS.some((r) => r.id === id))).toEqual([
      "winter-park",
      "steamboat",
      "telluride",
    ]);
    expect((colorado.sources.nws?.payload as NwsPayload).points.map((p) => p.id)).toEqual([
      "winter-park",
      "steamboat",
      "telluride",
    ]);
    const d = buildDailyDigest(colorado, null, [], now);
    expect(d.digest.areas?.map((a) => a.id)).toEqual(["winter-park", "steamboat", "telluride"]);
    expect(d.digest.ensemble).toBeUndefined();
  });
  it.each(["2026-03-08", "2026-11-01"])("keeps each snow day at local 6AM through DST (%s)", (date) => {
    const start = snowDayStart(date, "America/Los_Angeles"),
      end = snowDayEnd(date, "America/Los_Angeles");
    expect(end - start).toBe((date.includes("03") ? 23 : 25) * 3600000);
    const series = Array.from({ length: (end - start) / 3600000 }, (_, i) => ({
      start: new Date(start + i * 3600000).toISOString(),
      snowIn: 1,
    }));
    expect(forecastForDay(series, date, -Infinity, "America/Los_Angeles")).toBe(series.length);
  });
  it("starts Mountain and Pacific editions at 6AM local and the Western overview at 7AM Pacific", () => {
    expect(shouldRunDailySnow(undefined, new Date("2026-11-05T13:00:00Z"), "utah")).toBe("morning");
    expect(shouldRunDailySnow(undefined, new Date("2026-11-05T13:00:00Z"), "tahoe")).toBeNull();
    expect(shouldRunDailySnow(undefined, new Date("2026-11-05T14:00:00Z"), "tahoe")).toBe("morning");
    expect(shouldRunDailySnow(undefined, new Date("2026-11-05T14:00:00Z"), "western-us")).toBeNull();
    expect(shouldRunDailySnow(undefined, new Date("2026-11-05T15:00:00Z"), "western-us")).toBe("morning");
  });
});

describe("atomic publication reservations", () => {
  it("allows one winner for overlapping attempts on a channel", async () => {
    const c = new MemoryCoordinator();
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => c.reserve({ channel: "utah", date: "2026-11-05", now: +now })),
    );
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(c.state.calls.reduce((s, v) => s + v.count, 0)).toBe(2);
  });
  it("caps concurrent channels at four and rejects superseded completions", async () => {
    const c = new MemoryCoordinator();
    for (const r of REGIONS.slice(0, 4))
      expect((await c.reserve({ channel: r.id, date: "2026-11-05", now: +now })).ok).toBe(true);
    expect((await c.reserve({ channel: "montana", date: "2026-11-05", now: +now })).reason).toBe(
      "generation concurrency limit",
    );
    const old = c.state.channels.utah!.token;
    const fresh = await c.reserve({ channel: "utah", date: "2026-11-05", now: +now + LEASE_MS });
    expect(fresh.ok).toBe(true);
    expect(await c.finish("utah", old)).toBe(false);
    expect(await c.valid("utah", fresh.token!)).toBe(true);
  });
  it("counts manual attempts and fallback reservations toward per-channel and rolling global caps", async () => {
    const c = new MemoryCoordinator();
    const t = Date.parse("2026-11-05T09:00:00Z");
    for (const channel of CHANNELS) {
      for (let i = 0; i < 3; i++) {
        const r = await c.reserve({ channel: channel.id, date: "2026-11-05", now: t });
        expect(r.ok).toBe(true);
        await c.finish(channel.id, r.token!);
      }
      expect((await c.reserve({ channel: channel.id, date: "2026-11-05", now: t })).reason).toBe("channel daily cap");
    }
    let accepted = 0;
    for (const channel of CHANNELS) {
      const r = await c.reserve({ channel: channel.id, date: "2026-11-06", now: t + 23 * 3600000 });
      if (r.ok) {
        accepted++;
        await c.finish(channel.id, r.token!);
      }
    }
    expect(accepted).toBe(5);
    expect(c.state.calls.reduce((s, v) => s + v.count, 0)).toBe(GLOBAL_CALL_CAP);
    const next = await c.reserve({ channel: "utah", date: "2026-11-06", now: t + 24 * 3600000 + 1 });
    expect(next.ok).toBe(true);
  });
});

describe("independent editions and stored artifacts", () => {
  it("freezes overnight observations separately so Western can validate a true overnight amount",async()=>{
    const s=structuredClone(regionalSnapshot(base,"colorado"));
    const report=s.sources.telluride!.payload as ResortReport;
    report.snowfall.overnight={state:"reported",value:6,unit:"in",label:"Snow overnight"};
    const state=await planDailySnow(undefined,s,{SNOW_KV:new MemoryKV(),DAILY_SNOW_CHANNEL:"colorado",AI:{async run(){return {response:JSON.stringify(reply())};}}},now,{force:true})!.run!();
    report.snowfall.overnight={state:"reported",value:0,unit:"in",label:"Snow overnight"};
    const input=buildWesternInput(base,{colorado:state.current!},now);
    const observation=input.regions[0].observations.find(r=>r.name==="Telluride")!;
    expect(observation.windows.find(w=>w.window==="overnight")).toMatchObject({amountIn:6,label:"Snow overnight"});
    const result=validateWestern({title:"Western Outlook",summary:"Weather varies.",overview:"Read the current regional forecasts.",regions:[{region:"colorado",text:"Telluride reported six inches overnight."}]},input);
    expect(result.regions).toHaveLength(1);
  });
  it("keeps all three Colorado storm recaps when optional figures fill the model's six slots", async () => {
    const s = structuredClone(regionalSnapshot(base, "colorado"));
    s.areaStorms = {};
    for (const r of RESORTS.filter((r) => r.region === "colorado")) {
      s.areaStorms[r.canyon] = {
        checkedAt: now.toISOString(),
        cursors: {},
        events: [
          {
            id: r.canyon + ":" + now.toISOString(),
            firstObservedAt: now.toISOString(),
            lastSnowAt: now.toISOString(),
            updatedAt: now.toISOString(),
            status: "active",
            closedAt: null,
            closureReason: null,
            resorts: [{ id: r.id, name: r.name, total: null, rolling: null }],
          },
        ],
      };
    }
    const candidates = buildDailyDigest(s, null, [], now)
      .figures.filter((c) => c.figure.kind !== "storm-recap")
      .slice(0, 6);
    const answer = {
      ...reply(),
      sections: [
        {
          id: "update",
          paragraphs: candidates.map((c) => ({ text: "The supplied forecast guidance follows.", figure: c.figure.id })),
        },
      ],
    };
    const state = await planDailySnow(
      undefined,
      s,
      {
        SNOW_KV: new MemoryKV(),
        DAILY_SNOW_CHANNEL: "colorado",
        AI: {
          async run() {
            return { response: JSON.stringify(answer) };
          },
        },
      },
      now,
      { force: true },
    )!.run!();
    for (const area of ["winter-park", "steamboat", "telluride"])
      expect(state.current?.figures["storm-recap-" + area]?.kind).toBe("storm-recap");
    expect(Object.keys(state.current!.figures).length).toBeLessThanOrEqual(6);
    expect(state.current?.areaStormRecaps).toHaveLength(3);
  });
  it("publishes regional editions without changing source state or another channel's archive", async () => {
    const kv = new MemoryKV();
    const coordinator = new MemoryCoordinator();
    const ai = {
      async run() {
        return { response: JSON.stringify(reply()) };
      },
    };
    const env = { SNOW_KV: kv, AI: ai, PUBLICATIONS: coordinatorBinding(coordinator) };
    const before = JSON.stringify(base);
    for (const channel of ["utah", "tahoe"] as const) await runChannels(env, base, now, { channel, force: true });
    const states = await readChannelStates(kv);
    expect(states.utah?.current?.channel).toBe("utah");
    expect(states.tahoe?.current?.channel).toBe("tahoe");
    expect(states.utah?.current?.numbers.resorts.map((r) => r.id)).not.toContain("palisades-tahoe");
    expect(states.tahoe?.current?.numbers.resorts.map((r) => r.id)).toEqual(["palisades-tahoe"]);
    expect(await kv.get(dailySnowKey("2026-11-05"), "text")).toBeNull();
    expect(await channelKV(kv, "tahoe").get(dailySnowKey("2026-11-05"), "text")).toBeTruthy();
    expect(JSON.stringify(base)).toBe(before);
  });
  it("automatically freezes a real available plume and preserves earlier revisions through a failed rewrite", async () => {
    const kv = new MemoryKV(),
      s = regionalSnapshot(base, "utah");
    const candidate = buildDailyDigest(s, null, [], now).figures.find((c) => c.figure.id === "plume-snow-cln")!;
    expect(candidate?.source?.kind).toBe("kv");
    if (candidate.source?.kind !== "kv") throw new Error("missing panel");
    await kv.put(candidate.source.key, new Uint8Array([137, 80, 78, 71, 1]).buffer);
    const env = {
      SNOW_KV: channelKV(kv, "utah"),
      DAILY_SNOW_CHANNEL: "utah" as const,
      AI: {
        async run() {
          return { response: JSON.stringify(reply()) };
        },
      },
    };
    const first = await planDailySnow(undefined, s, env, now, { force: true })!.run!();
    const old = first.current!.figures["plume-snow-cln"];
    expect(old?.kind).toBe("image");
    if (old.kind !== "image") throw new Error("not image");
    expect(old.url).toContain("channel=utah");
    const revision = new URL(old.url, "https://example.test").searchParams.get("v")!;
    const bytes = await env.SNOW_KV.get(dailySnowFigureKey(first.current!.date, old.id, revision), "arrayBuffer");
    await kv.put(candidate.source.key, new Uint8Array([137, 80, 78, 71, 2]).buffer);
    const second = await planDailySnow(first, s, env, new Date(+now + 60000), { force: true })!.run!();
    expect(second.current?.figures[old.id]).not.toEqual(old);
    expect(await env.SNOW_KV.get(dailySnowFigureKey(first.current!.date, old.id, revision), "arrayBuffer")).toEqual(
      bytes,
    );
    const saved = await env.SNOW_KV.get(dailySnowKey(first.current!.date), "text");
    const put = env.SNOW_KV.put.bind(env.SNOW_KV);
    env.SNOW_KV.put = async (key, value, options) => {
      if (key === dailySnowKey(first.current!.date)) throw new Error("publication failed");
      await put(key, value, options);
    };
    const failed = await planDailySnow(second, s, env, new Date(+now + 120000), { force: true })!.run!();
    expect(failed.lastError).toBe("publication failed");
    expect(failed.current).toEqual(second.current);
    expect(await env.SNOW_KV.get(dailySnowKey(first.current!.date), "text")).toBe(saved);
  });
  it("falls back once on invalid prose and retains the last good edition when both models fail", async () => {
    const kv = new MemoryKV();
    let failing = false;
    const calls: string[] = [];
    const env = {
      SNOW_KV: kv,
      PUBLICATIONS: coordinatorBinding(),
      AI: {
        async run(model: string) {
          calls.push(model);
          return { response: JSON.stringify(model === PRIMARY_MODEL || failing ? {} : reply()) };
        },
      },
    };
    await runChannels(env, base, now, { channel: "tahoe", force: true });
    const first = (await readChannelStates(kv)).tahoe!;
    expect(calls).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);
    expect(first.current?.model).toBe(FALLBACK_MODEL);
    failing = true;
    await runChannels(env, base, new Date(+now + 60000), { channel: "tahoe", force: true });
    const second = (await readChannelStates(kv)).tahoe!;
    expect(second.current).toEqual(first.current);
    expect(second.lastError).toBeTruthy();
    expect(second.attempts.calls).toBe(4);
  });
  it("rejects a Western highlight quoting another region's number and excludes yesterday's editions", async () => {
    const kv = new MemoryKV();
    const env = {
      SNOW_KV: kv,
      PUBLICATIONS: coordinatorBinding(),
      AI: {
        async run() {
          return { response: JSON.stringify(reply()) };
        },
      },
    };
    for (const channel of ["tahoe", "mammoth"] as const) await runChannels(env, base, now, { channel, force: true });
    const states = await readChannelStates(kv);
    const editions = { tahoe: states.tahoe!.current!, mammoth: states.mammoth!.current! };
    const input = buildWesternInput(base, editions, now);
    expect(input.regions).toHaveLength(2);
    input.regions[0].forecasts = [];
    input.regions[0].observations = [];
    const raw = {
      title: "Western Outlook",
      summary: "Patterns vary.",
      overview: "Read each regional outlook below.",
      regions: [
        { region: "tahoe", text: "The NWS expects 90″." },
        { region: "mammoth", text: "A quiet period." },
      ],
    };
    expect(() => validateWestern(raw, input)).toThrow(/tahoe/);
    const yesterday = { ...editions.tahoe, date: "2026-11-04" };
    expect(buildWesternInput(base, { tahoe: yesterday }, now).regions).toHaveLength(0);
  });
});
