import { readChannelStates } from "../lib/dailysnow/channels";
import { CHANNELS } from "../lib/catalog";
import { publicDailySnow } from "../lib/report";
import { dailySnowActivity } from "../lib/dailysnow/digest";
import { dailySnowPublicationStatus } from "../lib/dailysnow/publication";
import { regionalSnapshot } from "../lib/dailysnow/regions";
import type { CollectorEnv } from "../lib/collect";
import { buildReport } from "../lib/report";
import { readSnapshot } from "../lib/store";

/**
 * Serves the latest stored snapshot. Never triggers upstream collection;
 * that only happens in the scheduled handler (worker.ts).
 */
export async function report(env: CollectorEnv) {
  try {
    const [snapshot,states]=await Promise.all([readSnapshot(env.SNOW_KV),readChannelStates(env.SNOW_KV)]);
    const output=buildReport(snapshot);
    output.dailySnows={};output.publicationStatus={};
    for(const channel of CHANNELS){
      const expected=channel.id==="western-us"?CHANNELS.some(c=>c.id!=="western-us"&&snapshot&&dailySnowActivity(regionalSnapshot(snapshot,c.id),new Date()).publicationExpected):!!snapshot&&dailySnowActivity(regionalSnapshot(snapshot,channel.id),new Date()).publicationExpected;
      const state=states[channel.id];
      output.dailySnows[channel.id]=publicDailySnow(state?.current,state,new Date(),expected);
      output.publicationStatus[channel.id]=output.dailySnows[channel.id]?.publicationStatus??dailySnowPublicationStatus(state?.current?.date??null,state,new Date(),expected,channel.id);
    }
    output.dailySnow=output.dailySnows["western-us"];
    return Response.json(output, {
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
