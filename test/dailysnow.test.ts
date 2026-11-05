import { beforeAll, describe, expect, it } from "vitest";
import { runCollection } from "@/lib/collect";
import { dailySnowFigureKey, dailySnowKey, emptyDailySnowState, planDailySnow } from "@/lib/dailysnow";
import { buildContinuity, historyEntry } from "@/lib/dailysnow/continuity";
import { buildDailyDigest, dailySnowActivity, phaseOf, snowNext } from "@/lib/dailysnow/digest";
import { allowedAmounts, askDailySnow, buildModelInput, DAILY_SNOW_TIMEOUT_MS, SYSTEM_PROMPT, validateDailySnow } from "@/lib/dailysnow/llm";
import { IN_FLIGHT_MS, MAX_ATTEMPTS, RETRY_AFTER_MS, shouldRunDailySnow } from "@/lib/dailysnow/schedule";
import { inchAmountsIn, ungroundedInches } from "@/lib/ai/grounding";
import { FALLBACK_MODEL, PRIMARY_MODEL } from "@/lib/ai/model";
import { buildReport, publicDailySnow, DAILY_SNOW_ARCHIVE_POSTS } from "@/lib/report";
import { parseAfd } from "@/lib/sources/nwsafd";
import { MemoryKV, readSnapshot, writeSnapshot } from "@/lib/store";
import type { AfdPayload, DailySnowHistoryEntry, DailySnowNumbers, DailySnowPost, DailySnowState, PlumePayload, ResortCamsPayload, ResortReport, NwsPayload, Snapshot } from "@/lib/types";
import { createFixtureFetch, fixture } from "./fixtureFetch";

// Nov 1 2026 is the end of daylight saving time: 13:00 UTC is 6:00 AM MST.
const SIX_AM = new Date("2026-11-01T13:00:00Z");
const at = (iso: string) => new Date(iso);

let captured: Snapshot;
beforeAll(async () => {
  const kv = new MemoryKV();
  await runCollection({ SNOW_KV: kv }, { now: SIX_AM, fetchImpl: createFixtureFetch().fetchImpl });
  captured = (await readSnapshot(kv))!;
  // Reuse measured forecast values at this scenario clock; freshness is tested separately.
  const nws=captured.sources.nws!;nws.sourceUpdatedAt=SIX_AM.toISOString();
  const payload=nws.payload as NwsPayload;
  payload.points=payload.points.filter(p=>p.id==="LCC"||p.id==="BCC");
  for(const point of payload.points){point.gridUpdatedAt=SIX_AM.toISOString();point.lastCheckedAt=SIX_AM.toISOString();}

});
const snap = () => structuredClone(captured);

/** A model answer that uses two figures and only amounts present in the fixture data. */
function answer(digestFigures: string[], extra: Record<string, unknown> = {}) {
  return {
    title: "Storm Underway",
    summary: "The main surge is here today with snow above 8,000 feet. Snow levels fall tonight and we clear out Monday.",
    sections: [
      {
        id: "update",
        paragraphs: [
          { text: "Snow is falling at the upper elevations of the Cottonwoods this morning:", figure: digestFigures[0] ?? "none" },
          { text: "Snow levels drop through tonight:", figure: digestFigures[1] ?? "none" },
        ],
      },
      { id: "extended", paragraphs: [{ text: "A weaker system arrives Wednesday into Thursday.", figure: "none" }] },
    ],
    ...extra,
  };
}

function fakeAi(respond: (model: string, input: Record<string, unknown>) => unknown) {
  const calls: Array<{ model: string; schema: string; user: string }> = [];
  return {
    calls,
    ai: {
      async run(model: string, input: Record<string, unknown>) {
        const schema = (input.response_format as { json_schema: { name: string } }).json_schema.name;
        calls.push({ model, schema, user: (input.messages as Array<{ content: string }>)[1].content });
        if (schema !== "daily_snow") throw new Error("resort pick not under test");
        return { response: JSON.stringify(respond(model, input)) };
      },
    },
  };
}

