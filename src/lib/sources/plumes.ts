import { PLUME_LOCATIONS } from "../catalog";
import type { FetchContext } from "../http";
import { cropSnowPanels } from "../plumeCrop";
import { PLUME_PANEL_REFRESH_MS, PLUME_PANEL_TTL_S, panelsStoredAt, plumeCropRetryDue, plumePanelsLive } from "../plumePanels";
import { plumePanelKey } from "../store";
import type { PlumeChart, PlumePanel, PlumePayload } from "../types";
import { assertValid, HOUR, MINUTE, type SourceDefinition } from "./types";

export const PLUME_BASE = "https://weather.utah.edu/";
export const plumePageUrl = (station: string) => `${PLUME_BASE}index.php?t=ensgefsds&d=PL&r=${station}`;

/** Station codes verified against the weather.utah.edu station menu (2026-10-30). */
export const PLUME_STATIONS = PLUME_LOCATIONS;

/** "2026103012" → 2026-10-30T12:00Z (model runs are labelled in UTC). */
export function runCodeToIso(runCode: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(runCode);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4])).toISOString();
}

/**
 * Parse the plume page. Without a runcode parameter the page serves the latest
 * available run; we read the run from the "Current selection … initialization"
 * summary and the chart path from the SciAnimator image list.
 */
export function parsePlumePage(html: string, station: string): { runCode: string; imagePath: string; product: string } {
  const sel = /Current selection:\s*([^,]+),[\s\S]*?(\d{10})\s+initialization/.exec(html);
  assertValid(sel, `Plume page for ${station}: run selection not found`);
  const list = /images_vis:\s*\[([\s\S]*?)\]/.exec(html);
  assertValid(list, `Plume page for ${station}: image list not found`);
  const paths = [...list[1].matchAll(/"([^"]+\.png)"/g)].map((m) => m[1]);
  assertValid(paths.length > 0, `Plume page for ${station}: product not available`);
  const imagePath = paths[paths.length - 1];
  assertValid(imagePath.includes(`PL_${station}${sel[2]}`), `Plume image ${imagePath} does not match ${station}/${sel[2]}`);
  return { runCode: sel[2], imagePath, product: sel[1].trim() };
}

/** "…PL_CLN2026110100F240.png" → 240. */
export function forecastHoursFromPath(path: string): number | null {
  const m = /F(\d{2,3})\.png$/.exec(path);
  return m ? +m[1] : null;
}

const PANEL_TITLES: Record<PlumePanel["id"], string> = {
  snow: "Accumulated Snow (inches)",
  slr: "Snow-to-Liquid Ratio",
};

export const plumePanelUrl = (station: string, runCode: string, panel: string) =>
  `/api/plume/${station}/${runCode}/${panel}`;

/**
 * Download the chart, crop the two snow panels and store them in KV. Runs once
 * per new model run per station; later collections of the same run reuse the
 * stored panels (see collect below), keeping the 5-minute cron cheap. A run
 * that stays current for days is re-cropped a day before its panels expire.
 */
async function cropAndStore(ctx: FetchContext, station: string, runCode: string, imageUrl: string): Promise<PlumePanel[]> {
  if (!ctx.kv) throw new Error("no KV available for cropped panels");
  const png = await ctx.fetchBytes(imageUrl, { browserLike: true, contentType: "image/png", maxBytes: 8_000_000 });
  const cropped = cropSnowPanels(png);
  await Promise.all(
    cropped.map((c) =>
      ctx.kv!.put(plumePanelKey(station, runCode, c.id), c.png.slice().buffer as ArrayBuffer, { expirationTtl: PLUME_PANEL_TTL_S }),
    ),
  );
  return cropped.map((c) => ({
    id: c.id,
    title: PANEL_TITLES[c.id],
    url: plumePanelUrl(station, runCode, c.id),
    width: c.width,
    height: c.height,
    plot: c.plot,
  }));
}

type CropState = Pick<PlumeChart, "panels" | "cropError" | "panelsStoredAt" | "cropAttempts" | "cropFailedAt">;

/** Crop and store a run's panels. A failure keeps whatever still-live panels `kept` has. */
async function tryCrop(ctx: FetchContext, station: string, runCode: string, imageUrl: string, kept: CropState): Promise<CropState> {
  try {
    const panels = await cropAndStore(ctx, station, runCode, imageUrl);
    return { panels, panelsStoredAt: ctx.now.toISOString(), cropError: null, cropAttempts: 0, cropFailedAt: null };
  } catch (err) {
    // The original chart is still valid; the Plumes page falls back to it.
    const cropError = err instanceof Error ? err.message : String(err);
    return { ...kept, cropError, cropAttempts: (kept.cropAttempts ?? 0) + 1, cropFailedAt: ctx.now.toISOString() };
  }
}

