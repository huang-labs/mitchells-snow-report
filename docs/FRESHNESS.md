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

Reported **0** is distinct from **not reported** (published field empty) and **unavailable** (measurement not supplied). Resort pages preserve those states. Compact timelines may use one no-data mark for the latter two, while historical days also distinguish no new morning report from no collection. Ranges remain ranges. There is no station averaging or elevation correction.

Source metadata and reporting location appear quietly on detail pages. Lift-feed timestamps are independent of snow-report time where supplied. Resort camera stills older than three hours say “not updating”; capture time unknown and live-player status remain explicit.

Latest Daily Snow always displays its edition date and posting time. Publication status is current, scheduled, pending, delayed or paused. Regional windows are 6–10 AM local; Western is 7–11 AM Pacific. A running final attempt can finish after cutoff. A missed expected edition retains the last good post and shows “Latest edition delayed”; an established quiet off-season pause does not. Missing inputs cannot establish a pause. Archive responses omit the current-publication warning.

The homepage shows report times and a shared value legend. Required unavailable/delayed feeds raise the global banner; API polling errors retain the last report with a connection notice. No API read collects data or generates AI.
