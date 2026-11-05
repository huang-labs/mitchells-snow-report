import { decode, encode } from "fast-png";
import { describe, expect, it, vi } from "vitest";
import { runCollection } from "@/lib/collect";
import { cropSnowPanels, findRightColumnFrames } from "@/lib/plumeCrop";
import { PLUME_MAX_CROP_ATTEMPTS, PLUME_PANEL_REFRESH_MS, PLUME_PANEL_TTL_S, plumePanelsLive } from "@/lib/plumePanels";
import { MemoryKV, plumePanelKey, readSnapshot, writeSnapshot } from "@/lib/store";
import { denverMidnightsBetween } from "@/lib/time";
import type { PlumeChart, PlumePayload } from "@/lib/types";
import { createFixtureFetch, FIXTURE_NOW, fixtureBytes } from "./fixtureFetch";

// Each plume collection decodes, crops and re-encodes 12 full-size charts, so
// tests that run several collections take ~3-5 s on CI runners; vitest's 5 s
// default leaves no headroom.
const IMAGE_HEAVY = { timeout: 20_000 };

const chart = () => fixtureBytes("utah-plume-CLN-2026110100.png");

describe("plume panel cropping", IMAGE_HEAVY, () => {
  it("finds the accumulated snow and SLR panels from the chart's axes frames", () => {
    const panels = cropSnowPanels(chart());
    expect(panels.map((p) => p.id)).toEqual(["snow", "slr"]);
    for (const p of panels) {
      const img = decode(p.png);
      expect([img.width, img.height]).toEqual([p.width, p.height]);
      // Half the 1984 px figure width, title included, UTC tick labels cut off.
      expect(p.width).toBeGreaterThan(850);
      expect(p.width).toBeLessThan(1000);
      expect(p.height).toBeGreaterThan(450);
      expect(p.height).toBeLessThan(600);
      expect(p.plot.left).toBeGreaterThan(40); // y-axis label and tick labels kept
      expect(p.plot.right - p.plot.left).toBeGreaterThan(800);
      expect(p.plot.top).toBeGreaterThan(15); // panel title kept
      expect(p.height - p.plot.bottom).toBeLessThan(15); // only tick marks and the bottom y tick label below the frame
    }
  });

  it("keeps y tick labels that overhang the frame's top and bottom edges whole", () => {
    // Paint label-sized marks centred on the top and bottom edges of each
    // snow panel's frame, where matplotlib puts e.g. "25" and "0".
    const img = decode(chart());
    const r = { width: img.width, height: img.height, rgba: img.data as Uint8Array };
    const { frames } = findRightColumnFrames(r);
    const LABEL = { dx: -28, w: 12, h: 14 };
    const paint = (x0: number, yc: number) => {
      for (let y = yc - LABEL.h / 2; y < yc + LABEL.h / 2; y++)
        for (let x = x0; x < x0 + LABEL.w; x++) r.rgba.set([0, 0, 0, 255], (y * r.width + x) * 4);
    };
    for (const f of [frames[0], frames[2]]) {
      paint(f.left + LABEL.dx, f.top);
      paint(f.left + LABEL.dx, f.bottom);
    }
    const panels = cropSnowPanels(encode({ width: r.width, height: r.height, data: r.rgba, channels: 4, depth: 8 }));
    for (const p of panels) {
      const out = decode(p.png);
      const d = out.data as Uint8Array;
      const black = (yc: number) => {
        let n = 0;
        for (let y = yc - LABEL.h / 2; y < yc + LABEL.h / 2; y++)
          for (let x = p.plot.left + LABEL.dx; x < p.plot.left + LABEL.dx + LABEL.w; x++) {
            const i = (y * out.width + x) * 4;
            if (y >= 0 && y < out.height && d[i] === 0 && d[i + 3] === 255) n++;
          }
        return n;
      };
      expect(black(p.plot.top)).toBe(LABEL.w * LABEL.h);
      expect(black(p.plot.bottom)).toBe(LABEL.w * LABEL.h);
    }
  });

  it("refuses an image without the expected panel layout", () => {
    const blank = encode({ width: 400, height: 300, data: new Uint8Array(400 * 300 * 4).fill(255), channels: 4, depth: 8 });
    expect(() => cropSnowPanels(blank)).toThrow(/frame edge columns/);
  });
});

