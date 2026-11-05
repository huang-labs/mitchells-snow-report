import { channelById } from "../lib/catalog";
import { channelKV } from "../lib/dailysnow/regions";
import { dailySnowFigureKey } from "../lib/dailysnow";
import type { CollectorEnv } from "../lib/collect";

/** Content type from the image's magic bytes (stills are PNG plume panels or JPEG cams). */
function imageType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) return "image/webp";
  return null;
}

/** A Daily Snow figure still, copied when the post was written; never changes. */
export async function dailySnowFigure(env: CollectorEnv, date: string, id: string, revision?: string,channel="western-us") {
  if(!channelById(channel))return new Response("Not found",{status:404});
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-z0-9-]{1,40}$/.test(id)) return new Response("Not found", { status: 404 });
  if (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const buf = await channelKV(env.SNOW_KV,channel).get(dailySnowFigureKey(date, id, revision), "arrayBuffer");
    const type = buf ? imageType(new Uint8Array(buf, 0, Math.min(12, buf.byteLength))) : null;
    if (!buf || !type) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    return new Response(buf, { headers: { "Content-Type": type, "Cache-Control": revision ? "public, max-age=86400, immutable" : "public, max-age=300, must-revalidate" } });
  } catch (err) {
    console.error("daily-snow figure: storage read failed", err);
    return new Response("Storage unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
