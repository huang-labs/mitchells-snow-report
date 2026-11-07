import { snowfallIssues } from "@/lib/snowfall-quality";
import { resortTimeZone, resortById } from "@/lib/catalog";
import Link from "next/link";
import type { ApiSource, Metric, ResortReport, SnowfallSet } from "@/lib/types";
import { formatLocal } from "@/lib/time";
import {
  FreshnessBadge,
  MetricValue,
  NoticeList,
  SourceLine,
  StatusDot,
  Unavailable,
} from "../ui";
import { ResortCams } from "./ResortCams";
import { byStatus, newSnowKey, SNOW_LABEL, snowQualifier } from "./resort-display";
import "./resort-report.css";

/** A snowfall value under our window label, with the resort's wording only where it differs. */
function SnowMetric({
  label,
  metric,
  qualifier = null,
  hero = false,
}: {
  label: string;
  metric: Metric;
  qualifier?: string | null;
  hero?: boolean;
}) {
  return (
    <div className={`resort-metric ${hero ? "resort-metric--hero" : ""}`}>
      <div className="resort-metric__label">{label}</div>
      <MetricValue m={metric} size={hero ? "xl" : "lg"} />
      {qualifier && <p className="resort-metric__qualifier">{qualifier}</p>}
    </div>
  );
}

/**
 * Every resort shows the same slots in the same order: overnight, 24 h and base
 * as tiles, then 48 h, 72 h, 7 days, storm and season. Alta's overnight tile
 * holds its 12 h total, captioned with Alta's own wording. A window the resort
 * doesn't publish, or left empty, keeps its slot as "—".
 */
function snowSlots(snowfall: SnowfallSet, base: Metric) {
  const slot = (key: keyof SnowfallSet) => ({
    key,
    label: SNOW_LABEL[key === "h12" ? "overnight" : key],
    metric: snowfall[key],
    qualifier: snowfall[key].state === "unavailable" ? null : snowQualifier(key === "h12" ? "overnight" : key, snowfall[key].label),
  });
  const hero = [slot(newSnowKey(snowfall)), slot("h24")];
  const history = (["h48", "h72", "d7", "storm", "season"] as const).map(slot);
  // Source notes ("rolling total computed by Snowbird…") apply to several
  // windows at once, so they're listed once under the section.
  const notes = new Map<string, string[]>();
  for (const s of [...hero, ...history]) {
    if (s.metric.state === "unavailable" || !s.metric.note) continue;
    notes.set(s.metric.note, [...(notes.get(s.metric.note) ?? []), s.label]);
  }
  return {
    hero,
    history,
    // Missing values all show "—"; one line names them, whether left empty or never published.
    missing: [...hero, { label: "Base depth", metric: base }, ...history]
      .filter((s) => s.metric.state !== "reported")
      .map((s) => s.label),
    notes: [...notes].map(([note, labels]) => ({ note, labels })),
  };
}

/**
 * Capitalize the source's raw status string for display. Sources differ in
 * casing (Alta terrain is "closed", Alta lifts "Closed", Snowbird "closed"),
 * so the page normalizes the first letter and leaves the rest verbatim.
 */
