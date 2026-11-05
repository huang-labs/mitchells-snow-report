/**
 * Checks that snow and liquid amounts in model prose come from the input.
 *
 * Only inch amounts in the input count: numeric fields named as inches
 * (`snowIn`, `next24In`, …) and inch amounts written in source text. Elevations,
 * temperatures, wind speeds, percentages, dates and times do not, so an
 * invented "30″" is not excused by a 30 mph gust or a 30% chance.
 */

/**
 * Inch amounts written in text: 12″, 3-6", 17 inches, 0.5 in. A bare "in"
 * starting a phrase is not a unit: "4 in the morning", or before a place
 * name, as in "highs near 38 in Little Cottonwood".
 */
const INCH_AMOUNT = /(\d+(?:\.\d+)?)(?:(?:\s*(?:-|–|to)\s*|\s+(?:and|or)\s+)(\d+(?:\.\d+)?))?\s*(?:″|"|”|-?inch(?:es)?\b|in\.|in\b(?!\s+(?:(?:the|a|an|this|that|which|each|total)\b|[A-Z])))/g;

/** Field names holding inch amounts (both ends of a range, or the P10/P50/P90 triple, are arrays of these). */
const INCH_FIELD = /In$/;

const NUMBER_WORDS:Record<string,number>={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100};
const word=`(?:${Object.keys(NUMBER_WORDS).join("|")})`;
// Compounds join words without "and" ("twenty-five", "one hundred five"), so
// "two and three inches" and "five or six inches" read as ranges, never sums.
const phrase=`${word}(?:[ -]+${word}){0,3}`;
const unit=`(?:inches?\\b|″|"|in\\.)`;
const wordRange=new RegExp(`\\b(${phrase})(?:\\s+(?:to|and|or)\\s+|\\s*–\\s*|\\s+-\\s+)(${phrase})(?=\\s*${unit})`,"gi");
const wordAmount=new RegExp(`\\b(${phrase})(?=\\s*${unit})`,"gi");
function writtenNumber(text:string){
  let value=0;
  for(const part of text.toLowerCase().split(/[ -]+/))if(part==="hundred")value=(value||1)*100;else value+=NUMBER_WORDS[part]??0;
  return value;
}

/** Every inch amount written in `text`, both ends of a range included. */
export function inchAmounts(text: string): number[] {
  // Models sometimes spell observations as “six inches”; spelling cannot bypass grounding.
  text=text.replace(wordRange,(_match,a:string,b:string)=>`${writtenNumber(a)} to ${writtenNumber(b)}`).replace(wordAmount,(_match,a:string)=>String(writtenNumber(a)));
  const out: number[] = [];
  for (const m of text.matchAll(INCH_AMOUNT)) {
    out.push(Number(m[1]));
    if (m[2] !== undefined) out.push(Number(m[2]));
  }
  return out;
}

/**
 * Inch amounts in `value`: numbers in inch-named fields, and inch amounts in
 * any string. Fields in `skip` (with everything under them) are ignored.
 */
export function inchAmountsIn(value: unknown, skip: ReadonlySet<string> = new Set()): number[] {
  const out = new Set<number>();
  const walk = (v: unknown, inchField: boolean) => {
    if (typeof v === "number") {
      if (inchField && Number.isFinite(v)) out.add(v);
    } else if (typeof v === "string") {
      for (const n of inchAmounts(v)) out.add(n);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, inchField);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) if (!skip.has(k)) walk(x, INCH_FIELD.test(k));
    }
  };
  walk(value, false);
  return [...out];
}

/**
 * Inch amounts in `text` that are not within 1″ of an allowed amount. Catches
 * invented totals ("30″" when the data tops out at 12″). Amounts up to 1″ are
 * not checked, and neither is arithmetic: a sum the model was allowed to make
 * must be in `allowed`.
 */
export function ungroundedInches(text: string, allowed: number[]): number[] {
  return inchAmounts(text).filter((n) => n > 1 && !allowed.some((a) => Math.abs(a - n) <= 1));
}
