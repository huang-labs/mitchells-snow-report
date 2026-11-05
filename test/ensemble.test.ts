import { describe, expect, it } from "vitest";
import { collectSource, isDue, runCollection } from "@/lib/collect";
import { ensembleGuidance } from "@/lib/ensemble";
import { buildDigest } from "@/lib/dailysnow/facts";
import { buildDailyDigest } from "@/lib/dailysnow/digest";
import { buildModelInput as dailyInput, SYSTEM_PROMPT as dailyPrompt } from "@/lib/dailysnow/llm";
import { PRIMARY_MODEL } from "@/lib/ai/model";
import { ensembleSource, ensembleTimeLabel, parseEnsemble } from "@/lib/sources/ensemble";
import { plumesSource } from "@/lib/sources/plumes";
import { MemoryKV, readSnapshot, writeSnapshot } from "@/lib/store";
import type { Snapshot } from "@/lib/types";
import { createFixtureFetch, fixture } from "./fixtureFetch";

const html = fixture("utah-ensemble-CLN-2026110112.html");
const now = new Date("2026-11-01T18:30:00Z");
async function snapshot() {
  const rec = await collectSource(ensembleSource, undefined, {}, now, createFixtureFetch().fetchImpl);
  expect(rec.status).toBe("ok");
  return { schemaVersion: 1, writtenAt: now.toISOString(), sources: { ensemble: rec } } satisfies Snapshot;
}

