import { describe, expect, it } from "vitest";
import { collectSource } from "@/lib/collect";
import { cpcSource, currentCpc, parseCpc } from "@/lib/sources/cpc";
import { MemoryKV } from "@/lib/store";
import type { CpcPayload, Snapshot } from "@/lib/types";
import { createFixtureFetch, fixture } from "./fixtureFetch";

// Captured outlook: issued 3 PM EST Nov 4 2026, valid Nov 12–18.
const now = new Date("2026-11-05T15:00:00Z");
const page = fixture("cpc-500mb.html");
const discussion = fixture("cpc-fxus06.html");
const snapshotWith = (rec: Snapshot["sources"]["cpc"]): Snapshot => ({ schemaVersion: 1, writtenAt: now.toISOString(), sources: { cpc: rec } });

describe("NOAA 8–14-day pattern outlook", () => {
  it("matches the map page and the written discussion to one issue and window", () => {
    const p = parseCpc(page, discussion);
    expect(p).toMatchObject({ issuedAt: "2026-11-04T20:00:00.000Z", validFrom: "2026-11-12", validTo: "2026-11-18" });
    expect(p.discussion).toMatch(/^The 0Z ECMWF/);
    expect(p.discussion).toContain("deep trough and negative 500-hPa height anomalies");
    expect(p.discussion).not.toMatch(/ {2}|FORECASTER/);
    // The 6–10-day outlook from the same issue, ending before week two's header.
    expect(p.sixToTen).toMatchObject({ validFrom: "2026-11-10", validTo: "2026-11-14" });
    expect(p.sixToTen!.discussion).toMatch(/^The 0Z ECMWF, GEFS, and Canadian ensemble mean forecasts/);
    expect(p.sixToTen!.discussion).toContain("FORECAST CONFIDENCE FOR THE 6-10 DAY PERIOD");
    expect(p.sixToTen!.discussion).not.toContain("8-14 DAY OUTLOOK");
  });

  it("rejects a map page and discussion from different issues", () => {
    expect(() => parseCpc(page.replace("Updated: 04 Nov 2026", "Updated: 03 Nov 2026"), discussion)).toThrow(/issue dates/);
    expect(() => parseCpc(page.replace("November 12 2026", "November 13 2026"), discussion)).toThrow(/8–14-day window|periods/);
    expect(() => parseCpc(page.replace(/814day\.03\.gif/g, "x.gif"), discussion)).toThrow(/metadata/);
    expect(() => parseCpc(page, discussion.replace("6-10 DAY OUTLOOK FOR NOV 10 - 14 2026", "6-10 DAY OUTLOOK FOR NOV 9 - 13 2026"))).toThrow(/6–10-day period/);
    expect(() => parseCpc(page, discussion.replace("6-10 DAY OUTLOOK FOR", "OUTLOOK FOR"))).toThrow(/6-10-day discussion unavailable/);
  });

  it("stores the verified map by content hash and keeps it out of stale or past articles", async () => {
    const kv = new MemoryKV();
    const rec = await collectSource(cpcSource, undefined, {}, now, createFixtureFetch().fetchImpl, kv);
    expect(rec.status).toBe("ok");
    const payload = rec.payload as CpcPayload;
    expect(payload.image).toMatchObject({ originUrl: cpcSource.sourceUrl.replace("500mb.php", "814day.03.gif"), width: expect.any(Number) });
    expect(payload.image.key).toMatch(/^cpc-map:v1:[0-9a-f]{64}$/);
    expect((await kv.get(payload.image.key, "arrayBuffer"))?.byteLength).toBeGreaterThan(1000);
    expect(currentCpc(snapshotWith(rec), now)).toEqual(payload);
    expect(currentCpc(snapshotWith(rec), new Date("2026-11-07T00:00:00Z"))).toBeNull();
    expect(currentCpc(snapshotWith(rec), new Date("2026-11-12T18:00:00Z"))).toBeNull();
    expect(currentCpc(snapshotWith({ ...rec, status: "error" }), now)).toBeNull();
  });

  it("fails without storing anything when the image is not a GIF", async () => {
    const kv = new MemoryKV();
    const fetchImpl = createFixtureFetch([[/814day\.03\.gif/, () => new Response("<html>", { headers: { "content-type": "image/gif" } })]]).fetchImpl;
    const rec = await collectSource(cpcSource, undefined, {}, now, fetchImpl, kv);
    expect(rec.status).toBe("error");
    expect(rec.lastError).toMatch(/GIF/);
  });
});
