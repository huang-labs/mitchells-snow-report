import { regionById } from "./catalog";
import type { Metadata } from "next";
import { sectionHref, type SectionDef } from "./sections";

export const SITE_TITLE = "Mitchell’s Snow Report";
// Set at build time for PR previews; production keeps its custom domain.
export const metadataBase = new URL(process.env.SITE_URL || "https://mitchells-snow-report.huang.mx");
export const SITE_DESCRIPTION = "Snowfall, mountain forecasts and ensemble plumes for 14 Western US favorites.";
export const DAILY_SNOW_DESCRIPTION = "Regional Daily Snow forecasts and a Western United States overview, with storm updates and mountain weather.";

export const siteOpenGraph = {
  type: "website" as const,
  url: "/",
  siteName: SITE_TITLE,
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  locale: "en_US",
};

/** Social titles must include the same suffix as the root document title template. */
export function sectionMetadata(section: SectionDef): Metadata {
  const title = `${section.title} · ${SITE_TITLE}`;
  const description = section.id === "daily-snow" ? DAILY_SNOW_DESCRIPTION : SITE_DESCRIPTION;
  // Nested openGraph objects replace the parent's object, including its image.
  const images = [{
    url: section.id === "daily-snow" ? "/daily-snow/opengraph-image" : "/share-brand-v2.png",
    width: 1200,
    height: 630,
    alt: section.id === "daily-snow"
      ? "Daily Snow — Mitchell's regional snow forecasts"
      : "Mitchell’s Snow Report — Western United States",
  }];
  return {
    title: section.title,
    description,
    openGraph: { ...siteOpenGraph, title, description, url: sectionHref(section.id), images },
    twitter: { card: "summary_large_image", title, description, images },
  };
}

export function regionalMetadata(section:string,region:string):Metadata{
 const r=regionById(region);if(!r)return {};
 const label=section==="daily-snow"?"Daily Snow":section==="weather"?"Mountain weather":"Ensemble plumes";
 const title=`${r.name} ${label}`;const url=`/${section}/${r.id}`;
 const images=[{url:section==="daily-snow"?`/daily-snow/${r.id}/opengraph-image`:"/share-brand-v2.png",width:1200,height:630,alt:title}];
 return {title,description:`${label} for ${r.name}'s tracked resorts.`,openGraph:{...siteOpenGraph,title:`${title} · ${SITE_TITLE}`,url,images},twitter:{card:"summary_large_image",title,images}};
}
