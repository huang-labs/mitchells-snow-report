import { beforeAll, describe, it, expect } from "vitest";
import { RESORTS, REGIONS, CHANNELS, FORECAST_AREAS, regionById } from "@/lib/catalog";
import { parseFavoriteHtml, parseBachelor, parseJackson, favoriteSources } from "@/lib/sources/favorites";
import { parseMtnPowder } from "@/lib/sources/mtnpowder";
import { runCollection } from "@/lib/collect";
import { MemoryKV, readSnapshot, writeSnapshot } from "@/lib/store";
import { buildDailyDigest } from "@/lib/dailysnow/digest";
import { regionalSnapshot, channelKV, channelStateKey } from "@/lib/dailysnow/regions";
import { runChannels, readChannelStates } from "@/lib/dailysnow/channels";
import { dailySnowKey, emptyDailySnowState, planDailySnow, dailySnowFigureKey } from "@/lib/dailysnow";
import { buildWesternInput, validateWestern, westernFigures } from "@/lib/dailysnow/western";
import { localDate, zonedToUtc } from "@/lib/time";
import { snowDayEnd, snowDayStart, forecastForDay } from "@/lib/snowlog/days";
import { shouldRunDailySnow } from "@/lib/dailysnow/schedule";
import { PRIMARY_MODEL, FALLBACK_MODEL } from "@/lib/ai/model";
import type { Snapshot, NwsPayload, ResortReport, DailySnowPost, DailySnowState, PlumePayload } from "@/lib/types";
import { createFixtureFetch, fixture, fixtureBytes } from "./fixtureFetch";
import { regionalSource } from "@/lib/regionalSource";
import { buildReport } from "@/lib/report";
import { dailySnowActivity } from "@/lib/dailysnow/digest";
import { validateDailySnow } from "@/lib/dailysnow/llm";
import { collectSource } from "@/lib/collect";
import { nwsSource } from "@/lib/sources/nws";
import { plumesSource } from "@/lib/sources/plumes";
import { nwsAfdSource } from "@/lib/sources/nwsafd";
import { historyEntry } from "@/lib/dailysnow/continuity";
import { inchAmounts } from "@/lib/ai/grounding";
import { isSnowPlume } from "@/lib/dailysnow/plume";
import { dailySnow as dailySnowArchive } from "@/worker/daily-snow";
import type { AfdPayload, CpcPayload } from "@/lib/types";
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
      { SNOW_KV: new MemoryKV(), AI: ai, AI_ENABLED: "false" },
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

