import type { ReactNode, CSSProperties } from "react";
import { regionById, type RegionId } from "@/lib/catalog";
import type { ApiSource, PlumeChart, PlumePanel, PlumePayload } from "@/lib/types";
import { plumePanelsLive } from "@/lib/plumePanels";
import { formatLocal } from "@/lib/time";
import { PlumePanelSvg } from "../PlumePanelSvg";
import { SourceLine, Unavailable } from "../ui";

const utcFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "2-digit", hourCycle: "h23" });

function initLabel(iso: string) {
  return `${utcFmt.format(new Date(iso)).replace(/, (\d{2})$/, " $1")}Z`;
}

/** One cropped panel with a Mountain Time axis and a "now" line. */
function Panel({ chart, panel, now }: { chart: PlumeChart; panel: PlumePanel; now: Date }) {
  return (
    <figure className="plume">
      <figcaption className="plume__title">{chart.stationName}{chart.note && <small> · {chart.note}</small>}{chart.lastError && <span className="source-line__error"> · updates failing; last successful run shown</span>}</figcaption>
      <PlumePanelSvg
        timeZone={regionById(chart.region??"utah")!.timeZone}
        src={panel.url}
        width={panel.width}
        height={panel.height}
        plot={panel.plot}
        initTime={chart.initTime}
        forecastHours={chart.forecastHours}
        marker={{ time: now, label: "now" }}
        label={`${panel.title} plume for ${chart.stationName}, run ${chart.runCode}, times in ${regionById(chart.region??"utah")!.timeZone}`}
      />
    </figure>
  );
}

function FullChart({ chart, product }: { chart: PlumeChart; product: string }) {
  return (
    <figure className="plume plume--full">
      <figcaption className="plume__title">
        {chart.stationName}{chart.note&&` · ${chart.note}`}{chart.lastError&&" · updates failing; last successful run shown"} · <span className="source-line__error">cropped panels unavailable, showing the original chart (times in UTC)</span>
      </figcaption>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={chart.imageUrl} alt={`${product} plume for ${chart.stationName}, run ${chart.runCode}`} />
    </figure>
  );
}

export function PlumesPage({ source, now,region="utah",selector }: { source: ApiSource; now: Date;region?:RegionId;selector?:ReactNode }) {
  const p = source.payload as PlumePayload | null;
  return (
    <section className="page page--plumes">
      <header className="page__header">
        <h1>{regionById(region)!.name} ensemble snow plumes</h1>
        {p && (
          <p className="page__sub">
            Run <strong>{p.runCode}</strong> · initialized <strong>{formatLocal(p.initTime,now,regionById(region)!.timeZone)}</strong> ({initLabel(p.initTime)}). Times follow the selected region (source charts use UTC); dashed lines mark midnight, the orange line is now.
          </p>
        )}
      </header>
      {selector}
      {p?.failures?.filter(f=>!p.charts.some(c=>c.lastError===f)).map(f=><p key={f} className="source-line__error">Plume unavailable · {f}</p>)}
      {p?.charts.length ? (
        // One column per station (snow on top, SLR below): the grid flows by column.
        <div className="plume-grid" style={{"--plume-columns":p.charts.length} as CSSProperties}>
          {p.charts.flatMap((c) =>
            // A last-good payload can outlive its stored panels if collection stalls.
            c.panels?.length && plumePanelsLive(c, now)
              ? c.panels.map((panel) => <Panel key={`${c.stationCode}-${panel.id}`} chart={c} panel={panel} now={now} />)
              : [<FullChart key={c.stationCode} chart={c} product={p.product} />],
          )}
        </div>
      ) : (
        <Unavailable source={source} what="Plume charts" />
      )}
      <SourceLine source={source} now={now} reportLabel="Model initialization" timeZone={regionById(region)!.timeZone} />
    </section>
  );
}
