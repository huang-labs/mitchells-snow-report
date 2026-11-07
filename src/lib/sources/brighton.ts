import { emptySnowfall, fromField, htmlToText, unavailable } from "../metric";
import { parseOffsetIso } from "../time";
import type { Lift, NamedTerrain, Notice, ResortReport } from "../types";
import { liftStatusFrom } from "./snowbird";
import { assertValid, HOUR, type SourceDefinition } from "./types";

export const BRIGHTON_PAGE = "https://www.brightonresort.com/conditions";
/** Same-origin JSON endpoint used by brightonresort.com's conditions page. */
export const BRIGHTON_API = "https://www.brightonresort.com/api/reportpal?resortName=br&useReportPal=true";
export const BRIGHTON_ROADS_API = "https://www.brightonresort.com/api/reportpal-roads?resortName=br";

type Amount = { inches: string | null; centimeters?: string | null } | null | undefined;

interface NamedStatus {
  name: string;
  status: string | null;
  comment?: string | null;
}

interface ReportPal {
  name: string;
  units?: string;
  updated?: string;
  liftsUpdated?: string;
  operations?: { resortStatus?: string | null };
  currentConditions?: {
    resortwide?: { numLiftsOpen?: number; numLiftsTotal?: number };
    resortLocations?: { location?: Array<Record<string, Amount | string | null>> };
  };
  comments?: { comment?: Array<{ name: string; title: string; text: string }> };
  facilities?: {
    areas?: {
      area?: Array<{
        name: string;
        lifts?: { lift?: Array<NamedStatus & { openTime?: string | null; closeTime?: string | null }> | null } | null;
        gates?: { gate?: NamedStatus[] | null } | null;
        specialTerrain?: { terrain?: NamedStatus[] | null } | null;
      }>;
    };
    parkingLots?: { parking?: Array<{ name: string; status: string; comment?: string; alert?: string }> | null };
  };
}

function amount(loc: Record<string, Amount | string | null>, key: string, fallbackLabel: string, note?: string) {
  const labelRaw = loc[`${key}Label`];
  const label = typeof labelRaw === "string" && labelRaw ? labelRaw : fallbackLabel;
  if (!(key in loc)) return unavailable(label);
  const v = loc[key] as Amount;
  return fromField(v?.inches ?? null, "in", label, note);
}

// ReportPal comment names are feed keys ("commentAlert"); never show one as a heading.
const REPORTPAL_COMMENT_TITLES: Record<string, string> = {
  Comment: "Conditions report",
  commentAlert: "Alert",
  trailsAlert: "Trails alert",
  liftsAlert: "Lifts alert",
  Uphill: "Uphill travel",
  Weather: "Weather",
  Road: "Roads",
};

export function reportPalCommentTitle(name: string): string {
  return REPORTPAL_COMMENT_TITLES[name] ?? "Notice";
}

export function parseBrighton(rp: ReportPal): { report: ResortReport; sourceUpdatedAt: string | null } {
  assertValid(rp && rp.name, "Brighton reportpal response missing name");
  assertValid(!rp.units || rp.units === "USC", `Unexpected Brighton units ${rp.units}`);
  const loc = rp.currentConditions?.resortLocations?.location?.[0];
  assertValid(loc, "Brighton reportpal has no snow location");
  const reportTime = parseOffsetIso(rp.updated);

  const snowfall = emptySnowfall();
  snowfall.overnight = amount(loc, "snowOverNight", "Snow Overnight");
  snowfall.h12 = amount(loc, "snow12Hours", "Snow 12 Hrs.");
  snowfall.h24 = amount(loc, "snow24Hours", "Snow 24 Hrs.");
  snowfall.h48 = amount(loc, "snow48Hours", "Snow 48 Hrs.");
  snowfall.h72 = amount(loc, "snow72Hours", "Snow 72 Hrs.");
  snowfall.d7 = amount(loc, "snow7Days", "Snow 7 Days");
  snowfall.season = amount(loc, "snowSeasonTotal", "Snow Season Total");
  snowfall.storm = unavailable("Storm total", "Not reported by Brighton's feed");

  const areas = rp.facilities?.areas?.area ?? [];
  const lifts: Lift[] = areas.flatMap((a) =>
    (a.lifts?.lift ?? []).map((l) => ({
      name: l.name,
      status: liftStatusFrom(l.status ?? "unknown"),
      rawStatus: l.status ?? "unknown",
      hours: l.openTime && l.closeTime ? `${l.openTime}–${l.closeTime}` : null,
      note: l.comment ?? null,
    })),
  );
  const terrainItems: NamedTerrain[] = areas.flatMap((a) => [
    ...(a.gates?.gate ?? []).map((g) => ({ name: g.name, kind: "gate", status: liftStatusFrom(g.status ?? ""), rawStatus: g.status ?? "unknown", note: g.comment ?? null })),
    ...(a.specialTerrain?.terrain ?? []).map((t) => ({ name: t.name, kind: "special terrain", status: liftStatusFrom(t.status ?? ""), rawStatus: t.status ?? "unknown", note: t.comment ?? null })),
  ]);

  const notices: Notice[] = [];
  for (const c of rp.comments?.comment ?? []) {
    const text = htmlToText(c.text);
    if (!text || c.name === "Events") continue;
    const title = (c.title ?? "").trim() || reportPalCommentTitle(c.name);
    notices.push({ title, text, severity: /alert/i.test(c.name) ? "warning" : "info", updatedAt: reportTime });
  }

  const report: ResortReport = {
    resort: "Brighton",
    sourceName: "brightonresort.com conditions",
    sourceUrl: BRIGHTON_PAGE,
    reportTimeLabel: "Report updated",
    reportTime,
    operatingStatus: rp.operations?.resortStatus ?? null,
    snowfall,
    base: amount(loc, "base", "Base Depth"),
    observations: [],
    liftsOpen: rp.currentConditions?.resortwide?.numLiftsOpen ?? null,
    liftsTotal: rp.currentConditions?.resortwide?.numLiftsTotal ?? null,
    lifts,
    terrain: terrainItems.length ? terrainItems : null,
    notices,
    parking: (rp.facilities?.parkingLots?.parking ?? []).map((p) => ({
      name: p.name,
      status: p.status,
      note: [p.comment, p.alert].filter(Boolean).join(" ") || null,
    })),
    narrative: null,
  };
  return { report, sourceUpdatedAt: reportTime };
}

export const brightonSource: SourceDefinition<ResortReport> = {
  id: "brighton",
  label: "Brighton",
  category: "resort",
  required: true,
  attribution: "Brighton Resort — brightonresort.com conditions",
  sourceUrl: BRIGHTON_PAGE,
  reportMaxAgeMs: 26 * HOUR,
  async collect(ctx) {
    const rp = await ctx.fetchJson<ReportPal>(BRIGHTON_API, { browserLike: true, headers: { Accept: "application/json" } });
    const { report, sourceUpdatedAt } = parseBrighton(rp);
    return { payload: report, sourceUpdatedAt };
  },
};
