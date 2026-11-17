import { beforeAll, describe, expect, it } from "vitest";
import { runCollection } from "@/lib/collect";
import { emptyDailySnowState } from "@/lib/dailysnow";
import { publicationRequest } from "@/lib/dailysnow/channels";
import { ChannelPublisher, MemoryChannelStorage, type PublisherEnv } from "@/lib/dailysnow/publisher";
import { regionalSnapshot } from "@/lib/dailysnow/regions";
import { regionalSignals, settlingHold, stormUpdateDue, STORM_UPDATE_TRIGGER, type RegionalSignals } from "@/lib/dailysnow/storm-update";
import { emptySnowfall } from "@/lib/metric";
import { MemoryKV, readSnapshot } from "@/lib/store";
import type { DailySnowPost, DailySnowState, ResortReport, Snapshot } from "@/lib/types";
import { createFixtureFetch } from "./fixtureFetch";

// 8 AM MST: inside Utah's 7–11 AM window.
const now = new Date("2026-11-05T15:00:00Z");
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
let base: Snapshot;
beforeAll(async () => {
  const kv = new MemoryKV();
  await runCollection({ SNOW_KV: kv }, { now, fetchImpl: createFixtureFetch().fetchImpl });
  base = (await readSnapshot(kv))!;
});

/** Every source re-fetched at `at`; Park City (0″ in the fixture) then reports `inches` in every rolling window. */
function collectedAt(at: Date, inches?: number): Snapshot {
  const s = structuredClone(base);
  for (const source of Object.values(s.sources)) if (source?.lastSuccessfulFetchAt) source.lastSuccessfulFetchAt = source.lastAttemptAt = at.toISOString();
  if (inches === undefined) return s;
  const r = s.sources["park-city"]!.payload as ResortReport;
  for (const key of ["h24", "h48", "h72", "d7"] as const)
    r.snowfall[key] = { state: "reported", value: inches, unit: "in", label: r.snowfall[key].label };
  return s;
}

/** Telluride's conflicting fixture report (overnight 6″ against 24 h 0″), republished at `iso`. */
function tellurideAt(s: Snapshot, iso: string | null): Snapshot {
  const out = structuredClone(s);
  (out.sources.telluride!.payload as ResortReport).reportTime = iso;
  return out;
}
// 7:20 AM MST on the test morning.
const thisMorning = "2026-11-05T14:20:00Z";

const reply = (title: string) => ({
  title,
  summary: "Mountain weather varies across the tracked locations.",
  sections: [{ id: "update", paragraphs: [{ text: "Check the source times for the latest mountain forecast.", figure: "none" }] }],
});

function setup() {
  let snapshot = base;
  const prompts: string[] = [];
  const env: PublisherEnv = {
    SNOW_KV: new MemoryKV(),
    AI: {
      async run(_model: string, input: unknown) {
        prompts.push(JSON.stringify(input));
        return { response: JSON.stringify(reply(prompts.length === 1 ? "Morning Edition" : "Storm Update")) };
      },
    },
  };
  const publisher = new ChannelPublisher("utah", new MemoryChannelStorage(), env, { snapshot: async () => snapshot, editions: async () => ({}) });
  const request = (at: Date) => publisher.request(publicationRequest(snapshot, "utah", at));
  return { publisher, prompts, request, use: (s: Snapshot) => void (snapshot = s) };
}

