import { classify } from "../freshness";
import type { CpcPayload, Snapshot } from "../types";
import { assertValid, HOUR, type SourceDefinition } from "./types";

export const CPC_PAGE = "https://www.cpc.ncep.noaa.gov/products/predictions/814day/500mb.php";
export const CPC_DISCUSSION = "https://www.cpc.ncep.noaa.gov/products/predictions/6-10_day/fxus06.html";
export const CPC_IMAGE = "https://www.cpc.ncep.noaa.gov/products/predictions/814day/814day.03.gif";
const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function day(month: string, date: string, year: string): string {
  const m = months.indexOf(month.slice(0, 3).toUpperCase());
  const iso = `${year}-${String(m + 1).padStart(2, "0")}-${date.padStart(2, "0")}`;
  assertValid(m >= 0 && Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso, "Invalid CPC date");
  return iso;
}

/** Verify the map page and written outlook describe the same issue and forecast period. */
export function parseCpc(page: string, html: string): Omit<CpcPayload, "image"> {
  const text = plain(page).replace(/\s+/g, " ");
  const valid = /Valid:\s*([A-Za-z]+) (\d{1,2}) (\d{4}) to ([A-Za-z]+) (\d{1,2}) (\d{4})/.exec(text);
  const updated = /Updated:\s*(\d{1,2}) ([A-Za-z]+) (\d{4})/.exec(text);
  assertValid(valid && updated && /814day\.03\.gif/.test(page), "CPC map metadata unavailable");
  const validFrom = day(valid[1], valid[2], valid[3]);
  const validTo = day(valid[4], valid[5], valid[6]);
  assertValid(Date.parse(validTo) - Date.parse(validFrom) === 6 * 86400000, "Invalid CPC 8–14-day window");
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  assertValid(pre, "CPC discussion unavailable");
  const discussion = plain(pre[1]).replace(/\r/g, "");
  const issued = /(\d{1,4}) (AM|PM) (EST|EDT) \w+ ([A-Za-z]+) (\d{1,2}) (\d{4})/.exec(discussion);
  const period = /8-14 DAY OUTLOOK FOR ([A-Z]+) (\d{1,2}) - (?:(?:([A-Z]+) )?)(\d{1,2}) (\d{4})/.exec(discussion);
  assertValid(issued && period, "CPC discussion dates unavailable");
  const issueDate = day(issued[4], issued[5], issued[6]);
  assertValid(issueDate === day(updated[2], updated[1], updated[3]), "CPC issue dates do not match");
  const end = day(period[3] ?? period[1], period[4], period[5]);
  const startYear = months.indexOf(period[1].slice(0, 3)) > months.indexOf((period[3] ?? period[1]).slice(0, 3)) ? String(+period[5] - 1) : period[5];
  assertValid(day(period[1], period[2], startYear) === validFrom && end === validTo, "CPC forecast periods do not match");
  const clock = issued[1].padStart(4, "0");
  const hours = +clock.slice(0, 2), minutes = +clock.slice(2);
  assertValid(hours >= 1 && hours <= 12 && minutes < 60, "Invalid CPC issue time");
  const hour24 = hours % 12 + (issued[2] === "PM" ? 12 : 0);
  const issuedAt = new Date(`${issueDate}T${String(hour24).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00${issued[3] === "EST" ? "-05:00" : "-04:00"}`).toISOString();
  const body = discussion.slice(period.index + period[0].length).split(/\n\s*FORECASTER:/)[0].trim();
  assertValid(body.length > 100 && body.length <= 16000, "Invalid CPC discussion length");
  return { issuedAt, validFrom, validTo, discussion: body.replace(/([^\n])\n(?=[^\n])/g, "$1 ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n\n"), sourceUrl: CPC_PAGE };
}

export const cpcSource: SourceDefinition<CpcPayload> = {
  id: "cpc", label: "NOAA extended pattern outlook", category: "weather", required: false,
  attribution: "NOAA Climate Prediction Center — 8–14-day 500-mb height outlook",
  sourceUrl: CPC_PAGE, intervalMs: HOUR, reportMaxAgeMs: 48 * HOUR,
  async collect(ctx) {
    const [page, discussion] = await Promise.all([ctx.fetchText(CPC_PAGE), ctx.fetchText(CPC_DISCUSSION)]);
    const parsed = parseCpc(page, discussion);
    assertValid(Date.parse(parsed.issuedAt) <= +ctx.now + 120000, "CPC issue time is in the future");
    const bytes = await ctx.fetchBytes(CPC_IMAGE, { contentType: "image/gif", maxBytes: 1_000_000 });
    assertValid(bytes.length > 100 && /^GIF8[79]a$/.test(new TextDecoder().decode(bytes.slice(0, 6))) && bytes.at(-1) === 0x3b, "Invalid CPC GIF");
    const width = bytes[6] + bytes[7] * 256, height = bytes[8] + bytes[9] * 256;
    assertValid(width >= 300 && height >= 200 && width <= 3000 && height <= 3000, "Invalid CPC map dimensions");
    // Reject an issue rollover while downloading the mutable upstream image.
    const checked = parseCpc(await ctx.fetchText(CPC_PAGE), discussion);
    assertValid(checked.issuedAt === parsed.issuedAt, "CPC issue changed during collection");
    assertValid(ctx.kv, "CPC map storage unavailable");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map(b => b.toString(16).padStart(2, "0")).join("");
    const key = `cpc-map:v1:${hash}`;
    await ctx.kv.put(key, bytes.buffer as ArrayBuffer, { expirationTtl: 3 * 86400 });
    return { payload: { ...parsed, image: { key, width, height, originUrl: CPC_IMAGE } }, sourceUpdatedAt: parsed.issuedAt };
  },
};

/** Failed, old, future or uncollected pattern guidance never enters a new article. */
export function currentCpc(snapshot: Snapshot, now: Date): CpcPayload | null {
  const source = snapshot.sources.cpc;
  if (source?.status !== "ok" || classify(cpcSource, source, now).freshness !== "current") return null;
  const p = source.payload as CpcPayload | null;
  return p && p.validFrom > now.toISOString().slice(0, 10) ? p : null;
}