function displayStatus(raw: string): string {
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** One resort's report page: header, snowfall, weather, narrative, lifts and terrain, webcams. */
export function ResortReportPage({
  source,
  now,
  cams,
  loadedAt = null,
}: {
  source: ApiSource;
  now: Date;
  cams?: ApiSource;
  loadedAt?: number | null;
}) {
  const r = source.payload as ResortReport | null;
  if (!r)
    return (
      <section className="resort-report">
        <header className="resort-report__header">
          <h1>{source.label}</h1>
        </header>
        <Unavailable source={source} what={`${source.label} report`} />
        <SourceLine source={source} now={now} timeZone={resortTimeZone(source.id)} />
      </section>
    );

  const snow = snowSlots(r.snowfall, r.base);
  const issues = snowfallIssues(r.snowfall);
  const location=r.reportingLocation??{name:resortById(source.id)?.station,elevationFt:resortById(source.id)?.elevationFt,note:undefined};
  const observations = r.observations.filter(
    (observation) =>
      source.id !== "alta" || observation.temperature.state !== "unavailable",
  );
  // Routine road status lives on the Roads page.
  const notices = r.notices.filter(
    (notice) => !(notice.severity === "info" && /^road status$/i.test(notice.title.trim())),
  );

  return (
    <article className="resort-report" aria-label={`${r.resort} resort report`}>
      <header className="resort-report__header">
        <div>
          <p className="eyebrow">Mountain report</p>
          <h1>{r.resort}</h1>
          {location.name && <p className="muted">Snow reporting: {location.name}{location.elevationFt?` · ${location.elevationFt.toLocaleString()} ft`:""}{location.note?` · ${location.note}`:""}</p>}
          {r.mountainBaseRange && <p className="muted">Mountain-wide base: {r.mountainBaseRange.minIn}–{r.mountainBaseRange.maxIn}″</p>}
          <p className="resort-report__time">
            Updated{" "}
            <strong>{formatLocal(r.reportTime,now,resortTimeZone(source.id))}</strong>
          </p>
        </div>
        <div className="resort-report__state">
          <FreshnessBadge freshness={source.freshness} />
          {r.operatingStatus && (
            <span>{r.operatingStatus}</span>
          )}
          {r.liftsOpen !== null && r.liftsTotal !== null && (
            <span>
              <strong>
                {r.liftsOpen} / {r.liftsTotal}
              </strong>{" "}
              lifts open
            </span>
          )}
        </div>
      </header>

      <nav className="resort-report__jump" aria-label="In this resort report">
        <a href="#resort-snow-heading">Snowfall</a>
        <a href="#resort-weather-heading">Weather</a>
        {r.narrative && <a href="#resort-narrative-heading">Resort report</a>}
        <a href="#resort-lifts-heading">Lifts</a>
        <a href="#resort-terrain-heading">Terrain</a>
        <a href="#resort-webcams">Webcams</a>
      </nav>

      {notices.length > 0 && (
        <section className="resort-alerts" aria-label="Resort notices">
          <NoticeList notices={notices} now={now} timeZone={resortTimeZone(source.id)} />
        </section>
      )}
      {!!r.missingSections?.length && (
        <p className="resort-report__gap">
          Some information is unavailable this check:{" "}
          {r.missingSections.join(", ")}. Available sections are shown below.
        </p>
      )}

      <section className="resort-snow" aria-labelledby="resort-snow-heading">
        <div className="resort-section-heading">
          <h2 id="resort-snow-heading">Snowfall</h2>
          <span>Reported by {r.resort}</span>
        </div>
        {issues.length > 0 && (
          <p className="resort-report__gap resort-snow__warning" role="note">
            Snowfall data warning: the resort publishes conflicting or invalid amounts.
          </p>
        )}
        <div className="resort-snow__headline">
          {snow.hero.map((s) => (
            <SnowMetric key={s.key} label={s.label} metric={s.metric} qualifier={s.qualifier} hero />
          ))}
          <SnowMetric label="Base depth" metric={r.base} hero />
        </div>
        <div className="resort-snow__history">
          {snow.history.map((s) => (
            <SnowMetric key={s.key} label={s.label} metric={s.metric} qualifier={s.qualifier} />
          ))}
        </div>
        {(snow.missing.length > 0 || snow.notes.length > 0) && (
          <div className="resort-snow__notes">
            {snow.notes.map(({ note, labels }) => (
              <p key={note}>{labels.join(", ")}: {note}</p>
            ))}
            {snow.missing.length > 0 && (
              <p className="resort-snow__unavailable">
                No data from {r.resort}: {snow.missing.join(", ")}
              </p>
            )}
          </div>
        )}
      </section>

      <section
        className="resort-weather"
        aria-labelledby="resort-weather-heading"
      >
        <div className="resort-section-heading">
          <h2 id="resort-weather-heading">On the mountain</h2>
          <Link href={`/weather/${resortById(source.id)?.region??"utah"}`}>Forecast ↗</Link>
        </div>
        {observations.length === 0 ? (
          <p className="muted">
            Temperature and wind observations aren’t provided in {r.resort}’s
            feed. Check the mountain forecast for weather guidance.
          </p>
        ) : (
          <div className="resort-observations">
            {observations.map((observation) => (
              <div key={observation.location} className="resort-observation">
                <div className="resort-observation__heading">
                  <h3>{observation.location}</h3>
                  <span className="resort-observation__time">
                    Observed {formatLocal(observation.observedAt, now,resortTimeZone(source.id))}
                  </span>
                </div>
                {observation.sky && <p className="muted">{observation.sky}</p>}
                <dl>
                  <div>
                    <dt>Temperature</dt>
                    <dd>
                      <MetricValue m={observation.temperature} size="md" />
                    </dd>
                  </div>
                  {observation.wind.state !== "unavailable" && (
                    <div>
                      <dt>Wind {observation.direction}</dt>
                      <dd>
                        <MetricValue m={observation.wind} size="md" />
                      </dd>
                    </div>
                  )}
                  {observation.gust.state !== "unavailable" && (
                    <div>
                      <dt>Gust / high</dt>
                      <dd>
                        <MetricValue m={observation.gust} size="md" />
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            ))}
          </div>
        )}
      </section>

      {r.narrative && (
        <section
          className="resort-narrative"
          aria-labelledby="resort-narrative-heading"
        >
          <div className="resort-section-heading">
            <h2 id="resort-narrative-heading">From {r.resort}</h2>
            <a href={r.sourceUrl} target="_blank" rel="noreferrer">
              Resort report ↗
            </a>
          </div>
          {r.narrative.length > 240 ? (
            <>
              <p className="resort-narrative__preview">
                {r.narrative.slice(0, 240).trimEnd()}…
              </p>
              <details className="resort-narrative__disclosure" key={source.id}>
                <summary>
                  <span className="resort-narrative__more">Read more</span>
                  <span className="resort-narrative__less">Read less</span>
                </summary>
                <p>{r.narrative}</p>
              </details>
            </>
          ) : (
            <p>{r.narrative}</p>
          )}
        </section>
      )}

      <section
        className="resort-operations"
        aria-labelledby="resort-lifts-heading"
      >
        <div className="resort-section-heading">
          <h2 id="resort-lifts-heading">Lifts</h2>
          {r.liftsOpen !== null && r.liftsTotal !== null && (
            <span>
              {r.liftsOpen} of {r.liftsTotal} lifts open
            </span>
          )}
        </div>
        {r.operationsUpdatedAt&&<p className="muted">Lift status updated {formatLocal(r.operationsUpdatedAt,now,resortTimeZone(source.id))}</p>}
        <p className="resort-status-key">
          <StatusDot status="open" /> Open <StatusDot status="hold" /> Hold{" "}
          <StatusDot status="scheduled" /> Scheduled{" "}
          <StatusDot status="closed" /> Closed <StatusDot status="unknown" />{" "}
          Unknown
        </p>
        {r.lifts === null ? (
          <p className="muted">
            Individual lift status unavailable
            {r.missingSections?.includes("lifts") ? " (lift feed failed)" : ""}.
          </p>
        ) : r.lifts.length === 0 ? (
          <p className="muted">No individual lifts listed in this report.</p>
        ) : (
          <ul className="status-list">
            {byStatus(r.lifts).map((lift) => (
              <li
                key={lift.name}
                className={`status-item status-item--${lift.status}`}
              >
                <div className="status-item__row">
                  <strong>{lift.name}</strong>
                  <span>
                    <StatusDot status={lift.status} /> {displayStatus(lift.rawStatus)}
                  </span>
                </div>
                {lift.hours && <p className="status-item__meta">{lift.hours}</p>}
                {lift.note && <p className="status-item__note">{lift.note}</p>}
              </li>
            ))}
          </ul>
        )}
        <div className="resort-section-heading resort-terrain-heading">
          <h2 id="resort-terrain-heading">Named terrain &amp; gates</h2>
        </div>
        {r.terrain === null ? (
          <p className="muted">
            Named terrain status not provided by this source.
          </p>
        ) : r.terrain.length === 0 ? (
          <p className="muted">No named terrain listed in this report.</p>
        ) : (
          <ul className="status-list">
            {byStatus(r.terrain).map((terrain) => (
              <li
                key={`${terrain.kind}-${terrain.name}`}
                className={`status-item status-item--${terrain.status}`}
              >
                <div className="status-item__row">
                  <strong>{terrain.name}</strong>
                  <span>
                    <StatusDot status={terrain.status} /> {displayStatus(terrain.rawStatus)}
                  </span>
                </div>
                <p className="status-item__meta">{terrain.kind}</p>
                {terrain.note && <p className="status-item__note">{terrain.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div id="resort-webcams">
        <ResortCams
          resortId={source.id}
          cams={cams}
          now={now}
          loadedAt={loadedAt}
        />
      </div>

      <SourceLine source={source} now={now} timeZone={resortTimeZone(source.id)} reportLabel={r.reportTimeLabel} />
    </article>
  );
}
