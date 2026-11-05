import { CAM_PAGES, type ResortId } from "../catalog";
import type { FetchContext } from "../http";
import { decodeEntities } from "../metric";
import type { PrimaryResortId, ResortCam, ResortCamsPayload } from "../types";
import { extractAltaJson } from "./alta";
import { assertValid, type SourceDefinition } from "./types";

/**
 * Resort-operated cameras for the individual resort pages: every camera each
 * resort publishes except the small exclusion list, with the useful ones
 * first — lift lines where a resort has them (crowds), otherwise snow stakes
 * and base areas.
 *
 * Cameras are discovered from each resort's own webcam page on every run, so
 * re-pointed streams (YouTube live IDs change when a stream restarts) are
 * picked up. Each resort is isolated: one failing page only drops its cameras.
 */

export const ALTA_WEATHER_URL = "https://www.alta.com/weather";
export const SNOWBIRD_WEBCAMS_URL = "https://www.snowbird.com/the-mountain/webcams/view-all-webcams/";
export const SOLITUDE_WEBCAMS_URL = "https://www.solitudemountain.com/mountain-and-village/webcams";
export const BRIGHTON_CONDITIONS_URL = "https://www.brightonresort.com/conditions";

/**
 * Featured cameras per resort, in display order, matched against the resort's
 * own camera names. These lead each resort's webcam section; every other
 * camera the resort publishes follows in page order.
 */
export const WANTED: Partial<Record<PrimaryResortId, RegExp[]>> = {
  // Alta publishes no lift-line camera.
  alta: [/^snow stake$/i, /^albion basin$/i],
  // Snow stake first, as at Alta. No Gad Zoom camera is published; Tram
  // Bullpen is Snowbird's lift-line camera.
  snowbird: [/^snowstake$/i, /^tram bullpen$/i],
  // The named snowstake first, then the featured lift lines.
  solitude: [/^solitude snowstake$/i, /moonbeam.*lift line/i, /apex.*sunrise/i],
  // The parking lot answers "how busy is it", before the lift line.
  brighton: [/^parking lot$/i, /milly express/i],
};

/** Featured cameras first (first match per pattern), then the rest in page order. */
function order<T extends { title: string }>(found: T[], featured: RegExp[]): T[] {
  const taken = new Set<T>();
  const lead = featured.flatMap((re) => {
    const match = found.find((c) => !taken.has(c) && re.test(c.title));
    if (match) taken.add(match);
    return match ? [match] : [];
  });
  return [...lead, ...found.filter((c) => !taken.has(c))];
}

/** Cameras the resorts publish that the dashboard does not show. */
const EXCLUDED: Partial<Record<PrimaryResortId, RegExp[]>> = {
  // A gimmick 360° panorama with no snow-information value.
  snowbird: [/^hidden peak 360$/i],
};

function notExcluded(resort: PrimaryResortId, title: string): boolean {
  return !(EXCLUDED[resort] ?? []).some((re) => re.test(title));
}

/** A Last-Modified header as capture time, rejecting future values (some hosts send local time as GMT). */
export function captureTime(lastModified: string | null, now: Date): string | null {
  if (!lastModified) return null;
  const t = Date.parse(lastModified);
  if (Number.isNaN(t) || t > now.getTime() + 2 * 60_000) return null;
  return new Date(t).toISOString();
}

// ---------- Alta: `window.Alta.weather.mountainCams` on the weather page ----------

export function parseAltaCams(html: string): Array<{ title: string; imageUrl: string }> {
  const data = extractAltaJson(html) as unknown as { weather?: { mountainCams?: Array<{ name?: string; url?: string }> } };
  const cams = data.weather?.mountainCams ?? [];
  assertValid(cams.length > 0, "Alta: weather.mountainCams not found");
  return cams.filter((c) => c.name && c.url).map((c) => ({ title: c.name!, imageUrl: c.url! }));
}

// ---------- Snowbird: webcam cards on the view-all page ----------

/** Cards are `<a aria-label="Tram Bullpen - null - View Webcam" …><img src="https://manage.hdrelay.com/snapshot/…">`. */
export function parseSnowbirdCams(html: string): Array<{ title: string; imageUrl: string }> {
  const out: Array<{ title: string; imageUrl: string }> = [];
  for (const m of html.matchAll(/aria-label="([^"]+?) - [^"]*View Webcam"[^>]*>\s*<img src="(https:\/\/[^"]+)"/g)) {
    const title = decodeEntities(m[1]).trim();
    if (!out.some((c) => c.title === title)) out.push({ title, imageUrl: decodeEntities(m[2]) });
  }
  assertValid(out.length > 0, "Snowbird: no webcam cards found");
  return out;
}

// ---------- Solitude / Brighton: YouTube live embeds ----------

export function youtubeIds(html: string): string[] {
  return [...new Set([...html.matchAll(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/g)].map((m) => m[1]))];
}

interface OEmbed {
  title?: string;
}

/**
 * Stream titles come from YouTube oEmbed, not from page layout (captions sit
 * on different sides of the player on different sites). Titles of IDs already
 * known from the previous run are reused — including lookups that failed, so a
 * private stream costs one oEmbed call ever — so a steady state costs one page
 * fetch per resort. Embeds with no public title are dropped: their players
 * only show "video unavailable".
 */