describe("plume collection", IMAGE_HEAVY, () => {
  it("stores cropped panels per station and run, and references them by same-origin URL", async () => {
    const kv = new MemoryKV();
    const { fetchImpl } = createFixtureFetch();
    await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl, only: ["plumes"] });
    const p = (await readSnapshot(kv))!.sources.plumes!.payload as PlumePayload;
    for (const c of p.charts) {
      expect(c.cropError).toBeNull();
      expect(c.forecastHours).toBe(240);
      expect(c.panels!.map((x) => x.url)).toEqual([
        `/api/plume/${c.stationCode}/2026103012/snow`,
        `/api/plume/${c.stationCode}/2026103012/slr`,
      ]);
      const stored = await kv.get(plumePanelKey(c.stationCode, "2026103012", "snow"), "arrayBuffer");
      expect(decode(new Uint8Array(stored!)).width).toBe(c.panels![0].width);
    }
  });

  it("crops each run once; later collections of the same run reuse the stored panels", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = createFixtureFetch();
    await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl, only: ["plumes"] });
    const first = calls.filter((u) => u.endsWith(".png")).length;
    await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl, only: ["plumes"] });
    const second = calls.filter((u) => u.endsWith(".png")).length - first;
    expect(second).toBe(12); // one HEAD per station, no re-download
    const p = (await readSnapshot(kv))!.sources.plumes!.payload as PlumePayload;
    expect(p.charts.every((c) => c.panels?.length === 2)).toBe(true);
  });

  it("falls back to the full original chart when cropping fails", async () => {
    const kv = new MemoryKV();
    const notAChart = encode({ width: 40, height: 30, data: new Uint8Array(40 * 30 * 4).fill(255), channels: 4, depth: 8 });
    const { fetchImpl } = createFixtureFetch([
      [/weather\.utah\.edu\/.*\.png$/, (_u, init) => new Response(init?.method === "HEAD" ? null : (notAChart.slice().buffer as ArrayBuffer), { headers: { "content-type": "image/png" } })],
    ]);
    const summary = await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl, only: ["plumes"] });
    expect(summary.results[0].ok).toBe(true); // the plume run itself is still valid
    const p = (await readSnapshot(kv))!.sources.plumes!.payload as PlumePayload;
    expect(p.charts.every((c) => c.panels === null && c.cropError)).toBe(true);
    expect(p.charts[0].imageUrl).toMatch(/^https:\/\/weather\.utah\.edu\//);
  });
});

