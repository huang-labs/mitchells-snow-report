import { readChannelStates } from "../lib/dailysnow/channels";
import { CHANNELS, REGIONS, type ChannelId } from "../lib/catalog";
import { publicDailySnow } from "../lib/report";
import { dailySnowActivity } from "../lib/dailysnow/digest";
import { dailySnowPublicationStatus } from "../lib/dailysnow/publication";
import { regionalSnapshot } from "../lib/dailysnow/regions";
import type { CollectorEnv } from "../lib/collect";
import { buildReport } from "../lib/report";
import { readSnapshot } from "../lib/store";
import type { DailySnowState, ReportResponse, Snapshot } from "../lib/types";

/** The /api/report body for a snapshot and channel states. */
export function reportBody(snapshot: Snapshot | null, states: Partial<Record<ChannelId, DailySnowState>>, now = new Date()): ReportResponse {
  const output=buildReport(snapshot);
  output.dailySnows={};output.publicationStatus={};
  // One activity check per region; Western is expected when any region is.
  const regional=Object.fromEntries(REGIONS.map(r=>[r.id,!!snapshot&&dailySnowActivity(regionalSnapshot(snapshot,r.id),now).publicationExpected]));
  for(const channel of CHANNELS){
    const expected=channel.id==="western-us"?Object.values(regional).some(Boolean):regional[channel.id];
    const state=states[channel.id];
    output.dailySnows[channel.id]=publicDailySnow(state?.current,state,now,expected);
    output.publicationStatus[channel.id]=output.dailySnows[channel.id]?.publicationStatus??dailySnowPublicationStatus(state?.current?.date??null,state,now,expected,channel.id);
  }
  output.dailySnow=output.dailySnows["western-us"];
  return output;
}

/**
 * Serves the KV read copies of the snapshot and channel states. Never triggers
 * upstream collection; that only happens in the scheduled handler (worker.ts).
 */
export async function report(env: CollectorEnv) {
  try {
    const [snapshot,states]=await Promise.all([readSnapshot(env.SNOW_KV),readChannelStates(env.SNOW_KV)]);
    return Response.json(reportBody(snapshot,states), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("report: failed to read snapshot", err);
    return Response.json(
      { error: "Report storage unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