async function youtubeCams(
  ctx: FetchContext,
  resort: PrimaryResortId,
  pageUrl: string,
  titles: Record<string, string>,
): Promise<ResortCam[]> {
  const ids = youtubeIds(await ctx.fetchText(pageUrl, { browserLike: true }));
  assertValid(ids.length > 0, `${resort}: no YouTube camera embeds found`);
  const found: Array<{ title: string; videoId: string }> = [];
  for (const id of ids) {
    let title: string | undefined = titles[id];
    if (title === undefined) {
      const meta = await ctx
        .fetchJson<OEmbed>(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`)
        .catch(() => null);
      titles[id] = title = meta?.title ?? "";
    }
    if (title) {
      const clean = title.replace(/\s*-\s*(Brighton Ski Resort|Solitude.*)$/i, "");
      if (notExcluded(resort, clean)) found.push({ title: clean, videoId: id });
    }
  }
  return order(found, WANTED[resort]??[/snow.?stake/i,/lift/i]).map((c) => ({ resort, kind: "youtube", pageUrl, ...c }));
}

async function imageCams(
  ctx: FetchContext,
  resort: PrimaryResortId,
  pageUrl: string,
  parse: (html: string) => Array<{ title: string; imageUrl: string }>,
): Promise<ResortCam[]> {
  const chosen = order(
    parse(await ctx.fetchText(pageUrl, { browserLike: true })).filter((c) => notExcluded(resort, c.title)),
    WANTED[resort]??[/snow.?stake/i,/lift/i],
  );
  const cams = await Promise.all(
    chosen.map(async (c): Promise<ResortCam | null> => {
      const res = await ctx.probe(c.imageUrl, { browserLike: true }).catch(() => null);
      if (!res || res.status >= 400 || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
      return { resort, kind: "image", pageUrl, title: c.title, imageUrl: c.imageUrl, capturedAt: captureTime(res.headers.get("last-modified"), ctx.now) };
    }),
  );
  return cams.filter((c): c is ResortCam => c !== null);
}

/** Only publicly embedded camera hosts on the curated official webcam pages. */
export async function embeddedCams(ctx:FetchContext,resort:ResortId,pageUrl:string,titles:Record<string,string>):Promise<ResortCam[]>{
 const html=await ctx.fetchText(pageUrl,{browserLike:true});
 const out:ResortCam[]=[];
 for(const id of youtubeIds(html)){
   if(titles[id]===undefined){const meta=await ctx.fetchJson<OEmbed>(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`).catch(()=>null);titles[id]=meta?.title??"";}
   if(titles[id])out.push({resort,kind:"youtube",pageUrl,title:titles[id],videoId:id});
 }
 for(const m of html.matchAll(/<iframe[^>]+src=["'](https:\/\/[^"']+)["'][^>]*>/gi)){
   const url=new URL(decodeEntities(m[1]));
   if(!/(^|\.)(ozolio\.com|camstreamer\.com|roundshot\.com|hdrelay\.com)$/.test(url.hostname))continue;
   out.push({resort,kind:"embed",pageUrl,title:decodeEntities(/title=["']([^"']+)/i.exec(m[0])?.[1]??"Resort live camera"),embedUrl:url.toString()});
 }
 return out;
}

export const resortCamsSource: SourceDefinition<ResortCamsPayload> = {
  id: "resortcams",
  label: "Resort webcams",
  category: "webcams",
  required: false,
  attribution: "Official resort webcam pages",
  sourceUrl: SNOWBIRD_WEBCAMS_URL,
  // Per-camera capture times are shown on each image instead.
  reportMaxAgeMs: null,
  async collect(ctx) {
    const previous = ((ctx.previous as ResortCamsPayload | null)?.cameras ?? []) as ResortCam[];
    const prev = (r: PrimaryResortId) => previous.filter((c) => c.resort === r);
    // Titles resolved earlier (including streams that aren't wanted) are reused.
    const streamTitles: Record<string, string> = { ...(ctx.previous as ResortCamsPayload | null)?.streamTitles };
    const jobs: Array<[PrimaryResortId, Promise<ResortCam[]>]> = [
      ["alta", imageCams(ctx, "alta", ALTA_WEATHER_URL, parseAltaCams)],
      ["snowbird", imageCams(ctx, "snowbird", SNOWBIRD_WEBCAMS_URL, parseSnowbirdCams)],
      ["solitude", youtubeCams(ctx, "solitude", SOLITUDE_WEBCAMS_URL, streamTitles)],
      ["brighton", youtubeCams(ctx, "brighton", BRIGHTON_CONDITIONS_URL, streamTitles)],
      ...Object.entries(CAM_PAGES).map(([id,page])=>[id as ResortId,embeddedCams(ctx,id as ResortId,page,streamTitles)] as [ResortId,Promise<ResortCam[]>]),
    ];
    const settled = await Promise.allSettled(jobs.map(([, p]) => p));
    const cameras: ResortCam[] = [];
    const failures: string[] = [];
    settled.forEach((r, i) => {
      const resort = jobs[i][0];
      if (r.status === "fulfilled" && r.value.length) {
        cameras.push(...r.value);
        return;
      }
      // Keep this resort's cameras from the previous run: image cams carry their
      // own capture time, and a stream player shows its own live/offline state.
      cameras.push(...prev(resort));
      failures.push(`${resort}: ${r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : "no matching cameras"}`);
    });
    assertValid(cameras.length > 0, `No resort cameras found (${failures.join("; ")})`);
    return { payload: { cameras, failures, streamTitles }, sourceUpdatedAt: null };
  },
};