describe("publication guards in channel state", () => {
  const replyAi = (calls: { n: number }) => ({
    async run() {
      calls.n++;
      return { response: JSON.stringify(reply()) };
    },
  });
  it("refuses a forced run while the channel's attempt is still in flight", async () => {
    const kv = new MemoryKV();
    const calls = { n: 0 };
    await kv.put(
      channelStateKey("tahoe"),
      JSON.stringify({ ...emptyDailySnowState(), lastAttemptAt: new Date(+now - 60000).toISOString() }),
    );
    const out = await runChannels({ SNOW_KV: kv, AI: replyAi(calls) }, base, now, { channel: "tahoe", force: true });
    expect(out).toEqual([{ channel: "tahoe", skipped: "in-flight" }]);
    expect(calls.n).toBe(0);
  });
  it("counts forced Western attempts toward the channel's daily cap", async () => {
    const kv = new MemoryKV();
    const calls = { n: 0 };
    const env = { SNOW_KV: kv, AI: replyAi(calls) };
    await runChannels(env, base, now, { channel: "tahoe", force: true });
    const westernDate = localDate(now, "America/Los_Angeles");
    await kv.put(
      channelStateKey("western-us"),
      JSON.stringify({ ...emptyDailySnowState(), attempts: { date: westernDate, count: 3, calls: 6 } }),
    );
    calls.n = 0;
    const out = await runChannels(env, base, now, { channel: "western-us", force: true });
    expect(out).toEqual([{ channel: "western-us", skipped: "channel daily cap" }]);
    expect(calls.n).toBe(0);
  });
  it("counts attempts still running from an earlier cron toward the concurrency limit", async () => {
    const kv = new MemoryKV();
    const calls = { n: 0 };
    const at = new Date(+now - 60000).toISOString();
    for (const r of REGIONS.slice(0, 3))
      await kv.put(channelStateKey(r.id), JSON.stringify({ ...emptyDailySnowState(), lastAttemptAt: at }));
    const out = await runChannels({ SNOW_KV: kv, AI: replyAi(calls) }, base, now, { force: true });
    const limited = out.filter((o) => o.skipped === "generation concurrency limit").map((o) => o.channel);
    expect(limited).toEqual(REGIONS.slice(4).map((r) => r.id));
    // The forced Western overview follows the regional attempts.
    expect(out.filter((o) => o.published || o.error).map((o) => o.channel)).toEqual([REGIONS[3].id, "western-us"]);
  });
  it("forces every requested channel, regions before the Western overview, when no channel is named", async () => {
    const kv = new MemoryKV();
    const calls = { n: 0 };
    const out = await runChannels({ SNOW_KV: kv, AI: replyAi(calls) }, base, now, { force: true });
    const attempted = out.filter((o) => o.published || o.error).map((o) => o.channel);
    expect([...attempted.slice(0, 4)].sort()).toEqual(REGIONS.slice(0, 4).map((r) => r.id).sort());
    expect(attempted.at(-1)).toBe("western-us");
    expect(out.filter((o) => o.skipped === "generation concurrency limit").map((o) => o.channel)).toEqual(REGIONS.slice(4).map((r) => r.id));
  });
  it("does not let a superseded run overwrite a newer attempt's state or edition", async () => {
    const kv = new MemoryKV();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const env = {
      SNOW_KV: kv,
      AI: {
        async run() {
          await gate;
          return { response: JSON.stringify(reply()) };
        },
      },
    };
    const slow = runChannels(env, base, now, { channel: "tahoe", force: true });
    await new Promise((r) => setTimeout(r, 0));
    const newer = { ...emptyDailySnowState(), lastAttemptAt: new Date(+now + 13 * 60000).toISOString() };
    await kv.put(channelStateKey("tahoe"), JSON.stringify(newer));
    release();
    const out = await slow;
    expect(out[0].error).toMatch(/superseded/);
    expect(JSON.parse((await kv.get(channelStateKey("tahoe"), "text"))!)).toEqual(newer);
    expect(await channelKV(kv, "tahoe").get(dailySnowKey("2026-11-05"), "text")).toBeNull();
  });
});

