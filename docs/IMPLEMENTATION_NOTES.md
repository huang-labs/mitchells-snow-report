# Implementation notes

[← README](../README.md)

Current source semantics and lasting design decisions. The [expansion plan](EXPANSION_PLAN.md) supersedes the original Cottonwoods brief. PR descriptions and Git history hold change-specific evidence.

## Reporting locations

Prefer one fixed official mid-mountain series; never select the snowiest station, average stations or numerically adjust elevations. Catalog elevations are independently verified or unknown, not inferred from inconsistent feed metadata. Homepage names stay unchanged; detail pages disclose provenance.

| Resort | Selected report / caveat |
| --- | --- |
| Alta | Collins Study Plot, 9,662 ft; official report |
| Snowbird | Official Primary; explicit published report time separate from rolling computations |
| Solitude | Mid-Mountain, explicitly selected even if the upstream preference changes |
| Brighton | Official resort report; elevation not established |
| Snowbasin | Official mountain report; elevation not established |
| Palisades Tahoe | Palisades Mid-Mountain, 8,000 ft |
| Mammoth Mountain | McCoy Station, 9,600 ft |
| Jackson Hole | Mid Mountain study plot, 8,180 ft |
| Big Sky | Official composite: highest amounts across reporting stations; not a single mid-mountain plot |
| Winter Park | Mid-Mountain; elevation not established |
| Steamboat | Mid-Mountain / Thunderhead, 9,080 ft |
| Telluride | Official snow report; elevation not established |
| Crystal Mountain | Mid-Mountain; elevation not established |
| Mt. Bachelor | Official Primary; elevation not established |

## Adapters

- **Alta:** parses `window.Alta` on lift/terrain status. `conditions.dated_at` is Denver local. The source supplies 12-hour/24-hour/storm/base/season values and independently timed weather/lifts/terrain/alerts. It does not publish every normalized snow window.
- **Snowbird:** public Drupal/API snow, lifts, terrain, sensors and parking feeds. `updated` is publication time; `computed` rolling totals refer to fetch time, from published reports. Overnight is the latest Primary report. A fresh rolling zero does not prove a new morning publication. Optional subfeeds degrade independently. Sensor times without a year are interpreted locally.
- **Mountain Powder:** Solitude plus Palisades, Mammoth, Winter Park, Steamboat and Crystal. Read public widget config at collection time; credentials are redacted and excluded from fixtures. Use `SnowReport.LastUpdate`, not the resort-wide update. Explicitly choose Mid-Mountain. Selected station depth is scalar; mountain-wide ranges such as 12–20″ remain separate ranges. Preserve published lift counts, which can differ from row counts; reconcile duplicate rows without inventing totals.
- **ReportPal:** Brighton and Big Sky; preserve published windows/counts and unknown fields. Big Sky remains an explicit official-composite exception.
- **Snowbasin / Telluride:** parse measured official HTML sections, publication times and lift rows. Exclude editorial forecast embeds and unrelated footer/phone labels. Local timestamps are Denver; source dates are not fetch dates.
- **Jackson Hole:** `/api/snow.json` provides mid-mountain amounts. Empty objects are unavailable. Use `lastModified`, not `respTimestamp`; do not trust inconsistent altitude metadata. Its optional trail/lift feed supplies official counts, named statuses and a separate update time.
- **Mt. Bachelor:** latest Primary snow report, explicit `updated` epoch and inch units. Rolling totals are source-computed; the timezone-free `date` is not used as freshness. Winter lift rows are separate from summer duplicates, with their own publication epoch.
- **Cameras:** retain the original four resorts' verified discovery and featured ordering. Other favorites use official pages, supported YouTube/allowlisted players, and an official camera-page link when no supported embed is discovered. A failed optional camera never makes snowfall zero or fails the resort report.

Captured fixtures retain real field values and source structure. Tests cover missing windows, real zeros, ranges, stale reports, timestamps, mid-mountain selection and partial failures.

## Weather and plumes

Each of 12 catalog mountain coordinates resolves through NWS `/points`. Grid elevation is shown explicitly and is not relabeled as the resort base or reporting station. Palisades' higher mountain point resolves to STO; Mammoth remains REV. The nine issuing offices are SLC, STO, REV, RIW, TFX, BOU, GJT, SEW and PDT; discussions deduplicate shared offices.

NWS interval accumulations are uniformly allocated to hours. Complete hourly coverage is required for comparable rolling totals and historical whole-day forecasts. Day/night blocks follow destination 6 AM/6 PM; missing values remain missing. Point failures keep their own previous forecast, check time and error.

Plume stations retain true names: PALT, MTH04, CMT and MBB are base references; CABTP is Berthoud Pass near Winter Park; RMPC2 is a San Juan reference, not a Telluride terrain forecast. The source PNG x-axis is UTC. Cropped panels draw local day boundaries without altering values; original fallbacks keep UTC.

Numerical ensemble tables are verified only for CLN: six tables, seven ordered percentile rows and forty six-hour leads. The parser validates location, units, headings and DST-safe UTC lead mapping. Exact published −0.01″ liquid traces normalize to zero and are counted; other negatives fail. Cumulative percentiles need not be monotone. Only wholly future P10/P50/P90 six-hour snow, liquid and supplied SLR reach Utah AI facts. Failed checks, old/future runs or old collection withhold usable values. There is no inferred regional numerical endpoint or arithmetic across percentiles.

## History, publication and limits

History begins with this deployment. Each destination uses a 6 AM local snow day, with source reporting windows preserved. A published report before the prior evening cutoff is not reused as a new morning reading; future timestamps cannot become history. Local days can be 23 or 25 hours.

Storm observations persist independently for each forecast area and are archived on material changes. Earlier rolling observations never become event totals; source counters can reset into separately labeled segments. New resort participants join an existing event when their reports arrive later.

Source snapshot merging remains best effort because KV has no compare-and-swap. AI attempt reservations instead use a Durable Object and channel states live outside the source snapshot. Late source writes cannot erase regional articles. Edition stills are revision-addressed; article/figure identities always include the channel. Inference is collection-time only.

Three attempts per channel/local date reserve two calls each, under a global rolling-24-hour ceiling of 64 and four concurrent channels. Models can each take five minutes; the twelve-minute lease covers fallback and figure copies. Quiet winter publishing uses a conservative November–May default unless a source explicitly declares the season closed; current/recent operations and snow activity extend eligibility. Missing inputs cannot establish an off-season pause.

Free-prose grounding is necessarily imperfect. Schemas, amount checks and explicit eligibility reduce errors, while real output review checks semantic attribution, windows and unseen-image claims. No automated check proves that every sentence associates a supplied number with the correct source.

## Deployment boundary

Production Worker/KV/Gateway are distinct from Cottonwoods. Modern Worker Previews are required for Durable Object support; version URLs do not support DO implementations. PRs read only the seeded preview KV and run no crons. Use a disposable seed Preview for temporary administrative access, then delete that Preview so its immutable deployment URLs close too. Production writes outside an owner-requested operation require approval.
