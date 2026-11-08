import { CHANNELS, channelById, type ChannelId } from "../lib/catalog";
import { SOURCE_BY_ID } from "../lib/sources";
import type { DailySnowState, Snapshot, SourceId } from "../lib/types";
import { collectAndPublish, COLLECTOR_NAME } from "./collection";
import type { WorkerEnv } from "./env";
import { reportBody } from "./report";

/**
 * Admin endpoints for owner-requested operations and PR preview tooling.
 * Disabled (404) unless ADMIN_TOKEN is configured; every call needs its bearer token.
 *
 *   POST /api/admin/collect   collect (?source=…), optionally force ?dailysnow=force&channel=…
 *   GET  /api/admin/channel   ?channel=… the channel's authoritative state and whether an attempt is pending
 *   GET  /api/admin/report    /api/report built from the Durable Objects instead of the KV read copies
 *   POST /api/admin/seed      {snapshot?, channels?} initializes empty Durable Objects (previews)
 */
export const ADMIN_ROUTES: Record<string, "GET" | "POST"> = {
  "/api/admin/collect": "POST",
  "/api/admin/channel": "GET",
  "/api/admin/report": "GET",
  "/api/admin/seed": "POST",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function admin(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.ADMIN_TOKEN) return new Response("Not found", { status: 404 });
  if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/api/admin/collect":
      return adminCollect(url, env);
    case "/api/admin/channel": {
      const channel = url.searchParams.get("channel") ?? "";
      if (!channelById(channel)) return json({ error: "Unknown channel" }, 400);
      return json(await env.CHANNEL!.getByName(channel).status(channel as ChannelId));
    }
    case "/api/admin/report": {
      const [snapshot, states] = await Promise.all([
        env.COLLECTOR!.getByName(COLLECTOR_NAME).latest(),
        Promise.all(CHANNELS.map(async (c) => [c.id, await env.CHANNEL!.getByName(c.id).state(c.id)] as const)),
      ]);
      return json(reportBody(snapshot, Object.fromEntries(states)));
    }
    case "/api/admin/seed":
      return adminSeed(request, env);
    default:
      return new Response("Not found", { status: 404 });
  }
}

async function adminCollect(url: URL, env: WorkerEnv) {
  const only = url.searchParams.getAll("source") as SourceId[];
  const channel = url.searchParams.get("channel");
  if (channel && !channelById(channel)) return json({ error: "Unknown channel" }, 400);
  if (only.some((id) => !SOURCE_BY_ID[id])) return json({ error: "Unknown source" }, 400);
  const force = url.searchParams.get("dailysnow") === "force";
  if (force && !channel) return json({ error: "Forced publication requires a channel" }, 400);
  const summary = await collectAndPublish(env, {
    only: only.length ? only : undefined,
    channel: (channel ?? undefined) as ChannelId | undefined,
    forceDailySnow: force,
  });
  return json(summary);
}

/** Seeds only empty objects, so repeating it (every preview run does) never overwrites live state. */
async function adminSeed(request: Request, env: WorkerEnv) {
  const body = (await request.json().catch(() => null)) as { snapshot?: Snapshot; channels?: Partial<Record<ChannelId, DailySnowState>> } | null;
  if (!body || typeof body !== "object") return json({ error: "Expected a JSON body" }, 400);
  if (body.snapshot && body.snapshot.schemaVersion !== 1) return json({ error: "Unsupported snapshot" }, 400);
  const unknown = Object.keys(body.channels ?? {}).filter((id) => !channelById(id));
  if (unknown.length) return json({ error: `Unknown channel: ${unknown.join(", ")}` }, 400);
  const snapshot = body.snapshot ? await env.COLLECTOR!.getByName(COLLECTOR_NAME).seed(body.snapshot) : false;
  const channels: Partial<Record<ChannelId, boolean>> = {};
  for (const [id, state] of Object.entries(body.channels ?? {}) as Array<[ChannelId, DailySnowState]>)
    channels[id] = await env.CHANNEL!.getByName(id).seed(id, state);
  return json({ snapshot, channels });
}