describe("NWS forecast discussion", () => {
  it("keeps forecast sections and drops aviation and hydrology", () => {
    const sections = parseAfd((JSON.parse(fixture("nws-afd-SLC.json")) as { productText: string }).productText);
    expect(sections.map((s) => s.name)).toEqual(["KEY MESSAGES", "DISCUSSION", "WATCHES/WARNINGS/ADVISORIES"]);
    expect(sections[0].text).toContain("Upper elevations of the Cottonwoods and western Uintas may see localized accumulations 18-24\".");
    // Wrapped 70-column lines are joined.
    expect(sections[1].text).not.toMatch(/\w\n\w/);
    expect(sections.every((s) => s.issued === undefined)).toBe(true);
  });
  it("reads updated products whose headers carry the original issuance (2026-11-02 5:13 AM update)", () => {
    const sections = parseAfd((JSON.parse(fixture("nws-afd-SLC-update.json")) as { productText: string }).productText);
    expect(sections.map((s) => s.name)).toEqual(["KEY MESSAGES", "DISCUSSION", "WATCHES/WARNINGS/ADVISORIES"]);
    expect(sections[0].issued).toBe("1037 PM MST Sun Nov 1 2026");
    expect(sections[1].issued).toBe("1037 PM MST Sun Nov 1 2026");
    expect(sections[1].text).toMatch(/^Currently, a mid-level trough/);
    // The next header ends the section rather than being swallowed into it.
    expect(sections[1].text).not.toContain("AVIATION");
  });
  it("is collected with the other sources and reused while the product is unchanged", async () => {
    const afd = captured.sources.nwsafd!;
    expect(afd.status).toBe("ok");
    expect((afd.payload as AfdPayload).issuedAt).toBe("2026-11-01T16:34:00.000Z");
    const kv = new MemoryKV();
    await writeSnapshot(kv, captured);
    const { fetchImpl, calls } = createFixtureFetch();
    await runCollection({ SNOW_KV: kv }, { now: SIX_AM, fetchImpl, only: ["nwsafd"] });
    expect(calls.filter((u) => u.includes("/products/types/AFD/locations/"))).toHaveLength(9);
    expect(calls.filter(u=>u.includes("/products/")&&!u.includes("/types/"))).toHaveLength(0);
  });
});