export const plumesSource: SourceDefinition<PlumePayload> = {
  id: "plumes",
  // New runs appear about twice a day; checking every 30 min is plenty.
  intervalMs: 30 * MINUTE,
  label: "Utah ensemble plumes",
  category: "plume",
  required: true,
  attribution: "University of Utah Atmospheric Sciences — Utah Snow Ensemble (NCEP GEFS + ECMWF ENS)",
  sourceUrl: plumePageUrl("CLN"),
  // Runs are produced every 12 h; flag as old when a newer cycle should exist.
  reportMaxAgeMs: 30 * HOUR,
  async collect(ctx) {
    const previous = ctx.previous as PlumePayload | null;
    const settled = await Promise.allSettled(
      PLUME_STATIONS.map(async (s) => {
        const html = await ctx.fetchText(plumePageUrl(s.code), { browserLike: true });
        const parsed = parsePlumePage(html, s.code);
        const imageUrl = new URL(parsed.imagePath, PLUME_BASE).toString();
        const forecastHours = forecastHoursFromPath(parsed.imagePath);
        assertValid(forecastHours, `Plume image ${imageUrl}: forecast length not in file name`);
        const prior = previous?.charts?.find((c) => c.stationCode === s.code);
        const head = await ctx.probe(imageUrl, { browserLike: true });
        assertValid(head.status === 200, `Plume image ${imageUrl} returned HTTP ${head.status}`);
        // Same run already processed (cropped, or cropping failed and the full
        // chart is the fallback): reuse it unless its panels are due for
        // re-storing before they expire, or a failed crop is due a retry.
        const sameRun = prior && prior.imageUrl === imageUrl && (prior.panels || prior.cropError) ? prior : null;
        let imageLastModified: string | null;
        let crop: CropState;
        if (sameRun) {
          imageLastModified = sameRun.imageLastModified;
          const live = plumePanelsLive(sameRun, ctx.now);
          const kept: CropState = {
            panels: live ? sameRun.panels : null,
            panelsStoredAt: live ? (sameRun.panelsStoredAt ?? null) : null,
            cropError: live ? sameRun.cropError : (sameRun.cropError ?? "stored panels expired"),
            cropAttempts: sameRun.cropAttempts ?? (sameRun.cropError ? 1 : 0),
            cropFailedAt: sameRun.cropFailedAt ?? null,
          };
          const due = !live || ctx.now.getTime() - panelsStoredAt(sameRun) >= PLUME_PANEL_REFRESH_MS;
          crop = due && plumeCropRetryDue(sameRun, ctx.now) ? await tryCrop(ctx, s.code, parsed.runCode, imageUrl, kept) : kept;
        } else {
          assertValid((head.headers.get("content-type") ?? "").startsWith("image/"), `Plume image ${imageUrl} is not an image`);
          const lm = head.headers.get("last-modified");
          imageLastModified = lm ? new Date(lm).toISOString() : null;
          crop = await tryCrop(ctx, s.code, parsed.runCode, imageUrl, { panels: null, panelsStoredAt: null, cropError: null, cropAttempts: 0, cropFailedAt: null });
        }
        const chart: PlumeChart = {
          region:s.region, note:s.note, lastCheckedAt:ctx.now.toISOString(), lastError:null,
          stationCode: s.code,
          stationName: s.name,
          imageUrl,
          pageUrl: plumePageUrl(s.code),
          imageLastModified,
          runCode: parsed.runCode,
          initTime: runCodeToIso(parsed.runCode) ?? "",
          forecastHours,
          ...crop,
        };
        return { chart, runCode: parsed.runCode, product: parsed.product };
      }),
    );
    const failures:string[]=[];
    const results=settled.flatMap((r,i)=>{
      if(r.status==="fulfilled")return [r.value];
      const station=PLUME_STATIONS[i];const message=`${station.name}: ${r.reason instanceof Error?r.reason.message:String(r.reason)}`;
      failures.push(message);
      const prior=previous?.charts.find(c=>c.stationCode===station.code);
      return prior?[{chart:{...prior,lastError:message},runCode:prior.runCode,product:previous!.product}]:[];
    });
    assertValid(results.length,"No ensemble station available");
    // Stations can briefly straddle cycles; report the oldest run shown.
    const runCode = results.map((r) => r.runCode).sort()[0];
    const initTime = runCodeToIso(runCode);
    assertValid(initTime, `Bad run code ${runCode}`);
    return {
      payload: { product: results[0].product, runCode, initTime, charts: results.map((r) => r.chart), failures },
      sourceUpdatedAt: initTime,
    };
  },
};
