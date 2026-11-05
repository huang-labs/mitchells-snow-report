# Mitchell's Snow Report expansion plan

[← README](../README.md)

Status: design approved on November 5, 2026; implementation delivered in the expansion PR. The follow-up design uses the name United States West, top-of-page dropdowns without visible labels, and a standalone West article with comparison figures instead of regional highlights and links. Resort navigation uses homepage links rather than a resort subnav. This document retains the approved scope; current operations and source findings live in the linked guides.

Expand the Cottonwoods dashboard into Mitchell's Snow Report at
`mitchells-snow-report.huang.mx`. Launch with a fixed list of 14 United States
resorts, eight regional forecast channels, and a Western United States Daily Snow
overview. International favorites are outside this release.

Before feature implementation, complete the [fork setup](REPOSITORY_SETUP.md) so
CI, AI reviews, and isolated preview deployments work in this repository.

## Product scope

The main navigation becomes **Resorts · Daily Snow · Weather · Plumes**. Remove
Roads and its dedicated feeds, AI resort recommendations and their generation,
and the homepage Daily Snow teaser. Keep resort-operated webcams and useful
resort-supplied operational alerts.

The homepage retains the current snowfall timelines and this exact favorites
order:

1. Alta
2. Snowbird
3. Solitude
4. Brighton
5. Snowbasin
6. Palisades Tahoe
7. Mammoth Mountain
8. Jackson Hole
9. Big Sky
10. Winter Park
11. Steamboat
12. Telluride
13. Crystal Mountain
14. Mt. Bachelor

Each resort has a detail page with the same structure, showing the snow reports,
operations, observations, and webcams its sources support. Missing data remains
distinct from a reported zero. Launch requires reliable reported snowfall,
accumulating history, and mountain forecasts; individual optional fields depend
on what each resort publishes.

### Regions and selectors

| Region | Tracked resorts | Time zone |
| --- | --- | --- |
| Utah | Alta, Snowbird, Solitude, Brighton, Snowbasin | America/Denver |
| Tahoe | Palisades Tahoe | America/Los_Angeles |
| Mammoth / Eastern Sierra | Mammoth Mountain | America/Los_Angeles |
| Tetons | Jackson Hole | America/Denver |
| Montana | Big Sky | America/Denver |
| Colorado | Winter Park, Steamboat, Telluride | America/Denver |
| Washington | Crystal Mountain | America/Los_Angeles |
| Oregon | Mt. Bachelor | America/Los_Angeles |

Daily Snow defaults to **Western United States**, followed by these eight regional
choices. The overview covers the tracked western regions, not the entire country.
Weather and Plumes remember the last regional selection, initially Utah. Choosing
the Western overview preserves that regional preference. Direct links override
saved preferences. The homepage always shows all 14 resorts.

Place a compact, labeled region selector below the relevant page heading. Use
fixed, shareable regional routes, such as `/daily-snow/utah`, `/weather/utah`, and
`/plumes/utah`, retaining the base pages as defaults. Prerender the fixed routes.

## Reporting locations and source semantics

Keep resort names unchanged on the homepage: **Mammoth Mountain**, not the name of
its reporting station. Select an official mid-mountain snow report wherever
available, with a stable chosen location for each resort. This means comparable
positions on the mountains, not identical absolute elevations across ranges.

Do not mathematically adjust snowfall, average stations, or switch to whichever
station reports the most. Single-report and composite sources are documented
exceptions. Keep reporting location, verified elevation, and measurement-window
provenance on the detail page. Preserve that provenance with historical readings.