describe("digest", () => {
  it("uses exact hourly coverage rather than five intersecting six-hour bars", () => {
    const p = (snap().sources.nws!.payload as NwsPayload).points[0];
    const now = new Date("2026-11-03T13:00:00Z");
    const h = 3_600_000;
    p.sixHourSnow = Array.from({ length: 5 }, (_, i) => ({ start: new Date(now.getTime() - h + i * 6 * h).toISOString(), snowIn: 1, snowLevelFt: null }));
    delete p.hourlySnow;
    expect(snowNext(p, now, 24)).toBeNull();
    p.hourlySnow = Array.from({ length: 30 }, (_, i) => ({ start: new Date(now.getTime() - h + i * h).toISOString(), snowIn: 1 / 6 }));
    expect(snowNext(p, now, 24)).toBe(4);
    expect(snowNext(p, new Date(now.getTime() + 5 * 60_000), 24)).toBe(4);
    p.hourlySnow.splice(5, 1);
    expect(snowNext(p, now, 24)).toBeNull();
  });
  it("distinguishes covered zero from missing, duplicate, and partial coverage", () => {
    const p = (snap().sources.nws!.payload as NwsPayload).points[0];
    const now = new Date("2026-11-03T12:00:00Z");
    p.hourlySnow = Array.from({ length: 24 }, (_, i) => ({ start: new Date(now.getTime() + i * 3_600_000).toISOString(), snowIn: 0 }));
    expect(snowNext(p, now, 24)).toBe(0);
    expect(snowNext(p, new Date(now.getTime() + 60_000), 24)).toBeNull();
    p.hourlySnow[1] = p.hourlySnow[0];
    expect(snowNext(p, now, 24)).toBeNull();
    p.hourlySnow = [];
    expect(snowNext(p, now, 24)).toBeNull();
    expect(phaseOf(0, 0, null, null).reason).toContain("unavailable snowfall forecast");
  });
  it("decides the storm phase in code", () => {
    expect(phaseOf(0, 0, 5, 12).phase).toBe("storm");
    expect(phaseOf(3, 3, 2, 4).phase).toBe("storm");
    expect(phaseOf(1, 8, 0, 0).phase).toBe("post-storm");
    expect(phaseOf(0, 0, 1, 6).phase).toBe("pre-storm");
    expect(phaseOf(0, 0, 0, 1).phase).toBe("quiet");
  });
  it("computes totals, figures and recent-post context from the sources", () => {
    const s = snap();
    // Make the Snowbird stake still this morning's.
    const cams = s.sources.resortcams!.payload as ResortCamsPayload;
    for (const c of cams.cameras) if (c.kind === "image") c.capturedAt = "2026-11-01T12:55:00.000Z";
    const history = [{ date: "2026-10-31", title: "Storm Arrives", phase: "pre-storm" as const, forecast: [{ canyon: "LCC" as const, next24In: 10, next72In: 16, stormIn: 17 }] }];
    const { digest, numbers, figures, worthPosting } = buildDailyDigest(s, null, history, SIX_AM);
    expect(digest.date).toBe("2026-11-01");
    expect(digest.weekday).toBe("Sunday");
    expect(digest.phase).toBe("storm");
    expect(numbers.canyons.map((c) => c.canyon)).toEqual(["LCC", "BCC"]);
    expect(numbers.canyons[0].next24In).not.toBeNull();
    // A truncated forecast horizon must not masquerade as a complete seven days.
    expect(numbers.canyons[0].next7dIn).toBeNull();
    expect(digest.discussion?.sections[0].name).toBe("KEY MESSAGES");
    // Entries stored before posting times were kept are labeled by day.
    expect(digest.recentPosts[0].forecast[0]).toBe("LCC: 10″ in the 24 h and 16″ in the 72 h from Saturday morning; next storm 17″");
    expect(digest.phaseChange).toBe("pre-storm (Saturday's post) → storm (today)");
    const ids = figures.map((f) => f.figure.id);
    expect(ids).toEqual(expect.arrayContaining(["nws-snow-lcc", "nws-snow-bcc", "nws-snow-level", "plume-snow-cln", "plume-slr-pkcu1", "stake-alta", "stake-snowbird"]));
    // Captions come from code; the model is told it cannot see images.
    expect(digest.figures.find((f) => f.id === "stake-snowbird")?.shows).toMatch(/cannot see/);
    expect(worthPosting).toBe(true);
  });
  it("leaves out stake cams that are not this morning's", () => {
    const ids = buildDailyDigest(snap(), null, [], SIX_AM).figures.map((f) => f.figure.id);
    expect(ids.some((id) => id.startsWith("stake-"))).toBe(false);
  });
});