describe("plume panel recovery", IMAGE_HEAVY, () => {
  const H = 3_600_000;
  const pngCalls = (calls: string[]) => calls.filter((u) => u.endsWith(".png")).length;
  const charts = async (kv: MemoryKV) => ((await readSnapshot(kv))!.sources.plumes!.payload as PlumePayload).charts;
  const blank = encode({ width: 40, height: 30, data: new Uint8Array(40 * 30 * 4).fill(255), channels: 4, depth: 8 });

  it("re-crops a run still current a day before its panels expire, restarting their TTL", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = createFixtureFetch();
    await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl, only: ["plumes"] });
    expect((await charts(kv)).every((c) => c.panelsStoredAt === FIXTURE_NOW.toISOString())).toBe(true);
    let before = pngCalls(calls);
    const notYet = new Date(FIXTURE_NOW.getTime() + PLUME_PANEL_REFRESH_MS - H);
    await runCollection({ SNOW_KV: kv }, { now: notYet, fetchImpl, only: ["plumes"] });
    expect(pngCalls(calls) - before).toBe(12); // HEAD only
    before = pngCalls(calls);
    const due = new Date(FIXTURE_NOW.getTime() + PLUME_PANEL_REFRESH_MS);
    await runCollection({ SNOW_KV: kv }, { now: due, fetchImpl, only: ["plumes"] });
    expect(pngCalls(calls) - before).toBe(24); // HEAD and download per station
    expect((await charts(kv)).every((c) => c.panelsStoredAt === due.toISOString() && c.panels?.length === 2)).toBe(true);
  });

  it("refreshes legacy panels by run initialization time", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = createFixtureFetch();
    await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl, only: ["plumes"] });
    const snap = (await readSnapshot(kv))!;
    for (const c of (snap.sources.plumes!.payload as PlumePayload).charts) delete c.panelsStoredAt;
    await writeSnapshot(kv, snap);
    const init = Date.parse((await charts(kv))[0].initTime);
    const before = pngCalls(calls);
    await runCollection({ SNOW_KV: kv }, { now: new Date(init + PLUME_PANEL_REFRESH_MS), fetchImpl, only: ["plumes"] });
    expect(pngCalls(calls) - before).toBe(24);
  });

  it("retries a failed crop hourly, three times per run, then keeps the full chart", async () => {
    const kv = new MemoryKV();
    let broken = true;
    const { fetchImpl, calls } = createFixtureFetch([
      [/weather\.utah\.edu\/.*\.png$/, (_u, init) => new Response(init?.method === "HEAD" ? null : ((broken ? blank : fixtureBytes("utah-plume-CLN-2026110100.png")).slice().buffer as ArrayBuffer), { headers: { "content-type": "image/png" } })],
    ]);
    const at = (h: number) => new Date(FIXTURE_NOW.getTime() + h * H);
    await runCollection({ SNOW_KV: kv }, { now: at(0), fetchImpl, only: ["plumes"] });
    expect((await charts(kv)).every((c) => c.cropAttempts === 1 && c.panels === null)).toBe(true);
    let before = pngCalls(calls);
    await runCollection({ SNOW_KV: kv }, { now: at(0.5), fetchImpl, only: ["plumes"] });
    expect(pngCalls(calls) - before).toBe(12); // within the hour: no retry
    for (const h of [1, 2]) await runCollection({ SNOW_KV: kv }, { now: at(h), fetchImpl, only: ["plumes"] });
    expect((await charts(kv)).every((c) => c.cropAttempts === PLUME_MAX_CROP_ATTEMPTS && c.cropError)).toBe(true);
    broken = false;
    before = pngCalls(calls);
    await runCollection({ SNOW_KV: kv }, { now: at(5), fetchImpl, only: ["plumes"] });
    expect(pngCalls(calls) - before).toBe(12); // attempts exhausted for this run
    expect((await charts(kv)).every((c) => c.panels === null)).toBe(true);
  });

  it("recovers on a retry, and drops expired panels when the refresh keeps failing", async () => {
    const kv = new MemoryKV();
    let broken = false;
    const { fetchImpl } = createFixtureFetch([
      [/weather\.utah\.edu\/.*\.png$/, (_u, init) => new Response(init?.method === "HEAD" ? null : ((broken ? blank : fixtureBytes("utah-plume-CLN-2026110100.png")).slice().buffer as ArrayBuffer), { headers: { "content-type": "image/png" } })],
    ]);
    await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl, only: ["plumes"] });
    broken = true;
    const refresh = FIXTURE_NOW.getTime() + PLUME_PANEL_REFRESH_MS;
    await runCollection({ SNOW_KV: kv }, { now: new Date(refresh), fetchImpl, only: ["plumes"] });
    // Failed refresh: the still-live panels stay, with the error recorded.
    expect((await charts(kv)).every((c) => c.panels?.length === 2 && c.cropAttempts === 1 && c.panelsStoredAt === FIXTURE_NOW.toISOString())).toBe(true);
    for (const h of [1, 2]) await runCollection({ SNOW_KV: kv }, { now: new Date(refresh + h * H), fetchImpl, only: ["plumes"] });
    const expired = new Date(FIXTURE_NOW.getTime() + PLUME_PANEL_TTL_S * 1000);
    await runCollection({ SNOW_KV: kv }, { now: expired, fetchImpl, only: ["plumes"] });
    const after = await charts(kv);
    expect(after.every((c) => c.panels === null && c.cropError)).toBe(true);
    expect(after.every((c) => !plumePanelsLive(c, expired))).toBe(true);
  });

  it("treats panels as unavailable once their TTL has passed, so readers fall back", () => {
    const chart = { panels: [{}], panelsStoredAt: FIXTURE_NOW.toISOString(), initTime: "2026-10-30T12:00:00.000Z" } as unknown as PlumeChart;
    expect(plumePanelsLive(chart, new Date(FIXTURE_NOW.getTime() + PLUME_PANEL_TTL_S * 1000 - 1))).toBe(true);
    expect(plumePanelsLive(chart, new Date(FIXTURE_NOW.getTime() + PLUME_PANEL_TTL_S * 1000))).toBe(false);
    expect(plumePanelsLive({ ...chart, panelsStoredAt: undefined }, new Date(Date.parse(chart.initTime) + PLUME_PANEL_TTL_S * 1000))).toBe(false);
  });
});

describe("GET /api/plume/[station]/[run]/[panel]", () => {
  const call = async (kv: MemoryKV, station: string, run: string, panel: string) => {
    const { plumePanel } = await import("@/worker/plume");
    const res = await plumePanel({ SNOW_KV: kv }, station, run, panel);
    return res;
  };

  it("serves a stored panel as a long-cacheable PNG", async () => {
    const kv = new MemoryKV();
    await kv.put(plumePanelKey("CLN", "2026110100", "slr"), new Uint8Array([137, 80, 78, 71]).buffer);
    const res = await call(kv, "CLN", "2026110100", "slr");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("rejects unknown stations, runs and panels without touching storage", async () => {
    const kv = new MemoryKV();
    const spy = vi.spyOn(kv, "get");
    for (const [s, r, p] of [["XYZ", "2026110100", "snow"], ["CLN", "latest", "snow"], ["CLN", "2026110100", "precip"]]) {
      expect((await call(kv, s, r, p)).status).toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
    expect((await call(kv, "CLN", "2026110100", "snow")).status).toBe(404); // valid but not stored
  });
});

describe("Mountain Time axis", () => {
  it("lists Denver midnights across the end of DST", () => {
    const start = new Date("2026-10-31T00:00:00Z"); // Oct 30, 6 PM MDT
    const ms = denverMidnightsBetween(start, new Date(start.getTime() + 72 * 3_600_000));
    expect(ms.map((d) => d.toISOString())).toEqual([
      "2026-10-31T06:00:00.000Z", // Oct 31 00:00 MDT
      "2026-11-01T06:00:00.000Z", // Nov 1 00:00 MDT (DST ends at 2 AM)
      "2026-11-02T07:00:00.000Z", // Nov 2 00:00 MST
    ]);
  });
});
