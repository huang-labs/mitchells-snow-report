import { FORECAST_AREAS } from "@/lib/catalog";
/**
 * Routes the collector's upstream URLs to responses captured from the real
 * sources on 2026-10-30 (test/fixtures). Test-only — never used at runtime.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Resolved from the project root (vitest runs there; jsdom has no file: import.meta.url).
export const FIXTURE_DIR = resolve(process.cwd(), "test/fixtures");
export const fixture = (name: string) => readFileSync(join(FIXTURE_DIR, name), "utf8");
export const fixtureBytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));

/** Fake public widget tokens — used to assert they never leak into the API. */
export const FAKE_TOKENS = { solitude: "TEST_TOKEN_SOLITUDE_abc123" };

/** YouTube oEmbed titles observed 2026-11-01 (one Solitude embed returned no oEmbed). */
export const YOUTUBE_TITLES: Record<string, string> = {
  "ta-4QZbfMXc": "Honeycomb Canyon",
  xNER0JHrqLg: "Powderhorn",
  Lnznapxh2xM: "Sunshine Bowl",
  lkEM6EC8NVA: "Solitude Snowstake",
  NSiItCGabfo: "Moonbeam Lift Line",
  l2X9DlRzX54: "Apex Express and Sunrise Lift Lines",
  oWaG8txpW1c: "Eagle Express Lift Line",
  yeoBog_kSzc: "Powderhorn II Lift Line",
  Yx3QmuKfwjY: "Link Lift Line",
  "4a-3iEM7bHk": "Parking Lot - Brighton Ski Resort",
  uZ24vqOWEkQ: "Molly Greens View - Brighton Ski Resort",
  Zv8HYwaXjBg: "Top of Crest Lift - Brighton Ski Resort",
  vMwQRjlfqtA: "Explorer Lift - Brighton Ski Resort",
  "N-d3MuOagLg": "Milly Express - Brighton Ski Resort",
};

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

const json = (v: unknown) => new Response(typeof v === "string" ? v : JSON.stringify(v), { headers: { "content-type": "application/json" } });
const html = (v: string) => new Response(v, { headers: { "content-type": "text/html" } });