describe("continuity with earlier posts", () => {
  // Monday 6 AM MST; Sunday's and Saturday's posts saw storms on Tue–Wed and over the weekend.
  const MONDAY = at("2026-11-02T13:00:00Z");
  const canyon = (canyon: "LCC" | "BCC", nextStorm: { start: string; end: string; totalSnowIn: number } | null) =>
    ({ canyon, point: canyon, next24In: 1, next72In: 2, next7dIn: 3, nextStorm: nextStorm && { ...nextStorm, minSnowLevelFt: null }, forecastUpdatedAt: null });
  const numbers = (lcc: Parameters<typeof canyon>[1]): DailySnowNumbers => ({
    canyons: [canyon("LCC", lcc)],
    resorts: [
      { id: "alta", name: "Alta", h24: 10, storm: 15, reportTime: "2026-11-02T12:30:00Z" },
      { id: "snowbird", name: "Snowbird", h24: null, storm: null, reportTime: null },
      { id: "solitude", name: "Solitude", h24: 5, storm: 9, reportTime: "2026-11-02T12:00:00Z" },
    ],
  });
  const entry = (date: string, postedAt: string, phase: DailySnowHistoryEntry["phase"], stormIn: number, storm: { start: string; end: string }): DailySnowHistoryEntry =>
    ({ date, title: `Post ${date}`, phase, postedAt, forecast: [{ canyon: "LCC", next24In: 1, next72In: stormIn, stormIn, storm }] });
  const weekend = { start: "2026-10-31T18:00:00Z", end: "2026-11-02T06:00:00Z" };
  const midweek = { start: "2026-11-04T06:00:00Z", end: "2026-11-05T00:00:00Z" };
  const history = [
    entry("2026-11-01", "2026-11-01T13:04:00Z", "storm", 8.4, { start: "2026-11-01T13:00:00Z", end: "2026-11-02T05:00:00Z" }),
    entry("2026-10-31", "2026-10-31T12:05:00Z", "pre-storm", 6, weekend),
  ];

  it("tracks the coming storm's forecast across posts, matching by storm window", () => {
    // Saturday's post saw the same midweek storm 3 hours later; Sunday's saw a different (weekend) storm.
    const h = [{ ...history[0] }, entry("2026-10-31", "2026-10-31T12:05:00Z", "pre-storm", 4, { start: "2026-11-04T09:00:00Z", end: "2026-11-05T03:00:00Z" })];
    const c = buildContinuity(null, h, numbers({ ...midweek, totalSnowIn: 1.7 }), "post-storm", "2026-11-02", MONDAY);
    expect(c.stormTrend).toEqual([{ canyon: "LCC", forecasts: [
      "our post at Sat, Oct 31, 6:05 AM MDT: 4″ (Wed, Nov 4, 2:00 AM MST to Wed, Nov 4, 8:00 PM MST)",
      "today's NWS forecast: 1.7″ (Tue, Nov 3, 11:00 PM MST to Wed, Nov 4, 5:00 PM MST)",
    ] }]);
  });
  it("compares the storm that just ended with what we forecast before and during it", () => {
    const c = buildContinuity(null, history, numbers(null), "post-storm", "2026-11-02", MONDAY);
    expect(c.stormTrend).toEqual([]);
    expect(c.lastStorm).toEqual([{
      canyon: "LCC",
      window: "Sat, Oct 31, 12:00 PM MDT to Sun, Nov 1, 10:00 PM MST",
      forecasts: ["our post at Sat, Oct 31, 6:05 AM MDT (before it began): 6″", "our post at Sun, Nov 1, 6:04 AM MST (after it began): 8.4″"],
      reported: ["Alta: storm total 15″, 24 h 10″ (report Mon, Nov 2, 5:30 AM MST)", "Snowbird: no storm or 24 h total reported"],
    }]);
    // Days later, the storm is no longer "the one that just ended".
    expect(buildContinuity(null, history, numbers(null), "quiet", "2026-11-05", at("2026-11-05T13:00:00Z")).lastStorm).toEqual([]);
  });
  it("gives the last post's text and never today's own post", () => {
    const previous = { date: "2026-11-01", title: "Storm On", summary: "Snowing.", sections: [{ id: "update", paragraphs: [{ text: "One.", figure: null }, { text: "Two.", figure: "x" }] }] } as DailySnowPost;
    expect(buildContinuity(previous, history, numbers(null), "post-storm", "2026-11-02", MONDAY).previousPost).toEqual({ date: "2026-11-01", weekday: "Sunday", title: "Storm On", summary: "Snowing.", paragraphs: ["One.", "Two."] });
    const rerun = buildContinuity({ ...previous, date: "2026-11-02" }, [{ ...history[0], date: "2026-11-02" }, ...history], numbers(null), "post-storm", "2026-11-02", MONDAY);
    expect(rerun.previousPost).toBeNull();
    expect(rerun.recentPosts.map((p) => p.date)).toEqual(["2026-11-01", "2026-10-31"]);
  });
  it("records the storm window and posting time in history", () => {
    const post = { date: "2026-11-02", title: "T", phase: "quiet", generatedAt: "2026-11-02T13:01:00.000Z", numbers: numbers({ ...midweek, totalSnowIn: 1.7 }) } as DailySnowPost;
    expect(historyEntry(post)).toEqual({ date: "2026-11-02", title: "T", phase: "quiet", postedAt: "2026-11-02T13:01:00.000Z", forecast: [{ canyon: "LCC", next24In: 1, next72In: 2, stormIn: 1.7, storm: midweek }] });
  });
  it("tells the model to follow on from earlier posts without reusing their amounts or titles", () => {
    expect(SYSTEM_PROMPT).toMatch(/never quote an amount from previousPost/);
    expect(SYSTEM_PROMPT).toMatch(/Different from every title in recentPosts/);
    expect(SYSTEM_PROMPT).toMatch(/never compare them with each other/);
  });
});

