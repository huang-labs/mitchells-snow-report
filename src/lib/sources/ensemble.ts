import { monthFromName } from "../time";
import type { EnsemblePayload, EnsembleVariable } from "../types";
import { assertValid, HOUR, MINUTE, type SourceDefinition } from "./types";

export const ENSEMBLE_URL = "https://weather.utah.edu/text/ensgefsdslccforecast.html";
export const ENSEMBLE_MAX_AGE_MS = 18 * HOUR;
export const PERCENTILES = ["Min", "P10", "P25", "P50", "P75", "P90", "Max"] as const;
const VARIABLES: Array<[EnsembleVariable, string]> = [
  ["totalLiquidIn", "Total Water Equivalent Precipitation (in)"],
  ["totalSnowIn", "Total Snowfall (in)"],
  ["liquidIn", "6-h Water Equivalent Precipitation (in)"],
  ["snowIn", "6-h Snowfall (in)"],
  ["slr", "Snow-to-Liquid Ratio"],
  ["wetBulbHalfFt", "Wet-Bulb 0.5 Height (ft MSL)"],
];
const clean = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "2-digit", hour12: true, weekday: "short", day: "2-digit", month: "short", year: "numeric" });
/** Match the published Denver wall label against a UTC lead; never guess a DST offset. */
export function ensembleTimeLabel(date: Date): string {
  const p = Object.fromEntries(local.formatToParts(date).map((p) => [p.type, p.value]));
  return `${p.hour} ${p.dayPeriod} ${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** Strict parser for the published CLN tables. Layout or semantic drift fails closed. */
export function parseEnsemble(html: string): EnsemblePayload {
  const stripped = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const run = /Utah Snow Ensemble \(Experimental\) Initialized (\d{2})00 UTC (\d{2}) ([A-Za-z]{3}) (\d{4}) \((\d+) members\)/.exec(clean(stripped));
  assertValid(run, "Missing Utah Snow Ensemble initialization/members");
  const month = monthFromName(run[3]);
  assertValid(month && [0, 6, 12, 18].includes(+run[1]) && +run[5] >= 2 && +run[5] <= 1000, "Invalid ensemble run/members");
  const initialized = new Date(Date.UTC(+run[4], month - 1, +run[2], +run[1]));
  assertValid(initialized.getUTCDate() === +run[2], "Invalid ensemble run date");
  const tables = [...stripped.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>\s*(<table\b[^>]*>[\s\S]*?<\/table>)/gi)];
  assertValid(tables.length === VARIABLES.length, "Expected six ensemble tables");
  let traceLiquidCorrections = 0;
  const values = {} as EnsemblePayload["values"];
  const ends = Array.from({ length: 40 }, (_, i) => new Date(initialized.getTime() + (i + 1) * 6 * HOUR));
  for (const [i, table] of tables.entries()) {
    const [key, heading] = VARIABLES[i];
    const title = clean(table[1]).replace(/^.*?members\) /, "");
    assertValid(title === `${heading} Guidance for 40.579 N 111.654 W 9416 ft AMSL [Nearest Grid Point to CLN]`, `Unexpected ensemble heading/unit/station: ${key}`);
    const rows = [...table[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => clean(c[1])));
    assertValid(rows.length === 8 && rows.every((r) => r.length === 41), `Invalid ensemble dimensions: ${key}`);
    assertValid(rows[0].slice(1).every((label, j) => label === ensembleTimeLabel(ends[j])), `Ensemble timestamp mismatch: ${key}`);
    values[key] = PERCENTILES.map((name, j) => {
      assertValid(rows[j + 1][0] === name, `Missing/ordered ensemble percentile: ${key} ${name}`);
      return rows[j + 1].slice(1).map((text) => {
        // Published six-hour liquid contains nonphysical trace negatives (-0.01, -0.02)
        // from rounding. Normalize trace negatives down to -0.05; larger negatives fail.
        if (key === "liquidIn" && /^-0\.0[1-5]$/.test(text)) { traceLiquidCorrections++; return 0; }
        assertValid(/^\d+(?:\.\d+)?$/.test(text), `Non-numeric ensemble value: ${key}`);
        const n = Number(text);
        assertValid(Number.isFinite(n) && n >= 0, `Invalid ensemble value: ${key}`);
        return n;
      });
    });
    for (let col = 0; col < 40; col++) {
      assertValid(values[key].every((row, j, a) => j === 0 || row[col] >= a[j - 1][col]), `Unordered ensemble percentiles: ${key}`);
    }
  }
  return { traceLiquidCorrections, sourceUrl: ENSEMBLE_URL, model: "Utah Snow Ensemble (Experimental)", station: "CLN", scope: "Nearest grid point to Alta-Collins, LCC; not BCC-specific", latitude: 40.579, longitude: -111.654, elevationFt: 9416, initializedAt: initialized.toISOString(), members: +run[5], periodEnds: ends.map((d) => d.toISOString()), percentiles: [...PERCENTILES], values };
}

export const ensembleSource: SourceDefinition<EnsemblePayload> = {
  id: "ensemble", label: "Utah Snow Ensemble numerical guidance (CLN/LCC)", category: "weather", required: false,
  attribution: "University of Utah — experimental ensemble forecast, Alta-Collins grid point",
  sourceUrl: ENSEMBLE_URL, intervalMs: 30 * MINUTE, reportMaxAgeMs: ENSEMBLE_MAX_AGE_MS,
  async collect(ctx) {
    const payload = parseEnsemble(await ctx.fetchText(ENSEMBLE_URL));
    assertValid(Date.parse(payload.initializedAt) <= ctx.now.getTime() + 5 * MINUTE, "Ensemble run is in the future");
    const prev = ctx.previous as EnsemblePayload | null;
    assertValid(!prev || Date.parse(payload.initializedAt) >= Date.parse(prev.initializedAt), "Ensemble run regressed");
    return { payload, sourceUpdatedAt: payload.initializedAt };
  },
};
