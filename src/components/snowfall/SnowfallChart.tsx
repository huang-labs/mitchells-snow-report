import { dateFormat } from "@/lib/time";
import type { SixHourSnow } from "@/lib/types";
import { dateLabel, dayLabel, snowfallDays, timeLabel, zonedTimeLabel } from "./model";
import "./snowfall.css";

export const SNOWFALL_UNITS = "6-hour snowfall · inches";

/**
 * Pass `units={false}` when the surrounding caption already shows {@link SNOWFALL_UNITS},
 * or `title` to head the chart with that text instead.
 */
export function SnowfallChart({ bars, label, units = true, title, timeZone="America/Denver" }: { bars: SixHourSnow[]; label: string; units?: boolean; title?: string; timeZone?:string }) {
  const days = snowfallDays(bars,timeZone);
  const dayLabel=dateFormat("en-US",{timeZone,weekday:"short"});
  const dateLabel=dateFormat("en-US",{timeZone,month:"numeric",day:"numeric"});
  const timeLabel=dateFormat("en-US",{timeZone,hour:"numeric"});
  const zonedTimeLabel=dateFormat("en-US",{timeZone,hour:"numeric",timeZoneName:"short"});
  const max = Math.max(1, ...bars.map(b => b.snowIn));
  const slotsPerDay = Math.max(4, ...days.map(d => d.slots.length));
  if (!days.length) return <p className="muted">Snowfall forecast unavailable.</p>;
  return <div className="snowfall">
    {(title || units) && <p className="snowfall__heading">{title ?? SNOWFALL_UNITS}</p>}
    <div className="snowfall__scroll" tabIndex={0} role="region" aria-label={`${label}. Scroll for later periods.`}>
      <ol className="snowfall__days" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(${slotsPerDay * 44}px, 1fr))` }}>
        {days.map(d => <li className="snowfall__day" key={d.key}>
          <ol className="snowfall__periods" style={{ gridTemplateColumns: `repeat(${d.slots.length}, minmax(0, 1fr))` }}>
            {d.slots.map(b => <li className="snowfall__period" key={b.start} aria-label={`${dayLabel.format(new Date(b.start))} ${dateLabel.format(new Date(b.start))}, six hours from ${zonedTimeLabel.format(new Date(b.start))}: ${b.snowIn === null ? "not available" : `${b.snowIn.toFixed(1)} inches`}`}>
              <div className="snowfall__plot" aria-hidden="true">
                {b.snowIn !== null && <>
                  <strong className="snowfall__amount">{b.snowIn.toFixed(1)}″</strong>
                  <span className="snowfall__bar" style={{ height: `${b.snowIn / max * 100}px` }} />
                </>}
              </div>
              <span className="snowfall__time" aria-hidden="true">{timeLabel.format(new Date(b.start)).replace(" AM", "a").replace(" PM", "p")}</span>
            </li>)}
          </ol>
          <span className="snowfall__date">{dayLabel.format(new Date(d.start))} {dateLabel.format(new Date(d.start))}</span>
        </li>)}
      </ol>
    </div>
    <p className="snowfall__note">Times are period starts in {timeZone==="America/Los_Angeles"?"Pacific Time":"Mountain Time"}. Blank slots = unavailable. Scroll for later days →</p>
  </div>;
}