describe("schedule", () => {
  const posted = (date: string): DailySnowState => ({ ...emptyDailySnowState(), current: { date } as DailySnowState["current"] });
  it("posts from 6 AM Denver time, across the daylight-saving change", () => {
    expect(shouldRunDailySnow(undefined, at("2026-11-01T12:55:00Z"))).toBeNull(); // 5:55 AM MST
    // 12:00 UTC was 6 AM yesterday (MDT) but is 5 AM today (MST).
    expect(shouldRunDailySnow(undefined, at("2026-11-01T12:00:00Z"))).toBeNull();
    expect(shouldRunDailySnow(undefined, SIX_AM)).toBe("morning");
    expect(shouldRunDailySnow(undefined, at("2026-07-01T12:00:00Z"))).toBe("morning"); // 6 AM MDT
    expect(shouldRunDailySnow(undefined, at("2026-11-01T17:00:00Z"))).toBeNull(); // 10 AM: too late
  });
  it("posts once a day", () => {
    expect(shouldRunDailySnow(posted("2026-11-01"), at("2026-11-01T14:00:00Z"))).toBeNull();
    expect(shouldRunDailySnow(posted("2026-10-31"), at("2026-11-01T14:00:00Z"))).toBe("morning");
  });
  it("allows slow generations within the cron wall-time limit", () => {
    // GLM took 128 s for a valid post on 2026-11-02; the old 120 s limit discarded it.
    expect(DAILY_SNOW_TIMEOUT_MS).toBe(5 * 60_000);
    expect(IN_FLIGHT_MS).toBeGreaterThan(2 * DAILY_SNOW_TIMEOUT_MS);
    expect(IN_FLIGHT_MS).toBeLessThanOrEqual(15 * 60_000);
  });
  it("does not start a second attempt while one is running", () => {
    const running: DailySnowState = { ...emptyDailySnowState(), lastAttemptAt: SIX_AM.toISOString(), attempts: { date: "2026-11-01", count: 1, calls: 2 } };
    expect(shouldRunDailySnow(running, at("2026-11-01T13:05:00Z"))).toBeNull();
    // Two 5-minute model timeouts: later crons still see the attempt as running.
    expect(shouldRunDailySnow(running, at("2026-11-01T13:10:00Z"))).toBeNull();
    // Cut off without finishing: tried again once the in-flight window has passed.
    expect(shouldRunDailySnow(running, new Date(SIX_AM.getTime() + IN_FLIGHT_MS))).toBe("morning");
  });
  it("retries failures after 10 minutes, a few times a day", () => {
    const failed: DailySnowState = { ...emptyDailySnowState(), lastAttemptAt: SIX_AM.toISOString(), lastFinishedAt: "2026-11-01T13:01:00.000Z", lastError: "timeout", consecutiveFailures: 1, attempts: { date: "2026-11-01", count: 1, calls: 2 } };
    expect(shouldRunDailySnow(failed, at("2026-11-01T13:05:00Z"))).toBeNull();
    expect(shouldRunDailySnow(failed, new Date(SIX_AM.getTime() + RETRY_AFTER_MS))).toBe("retry");
    expect(shouldRunDailySnow({ ...failed, attempts: { date: "2026-11-01", count: MAX_ATTEMPTS, calls: 6 } }, at("2026-11-01T14:00:00Z"))).toBeNull();
    // The count resets the next day.
    expect(shouldRunDailySnow({ ...failed, attempts: { date: "2026-10-31", count: MAX_ATTEMPTS, calls: 6 } }, SIX_AM)).toBe("morning");
  });
});

