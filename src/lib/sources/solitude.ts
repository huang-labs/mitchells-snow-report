import type { ResortReport } from "../types";
import { fetchMtnPowder, parseMtnPowder } from "./mtnpowder";
import { HOUR, type SourceDefinition } from "./types";

export const SOLITUDE_URL = "https://www.solitudemountain.com/mountain-and-village/conditions-and-maps";
export const SOLITUDE_OPTIONS = {
  resort: "Solitude",
  sourceUrl: SOLITUDE_URL,
  reportingArea: "mid" as const,
  namedTerrainAreas: ["Honeycomb Canyon", "Evergreen Peak", "Highway to Heaven", "Fantasy Ridge", "Terrain Areas"],
};

export const solitudeSource: SourceDefinition<ResortReport> = {
  id: "solitude",
  label: "Solitude",
  category: "resort",
  required: true,
  attribution: "Solitude Mountain Resort — snow report feed used by solitudemountain.com",
  sourceUrl: SOLITUDE_URL,
  reportMaxAgeMs: 26 * HOUR,
  async collect(ctx) {
    const feed = await fetchMtnPowder(ctx, "solitude");
    const { report, sourceUpdatedAt } = parseMtnPowder(feed, SOLITUDE_OPTIONS);
    return { payload: report, sourceUpdatedAt };
  },
};
