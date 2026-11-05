import { describe, expect, it } from "vitest";
import { createFetchContext } from "@/lib/http";
import { embeddedCams } from "@/lib/sources/resortcams";
import { createFixtureFetch, fixture, FIXTURE_NOW } from "./fixtureFetch";
import { parseJacksonCams, JACKSON_CAMS_API } from "@/lib/sources/favorite-cams";
import { collectSource } from "@/lib/collect";
import { resortCamsSource } from "@/lib/sources/resortcams";
import type { ResortCamsPayload } from "@/lib/types";

const page = "https://www.snowbasin.com/the-mountain/web-cams/";
const context = (html: string) => createFetchContext({}, FIXTURE_NOW, (async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "manage.hdrelay.com" && url.pathname.startsWith("/player/")) {
    return Response.json(JSON.parse(fixture("snowbasin-camera-configs.json"))[url.pathname.split("/").at(-1)!]);
  }
  return new Response(init?.method === "HEAD" ? null : html, { headers: { "content-type": init?.method === "HEAD" ? "image/jpeg" : "text/html" } });
}) as typeof fetch);

describe("favorite camera discovery regressions", () => {
  it("discovers Snowbasin's script-initialized HDRelay cameras", async () => {
    const cams = await embeddedCams(context(fixture("snowbasin-webcams.html")), "snowbasin", page, {});
    expect(cams).toHaveLength(7);
    expect(cams.find(c => c.title === "Earl's Plaza")).toMatchObject({ kind: "image", imageUrl: "https://manage.hdrelay.com/snapshot/6192dd615233cdcad76d7dba" });
  });

  it("recovers a cached missing title after a temporary metadata outage", async () => {
    const previous = { cameras: [], failures: [], streamTitles: { abcdefghijk: "" } };
    let calls = 0;
    const ctx = createFetchContext({}, FIXTURE_NOW, (async (url) => {
      if (String(url).includes("/oembed")) { calls++; return Response.json({ title: "Recovered camera" }); }
      return new Response('<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>');
    }) as typeof fetch, { previous });
    const cams = await embeddedCams(ctx, "big-sky", "https://example.com/cams", previous.streamTitles);
    expect(cams.map(c => c.title)).toEqual(["Recovered camera"]);
    expect(calls).toBe(1);
  });

  it("reports an HTTP 200 anti-bot document as blocked discovery", async () => {
    const html = '<html><iframe src="/_Incapsula_Resource?incident_id=example">Request unsuccessful. Incapsula incident ID: example</iframe></html>';
    await expect(embeddedCams(context(html), "steamboat", "https://example.com/cams", {})).rejects.toThrow(/blocked.*anti-bot/i);
  });

  it("loads and verifies full-size Jackson Hole stills through the official JSON feed", async () => {
    const { fetchImpl, calls } = createFixtureFetch([
      [/jacksonhole-prod\.zaneray\.com\/api\/web-cams\.json/, () => Response.json(JSON.parse(fixture("jackson-webcams.json")))],
      [/cams\.jacksonhole\.com\/webcam\//, () => new Response(null, { headers: { "content-type": "image/jpeg" } })],
    ]);
    const cams = await embeddedCams(createFetchContext({}, FIXTURE_NOW, fetchImpl), "jackson-hole", "https://www.jacksonhole.com/live-mountain-cams", {});
    expect(cams).toHaveLength(7);
    expect(cams.find(c => c.title === "Cody Bowl")).toMatchObject({ kind: "image", imageUrl: "https://cams.jacksonhole.com/webcam/codybowl.jpg" });
    expect(calls[0]).toBe(JACKSON_CAMS_API);
    expect(calls).not.toContain("https://www.jacksonhole.com/live-mountain-cams");
    expect(parseJacksonCams({ webcams: [{ caption: "Untrusted", url: "https://example.com/cam.jpg" }, { caption: "Invalid", url: "not-a-url" }] })).toEqual([]);
  });

  it("isolates a failed HDRelay config and accepts verified images after HEAD fails", async () => {
    const configs = JSON.parse(fixture("snowbasin-camera-configs.json"));
    let fallbackChecks = 0;
    const ctx = createFetchContext({}, FIXTURE_NOW, (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/player/")) {
        const id = url.pathname.split("/").at(-1)!;
        return id === "6192dda05233cdcad76d7dbb" ? new Response("down", { status: 503 }) : Response.json(configs[id]);
      }
      if (url.pathname.startsWith("/snapshot/")) {
        if (init?.method === "HEAD") return new Response(null, { status: 500 });
        expect(new Headers(init?.headers).get("range")).toBe("bytes=0-0");
        fallbackChecks++;
        return new Response(null, { headers: { "content-type": "image/jpeg" } });
      }
      return new Response(fixture("snowbasin-webcams.html"));
    }) as typeof fetch);
    const cams = await embeddedCams(ctx, "snowbasin", page, {});
    expect(cams).toHaveLength(6);
    expect(cams.some(c => c.title === "Earl's Plaza")).toBe(false);
    expect(fallbackChecks).toBe(6);
  });

  it.each([429, 503, 401, 404])("expires negative metadata cache after HTTP %s and persists retries across collections", async (status) => {
    const delay = status === 401 || status === 404 ? 6 * 3_600_000 : 15 * 60_000;
    let unavailable = true;
    let metadataCalls = 0;
    const { fetchImpl } = createFixtureFetch([
      [/solitudemountain\.com\/mountain-and-village\/webcams/, () => new Response('<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>')],
      [/youtube\.com\/oembed.*abcdefghijk/, () => {
        metadataCalls++;
        return unavailable ? new Response("Unavailable", { status }) : Response.json({ title: "Recovered camera" });
      }],
    ]);
    const first = await collectSource(resortCamsSource, undefined, {}, FIXTURE_NOW, fetchImpl);
    const cache = first.payload as ResortCamsPayload;
    expect(cache.streamTitleRetryAt?.abcdefghijk).toBe(new Date(+FIXTURE_NOW + delay).toISOString());
    unavailable = false;
    const early = await collectSource(resortCamsSource, first, {}, new Date(+FIXTURE_NOW + delay - 1), fetchImpl);
    expect(metadataCalls).toBe(1);
    const recovered = await collectSource(resortCamsSource, early, {}, new Date(+FIXTURE_NOW + delay), fetchImpl);
    expect(metadataCalls).toBe(2);
    expect((recovered.payload as ResortCamsPayload).cameras).toContainEqual(expect.objectContaining({ title: "Recovered camera", resort: "solitude" }));
    expect((recovered.payload as ResortCamsPayload).streamTitleRetryAt?.abcdefghijk).toBeUndefined();
  });
});