describe("validation", () => {
  const { digest } = buildDailyDigest(structuredClone({ schemaVersion: 1, writtenAt: "", sources: {} }) as Snapshot, null, [], SIX_AM);
  const withData = () => buildDailyDigest(snap(), null, [], SIX_AM).digest;
  it.each(["title", "summary", "paragraph"])("rejects figure IDs in the model's %s before clipping", (field) => {
    const d = withData();
    // Use the supplied catalog, including future IDs, rather than hardcoded families.
    d.figures.push({ id: "future-chart", caption: "Future chart", shows: "Forecast" });
    for (const marker of ["[nws-snow-lcc]", "[future-chart]", "future-chart"]) {
      const text = `${"Snow returns. ".repeat(80)}${marker}`;
      const raw = answer([], field === "paragraph"
        ? { sections: [{ id: "update", paragraphs: [{ text, figure: "nws-snow-level" }] }] }
        : { [field]: text });
      expect(() => validateDailySnow(raw, d)).toThrow(/figure ID in prose/);
    }
  });
  it("allows ordinary bracketed prose and structured figure placement", () => {
    const text = "Snow [at higher elevations] returns:";
    const r = validateDailySnow(answer([], {
      sections: [{ id: "update", paragraphs: [{ text, figure: "nws-snow-level" }] }],
    }), withData());
    expect(r.sections[0].paragraphs).toEqual([{ text, figure: "nws-snow-level" }]);
  });
  it("uses the existing fallback when primary output leaks a figure ID", async () => {
    const { ai, calls } = fakeAi((model) => answer([], model === PRIMARY_MODEL
      ? { summary: "Snow returns. [nws-snow-lcc]" } : {}));
    const result = await askDailySnow(ai, withData(), undefined);
    expect(result.model).toBe(FALLBACK_MODEL);
    expect(result.fallbackReason).toContain("figure ID in prose: nws-snow-lcc");
    expect(calls.map((c) => c.model)).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);
  });
  it("flags inch amounts that appear nowhere in the data", () => {
    expect(ungroundedInches("We got 12″ and 3-6\" lower down, 0.5″ of water.", [12, 3, 6, 0.5])).toEqual([]);
    expect(ungroundedInches("Up to 30″ fell", [12, 17.1])).toEqual([30]);
    expect(ungroundedInches("Totals of 17 inches", [17.1])).toEqual([]);
    // Plain "in" as the unit (gpt-oss writes "8 in (10 in in 48 h)").
    expect(ungroundedInches("Snowbird 8 in (25 in in 48 h), 3–40 in by Monday", [8, 10, 3])).toEqual([25, 40]);
    expect(ungroundedInches("Around 4 in the morning, 2 in a row", [])).toEqual([]);
    // A temperature before a place name (GLM, 2026-11-03).
    expect(ungroundedInches("Highs near 38 in Little Cottonwood and 41 in Big Cottonwood", [])).toEqual([]);
  });
  it("counts only inch amounts in the input, not elevations, temperatures, winds or the last post's text", () => {
    expect(ungroundedInches("Six inches overnight and twenty-seven inches in the storm.", [0])).toEqual([6,27]);
    expect(ungroundedInches("Six to ten inches.", [6,10])).toEqual([]);
    const amounts = inchAmountsIn({ elevationFt: 9600, tempF: "20–30", windMph: "30 gust 45", snowIn: 4, totals: { next72In: 12.5 }, ensemble: { snowIn: [1, 3, 7] }, text: "Total accumulation 8 to 14 inches" });
    expect(amounts.sort((a, b) => a - b)).toEqual([1, 3, 4, 7, 8, 12.5, 14]);
    const d = buildDailyDigest(snap(), null, [], SIX_AM).digest;
    const allowed = allowedAmounts({ ...d, previousPost: { date: "2026-10-31", weekday: "Saturday", title: "Old", summary: "We called for 77″.", paragraphs: ["Up to 88″."] } });
    expect(allowed).not.toContain(77);
    expect(allowed).not.toContain(88);
    // Elevations and years are no longer amounts.
    expect(allowed).not.toContain(2026);
    expect(allowed.some((a) => a >= 1000)).toBe(false);
    const isolated={...d,resorts:[],discussion:null,discussions:[],ensemble:undefined,areaStorms:[],stormRecap:null,figures:[],forecast:[{...d.forecast[0],sixHourSnow:["Thu 6 AM: 3.2″","Thu noon: 4.3″"],blocks:[],totals:{next24In:null,next72In:null,next7dIn:null},nextStorm:null}]};
    // The model cannot invent a total by adding hourly/period amounts.
    expect(allowedAmounts(isolated)).not.toContain(7.5);

  });
  it("accepts a well-formed post and drops unknown, repeated or misplaced parts", () => {
    const d = withData();
    const r = validateDailySnow(
      answer(["nws-snow-lcc", "nws-snow-lcc"], {
        sections: [
          { id: "extended", paragraphs: [{ text: "Misplaced first.", figure: "none" }] },
          { id: "update", paragraphs: [{ text: "Snow up high:", figure: "nws-snow-lcc" }, { text: "Again:", figure: "nws-snow-lcc" }, { text: "Unknown:", figure: "radar" }] },
        ],
      }),
      d,
    );
    expect(r.sections.map((s) => s.id)).toEqual(["update"]);
    expect(r.sections[0].paragraphs.map((p) => p.figure)).toEqual(["nws-snow-lcc", null, null]);
  });
  it("rejects invented amounts and thin posts", () => {
    const d = withData();
    expect(() => validateDailySnow(answer([], { summary: "A whopping 45″ fell overnight." }), d)).toThrow(/not in the data: 45/);
    // The last post's amounts are out of date, so quoting one is rejected too.
    const withPrevious = { ...d, previousPost: { date: "2026-10-31", weekday: "Saturday", title: "Old", summary: "Up to 58″ by Monday.", paragraphs: [] } };
    expect(() => validateDailySnow(answer([], { summary: "Still up to 58″ by Monday." }), withPrevious)).toThrow(/not in the data: 58/);
    expect(() => validateDailySnow(answer([], { title: "" }), d)).toThrow(/no title or summary/);
    expect(() => validateDailySnow(answer([], { sections: [] }), d)).toThrow(/sections/);
  });
  it("clips over-long paragraphs at a sentence boundary and keeps the figure", () => {
    const d = withData();
    const text = `${"b".repeat(500)}. Middle sentence one. Middle sentence two. ${"c".repeat(500)}`;
    const raw = answer([], { sections: [{ id: "update", paragraphs: [{ text, figure: "plume-snow-cln" }] }] });
    const r = validateDailySnow(raw, d);
    expect(r.sections[0].paragraphs[0]).toEqual({
      // 1044 characters in; the clip ends after the last sentence that keeps
      // most of the 800-character budget, without an ellipsis.
      text: `${"b".repeat(500)}. Middle sentence one. Middle sentence two.`,
      figure: "plume-snow-cln",
    });
  });
  it.each([['update', 'short-term'], ['short-term', 'update']])("preserves the outlook and plume when %s is followed by %s", (first, second) => {
    const d = withData();
    const raw = answer([], { sections: [
      { id: first, paragraphs: [{ text: "Snow level outlook:", figure: "nws-snow-level" }] },
      { id: second, paragraphs: [{ text: "The next system:", figure: "nws-snow-lcc" }, { text: "University of Utah ensemble guidance:", figure: "plume-snow-cln" }] },
    ] });
    const validated = validateDailySnow(raw, d);
    expect(validated.sections).toEqual([{ id: first, paragraphs: [
      { text: "Snow level outlook:", figure: "nws-snow-level" },
      { text: "The next system:", figure: "nws-snow-lcc" },
      { text: "University of Utah ensemble guidance:", figure: "plume-snow-cln" },
    ] }]);
    // Recovered paragraphs still undergo the same amount validation.
    raw.sections[1].paragraphs[0].text = "Expect 999″ tomorrow.";
    expect(() => validateDailySnow(raw, d)).toThrow(/not in the data: 999/);
  });
  it("constrains figures to the available ids in the schema", () => {
    const d = withData();
    const input = buildModelInput(PRIMARY_MODEL, d) as { response_format: { json_schema: { schema: { properties: { sections: { items: { properties: { paragraphs: { items: { properties: { figure: { enum: string[] } } } } } } } } } } } };
    const figureEnum = input.response_format.json_schema.schema.properties.sections.items.properties.paragraphs.items.properties.figure.enum;
    expect(figureEnum).toEqual([...d.figures.map((f) => f.id), "none"]);
  });
});

