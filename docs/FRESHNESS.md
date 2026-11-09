# Freshness and data semantics

[← README](../README.md)

Collection time, source publication time and article availability are separate. A fresh fetch of an old report remains an old report. Source windows and timestamps are retained; local displays use the resort or region's IANA time zone.

| State | Display | Meaning |
| --- | --- | --- |
| current | Current | Checked on schedule, source report within its age window |
| old-report | Old report | Recently fetched, source publication too old or invalid/future |
| time-unknown | Time unknown | Recent check, publication time not established |
| stale | Updates delayed | No successful check within its collection window |
| unavailable | Unavailable | No collected payload |

Report windows: resorts 26 h, NWS 12 h, discussions/numerical ensemble 18 h, plumes 30 h. Collection staleness is 22 minutes plus the interval beyond five minutes: NWS 32 minutes, half-hour sources 47. A confirmed failed latest check is separate from age. NWS points and plume stations retain independent errors/check times; regional footers consider only the selected region.

Reported **0** is distinct from **not reported** (published field empty) and **unavailable** (measurement not supplied). The data model preserves those states; pages show both missing states as one no-data mark (—), with the distinction kept in tooltips and screen-reader text. Historical timeline days also distinguish no new morning report from no collection. Ranges remain ranges. There is no station averaging or elevation correction.

Snowfall consistency is independent of fetch/report freshness. Shared checks flag negative/nonfinite amounts and a shorter accumulation exceeding a reported longer window (overnight or 12 h versus 24/48/72 h/7 days, and nested rolling windows). Missing fields do not imply zero. “Since lifts closed” counters are not assumed to fit inside 24 hours; overnight and fixed 12-hour windows are not compared with each other. Storm/season counters and base depth are not compared with rolling totals because they can reset or describe different periods.

Both sides of a contradiction are withheld from derived use: the system cannot establish which is wrong. Raw resort figures remain unchanged in the API and detail page, with a visible data warning. Daily Snow inputs, phase/activity, storm observations, the current timeline and newly recorded morning history use the same validated view. Suspect source narrative is excluded from AI input. Affected history entries retain their source label and a quality note, and show no data rather than a measured zero. The Western overview also rechecks frozen regional inputs and withholds an older edition’s prose when its frozen observations conflict.

Identical amounts alone do not establish staleness: valid totals can repeat, including zero. An advancing page timestamp cannot resolve a measurement conflict. Consistent but stuck values without independent evidence remain undetectable. Source corrections restore eligibility on the next collection/read. Previously published articles, existing storm archives and past history are not rewritten automatically; this safeguard prevents new derived uses and does not prove all source measurements are correct.

Source metadata and reporting location appear quietly on detail pages. Lift-feed timestamps are independent of snow-report time where supplied. Resort camera stills older than three hours say “not updating”; capture time unknown and live-player status remain explicit.

Latest Daily Snow always displays its edition date and posting time. Publication status is current, scheduled, pending, delayed or paused. Regional windows are 7–11 AM local; Western is 7:15 AM–noon Pacific. A running final attempt can finish after cutoff. A missed expected edition retains the last good post and shows “Latest edition delayed”; an established quiet off-season pause does not. Missing inputs cannot establish a pause. Archive responses omit the current-publication warning.

The homepage shows report times and a shared value legend. Required unavailable/delayed feeds raise the global banner; API polling errors retain the last report with a connection notice. No API read collects data or generates AI.
