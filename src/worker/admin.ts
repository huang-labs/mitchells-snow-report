import { channelById, type ChannelId } from "../lib/catalog";
import { SOURCE_BY_ID } from "../lib/sources";
import { runCollection } from "../lib/collect";
import type { WorkerEnv } from "./env";
import type { SourceId } from "../lib/types";

/**
 * Manual collection trigger for local development and post-deploy seeding.
 * Disabled (404) unless ADMIN_TOKEN is configured; requires a bearer token.
 */
export async function adminCollect(request: Request, env: WorkerEnv) {
  if (!env.ADMIN_TOKEN) return new Response("Not found", { status: 404 });
  if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const only = new URL(request.url).searchParams.getAll("source") as SourceId[];
  const channel=new URL(request.url).searchParams.get("channel");
  if(channel&&!channelById(channel))return Response.json({error:"Unknown channel"},{status:400});
  if(only.some(id=>!SOURCE_BY_ID[id]))return Response.json({error:"Unknown source"},{status:400});
  if(new URL(request.url).searchParams.get("dailysnow")==="force"&&!channel)return Response.json({error:"Forced publication requires a channel"},{status:400});
  const summary = await runCollection(env, {
    only: only.length ? only : undefined,
    channel:(channel??undefined) as ChannelId|undefined,
    forceDailySnow: new URL(request.url).searchParams.get("dailysnow") === "force",
  });
  return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
}
