import { describe, expect, it } from "vitest";
import { runCollection } from "@/lib/collect";
import { createFetchContext } from "@/lib/http";
import { embeddedCams } from "@/lib/sources/resortcams";
import {
  captureTime,
  parseAltaCams,
  parseSnowbirdCams,
  resortCamsSource,
  youtubeIds,
} from "@/lib/sources/resortcams";
import { MemoryKV, readSnapshot } from "@/lib/store";
import type { ResortCamsPayload } from "@/lib/types";
import { createFixtureFetch, fixture, FIXTURE_NOW } from "./fixtureFetch";

const collect = async (kv: MemoryKV, fetchImpl: typeof fetch) => {
  await runCollection({ SNOW_KV: kv }, { now: FIXTURE_NOW, fetchImpl, only: ["resortcams"] });
  const rec = (await readSnapshot(kv))!.sources.resortcams!;
  return { rec, payload: rec.payload as ResortCamsPayload };
};

describe("resort webcam discovery", () => {
  it("Alta: reads the camera list from window.Alta on the weather page", () => {
    const cams = parseAltaCams(fixture("alta-weather.html"));
    expect(cams.find((c) => c.title === "Snow Stake")?.imageUrl).toBe(
      "https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/Collins_Snow_Stake.jpg",
    );
    expect(cams.some((c) => c.title === "Albion Basin")).toBe(true);
  });

  it("Snowbird: pairs each webcam card's name with its own image", () => {
    const cams = parseSnowbirdCams(fixture("snowbird-webcams.html"));
    expect(cams.find((c) => c.title === "Tram Bullpen")?.imageUrl).toBe("https://manage.hdrelay.com/snapshot/61b2490be101c00b9c48374f");
    expect(cams.find((c) => c.title === "Snowstake")?.imageUrl).toBe("https://manage.hdrelay.com/snapshot/8611e276-7ee5-42c0-b8cd-d9e1890e1cd4");
  });

  it("finds YouTube live embeds", () => {
    expect(youtubeIds(fixture("brighton-conditions.html"))).toContain("N-d3MuOagLg");
    expect(youtubeIds(fixture("solitude-webcams.html"))).toHaveLength(12);
  });

  it("ignores Last-Modified values in the future", () => {
    expect(captureTime("Sat, 31 Oct 2026 00:55:00 GMT", FIXTURE_NOW)).toBe("2026-10-31T00:55:00.000Z");
    expect(captureTime("Sat, 31 Oct 2026 02:00:00 GMT", FIXTURE_NOW)).toBeNull();
    expect(captureTime(null, FIXTURE_NOW)).toBeNull();
  });
});

