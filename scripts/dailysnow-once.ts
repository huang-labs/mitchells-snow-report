/** Read-only prompt tuning for one regional channel or the Western overview.
 * --channel <id> defaults to western-us; --url defaults to this fork's /api/report.
 * --now, --model, --digest, --save-digest and --validate retain their usual meanings.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PRIMARY_MODEL, responseJson } from "../src/lib/ai/model";
import { channelById } from "../src/lib/catalog";
import { historyEntry } from "../src/lib/dailysnow/continuity";
import { buildDailyDigest } from "../src/lib/dailysnow/digest";
import { regionalSnapshot } from "../src/lib/dailysnow/regions";
import { buildModelInput, validateDailySnow } from "../src/lib/dailysnow/llm";
import { buildWesternInput, westernModelInput, validateWestern } from "../src/lib/dailysnow/western";
import type { ApiDailySnow, ReportResponse, Snapshot, DailySnowPost } from "../src/lib/types";
import type { RegionId } from "../src/lib/catalog";
import { addLiveEnsemble } from "./live-ensemble";

const arg = (name:string) => { const i=process.argv.indexOf(name); return i>0?process.argv[i+1]:undefined; };
const channel=channelById(arg("--channel")??"western-us");
if(!channel)throw new Error("Unknown Daily Snow channel");
const url=arg("--url")??"https://mitchells-snow-report.huang.mx/api/report";
const now=arg("--now")?new Date(arg("--now")!):new Date();
const response=await fetch(url);
if(!response.ok)throw new Error("Report HTTP "+response.status);
const report=await response.json() as ReportResponse;
// The same inputs collection hands to runChannels: sources plus per-area storm memory and operating history.
let snapshot:Snapshot={schemaVersion:1,writtenAt:report.snapshotWrittenAt??now.toISOString(),sources:report.sources,areaStorms:report.areaStorms,resortLastOperatingAt:report.resortLastOperatingAt};
if(!report.areaStorms||!report.resortLastOperatingAt)console.error("warning: this report predates exposed storm memory; area storm recaps and operating history are missing from the digest");
const model=arg("--model")??PRIMARY_MODEL;
const saved=arg("--validate"),saveTo=arg("--save-digest");
if(channel.id==="western-us"){
  const editions=Object.fromEntries(Object.entries(report.dailySnows??{}).filter(([key,value])=>key!=="western-us"&&value)) as Partial<Record<RegionId,DailySnowPost>>;
  const input=buildWesternInput(snapshot,editions,now);
  if(saveTo)writeFileSync(saveTo,JSON.stringify(input,null,2));
  console.log(JSON.stringify(saved?validateWestern(responseJson(JSON.parse(readFileSync(saved,"utf8"))),input):process.argv.includes("--digest")?input:westernModelInput(model,input),null,2));
}else{
  snapshot=regionalSnapshot(snapshot,channel.id);
  if(channel.id==="utah")await addLiveEnsemble(snapshot,now);
  const current=report.dailySnows?.[channel.id]??null;
  const posts=(await Promise.all((current?.archive??[]).map(async({date})=>{
    if(date===current?.date)return current;
    const res=await fetch(new URL("/api/daily-snow?date="+date+"&channel="+channel.id,url));
    return res.ok?await res.json() as ApiDailySnow:null;
  }))).filter((p):p is ApiDailySnow=>!!p);
  const {digest}=buildDailyDigest(snapshot,current,posts.map(historyEntry),now);
  if(saveTo)writeFileSync(saveTo,JSON.stringify(digest,null,2));
  console.log(JSON.stringify(saved?validateDailySnow(responseJson(JSON.parse(readFileSync(saved,"utf8"))),digest):process.argv.includes("--digest")?digest:buildModelInput(model,digest),null,2));
}