describe("regional signals", () => {
  it("reports current new snow and holds only for a conflict the previous morning didn't have", () => {
    expect(regionalSignals(regionalSnapshot(base, "utah"), now)).toEqual({ newSnow: { "park-city": 0 }, settling: [] });
    expect(regionalSignals(regionalSnapshot(tellurideAt(base, thisMorning), "colorado"), now).settling).toEqual(["Telluride"]);
    const stuck = tellurideAt(base, thisMorning);
    stuck.snowLog!.resorts.telluride = {
      "2026-11-04": { state: "unavailable", label: "Last 24 hours", qualityNote: "Withheld", windowEnd: null, collectedAt: now.toISOString() },
    };
    expect(regionalSignals(regionalSnapshot(stuck, "colorado"), now).settling).toEqual([]);
  });

  it("never holds for a conflict in a report from an earlier day or without a report time", () => {
    // The fixture's own report time is 10:34 PM MST the previous evening.
    expect(regionalSignals(regionalSnapshot(base, "colorado"), now).settling).toEqual([]);
    // 11:59 PM MST yesterday versus 12:01 AM MST today.
    expect(regionalSignals(regionalSnapshot(tellurideAt(base, "2026-11-05T06:59:00Z"), "colorado"), now).settling).toEqual([]);
    expect(regionalSignals(regionalSnapshot(tellurideAt(base, "2026-11-05T07:01:00Z"), "colorado"), now).settling).toEqual(["Telluride"]);
    expect(regionalSignals(regionalSnapshot(tellurideAt(base, null), "colorado"), now).settling).toEqual([]);
  });

  it("holds a morning edition for settling reports until 8 AM local", () => {
    const signals: RegionalSignals = { newSnow: {}, settling: ["Palisades Tahoe"] };
    // 7:30 and 8:00 AM PST.
    expect(settlingHold(signals, new Date("2026-11-14T15:30:00Z"), "tahoe")).toBe("Waiting for resort reports to settle: Palisades Tahoe");
    expect(settlingHold(signals, new Date("2026-11-14T16:00:00Z"), "tahoe")).toBeNull();
    expect(settlingHold(signals, new Date("2026-11-14T15:30:00Z"), "western-us")).toBeNull();
  });
});

