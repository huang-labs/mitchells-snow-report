import { UpstreamError, type FetchContext } from "../http";

/** Positive titles persist; unavailable videos retry in six hours, transient errors in 15 minutes. */
export async function youtubeTitle(
  ctx: FetchContext,
  id: string,
  titles: Record<string, string>,
  retryAt: Record<string, string>,
): Promise<string> {
  if (typeof titles[id] === "string" && titles[id]) return titles[id];
  if (Date.parse(retryAt[id] ?? "") > ctx.now.getTime()) return "";
  let delay = 15 * 60_000;
  try {
    const meta = await ctx.fetchJson<{ title?: string }>(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
    if (typeof meta.title === "string" && meta.title.trim()) {
      delete retryAt[id];
      titles[id] = meta.title.trim();
      return titles[id];
    }
  } catch (error) {
    if (error instanceof UpstreamError && [401, 404].includes(error.status ?? 0)) delay = 6 * 3_600_000;
  }
  retryAt[id] = new Date(ctx.now.getTime() + delay).toISOString();
  titles[id] = "";
  return "";
}
