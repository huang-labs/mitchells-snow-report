"use client";

import { createContext, useContext } from "react";
import type { ReportResponse } from "@/lib/types";
import { summarizeFreshness } from "./sections/freshness-summary";
import { FreshnessBadge } from "./ui";
import { formatAge } from "@/lib/time";

export interface DashboardData {
  report: ReportResponse | null;
  loadedAt: number | null;
  error: string | null;
  now: Date;
}

export const DashboardContext = createContext<DashboardData | null>(null);

/** Report data shared by every page (one poller for the whole app). */
export function useDashboard(): DashboardData {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be used inside <AppShell>");
  return ctx;
}

/** Notices about the web app's own data path, shown under the navbar. */
export function DataBanners({ data }: { data: DashboardData }) {
  const { report, loadedAt, error, now } = data;
  const apiStale = loadedAt !== null && now.getTime() - loadedAt > 3 * 60_000;
  return (
    <>
      {(error || apiStale) && report && (
        <div className="banner banner--offline" role="status">
          Web app can’t reach its server ({error ?? "no response"}). Showing data loaded {formatAge(new Date(loadedAt!).toISOString(), now)}.
        </div>
      )}
      {report && report.requiredMissing.length > 0 && (
        <div className="banner banner--required-missing" role="status" aria-label="Required feed status">
          {summarizeFreshness(report.requiredMissing.map((id) => report.sources[id])).groups.map(({ freshness, labels }) => (
            <span className="feed-status" key={freshness}><FreshnessBadge freshness={freshness} /> {labels.join(", ")}</span>
          ))}
        </div>
      )}
    </>
  );
}
