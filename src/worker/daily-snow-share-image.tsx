import { channelById } from "../lib/catalog";
import { channelStateKey } from "../lib/dailysnow/regions";
import type { DailySnowState } from "../lib/types";
import { publicDailySnow } from "../lib/report";
import { ImageResponse, cache as imageCache } from "@cf-wasm/og";
import type { CollectorEnv } from "../lib/collect";
import { SHARE_CARD_FONTS } from "../lib/og/image-fonts";
import { DailySnowShareCard } from "../lib/og/daily-snow-image";

export const alt = "Daily Snow — Mitchell's regional snow forecasts";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const CACHE_PATH = "/__cache/daily-snow/opengraph-image/v4";

/** Separate from the resort card so messaging apps and social sites show the daily forecast. */
export async function dailySnowShareImage(request: Request, env: CollectorEnv, ctx: ExecutionContext,channel="western-us") {
  if(!channelById(channel))return new Response("Not found",{status:404});
  imageCache.setExecutionContext(ctx);
  const cacheKey = new URL(`${CACHE_PATH}/${channel}`, request.url).href;
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
  const hit = await cache?.match(cacheKey).catch(() => undefined);
  if (hit) return hit;

  let post = null;
  try {
    const raw=await env.SNOW_KV.get(channelStateKey(channel),"text");
    const state=raw?JSON.parse(raw) as DailySnowState:undefined;
    post=publicDailySnow(state?.current,state,new Date());
  } catch (err) {
    console.error("daily-snow/opengraph-image: failed to read snapshot", err);
  }
  const res = await ImageResponse.async(<DailySnowShareCard post={post} channel={channelById(channel)!.id} />, {
    ...size,
    fonts: SHARE_CARD_FONTS,
    headers: { "Cache-Control": `public, max-age=${post ? 600 : 60}` },
  });
  if (cache) {
    ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  }
  return res;
}