Examples of usable selections are Palisades Mid-Mountain, Mammoth's McCoy Station,
and Jackson Hole's Mid Mountain series. Big Sky's published summary uses the
highest amounts across multiple stations, so it cannot be labeled a comparable
mid-mountain report. Its [reporting explanation](https://www.bigskyresort.com/current-conditions/snow-report-faqs)
describes that exception.

Keep published ranges as ranges and missing values distinct from zero. Report
publication time is separate from fetch time; a recently fetched old report is
still old. Preserve rolling totals and source-specific reporting windows.

Snow history starts with this deployment and fills naturally. Do not fabricate
past-week history or silently import Cottonwoods archives.

## Source plan

Live reconnaissance identified the following paths for the ten new resorts.
Endpoint discovery is complete; adapters and field semantics still need fixture
validation during implementation.

| Source approach | Resorts |
| --- | --- |
| Mountain Powder feeds | Palisades Tahoe, Mammoth Mountain, Winter Park, Steamboat, Crystal Mountain |
| ReportPal | Big Sky |
| Official HTML reports | Snowbasin, Telluride |
| Official JSON feeds | Jackson Hole, Mt. Bachelor |

The existing four Cottonwoods adapters remain the starting point for those
resorts. Mountain Powder configs are published at
`https://v4.mtnfeed.com/resorts/<slug>.json`; read public widget credentials at
collection time and keep them out of logs, fixtures, and API responses.

Confirmed additional endpoints include:

- [Big Sky ReportPal](https://www.bigskyresort.com/api/reportpal?resortName=bs&useReportPal=true)
- [Jackson Hole snow report](https://jacksonhole-prod.zaneray.com/api/snow.json)
- [Mt. Bachelor snow reports](https://api.mtbachelor.com/api/v1/dor/drupal/snow-reports?sort=date&direction=desc)
- [Snowbasin mountain report](https://www.snowbasin.com/the-mountain/mountain-report/)
- [Telluride snow report](https://tellurideskiresort.com/snow-report/)

Implementation must account for these verified differences:

- Mountain Powder's `SnowReport.LastUpdate` is the snow-report time; the resort-wide
  update time can advance independently. Several feeds default to base reporting
  despite exposing a selectable mid-mountain series.
- Mountain Powder publishes real base-depth ranges. The current leading-number
  parser must not silently truncate them. Use the chosen station's scalar depth
  consistently and explicitly support any displayed mountain-wide range.
- Jackson Hole's JSON exposes summit and mid-mountain snow. Its HTML can show zero
  for unavailable fields; use the JSON. `respTimestamp` is not report freshness.
- Mt. Bachelor exposes rolling computed totals and explicit modification epochs.
  Its timezone-free report date needs source verification before interpretation.
- Published lift totals can differ from the number of feed rows. Preserve source
  counts and reconcile duplicate rows without inventing operating totals.

### NWS and plumes

Resolve mountain coordinates, grid elevations, and issuing offices for every
resort. Map resorts to explicit forecast-point IDs and collect relevant NWS Area
Forecast Discussions, deduplicating shared offices. Share forecast fetches only
where the mapped points genuinely coincide. Isolate failures by forecast point
and plume station.

Actual University of Utah plume PNGs were verified for the proposed regions.
Candidate stations are CLN/PKCU1/SNI in Utah, PALT for Tahoe, MTH04 for Mammoth,
JHRV for Jackson Hole, LMTMT for Big Sky, CABTP/STORM and a labeled San Juan
reference station for Colorado, CMT for Crystal, and MBB for Bachelor. Nearby
reference stations and base-elevation charts retain their true labels.

Machine-readable numerical ensemble tables are currently verified only for
Alta-Collins. Keep those statistics LCC-scoped. Other regions use NWS facts and
discussions with plume images as supporting figures. Never infer numerical spread
or snowfall amounts by reading image pixels.

## Architecture and implementation sequence

### 1. Catalog and domain model

Create a fixed catalog for resort IDs, display names, order, regions, time zones,
reporting choices, forecast points, and plume stations. Replace duplicated
four-resort lists and LCC/BCC display-name matching with explicit identities.

Separate editorial regions from forecast areas. Colorado gets one article while
Winter Park, Steamboat, and Telluride retain independent forecast facts and storm
histories. Utah likewise keeps distinct Cottonwood and Snowbasin inputs. An
article can describe different storm phases within its region.

### 2. Collection and local calendars

Add the new adapters in dedicated modules, retaining last successful payloads
through failures and validating real captured fixtures. Expand resort camera
collection according to available official sources.

Apply each destination's time zone to forecast blocks, chart axes, day labels,
morning snow-history capture, and publication schedules. Test daylight-saving
transitions. A local display date does not change the source's measurement window.

### 3. Regional Daily Snow

Each region gets its own publication state, continuity, forecast-area storm
records, archive, frozen figures, and previous/next navigation. Preserve the
existing 30-day article retention. Article, image, cache, and share-image
identities include the channel so regions cannot overwrite or display one
another's content.

Regional editions target **6 AM local time**, including quiet ski-season days.
Verified off-season, quiet regions pause; missing inputs remain distinguishable
from an intentional pause. Use the current article treatment: one reading width,
original AI prose, facts and captions computed by code, supporting figures, an
AI badge, and model attribution.

Extract the shared factual and season-detection logic Daily Snow currently imports
from `src/lib/recommend/` before deleting the recommendation feature.

### 4. Western United States Daily Snow

Target **7 AM Pacific / 8 AM Mountain**. Use today's available regional summaries
and their saved structured facts. Open with the overall weather story, highlight
regional differences, and link to full regional articles. Any numerical comparison
must use matching forecast windows, with location and source attribution.

Identify delayed regional editions explicitly. Never substitute an older regional
article as today's. If overview generation fails, retain the previous edition
with its original date visible. Do not automatically rewrite successful editions
later that morning.

### 5. Generation coordination and limits

Keep `@cf/zai-org/glm-5.3-flash` as primary and `@cf/openai/gpt-oss-120b` as the
single fallback. Models write prose; code computes facts, eligibility, phases,
totals, figure captions, and availability. Use strict schemas and validation.

Allow up to **three attempts per channel per local day**, with at most one
fallback per attempt. Manual attempts count toward the limits. Reserve fallback
capacity before starting an attempt. A dedicated AI Gateway caps total model
requests at **64 per sliding day** across channels.

Record attempts, in-flight status and request counts in each channel's KV state,
following the original single-edition pattern; no separate lock or coordinator.
Forced manual runs pass the same checks. The collection cron continues to execute
inference after fresh sources are stored; API reads never generate. Keep
generation concurrency bounded and store channel editions independently so
overlapping completions cannot erase another region's publication.

*Revised during review:* the approved design specified a Durable Object
coordinator for atomic reservations. It duplicated limits already held in
channel state, the Gateway enforces the global ceiling, and the races it closed
are narrow, so it was removed before production deployment.

### 6. UI, branding, and deployment

Integrate region selectors and resort routes while retaining the current shared
report polling and rendering where practical. Remove the Roads page and feeds,
recommendation UI/backend, and homepage teaser.

Update the masthead, metadata, share assets, package identity, theme-storage
prefix, collector contact, deployment configuration, and documentation to
Mitchell's branding.

Create separate Mitchell's Worker, KV, and AI Gateway
resources. Configure `mitchells-snow-report.huang.mx`. Use isolated preview
storage seeded through the real collection path so the PR preview can demonstrate
the feature before production begins collecting.

## Existing code affected

This is a source-to-rendering domain expansion. Keep new adapters and publication
logic in dedicated modules; limit shared edits to the required integration seams.
The implementation PR must list its exact final existing-file changes and reasons.

| Area | Expected existing touchpoints and reason |
| --- | --- |
| Contracts and navigation | `src/lib/types.ts`, `sections.ts`: explicit catalog identities, regional publications, navigation |
| Sources | `src/lib/sources/index.ts`, `mtnpowder.ts`, `nws.ts`, `nwsafd.ts`, `plumes.ts`, `resortcams.ts`: expanded registration, reporting selection, collection and failure isolation |
| Collection and storage | `src/lib/collect.ts`, `store.ts`, `report.ts`, `worker.ts`: channel scheduling, persistence and channel state |
| Worker APIs | `src/worker/admin.ts`, `fetch.ts`, `env.ts`, `report.ts`, `plume.ts`, `daily-snow.ts`, `daily-snow-figure.ts`, `daily-snow-share-image.tsx`: channel-aware routes, bindings and images |
| Calendars and history | `src/lib/time.ts`, `snowlog/days.ts`, `record.ts`, `types.ts`; timeline, snowfall, chart and plume-axis components: local dates and forecast mappings |
| Daily Snow | `src/lib/dailysnow/`, `src/components/dailysnow/`: scoped facts, continuity, storms, publication states, archives and rendering |
| Pages | `AppShell.tsx`, `SectionNav.tsx`, `SectionView.tsx`, regional/weather/plumes/resort components, app routes and scoped styles: selection, expanded resort navigation and branding |
| Branding and operations | Metadata, layout, share-image files; `package.json`/lockfile; `wrangler.jsonc`; deployment workflow; collection/replay/smoke/share scripts: fork identity and isolated deployment |
| Documentation and tests | README, architecture/AI/development/deployment/design/freshness notes, repository instructions and affected tests/fixtures: current behavior and meaningful regression coverage |

Remove obsolete recommendation scripts/tests and dedicated Roads files/fixtures
after extracting the shared factual logic. Resort camera collection remains.

## Validation and delivery

- Validate all 14 resort adapters against real fixtures, including stale reports,
  missing values, zeros, ranges, and selected reporting locations.
- Test NWS point/station failure isolation, region and forecast-area storm
  separation, local calendars, DST, channel-specific archives and images, and
  concurrent generation limits including manual attempts.
- Run real primary-model output through all nine channels and exercise fallback
  behavior on representative cases. Review attribution and forecast windows as
  well as schema validity; number presence alone cannot prove semantic accuracy.
- Run tests, typecheck, build, Worker smoke checks, and `git diff --check`.
- Check phone and ordinary laptop layouts, both themes, keyboard navigation,
  selectors, archives, and missing/stale states.
- Deliver the feature in one Conventional Commit PR labeled `author:codex`, with
  updated documentation, exact file inventory, validation evidence, limitations,
  and a reviewable preview. Housekeeping is a separate prerequisite PR.