describe("activity gate",()=>{
  it("skips the off-season and needs the AI binding", () => {
    const s = snap();
    for (const p of (s.sources.nws!.payload as NwsPayload).points) { p.sixHourSnow = []; p.hourlySnow = []; }
    for (const id of ["alta", "snowbird", "solitude", "brighton", "snowbasin"] as const) s.sources[id] = undefined;
    const { ai } = fakeAi(() => answer([]));
    expect(planDailySnow(undefined, s, { SNOW_KV: new MemoryKV(), AI: ai }, SIX_AM)).toMatchObject({ skipped: "off-season" });
    expect(planDailySnow(undefined, s, { SNOW_KV: new MemoryKV() }, SIX_AM)).toBeUndefined();
  });
  it("counts the forecast bar in progress at posting time as activity", () => {
    const h = 3_600_000;
    const quiet = () => {
      const s = snap();
      for (const p of (s.sources.nws!.payload as NwsPayload).points) { p.sixHourSnow = []; p.hourlySnow = []; }
      for (const id of ["alta", "snowbird", "solitude", "brighton", "snowbasin"] as const) s.sources[id] = undefined;
      return s;
    };
    // Legacy six-hour-only snapshot: the only snow is in the bar covering now.
    const legacy = quiet();
    const lp = (legacy.sources.nws!.payload as NwsPayload).points[0];
    delete lp.hourlySnow;
    lp.sixHourSnow = [
      { start: new Date(SIX_AM.getTime() - 5 * h).toISOString(), snowIn: 2, snowLevelFt: null },
      { start: new Date(SIX_AM.getTime() + h).toISOString(), snowIn: 0, snowLevelFt: null },
    ];
    expect(dailySnowActivity(legacy, SIX_AM).worthPosting).toBe(true);
    // A bar that ended at now is past, not ahead.
    lp.sixHourSnow[0].start = new Date(SIX_AM.getTime() - 6 * h).toISOString();
    expect(dailySnowActivity(legacy, SIX_AM).worthPosting).toBe(false);
    // Hourly series: the current hour counts.
    const hourly = quiet();
    const now = new Date(SIX_AM.getTime() + 30 * 60_000);
    (hourly.sources.nws!.payload as NwsPayload).points[0].hourlySnow = [{ start: SIX_AM.toISOString(), snowIn: 1 }];
    expect(dailySnowActivity(hourly, now).worthPosting).toBe(true);
  });
});
