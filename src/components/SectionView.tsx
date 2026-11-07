"use client";

import type { ReportResponse, SourceId } from "@/lib/types";
import { ReportLoading, ReportLoadError } from "./loading/ReportLoading";
import { useDashboard } from "./dashboard-context";
import { DailySnowPage } from "./dailysnow/DailySnow";
import { PlumesPage } from "./sections/PlumesPage";
import { RegionalPage } from "./sections/RegionalPage";
import { ResortReportPage } from "./sections/ResortReportPage";
import { RegionSelector } from "./RegionSelector";
import { resortById, type RegionId } from "@/lib/catalog";
import { regionalSource } from "@/lib/regionalSource";
import { WeatherPage } from "./sections/WeatherPage";

/** A resort's regional Daily Snow edition, if any. */
function resortDailySnow(report: ReportResponse, id: string) {
  const region = resortById(id)?.region;
  return region ? report.dailySnows?.[region] ?? null : null;
}

export function renderSection(
  id: string,
  report: ReportResponse,
  now: Date,
  loadedAt: number | null,
  region?: RegionId,
) {
  const selector = ["daily-snow", "weather", "plumes"].includes(id) ? (
    <RegionSelector
      section={id as "daily-snow" | "weather" | "plumes"}
      selected={region ?? (id === "daily-snow" ? "western-us" : "utah")}
    />
  ) : undefined;
  switch (id) {
    case "regional":
      return <RegionalPage report={report} now={now} />;
    case "daily-snow":
      return (
        <DailySnowPage
          key={region ?? "western-us"}
          report={report}
          now={now}
          channel={region ?? "western-us"}
          selector={selector}
        />
      );
    case "weather":
      return (
        <WeatherPage
          source={regionalSource(report.sources.nws, region ?? "utah", now)}
          now={now}
          region={region}
          selector={selector}
        />
      );
    case "plumes":
      return (
        <PlumesPage
          source={regionalSource(report.sources.plumes, region ?? "utah", now)}
          now={now}
          region={region}
          selector={selector}
        />
      );
    default:
      return (
        <ResortReportPage
          source={report.sources[id as SourceId]}
          now={now}
          cams={report.sources.resortcams}
          loadedAt={loadedAt}
          dailySnow={resortDailySnow(report, id)}
        />
      );
  }
}

/** One section as a page. Data comes from the shell's shared poller. */
export function SectionView({ id, region }: { id: string; region?: RegionId }) {
  const { report, loadedAt, error, now } = useDashboard();
  if (!report) return error ? <ReportLoadError error={error} /> : <ReportLoading sectionId={id} region={region} />;
  return <div key={id}>{renderSection(id, report, now, loadedAt, region)}</div>;
}
