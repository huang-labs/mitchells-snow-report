import type { StormRecord } from "@/lib/dailysnow/storm-types";
import { cachedDateFormat, TZ } from "@/lib/time";

const reportTimeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** The same retained observations supplied to the model, frozen with this edition. */
export function StormRecap({ storm,timeZone=TZ }: { storm: StormRecord;timeZone?:string }) {
  const reportTimeFormat=cachedDateFormat("en-US",{timeZone,weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"});
  return (
    <table className="dailysnow-totals dailysnow-storm" aria-label="Observations for this storm">
      <thead><tr><th scope="col">Resort</th><th scope="col">Storm observations</th><th scope="col" className="dailysnow-storm__report-time">Report time</th></tr></thead>
      <tbody>{storm.resorts.map((r) => {
        const o = r.total ?? r.rolling;
        return (
          <tr key={r.id}>
            <th scope="row">{r.name}</th>
            <td>{o ? <>
              <strong>{o.amountIn}″</strong>{" "}<span className="muted">· {o.window === "storm" ? r.counterResetAt ? "Earlier reported storm total" : "Reported storm total" : `Earlier ${o.window === "48h" ? "48 h" : "24 h"} observation`}</span>
            </> : <span className="muted">— · Storm total unavailable</span>}</td>
            <td className="dailysnow-storm__report-time muted">{o?.reportTime
              ? <time dateTime={o.reportTime}>{reportTimeFormat.format(new Date(o.reportTime))}</time>
              : o ? "Time unavailable" : "—"}</td>
          </tr>
        );
      })}</tbody>
    </table>
  );
}