describe("independent editions and stored artifacts", () => {
  it("freezes overnight observations separately in Western context",async()=>{
    const s=structuredClone(regionalSnapshot(base,"colorado"));
    const report=s.sources.telluride!.payload as ResortReport;
    report.snowfall.overnight={state:"reported",value:6,unit:"in",label:"Snow overnight"};
    const totals=buildDailyDigest(s,null,[],now).figures.find(f=>f.figure.id==="resort-totals")?.figure;
    expect(totals?.kind).toBe("totals");
    if(totals?.kind==="totals")expect(totals.rows.find(r=>r.name==="Telluride")?.h24).toBe(0);
    const state=await planDailySnow(undefined,s,{SNOW_KV:new MemoryKV(),DAILY_SNOW_CHANNEL:"colorado",AI:{async run(){return {response:JSON.stringify(reply())};}}},now,{force:true})!.run!();
    report.snowfall.overnight={state:"reported",value:0,unit:"in",label:"Snow overnight"};
    const input=buildWesternInput(base,{colorado:state.current!},now);
    expect(input.asOfLocal).toContain("7:00 AM PST");
    const observation=input.regions[0].observations.find(r=>r.name==="Telluride")!;
    expect(observation.windows.find(w=>w.window==="overnight")).toMatchObject({amountIn:6,label:"Snow overnight"});

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
    // Captions name the forecast area for readers, never its internal id.
    expect(state.current?.figures["storm-recap-winter-park"]?.caption).toBe("Storm observations · Winter Park");
  });
  it("publishes regional editions without changing source state or another channel's archive", async () => {
    const kv = new MemoryKV();
    const ai = {
      async run() {
        return { response: JSON.stringify(reply()) };
      },
    };
    const env = { SNOW_KV: kv, AI: ai };
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
  it("keeps Western amounts in computed figures, rejects links, and excludes yesterday's editions", async () => {
    const kv = new MemoryKV();
    const env = {
      SNOW_KV: kv,
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
      title: "Western Outlook", summary: "Patterns vary.",
      sections: [
        {id: "update", paragraphs: [{text: "The western pattern varies."}, {text: "Timing differs across mountain ranges."}]},
        {id: "short-term", paragraphs: [{text: "The NWS expects 90″."}, {text: "Amounts belong in figures."}]},
        {id: "extended", paragraphs: [{text: "Later guidance remains limited."}, {text: "Check future updates."}]},
      ],
    };
    expect(() => validateWestern(raw, input)).toThrow(/snowfall amounts/);
    raw.sections[1].paragraphs[0].text = "The mountain outlook follows.";
    expect(validateWestern(raw, input).shortTerm).toHaveLength(2);
    raw.sections[1].paragraphs[0].text = "Read [Tahoe](/daily-snow/tahoe).";
    expect(() => validateWestern(raw, input)).toThrow(/links/);
    const figures = westernFigures(input);
    expect(Object.values(figures).every((f) => f.kind === "forecast-comparison")).toBe(true);
    const yesterday = { ...editions.tahoe, date: "2026-11-04" };
    expect(buildWesternInput(base, { tahoe: yesterday }, now).regions).toHaveLength(0);
  });
});

describe("West comparison figures", () => {
  it("freezes matching point windows with zeros, missing coverage and source times", () => {
    const input: ReturnType<typeof buildWesternInput> = { asOf: now.toISOString(), asOfLocal: "Thu 7:00 AM PST", timeZone: "America/Los_Angeles", coverage: "Tracked regions", patternOutlook: null, regions: [{
      id: "utah" as const, name: "Utah", edition: {} as never, observations: [],
      forecasts: [
        { area: "LCC" as const, name: "Alta / Snowbird", source: "NWS", issuedAt: now.toISOString(), issuedLocal: "7 AM PST", start: now.toISOString(), next24In: 0, next72In: 0, next7dIn: 5 },
        { area: "BCC" as const, name: "Brighton / Solitude", source: "NWS", issuedAt: now.toISOString(), issuedLocal: "7 AM PST", start: now.toISOString(), next24In: null, next72In: null, next7dIn: null },
      ],
    }] };
    const figures = westernFigures(input);
    expect(Object.keys(figures)).toEqual(["west-72h"]);
    const near = figures["west-72h"];
    expect(near.kind).toBe("forecast-comparison");
    if (near.kind !== "forecast-comparison") throw new Error("Expected comparison");
    expect(near.rows.map((r) => r.snowIn)).toEqual([0, null]);
    expect(near.rows[0].issuedAt).toBe(now.toISOString());
    expect(near.caption).toContain("next three days");
    input.regions[0].forecasts[0].next72In = 9;
    expect(near.rows[0].snowIn).toBe(0);
    for (const f of input.regions[0].forecasts) f.next72In = null;
    expect(westernFigures(input)["west-72h"]).toBeUndefined();
  });
});

describe("collection and publication survive secondary write failures", () => {
  it("keeps a collection run when a forecast area's storm archive write fails", async () => {
    class FlakyKV extends MemoryKV {
      stormPuts = 0;
      async put(key: string, value: string | ArrayBuffer) {
        if (key.startsWith("dailysnow-storm:")) {
          this.stormPuts++;
          throw new Error("KV write failed");
        }
        return super.put(key, value);
      }
    }
    const kv = new FlakyKV();
    const at = new Date(+now - 10 * 60000).toISOString();
    const seeded = structuredClone(base);
    seeded.areaStorms = {
      ...seeded.areaStorms,
      LCC: {
        checkedAt: at,
        cursors: {},
        events: [
          {
            id: `LCC:${at}`,
            firstObservedAt: at,
            lastSnowAt: at,
            updatedAt: at,
            status: "active",
            closedAt: null,
            closureReason: null,
            resorts: [],
          },
        ],
      },
    };
    await writeSnapshot(kv, seeded);
    const later = new Date(+now + 5 * 60000);
    const summary = await runCollection({ SNOW_KV: kv }, { now: later, fetchImpl: createFixtureFetch().fetchImpl });
    expect(kv.stormPuts).toBeGreaterThan(0);
    expect(summary.results.filter((r) => !r.ok)).toEqual([]);
    const stored = (await readSnapshot(kv))!;
    expect(stored.sources.alta?.lastAttemptAt).toBe(later.toISOString());
    expect(stored.areaStorms?.LCC?.events[0]?.id).toBe(`LCC:${at}`);
  });
  it("publishes a Western edition even when the older edition cannot be linked forward", async () => {
    const kv = new MemoryKV();
    const western = {
      title: "Western Outlook",
      summary: "Patterns vary across the tracked regions.",
      sections: [
        {id: "update", paragraphs: [{text: "The western pattern varies."}, {text: "Timing differs across mountain ranges."}]},
        {id: "short-term", paragraphs: [{text: "The near-term pattern follows."}, {text: "Mountain forecasts provide details."}]},
        {id: "extended", paragraphs: [{text: "Later guidance remains limited."}, {text: "Check future updates."}]},
      ],
    };
    const env = {
      SNOW_KV: kv,
      AI: {
        async run(_model: string, input: unknown) {
          const isWestern = JSON.stringify(input).includes("western_daily_snow");
          return { response: JSON.stringify(isWestern ? western : reply()) };
        },
      },
    };
    await runChannels(env, base, now, { channel: "tahoe", force: true });
    const tahoe = (await readChannelStates(kv)).tahoe!.current!;
    const olderDate = "2026-11-04";
    // An unparsable older archive entry makes the forward link fail.
    await channelKV(kv, "western-us").put(dailySnowKey(olderDate), "{not json");
    await kv.put(
      channelStateKey("western-us"),
      JSON.stringify({ ...emptyDailySnowState(), current: { ...tahoe, channel: "western-us", date: olderDate } }),
    );
    const out = await runChannels(env, base, now, { channel: "western-us", force: true });
    const today = localDate(now, "America/Los_Angeles");
    expect(out).toEqual([{ channel: "western-us", published: today }]);
    const state = (await readChannelStates(kv))["western-us"]!;
    expect(state.current?.date).toBe(today);
    expect(state.lastError).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
  });
});

describe("West pattern outlook", () => {
  const western = {
    title: "Western Outlook",
    summary: "Patterns vary across the tracked regions.",
    sections: [
      {id: "update", paragraphs: [{text: "The western pattern varies."}, {text: "Timing differs across mountain ranges."}]},
      {id: "short-term", paragraphs: [{text: "The near-term pattern follows."}, {text: "Mountain forecasts provide details."}]},
      {id: "extended", paragraphs: [{text: "A trough settles near the coast."}, {text: "The map shows the pattern."}]},
    ],
  };
  async function publish(snapshot: Snapshot, kv: MemoryKV) {
    const inputs: string[] = [];
    const env = {
      SNOW_KV: kv,
      AI: {
        async run(_model: string, input: unknown) {
          const body = JSON.stringify(input);
          if (body.includes("western_daily_snow")) inputs.push(body);
          return { response: JSON.stringify(body.includes("western_daily_snow") ? western : reply()) };
        },
      },
    };
    await runChannels(env, snapshot, now, { channel: "tahoe", force: true });
    await runChannels(env, snapshot, now, { channel: "western-us", force: true });
    return { post: (await readChannelStates(kv))["western-us"]!.current!, input: inputs[0] };
  }

  it("ends the extended section with the copied NOAA map and gives the model its discussion", async () => {
    const kv = new MemoryKV();
    const cpc = base.sources.cpc!.payload as CpcPayload;
    await kv.put(cpc.image.key, fixtureBytes("cpc-814day.03.gif").buffer as ArrayBuffer);
    const { post, input } = await publish(base, kv);
    expect(Object.keys(post.figures).sort()).toEqual(["west-72h", "west-pattern"]);
    const extended = post.sections.find((s) => s.id === "extended")!;
    expect(extended.paragraphs.map((p) => p.figure)).toEqual([null, "west-pattern"]);
    const map = post.figures["west-pattern"];
    if (map.kind !== "image") throw new Error("Expected image");
    expect(map.url).toMatch(/channel=western-us$/);
    expect(map.caption).toContain("8–14-day 500-mb height outlook · Nov 12–Nov 18 · issued");
    const sent = JSON.parse(JSON.parse(input).messages[1].content);
    expect(sent.patternOutlook).toMatchObject({ validLabel: "Nov 12–Nov 18" });
    expect(sent.patternOutlook.discussion).toContain("trough");
    expect(sent.patternOutlook.image).toBeUndefined();
    expect(sent.figures).toEqual({ snowComparison: true, patternMap: true });
  });

  it("publishes the extended prose without a map when the outlook is stale or the copy fails", async () => {
    const stale = structuredClone(base);
    stale.sources.cpc!.status = "error";
    const { post, input } = await publish(stale, new MemoryKV());
    expect(post.figures["west-pattern"]).toBeUndefined();
    expect(post.sections.find((s) => s.id === "extended")!.paragraphs.every((p) => p.figure === null)).toBe(true);
    const sentStale = JSON.parse(JSON.parse(input).messages[1].content);
    expect(sentStale.patternOutlook).toBeNull();
    expect(sentStale.figures).toEqual({ snowComparison: true, patternMap: false });
    // Current outlook whose stored map has expired: the figure is dropped, the post still publishes.
    const { post: missing, input: missingInput } = await publish(base, new MemoryKV());
    expect(missing.figures["west-pattern"]).toBeUndefined();
    // The prompt only promises figures the post will contain.
    expect(JSON.parse(JSON.parse(missingInput).messages[1].content).figures).toEqual({ snowComparison: true, patternMap: false });
  });
});

describe("prompt tuning inputs", () => {
  it("rebuilds the same regional digest from /api/report as production gets from the snapshot", () => {
    const at = new Date(+now - 10 * 60000).toISOString();
    const s = structuredClone(base);
    s.resortLastOperatingAt = { telluride: at };
    s.areaStorms = {
      ...s.areaStorms,
      telluride: {
        checkedAt: at,
        cursors: {},
        events: [
          {
            id: `telluride:${at}`,
            firstObservedAt: at,
            lastSnowAt: at,
            updatedAt: at,
            status: "active",
            closedAt: null,
            closureReason: null,
            resorts: [
              {
                id: "telluride",
                name: "Telluride",
                total: null,
                rolling: { amountIn: 4, window: "24h", reportTime: at, collectedAt: at, sourceUrl: "https://example.test" },
              },
            ],
          },
        ],
      },
    };
    const report = buildReport(s, now);
    // As scripts/dailysnow-once.ts builds it from the public report.
    const tuning: Snapshot = {
      schemaVersion: 1,
      writtenAt: report.snapshotWrittenAt!,
      sources: report.sources,
      areaStorms: report.areaStorms,
      resortLastOperatingAt: report.resortLastOperatingAt,
    };
    const production = buildDailyDigest(regionalSnapshot(s, "colorado"), null, [], now).digest;
    const rebuilt = buildDailyDigest(regionalSnapshot(tuning, "colorado"), null, [], now).digest;
    expect(production.areaStorms).toHaveLength(1);
    expect(production.figures.map((f) => f.id)).toContain("storm-recap-telluride");
    expect(rebuilt).toEqual(production);
  });
});

describe("partial and total upstream outages", () => {
  const down = () => new Response("down", { status: 503 });
  it.each([
    ["nws", nwsSource, /api\.weather\.gov\/(points|gridpoints)/],
    ["nwsafd", nwsAfdSource, /api\.weather\.gov\/products/],
    ["plumes", plumesSource, /weather\.utah\.edu/],
  ] as const)("records a total %s outage as a failed collection that keeps the last good payload", async (_id, source, pattern) => {
    const ok = await collectSource(source as never, undefined, {}, now, createFixtureFetch().fetchImpl);
    expect(ok.status).toBe("ok");
    const later = new Date(+now + 3_600_000);
    const failed = await collectSource(source as never, ok, {}, later, createFixtureFetch([[pattern, down]]).fetchImpl);
    expect(failed.status).toBe("error");
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.lastSuccessfulFetchAt).toBe(ok.lastSuccessfulFetchAt);
    expect(failed.payload).toEqual(ok.payload);
  });
  it("marks one office's retained discussion and dates the source from fresh products only", async () => {
    const ok = await collectSource(nwsAfdSource, undefined, {}, now, createFixtureFetch().fetchImpl);
    const prior = ok.payload as AfdPayload;
    const pdt = prior.discussions!.find((d) => d.office === "PDT")!;
    pdt.issuedAt = "2026-11-01T00:00:00.000Z";
    const partial = await collectSource(
      nwsAfdSource,
      ok,
      {},
      new Date(+now + 3_600_000),
      createFixtureFetch([[/locations\/PDT/, down]]).fetchImpl,
    );
    expect(partial.status).toBe("ok");
    const payload = partial.payload as AfdPayload;
    expect(payload.discussions!.find((d) => d.office === "PDT")?.lastError).toMatch(/PDT/);
    expect(payload.discussions!.filter((d) => d.office !== "PDT").every((d) => !d.lastError)).toBe(true);
    expect(partial.sourceUpdatedAt).not.toBe(pdt.issuedAt);
  });
  it("dates a region's plumes and discussions from that region's own entries", () => {
    const s = structuredClone(base);
    const plumes = s.sources.plumes!.payload as PlumePayload;
    plumes.charts.find((c) => c.stationCode === "MBB")!.initTime = "2026-10-01T00:00:00.000Z";
    s.sources.plumes!.sourceUpdatedAt = "2026-10-01T00:00:00.000Z";
    const afd = s.sources.nwsafd!.payload as AfdPayload;
    afd.discussions!.find((d) => d.office === "PDT")!.issuedAt = "2026-10-01T00:00:00.000Z";
    s.sources.nwsafd!.sourceUpdatedAt = "2026-10-01T00:00:00.000Z";
    const utah = regionalSnapshot(s, "utah");
    const oregon = regionalSnapshot(s, "oregon");
    expect(utah.sources.plumes!.sourceUpdatedAt).not.toBe("2026-10-01T00:00:00.000Z");
    expect(utah.sources.nwsafd!.sourceUpdatedAt).not.toBe("2026-10-01T00:00:00.000Z");
    expect(oregon.sources.plumes!.sourceUpdatedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(oregon.sources.nwsafd!.sourceUpdatedAt).toBe("2026-10-01T00:00:00.000Z");
  });
  it("keeps the previous day's link when a Western edition is rewritten the same day", async () => {
    const kv = new MemoryKV();
    const western = {
      title: "Western Outlook",
      summary: "Patterns vary across the tracked regions.",
      sections: [
        {id: "update", paragraphs: [{text: "The western pattern varies."}, {text: "Timing differs across mountain ranges."}]},
        {id: "short-term", paragraphs: [{text: "The near-term pattern follows."}, {text: "Mountain forecasts provide details."}]},
        {id: "extended", paragraphs: [{text: "Later guidance remains limited."}, {text: "Check future updates."}]},
      ],
    };
    const env = {
      SNOW_KV: kv,
      AI: {
        async run(_model: string, input: unknown) {
          const isWestern = JSON.stringify(input).includes("western_daily_snow");
          return { response: JSON.stringify(isWestern ? western : reply()) };
        },
      },
    };
    await runChannels(env, base, now, { channel: "tahoe", force: true });
    const tahoe = (await readChannelStates(kv)).tahoe!.current!;
    const yesterday = historyEntry({ ...tahoe, channel: "western-us", date: "2026-11-04", title: "Yesterday" });
    await kv.put(channelStateKey("western-us"), JSON.stringify({ ...emptyDailySnowState(), history: [yesterday] }));
    await runChannels(env, base, now, { channel: "western-us", force: true });
    await runChannels(env, base, new Date(+now + 20 * 60000), { channel: "western-us", force: true });
    const state = (await readChannelStates(kv))["western-us"]!;
    expect(state.attempts.count).toBe(2);
    expect(state.current?.older).toEqual({ date: "2026-11-04", title: "Yesterday" });
    expect(state.current?.sections.map((s) => s.id)).toEqual(["update", "short-term", "extended"]);
    expect(state.current?.regionalHighlights).toBeUndefined();
    expect(Object.values(state.current!.figures).every((f) => f.kind === "forecast-comparison")).toBe(true);
    const archived = JSON.parse((await channelKV(kv, "western-us").get(dailySnowKey(state.current!.date), "text"))!);
    expect(archived.older).toEqual({ date: "2026-11-04", title: "Yesterday" });
  });
});

describe("model output grounding and scoping", () => {
  it("reads spelled and numeric ranges joined by and/or as two amounts, never a sum", () => {
    expect(inchAmounts("between two and three inches")).toEqual([2, 3]);
    expect(inchAmounts("five or six inches")).toEqual([5, 6]);
    expect(inchAmounts("5 or 6 inches and 2 and 4″")).toEqual([5, 6, 2, 4]);
    expect(inchAmounts("twenty-five inches")).toEqual([25]);
    expect(inchAmounts("six to eight inches")).toEqual([6, 8]);
  });
  it("allows a neutral plume introduction and rejects claims about an unseen plume", () => {
    const { digest } = buildDailyDigest(regionalSnapshot(base, "utah"), null, [], now);
    const withText = (text: string) => ({
      ...reply(),
      sections: [{ id: "update", paragraphs: [{ text, figure: "none" }] }],
    });
    expect(() =>
      validateDailySnow(withText("The University of Utah plume below shows the spread of ensemble members."), digest),
    ).not.toThrow();
    for (const claim of ["The plume shows wide spread later in the week.", "The plume indicates good agreement on timing."])
      expect(() => validateDailySnow(withText(claim), digest)).toThrow(/unseen plume/);
  });
  it("keeps the retired single storm record to Utah", () => {
    const legacy = { ...base, stormTracking: { checkedAt: now.toISOString(), cursors: {}, events: [] } };
    expect(regionalSnapshot(legacy, "utah").stormTracking).toBe(legacy.stormTracking);
    expect(regionalSnapshot(legacy, "tahoe").stormTracking).toBeUndefined();
  });
  it("summarizes only the region's own offices and gives each office's text once", () => {
    const colorado = buildDailyDigest(regionalSnapshot(base, "colorado"), null, [], now).digest;
    expect(colorado.discussions?.map((d) => d.office)).toEqual(["BOU", "GJT"]);
    expect(colorado.discussion?.issued).toMatch(/^BOU .+; GJT /);
    expect(colorado.discussion).not.toHaveProperty("sections");
    const tahoe = buildDailyDigest(regionalSnapshot(base, "tahoe"), null, [], now).digest;
    expect(tahoe.discussions?.map((d) => d.office)).toEqual(["STO"]);
  });
});

describe("channel archive, retention and figures", () => {
  const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).buffer as ArrayBuffer;
  /** A storm morning: a current NWS grid with snow ahead, so NWS figures are candidates too. */
  const snowy = () => {
    const s = structuredClone(base);
    for (const p of (s.sources.nws!.payload as NwsPayload).points) {
      p.gridUpdatedAt = new Date(+now - 3_600_000).toISOString();
      p.sixHourSnow = p.sixHourSnow.map((b) => ({ ...b, snowIn: Date.parse(b.start) + 6 * 3_600_000 > +now ? 1 : b.snowIn }));
    }
    return s;
  };
  const candidates = () => buildDailyDigest(regionalSnapshot(snowy(), "utah"), null, [], now).figures;
  const storedKey = (id: string) => {
    const c = candidates().find((c) => c.figure.id === id);
    if (c?.source?.kind !== "kv") throw new Error(`no stored source for ${id}`);
    return c.source.key;
  };
  const answerWith = (figures: string[]) => ({
    ...reply(),
    sections: [
      {
        id: "update",
        paragraphs: figures.map((figure) => ({ text: "The supplied forecast guidance follows.", figure })),
      },
    ],
  });
  const env = (kv: MemoryKV, figures: string[]) => ({
    SNOW_KV: kv,
    AI: {
      async run() {
        return { response: JSON.stringify(answerWith(figures)) };
      },
    },
  });
  const nonImage = () => candidates().find((c) => c.figure.kind !== "image" && !c.figure.id.startsWith("storm-recap"))!.figure.id;
  const utahPost = async (kv: MemoryKV) => (await readChannelStates(kv)).utah!.current!;

  it("archives posts and stills for 30 days and keeps the older post's own expiry when linking it", async () => {
    const kv = new MemoryKV();
    await kv.put(storedKey("plume-snow-cln"), png());
    const ttls: Record<string, number | undefined> = {};
    const put = kv.put.bind(kv);
    kv.put = async (key: string, value: string | ArrayBuffer, opts?: { expirationTtl?: number }) => {
      if (key.startsWith("channel:v1:utah:dailysnow")) ttls[key.replace("channel:v1:utah:", "")] = opts?.expirationTtl;
      return put(key, value);
    };
    await runChannels(env(kv, ["plume-snow-cln"]), snowy(), now, { channel: "utah", force: true });
    // 30 days after noon UTC on the post date (Nov 5), written at 15:00Z.
    const ttl = 30 * 86_400 - 3 * 3_600;
    const first = await utahPost(kv);
    expect(ttls[dailySnowKey(first.date)]).toBe(ttl);
    const still = Object.keys(ttls).find((k) => k.startsWith("dailysnow-fig:"))!;
    expect(ttls[still]).toBe(ttl);
    for (const k of Object.keys(ttls)) delete ttls[k];
    await runChannels(env(kv, ["plume-snow-cln"]), snowy(), new Date(+now + 86_400_000), { channel: "utah", force: true });
    expect(ttls[dailySnowKey("2026-11-06")]).toBe(ttl);
    expect(ttls[dailySnowKey("2026-11-05")]).toBe(ttl - 86_400);
    const older = JSON.parse((await channelKV(kv, "utah").get(dailySnowKey("2026-11-05"), "text"))!);
    expect(older.newer).toMatchObject({ date: "2026-11-06" });
  });
  it("stops serving a channel's archived post past retention", async () => {
    const kv = new MemoryKV();
    const old = { ...(await (async () => {
      const k = new MemoryKV();
      await runChannels(env(k, [nonImage()]), snowy(), now, { channel: "utah", force: true });
      return utahPost(k);
    })()), date: "2026-09-01" };
    await channelKV(kv, "utah").put(dailySnowKey("2026-09-01"), JSON.stringify(old));
    const res = await dailySnowArchive(new Request("https://x/api/daily-snow?channel=utah&date=2026-09-01"), { SNOW_KV: kv });
    expect(res.status).toBe(404);
  });
  it("drops figures whose still cannot be stored", async () => {
    const kv = new MemoryKV(); // no plume panel stored
    const other = nonImage();
    await runChannels(env(kv, ["plume-snow-cln", other]), snowy(), now, { channel: "utah", force: true });
    const post = await utahPost(kv);
    expect(post.figures["plume-snow-cln"]).toBeUndefined();
    expect(post.sections[0].paragraphs.map((p) => p.figure)).toEqual([null, other]);
  });
  it("uses another snow plume if the preferred still is missing", async () => {
    const kv = new MemoryKV();
    await kv.put(storedKey("plume-snow-pkcu1"), png());
    await runChannels(env(kv, ["plume-snow-cln", nonImage()]), snowy(), now, { channel: "utah", force: true });
    const post = await utahPost(kv);
    expect(post.figures["plume-snow-cln"]).toBeUndefined();
    expect(post.figures["plume-snow-pkcu1"]).toBeDefined();
    expect(post.sections[0].paragraphs[0].figure).toBeNull();
  });
  it("reserves a slot for the required snow plume when six optional figures were selected", async () => {
    const kv = new MemoryKV();
    for (const c of candidates()) if (c.source?.kind === "kv") await kv.put(c.source.key, png());
    const optional = candidates()
      .map((c) => c.figure.id)
      .filter((id) => !isSnowPlume(id) && !id.startsWith("storm-recap"))
      .slice(0, 6);
    expect(optional).toHaveLength(6);
    await runChannels(env(kv, optional), snowy(), now, { channel: "utah", force: true });
    const post = await utahPost(kv);
    expect(Object.keys(post.figures)).toHaveLength(6);
    expect(Object.keys(post.figures).some(isSnowPlume)).toBe(true);
    expect(post.sections[0].paragraphs.at(-1)?.figure).toBeNull();
  });
});