describe("published ensemble parser", () => {
  it("captures real run, scope, units, all six tables and 40 ordered percentile columns", () => {
    const p = parseEnsemble(html);
    expect(p).toMatchObject({ initializedAt: "2026-11-01T12:00:00.000Z", members: 82, station: "CLN", elevationFt: 9416, traceLiquidCorrections: 3 });
    expect(p.periodEnds[0]).toBe("2026-11-01T18:00:00.000Z");
    expect(p.periodEnds.at(-1)).toBe("2026-11-11T12:00:00.000Z");
    expect(p.values.totalLiquidIn[0][0]).toBe(0.29);
    expect(Object.keys(p.values)).toHaveLength(6);
    expect(Object.values(p.values).flat(2).every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });
  it.each([
    ["units", "Total Snowfall (in)", "Total Snowfall (cm)"],
    ["station", "Point to CLN", "Point to PKCU1"],
    ["location", "40.579 N", "40.000 N"],
    ["members", "82 members", "0 members"],
    ["run", "1200 UTC", "2500 UTC"],
    ["date", "01 Nov 2026 (82", "31 Nov 2026 (82"],
    ["label", "11 AM Sun 01 Nov", "10 AM Sun 01 Nov"],
    ["row", ">P10<", ">P20<"],
    ["finite", ">0.29<", ">NaN<"],
    ["negative", ">0.29<", ">-0.02<"],
    ["percentile order", ">0.29<", ">900<"],
  ])("rejects changed %s", (_, before, after) => {
    expect(() => parseEnsemble(html.replace(before, after))).toThrow();
  });
  it("normalizes six-hour liquid trace negatives up to -0.05 and rejects larger ones", () => {
    // The live table began publishing -0.02 in the minimum-member row on Nov 5, 2026.
    expect(html).toContain(">-0.01<");
    expect(parseEnsemble(html.replace(">-0.01<", ">-0.02<")).traceLiquidCorrections).toBe(3);
    expect(parseEnsemble(html.replace(">-0.01<", ">-0.05<")).traceLiquidCorrections).toBe(3);
    expect(() => parseEnsemble(html.replace(">-0.01<", ">-0.06<"))).toThrow(/Non-numeric ensemble value: liquidIn/);
  });
  it("rejects absent tables and truncated periods", () => {
    expect(() => parseEnsemble(html.replace(/<table>[\s\S]*?<\/table>/, ""))).toThrow();
    expect(() => parseEnsemble(html.replace(/<td[^>]*>[^<]*<\/td>/, ""))).toThrow();
  });
  it.each(["2026-11-01T00:00:00Z", "2026-03-08T00:00:00Z"])("maps UTC leads across Denver DST (%s)", (run) => {
    const t = new Date(run);
    const initialized = run.includes("11-01") ? "0000 UTC 01 Nov 2026" : "0000 UTC 08 Mar 2026";
    const p = parseEnsemble(html.replace("1200 UTC 01 Nov 2026", initialized).replace(/\d{2} (?:AM|PM) [A-Z][a-z]{2} \d{2} [A-Z][a-z]{2} 2026/g, (label) => {
      // Relabel the real captured values for an explicit clock-only DST test.
      const original = parseEnsemble(html).periodEnds.findIndex((end) => ensembleTimeLabel(new Date(end)) === label);
      return ensembleTimeLabel(new Date(t.getTime() + (original + 1) * 6 * 3_600_000));
    }));
    expect(p.periodEnds.slice(0, 3)).toEqual([6, 12, 18].map((h) => new Date(t.getTime() + h * 3_600_000).toISOString()));
    expect(ensembleTimeLabel(new Date(p.periodEnds[0])).slice(0, 5)).not.toBe(ensembleTimeLabel(new Date(p.periodEnds[1])).slice(0, 5));
  });
});

describe("numeric source and model boundary", () => {
  it("isolates numerical failures, preserves last good payload and chart collection", async () => {
    const s = await snapshot();
    const kv = new MemoryKV();
    await writeSnapshot(kv, s);
    const fetchImpl = createFixtureFetch([[/ensgefsdslccforecast/, () => new Response("bad upstream", { status: 502 })]]).fetchImpl;
    await runCollection({ SNOW_KV: kv }, { now, only: ["ensemble", "plumes"], sources: [ensembleSource, plumesSource], fetchImpl });
    const saved = (await readSnapshot(kv))!;
    expect(saved.sources.ensemble).toMatchObject({ status: "error", payload: s.sources.ensemble.payload, lastSuccessfulFetchAt: now.toISOString() });
    expect(saved.sources.plumes?.status).toBe("ok");
    const guidance = ensembleGuidance(saved, now);
    expect(guidance.status).toBe("unavailable");
    expect(guidance).not.toHaveProperty("periods");
  });
  it("rejects future and regressed source runs and honors the 30-minute cadence", async () => {
    const s = await snapshot();
    expect((await collectSource(ensembleSource, undefined, {}, new Date("2026-11-01T10:00:00Z"), createFixtureFetch().fetchImpl)).status).toBe("error");
    const rec = structuredClone(s.sources.ensemble);
    (rec.payload as ReturnType<typeof parseEnsemble>).initializedAt = "2026-11-01T18:00:00Z";
    expect((await collectSource(ensembleSource, rec, {}, now, createFixtureFetch().fetchImpl)).lastError).toContain("regressed");
    expect(isDue(ensembleSource, s.sources.ensemble, new Date(+now + 10 * 60_000))).toBe(false);
    expect(isDue(ensembleSource, s.sources.ensemble, new Date(+now + 30 * 60_000))).toBe(true);
  });
  it("omits legacy, stale-fetch, old-run, failed and invalid-clock amounts from both digests", async () => {
    const s = await snapshot();
    const variants: Snapshot[] = [{ ...s, sources: {} }];
    for (const change of [
      { lastSuccessfulFetchAt: "2026-11-01T16:00:00Z" },
      { status: "error" as const },
      { lastSuccessfulFetchAt: "bad date" },
      { lastSuccessfulFetchAt: "2026-11-02T18:30:00Z" },
    ]) variants.push({ ...s, sources: { ensemble: { ...s.sources.ensemble, ...change } } });
    const old = structuredClone(s);
    (old.sources.ensemble.payload as ReturnType<typeof parseEnsemble>).initializedAt = "2026-10-31T12:00:00Z";
    variants.push(old);
    for (const v of variants) {
      expect(buildDigest(v, {}, now).ensemble?.status).toBe("unavailable");
      expect(buildDailyDigest(v, null, [], now).digest.ensemble).not.toHaveProperty("periods");
    }
  });
  it("feeds identical scoped future six-hour uncertainty to both prompts, without cumulative totals", async () => {
    const s = await snapshot();
    const pick = buildDigest(s, {}, now);
    const daily = buildDailyDigest(s, null, [], now).digest;
    expect(pick.ensemble).toEqual(daily.ensemble);
    const e = pick.ensemble!;
    expect(e.status).toBe("current");
    if (e.status !== "current") throw new Error("not current");
    expect(e.periods[0].start).toBe("2026-11-02T00:00:00.000Z");
    expect(e.periods.at(-1)?.end).toBe("2026-11-11T12:00:00.000Z");
    expect(e.periods[0].snowIn).toHaveLength(3);
    for(const input of [dailyInput(PRIMARY_MODEL,daily)]) {
      const text = JSON.stringify(input);
      expect(text).toContain("not BCC-specific");
      expect(text).toContain("P10, P50, P90");
      expect(text).not.toContain("totalSnowIn");
      expect(text).not.toContain("image_url");
    }
    for(const prompt of [dailyPrompt]) {
      expect(prompt).toContain("percentiles");
      expect(prompt).toContain("CLN");
    }
  });
});