export function fixtureRoutes(): Array<[RegExp, Handler]> {
  const captured = FORECAST_AREAS.map(a=>({area:a,data:JSON.parse(fixture(`nws-${a.id}.json`))}));
  return [
    [/jacksonhole-prod\.zaneray\.com\/api\/trail-lift\.json/,()=>json(fixture("jackson-lifts.json"))],
    [/api\.mtbachelor\.com\/api\/v1\/dor\/drupal\/lifts/,()=>json(fixture("bachelor-lifts.json"))],
    [/api\.weather\.gov\/products\/types\/AFD\/locations\/(STO|REV|RIW|TFX|BOU|GJT|SEW|PDT)/,(u)=>json(JSON.parse(fixture("nws-afd-"+u.pathname.split("/").pop()+".json")).list)],
    [/api\.weather\.gov\/products\/[0-9a-f-]+$/,(u)=>{for(const office of ["STO","REV","RIW","TFX","BOU","GJT","SEW","PDT"]){const d=JSON.parse(fixture("nws-afd-"+office+".json"));if(u.pathname.endsWith(d.product.id))return json(d.product);}return json(fixture("nws-afd-SLC.json"));}],
    [/api\.weather\.gov\/points\//,(u)=>{const a=captured.find(x=>u.pathname.endsWith(`${x.area.latitude},${x.area.longitude}`));return a?json(a.data.point):new Response("No point fixture",{status:404});}],
    [/api\.weather\.gov\/gridpoints\//,(u)=>{
      const match=/gridpoints\/([^/]+)\/(\d+),(\d+)/.exec(u.pathname)!;
      const found=captured.find(x=>x.data.point.properties.gridId===match[1]&&x.data.point.properties.gridX===+match[2]&&x.data.point.properties.gridY===+match[3]);
      if(!found)return new Response("No grid fixture",{status:404});
      if(found.area.id==="LCC"||found.area.id==="BCC")return json(fixture(u.pathname.endsWith("/forecast")?"nws-forecast-SLC-108-167.json":"nws-gridpoint-SLC-108-167.json"));
      return json(u.pathname.endsWith("/forecast")?found.data.forecast:found.data.grid);
    }],
    [/cpc\.ncep\.noaa\.gov\/products\/predictions\/814day\/500mb\.php/,()=>html(fixture("cpc-500mb.html"))],
    [/cpc\.ncep\.noaa\.gov\/products\/predictions\/6-10_day\/fxus06\.html/,()=>html(fixture("cpc-fxus06.html"))],
    [/cpc\.ncep\.noaa\.gov\/products\/predictions\/814day\/814day\.03\.gif/,()=>new Response(fixtureBytes("cpc-814day.03.gif"),{headers:{"content-type":"image/gif"}})],
    [/snowbasin\.com\/the-mountain\/mountain-report/ ,()=>html(fixture("snowbasin-mountain-report.html"))],
    [/tellurideskiresort\.com\/snow-report/,()=>html(fixture("telluride-snow-report.html"))],
    [/jacksonhole-prod\.zaneray\.com\/api\/snow\.json/,()=>json(fixture("jackson-feed.json"))],
    [/api\.mtbachelor\.com\/api\/v1\/dor\/drupal\/snow-reports/,()=>json(fixture("bachelor-feed.json"))],
    [/bigskyresort\.com\/api\/reportpal/,()=>json(fixture("bigsky_reportpal.json"))],
    [/v4\.mtnfeed\.com\/resorts\/(palisades-tahoe|mammoth|winter-park|steamboat|crystal-mountain)\.json/,(u)=>{const slug=u.pathname.split("/").pop()!.replace(".json","");const ids:Record<string,number>={"palisades-tahoe":61,mammoth:60,"winter-park":5,steamboat:6,"crystal-mountain":80};return json({resortIds:[ids[slug]],bearerToken:`TEST_${slug}`});}],
    [/weather\.utah\.edu\/text\/ensgefsdslccforecast\.html/, () => html(fixture("utah-ensemble-CLN-2026110112.html"))],
    [/alta\.com\/lift-terrain-status/, () => html(fixture("alta-lift-terrain-status.html"))],
    [/api\.snowbird\.com\/api\/v1\/dor\/drupal\/snow-reports/, () => json(fixture("snowbird-snow-reports.json"))],
    [/api\.snowbird\.com\/api\/v1\/dor\/drupal\/lifts/, () => json(fixture("snowbird-lifts.json"))],
    [/api\.snowbird\.com\/api\/v1\/dor\/drupal\/terrains/, () => json(fixture("snowbird-terrains.json"))],
    [/api\.snowbird\.com\/api\/v1\/dor\/sensors/, () => json(fixture("snowbird-sensors.json"))],
    [/api\.snowbird\.com\/api\/v1\/dor\/drupal\/parking/, () => json(fixture("snowbird-parking.json"))],
    [/v4\.mtnfeed\.com\/resorts\/solitude\.json/, () => json({ resortIds: [65], bearerToken: FAKE_TOKENS.solitude })],
    [/mtnpowder\.com\/feed\/v3\.json/, (u) => {
      const id = u.searchParams.get("resortId[]");
      const token = u.searchParams.get("bearer_token");
      if (id === "65" && token === FAKE_TOKENS.solitude) return json(fixture("mtnpowder-solitude.json"));
      const slugs:Record<string,string>={"61":"palisades-tahoe","60":"mammoth","5":"winter-park","6":"steamboat","80":"crystal-mountain"};
      const slug=slugs[id??""];if(slug&&token===`TEST_${slug}`)return json(fixture(`mtnpowder-${slug}.json`));
      return new Response("forbidden", { status: 403 });
    }],
    [/brightonresort\.com\/api\/reportpal\?/, () => json(fixture("brighton-reportpal.json"))],
    [/weather\.utah\.edu\/index\.php/, (u) => {
      const station = u.searchParams.get("r") ?? "CLN";
      // Only the CLN page was captured; other stations reuse it with the code swapped.
      return html(fixture("utah-plume-CLN.html").replaceAll("PL_CLN", `PL_${station}`));
    }],
    // One real chart (CLN, 2026-11-01 00Z run, same layout as every station) serves all chart URLs.
    [/weather\.utah\.edu\/.*\.png$/, (_u, init) => {
      const headers = { "content-type": "image/png", "last-modified": "Fri, 30 Oct 2026 23:00:05 GMT" };
      return new Response(init?.method === "HEAD" ? null : fixtureBytes("utah-plume-CLN-2026110100.png"), { headers });
    }],
    // Legacy SLC discussion capture, retained for controlled continuity tests.
    [/api\.weather\.gov\/products\/types\/AFD\/locations\/SLC/, () => json(fixture("nws-afd-list-SLC.json"))],
    [/api\.weather\.gov\/products\/[0-9a-f-]+$/, () => json(fixture("nws-afd-SLC.json"))],
    [/api\.weather\.gov\/gridpoints\/SLC\/\d+,\d+\/forecast/, () => json(fixture("nws-forecast-SLC-108-167.json"))],
    [/api\.weather\.gov\/gridpoints\/SLC\/\d+,\d+$/, () => json(fixture("nws-gridpoint-SLC-108-167.json"))],
    // Resort webcam pages (captured 2026-11-01) and their camera hosts.
    [/alta\.com\/weather$/, () => html(fixture("alta-weather.html"))],
    [/snowbird\.com\/the-mountain\/webcams\/view-all-webcams/, () => html(fixture("snowbird-webcams.html"))],
    [/solitudemountain\.com\/mountain-and-village\/webcams/, () => html(fixture("solitude-webcams.html"))],
    [/brightonresort\.com\/conditions/, () => html(fixture("brighton-conditions.html"))],
    [/youtube\.com\/oembed/, (u) => {
      const id = new URL(u.searchParams.get("url")!).searchParams.get("v")!;
      const title = YOUTUBE_TITLES[id];
      return title ? json({ title }) : new Response("Unauthorized", { status: 401 });
    }],
    [/manage\.hdrelay\.com\/snapshot\//, () => new Response(null, { headers: { "content-type": "image/jpeg", "last-modified": "Sat, 31 Oct 2026 00:52:00 GMT" } })],
    // Snowbird's Hidden Peak card.
    [/backend\.roundshot\.com\/cams\//, () => new Response(null, { headers: { "content-type": "image/jpeg", "last-modified": "Sat, 31 Oct 2026 00:52:00 GMT" } })],
    [/alta-webcams\.sfo3\.cdn\.digitaloceanspaces\.com\//, () => new Response(null, { headers: { "content-type": "image/jpeg", "last-modified": "Sat, 31 Oct 2026 00:55:00 GMT" } })],
    // prismcam sends a Last-Modified ahead of real time.
    [/app\.prismcam\.com\//, () => new Response(null, { headers: { "content-type": "image/jpeg", "last-modified": "Sat, 31 Oct 2026 02:00:00 GMT" } })],
  ];
}

export function createFixtureFetch(overrides: Array<[RegExp, Handler]> = []) {
  const routes = [...overrides, ...fixtureRoutes()];
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    for (const [re, handler] of routes) {
      if (re.test(url.href)) return handler(url, init);
    }
    return new Response(`no fixture for ${url.href}`, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Reference "now" just after the fixtures were captured (Fri Oct 30 2026, 7:00 PM MDT). */
export const FIXTURE_NOW = new Date("2026-10-31T01:00:00Z");
