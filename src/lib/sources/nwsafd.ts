import type { AfdPayload, NwsPayload } from "../types";
import { assertValid, HOUR, MINUTE, type SourceDefinition } from "./types";

/**
 * NWS Salt Lake City Area Forecast Discussion: the forecasters' own reasoning
 * (pattern, timing, confidence). Used only as input to the Daily Snow post.
 */
export const AFD_LIST_URL = "https://api.weather.gov/products/types/AFD/locations/SLC";
const productUrl = (id: string) => `https://api.weather.gov/products/${id}`;

/** Sections worth passing on; aviation, fire weather, hydrology and staff lines are dropped. */
const KEEP = /^(KEY MESSAGES|SYNOPSIS|DISCUSSION|SHORT TERM|LONG TERM|.*WATCHES\/WARNINGS\/ADVISORIES)/;
const MAX_SECTION_CHARS = 4000;

interface ProductList {
  "@graph"?: Array<{ id: string; issuanceTime: string }>;
}
interface Product {
  id: string;
  issuingOffice?: string;
  issuanceTime: string;
  productText: string;
}

/**
 * Split product text into `.NAME...` sections ending at `&&` or `$$`. Updated
 * products repeat unchanged sections with their original time:
 * `.DISCUSSION, Issued 1037 PM MST Sun Nov 1 2026...`.
 */
export function parseAfd(text: string): AfdPayload["sections"] {
  const sections: AfdPayload["sections"] = [];
  const re = /^\.([A-Z][A-Z0-9 /&()-]*?)(?:,\s*Issued\s+([^\n]*?))?\.\.\.([\s\S]*?)(?=^&&|^\$\$|^\.[A-Z][A-Z0-9 /&()-]*?(?:,[^\n]*?)?\.\.\.)/gm;
  for (const m of text.replaceAll("\r", "").matchAll(re)) {
    const name = m[1].trim().replace(/^SLC /, "");
    const issued = m[2]?.trim();
    if (!KEEP.test(name)) continue;
    // Unwrap the 70-column lines; keep bullets and paragraph breaks.
    const body = m[3]
      .split(/\n\s*\n/)
      .map((para) => para.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n")
      .replace(/ (- )/g, "\n$1")
      .trim();
    if (!body) continue;
    const clipped = body.length > MAX_SECTION_CHARS ? `${body.slice(0, MAX_SECTION_CHARS - 1)}…` : body;
    sections.push(issued ? { name, text: clipped, issued } : { name, text: clipped });
  }
  return sections;
}

export const nwsAfdSource: SourceDefinition<AfdPayload> = {
  id: "nwsafd",
  // Issued about four times a day, plus updates.
  intervalMs: 30 * MINUTE,
  label: "NWS forecast discussion",
  category: "weather",
  required: false,
  attribution: "National Weather Service — regional Area Forecast Discussions",
  sourceUrl: "https://www.weather.gov/",
  reportMaxAgeMs: 18 * HOUR,
  async collect(ctx) {
    // Offices verified against the catalog mountain points; shared offices fetch once.
    const offices=["SLC","STO","REV","RIW","TFX","BOU","GJT","SEW","PDT"];
    const previous=ctx.previous as AfdPayload|null;
    const failures:string[]=[];
    const results=await Promise.all(offices.map(async office=>{
      const prior=(previous?.discussions??(previous?[previous]:[])).find(p=>p.office.replace(/^K/,"")===office);
      try {
        const headers={Accept:"application/ld+json"};
        const list=await ctx.fetchJson<ProductList>(`https://api.weather.gov/products/types/AFD/locations/${office}`,{headers});
        const latest=list["@graph"]?.[0];assertValid(latest?.id,`${office} AFD list empty`);
        if(prior?.productId===latest.id)return prior;
        const product=await ctx.fetchJson<Product>(productUrl(latest.id),{headers});
        const sections=parseAfd(product.productText);assertValid(sections.length,`${office} AFD has no usable sections`);
        return {productId:product.id,office,issuedAt:new Date(product.issuanceTime).toISOString(),sections} satisfies AfdPayload;
      }catch(e){failures.push(`${office}: ${e instanceof Error?e.message:String(e)}`);return prior??null;}
    }));
    const discussions=results.filter((p):p is AfdPayload=>p!==null);
    assertValid(discussions.length,"No forecast discussion available");
    return {payload:{...discussions[0],discussions,failures},sourceUpdatedAt:discussions.map(d=>d.issuedAt).sort()[0]};
  },
};
