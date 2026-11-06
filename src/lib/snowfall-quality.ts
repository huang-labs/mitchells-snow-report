import type { ResortReport, SnowfallSet } from "./types";

type Window = keyof SnowfallSet;
export interface SnowfallIssue {
  windows: Window[];
  message: string;
}

/** Compare only nested measurement windows, never storm/season counters or base depth. */
export function snowfallIssues(snowfall: SnowfallSet | null | undefined): SnowfallIssue[] {
  const issues: SnowfallIssue[] = [];
  if (!snowfall) return issues;
  const rolling = ["h24", "h48", "h72", "d7"] as const;
  for (const [key, metric] of Object.entries(snowfall)) {
    if (metric?.state === "reported" && (!Number.isFinite(metric.value) || metric.value < 0)) {
      issues.push({ windows: [key as Window], message: `${metric.label}: invalid snowfall amount.` });
    }
  }
  for (const shorter of ["overnight", "h12", ...rolling] as const) {
    const a = snowfall[shorter];
    if (a?.state !== "reported" || !Number.isFinite(a.value) || a.value < 0) continue;
    // Some feeds normalize an unbounded “since lifts closed” counter into overnight.
    // Its source window is not necessarily contained in 24 hours.
    if (shorter === "overnight" && /since.*(?:lift|clos|open|report)/i.test(a.label)) continue;
    const longer = shorter === "overnight" || shorter === "h12" ? rolling : rolling.slice(rolling.indexOf(shorter) + 1);
    for (const key of longer) {
      const b = snowfall[key];
      if (b?.state !== "reported" || !Number.isFinite(b.value) || b.value < 0) continue;
      if (a.value > b.value) issues.push({
        windows: [shorter, key],
        message: `${a.label} exceeds ${b.label}; conflicting amounts withheld from derived snow data.`,
      });
    }
  }
  return issues;
}

/** A non-mutating view for AI, activity, storm memory and history. Raw reports stay intact. */
export function usableSnowfall(raw: SnowfallSet): SnowfallSet {
  const issues = snowfallIssues(raw);
  if (!issues.length) return raw;
  const snowfall = { ...raw };
  for (const issue of issues) for (const key of issue.windows) {
    snowfall[key] = { state: "unavailable", label: raw[key].label, note: "Withheld: conflicting or invalid resort snowfall data" };
  }
  return snowfall;
}

export function usableSnowReport(report: ResortReport | null | undefined): ResortReport | null {
  if (!report) return null;
  const snowfall = usableSnowfall(report.snowfall);
  if (snowfall === report.snowfall) return report;
  // Source prose can repeat the same suspect amounts; do not give it to the model as evidence.
  return { ...report, snowfall, narrative: null };
}
