import Link from "next/link";
import { RESORTS, resortTimeZone } from "@/lib/catalog";
import type { NwsPayload, ReportResponse, ResortReport } from "@/lib/types";
import { buildSnowTimeline, timelineScale } from "../timeline/model";
import { SnowTimeline } from "../timeline/SnowTimeline";
export function RegionalPage({ report, now }: { report: ReportResponse; now: Date }) {
  const points = (report.sources.nws?.payload as NwsPayload | null)?.points ?? [];
  const resorts = RESORTS.map((r) => ({
    ...r,
    model: buildSnowTimeline({
      resort: r.id,
      name: r.name,
      canyon: r.canyon,
      report: report.sources[r.id]?.payload as ResortReport | null,
      log: report.snowLog,
      // A failing point keeps its last payload for the Weather page; the timeline
      // shows no forecast rather than presenting old guidance as current.
      forecast:
        points.find((p) => !p.lastError && (p.id ?? (/BCC/.test(p.name) ? "BCC" : "LCC")) === r.canyon) ?? null,
      now,
      timeZone: resortTimeZone(r.id),
    }),
  }));
  const scale = timelineScale(resorts.map((r) => r.model));
  return (
    <section className="page page--regional">
      <header className="page__header">
        <h1>Resorts</h1>
      </header>
      <div className="resort-timelines">
        {resorts.map((r) => (
          <article key={r.id} className="resort-timeline" aria-label={r.name}>
            <SnowTimeline
              model={r.model}
              scale={scale}
              label={r.name}
              now={now}
              heading={
                <div className="resort-heading">
                  <h2 className="resort-name">
                    <Link className="resort-name__link" href={`/${r.id}`}>
                      {r.name}
                    </Link>
                  </h2>
                </div>
              }
              meta={`${r.state} · United States`}
            />
          </article>
        ))}
      </div>
      <p className="legend">
        <span className="legend__key legend__key--reported" /> reported ·{" "}
        <span className="legend__key legend__key--forecast" /> NWS forecast ·{" "}
        <span className="legend__key legend__key--ghost" /> what NWS forecast ·{" "}
        <span className="metric__value metric__value--zero">0</span> reported zero ·{" "}
        <span className="metric__na">–</span> no data · <span className="legend__key legend__key--none" /> not recorded.
        Days follow each destination's local time; report windows are preserved.
      </p>
    </section>
  );
}
