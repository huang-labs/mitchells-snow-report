import { decodeEntities } from "../metric";
import type { FetchContext } from "../http";
import { assertValid } from "./types";

export const JACKSON_CAMS_API = "https://jacksonhole-prod.zaneray.com/api/web-cams.json";
export interface CameraImage {
  title: string;
  imageUrl: string;
}

/** Snowbasin initializes HDRelay in scripts instead of publishing iframe tags. */
export function parseSnowbasinCams(html: string): Array<{ title: string; playerId: string }> {
  const cameras: Array<{ title: string; playerId: string }> = [];
  const blocks = html.split(/<h2\b[^>]*class="webcam__headline"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const heading = /^([^<]+)<\/h2>/.exec(block);
    const id = /HDRelay\.create\(\{[^}]*\bid:\s*"([a-f0-9-]{24,36})"/.exec(block)?.[1];
    if (heading && id) cameras.push({ title: decodeEntities(heading[1]).trim(), playerId: id });
  }
  assertValid(cameras.length, "Snowbasin: no HDRelay cameras found");
  return cameras;
}

/** HDRelay player IDs and camera IDs differ. Resolve through the page's official loader API. */
export async function snowbasinImages(ctx: FetchContext, html: string): Promise<CameraImage[]> {
  const results = await Promise.allSettled(parseSnowbasinCams(html).map(async (camera) => {
    const config = await ctx.fetchJson<{ camera?: { id?: string } }>(`https://manage.hdrelay.com/player/${camera.playerId}`);
    const id = config.camera?.id;
    assertValid(typeof id === "string" && /^[a-f0-9-]{24,36}$/.test(id), "Snowbasin: HDRelay camera ID missing");
    return { title: camera.title, imageUrl: `https://manage.hdrelay.com/snapshot/${id}` };
  }));
  const images = results.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
  assertValid(images.length, "Snowbasin: no HDRelay camera configuration available");
  return images;
}

/** The official Jackson Hole page loads these full-size stills from its JSON API. */
export function parseJacksonCams(raw: unknown): CameraImage[] {
  const feed = raw as { webcams?: Array<{ caption?: unknown; url?: unknown }> } | null;
  assertValid(Array.isArray(feed?.webcams), "Jackson Hole: camera list missing");
  return feed.webcams.flatMap((row) => {
    if (!row || typeof row.caption !== "string" || !row.caption.trim() || typeof row.url !== "string") return [];
    try {
      const url = new URL(row.url);
      if (url.protocol !== "https:" || !["cams.jacksonhole.com", "backend.roundshot.com"].includes(url.hostname)) return [];
      return [{ title: row.caption.trim(), imageUrl: url.href }];
    } catch {
      return [];
    }
  });
}