describe("storm update due", () => {
  const post = (patch: Partial<DailySnowPost> = {}): DailySnowPost => ({
    date: "2026-11-05", phase: "quiet", title: "t", summary: "s", sections: [], figures: {}, model: "m", trigger: "morning",
    generatedAt: "2026-11-05T14:00:00.000Z",
    numbers: { canyons: [], resorts: [{ id: "alta", name: "Alta", h24: 1, h48: null, seasonIn: null, storm: 1, reportTime: null,
      snowfall: { ...emptySnowfall(), h24: { state: "reported", value: 1, unit: "in", label: "Last 24 hrs" } } }] },
    ...patch,
  });
  const state = (p: DailySnowPost, patch: Partial<DailySnowState> = {}): DailySnowState => ({
    ...emptyDailySnowState(), current: p, lastAttemptAt: p.generatedAt, lastFinishedAt: p.generatedAt,
    attempts: { date: "2026-11-05", count: 1, calls: 2 }, ...patch,
  });
  const rise = (inches: number): RegionalSignals => ({ newSnow: { alta: inches }, settling: [] });

  it("rewrites once when a resort's new snow rose 3″ since the edition", () => {
    expect(stormUpdateDue(state(post()), rise(3), now, "utah")).toBe(null);
    expect(stormUpdateDue(state(post()), rise(4), now, "utah")).toMatch(/^New snow reported since .*: Alta 4″ \(1″ in this morning's edition\)$/);
    expect(stormUpdateDue(state(post({ trigger: STORM_UPDATE_TRIGGER })), rise(9), now, "utah")).toBeNull();
  });

  it("counts a resort the edition had no usable report for as 0″", () => {
    const p = post({ numbers: { canyons: [], resorts: [{ id: "alta", name: "Alta", h24: null, h48: null, seasonIn: null, storm: null, reportTime: null }] } });
    expect(stormUpdateDue(state(p), rise(3), now, "utah")).toMatch(/Alta 3″ \(0″/);
  });

  it("respects the cutoff, caps, retries, settling reports and other days", () => {
    expect(stormUpdateDue(state(post()), rise(9), new Date("2026-11-05T18:00:00Z"), "utah")).toBeNull(); // 11 AM
    expect(stormUpdateDue(state(post(), { attempts: { date: "2026-11-05", count: 3, calls: 6 } }), rise(9), now, "utah")).toBeNull();
    expect(stormUpdateDue(state(post(), { lastError: "x", lastAttemptAt: later(-5).toISOString() }), rise(9), now, "utah")).toBeNull();
    expect(stormUpdateDue(state(post(), { lastError: "x", lastAttemptAt: later(-10).toISOString(), lastFinishedAt: later(-9).toISOString() }), rise(9), now, "utah")).not.toBeNull();
    expect(stormUpdateDue(state(post()), { newSnow: { alta: 9 }, settling: ["Alta"] }, now, "utah")).toBeNull();
    expect(stormUpdateDue(state(post({ date: "2026-11-04" })), rise(9), now, "utah")).toBeNull();
    expect(stormUpdateDue(state(post()), rise(9), now, "western-us")).toBeNull();
  });
});

describe("settling hold", () => {
  it("skips a morning edition while a report newly conflicts, then posts at 8 AM", async () => {
    const env: PublisherEnv = { SNOW_KV: new MemoryKV(), AI: { async run() { return { response: JSON.stringify(reply("Colorado")) }; } } };
    const publisher = new ChannelPublisher("colorado", new MemoryChannelStorage(), env, { snapshot: async () => base, editions: async () => ({}) });
    // 7:30 AM MST, Telluride's conflicting report was published at 7:20 AM.
    const early = new Date("2026-11-05T14:30:00Z");
    const s = tellurideAt(collectedAt(early), thisMorning);
    expect(await publisher.request(publicationRequest(s, "colorado", early))).toEqual({ channel: "colorado", skipped: "Waiting for resort reports to settle: Telluride" });
    const eight = new Date("2026-11-05T15:00:00Z");
    expect(await publisher.request(publicationRequest(tellurideAt(collectedAt(eight), thisMorning), "colorado", eight))).toEqual({ channel: "colorado", scheduled: eight.toISOString() });
    // A forced run never waits.
    const forced = new ChannelPublisher("colorado", new MemoryChannelStorage(), { ...env, SNOW_KV: new MemoryKV() }, { snapshot: async () => base, editions: async () => ({}) });
    expect(await forced.request(publicationRequest(s, "colorado", early, true))).toEqual({ channel: "colorado", scheduled: early.toISOString() });
  });
});

describe("storm update edition", () => {
  it("rewrites today's edition with the new reports, once, keeping the first posting time", async () => {
    const { publisher, prompts, request, use } = setup();
    expect(await request(now)).toEqual({ channel: "utah", scheduled: now.toISOString() });
    await publisher.runPending();
    const morning = (await publisher.state()).current!;
    expect(morning.trigger).toBe("morning");
    expect(morning.firstPostedAt).toBeUndefined();

    // Nothing new: the cron has nothing to do.
    use(collectedAt(later(30)));
    expect(await request(later(30))).toBeNull();
    use(collectedAt(later(35), 5));
    expect(await request(later(35))).toEqual({ channel: "utah", scheduled: later(35).toISOString() });
    expect(await publisher.runPending()).toEqual({ channel: "utah", published: "2026-11-05" });
    const update = (await publisher.state()).current!;
    expect(update).toMatchObject({ trigger: STORM_UPDATE_TRIGGER, title: "Storm Update", firstPostedAt: morning.generatedAt, generatedAt: later(35).toISOString() });
    expect((await publisher.state()).attempts).toEqual({ date: "2026-11-05", count: 2, calls: 4 });
    expect((await publisher.state()).history.filter((h) => h.date === "2026-11-05")).toHaveLength(1);
    // The model is told what changed and sees this morning's text.
    const prompt = prompts.at(-1)!;
    expect(prompt).toContain("storm update replacing this morning");
    expect(prompt).toContain("Park City 5″ (0″ in this morning's edition)");
    expect(prompt).toContain("Morning Edition");

    // One update per day, however much more is reported.
    use(collectedAt(later(60), 12));
    expect(await request(later(60))).toBeNull();
  });

  it("refunds the attempt when the new report is corrected before the update runs", async () => {
    const { publisher, request, use } = setup();
    await request(now);
    await publisher.runPending();
    use(collectedAt(later(35), 5));
    await request(later(35));
    use(collectedAt(later(35)));
    expect(await publisher.runPending()).toEqual({ channel: "utah", skipped: "storm update no longer due" });
    const s = await publisher.state();
    expect(s.current?.trigger).toBe("morning");
    expect(s.attempts).toEqual({ date: "2026-11-05", count: 1, calls: 2 });
  });
});