describe("resort webcam collection", () => {
  it("collects every camera each resort publishes, featured ones first", async () => {
    const { fetchImpl } = createFixtureFetch();
    const { rec, payload } = await collect(new MemoryKV(), fetchImpl);
    expect(rec.status).toBe("ok");
    expect(payload.failures).toHaveLength(12);
    expect(payload.failures.every(f=>!/^alta:|^snowbird:|^solitude:|^brighton:/.test(f))).toBe(true);
    const summary = payload.cameras.map((c) => [c.resort, c.title, c.kind === "youtube" ? c.videoId : c.kind==="image"?c.capturedAt:null]);
    expect(summary).toEqual([
      // Featured first, then the rest in page order.
      ["alta", "Snow Stake", "2026-10-31T00:55:00.000Z"],
      ["alta", "Albion Basin", null], // future Last-Modified rejected
      ["alta", "Mount Baldy", null], // prismcam too
      ["alta", "Mount Superior", "2026-10-31T00:55:00.000Z"],
      ["alta", "Sugarloaf Peak", "2026-10-31T00:55:00.000Z"],
      ["alta", "East Greeley", "2026-10-31T00:55:00.000Z"],
      ["alta", "Salt Lake Valley", "2026-10-31T00:55:00.000Z"],
      ["snowbird", "Snowstake", "2026-10-31T00:52:00.000Z"],
      ["snowbird", "Tram Bullpen", "2026-10-31T00:52:00.000Z"],
      ["snowbird", "Peruvian Gulch", "2026-10-31T00:52:00.000Z"],
      ["snowbird", "Mineral Basin", "2026-10-31T00:52:00.000Z"],
      ["snowbird", "Little Cloud", "2026-10-31T00:52:00.000Z"],
      ["snowbird", "Hidden Peak", "2026-10-31T00:52:00.000Z"],
      // Hidden Peak 360 is excluded: a 360° panorama with no snow information.
      ["solitude", "Solitude Snowstake", "lkEM6EC8NVA"],
      ["solitude", "Moonbeam Lift Line", "NSiItCGabfo"],
      ["solitude", "Apex Express and Sunrise Lift Lines", "l2X9DlRzX54"],
      ["solitude", "Honeycomb Canyon", "ta-4QZbfMXc"],
      ["solitude", "Powderhorn", "xNER0JHrqLg"],
      ["solitude", "Sunshine Bowl", "Lnznapxh2xM"],
      // gfHReYIuydU, rUXoOLxKKX4 and j65wBm5rr_0 have no public oEmbed title
      // (their players only show "video unavailable") and are dropped.
      ["solitude", "Eagle Express Lift Line", "oWaG8txpW1c"],
      ["solitude", "Powderhorn II Lift Line", "yeoBog_kSzc"],
      ["solitude", "Link Lift Line", "Yx3QmuKfwjY"],
      ["brighton", "Parking Lot", "4a-3iEM7bHk"],
      ["brighton", "Milly Express", "N-d3MuOagLg"],
      ["brighton", "Molly Greens View", "uZ24vqOWEkQ"],
      ["brighton", "Top of Crest Lift", "Zv8HYwaXjBg"],
      ["brighton", "Explorer Lift", "vMwQRjlfqtA"],
    ]);
  });

  it("reuses known stream titles instead of re-querying oEmbed", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = createFixtureFetch();
    await collect(kv, fetchImpl);
    const before = calls.filter((u) => u.includes("oembed")).length;
    await collect(kv, fetchImpl);
    const after = calls.filter((u) => u.includes("oembed")).length - before;
    expect(before).toBeGreaterThan(0);
    // Every title — including failed lookups for private streams — is cached,
    // so the steady state costs no oEmbed calls at all.
    expect(after).toBe(0);
  });

  it("isolates a failing resort page and keeps that resort's previous cameras", async () => {
    const kv = new MemoryKV();
    await collect(kv, createFixtureFetch().fetchImpl);
    const { fetchImpl } = createFixtureFetch([[/snowbird\.com\/the-mountain\/webcams/, () => new Response("down", { status: 503 })]]);
    const { rec, payload } = await collect(kv, fetchImpl);
    expect(rec.status).toBe("ok");
    expect(payload.failures).toHaveLength(13);
    expect(payload.failures).toContainEqual(expect.stringMatching(/^snowbird: .*503/));
    expect(payload.cameras.filter((c) => c.resort === "snowbird").map((c) => c.title)).toEqual([
      "Snowstake",
      "Tram Bullpen",
      "Peruvian Gulch",
      "Mineral Basin",
      "Little Cloud",
      "Hidden Peak",
    ]);
    expect(payload.cameras.filter((c) => c.resort === "alta")).toHaveLength(7);
  });

  it("drops a camera whose image is not reachable", async () => {
    const { fetchImpl } = createFixtureFetch([[/manage\.hdrelay\.com\/snapshot\/61b2/, () => new Response("err", { status: 500 })]]);
    const { payload } = await collect(new MemoryKV(), fetchImpl);
    expect(payload.cameras.filter((c) => c.resort === "snowbird").map((c) => c.title)).toEqual([
      "Snowstake",
      "Peruvian Gulch",
      "Mineral Basin",
      "Little Cloud",
      "Hidden Peak",
    ]);
  });

  it("is not a required source", () => {
    expect(resortCamsSource.required).toBe(false);
  });
});

describe("embedded official resort cameras", () => {
  it("skips a malformed iframe URL without dropping the resort's other cameras", async () => {
    const page = `<iframe title="Bad" src="https://exa mple.com:bad/"></iframe>
      <iframe title="Summit cam" src="https://g0.ozolio.com/player/abc"></iframe>`;
    const fetchImpl = (async () => new Response(page, { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    const ctx = createFetchContext({}, FIXTURE_NOW, fetchImpl);
    const cams = await embeddedCams(ctx, "telluride", "https://tellurideskiresort.com/webcams/", {});
    expect(cams.map((c) => c.title)).toEqual(["Summit cam"]);
  });
});
