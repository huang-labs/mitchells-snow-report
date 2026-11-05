# Cottonwoods Snow Report — implementation brief

> Historical Cottonwoods brief. Current scope is the [Mitchell's expansion plan](EXPANSION_PLAN.md); source behavior is documented in [implementation notes](IMPLEMENTATION_NOTES.md).

Status: design interview complete; user accepted the decisions below and requested an implementation handoff.
Date: 2026-10-29. Revised 2026-11-01: the product is phone/desktop-first. Revised 2026-11-03: the TV slideshow mode was removed (PR #25), and its requirements are dropped from this brief.

## Purpose and audience

Build a snow/conditions web app read on phones and desktop browsers. It supplies evidence for people to decide where and when to ski, plus morning excitement. It does not score resorts or recommend a destination.

The owner is the primary audience and wants technically detailed information, including ensemble forecasts. Assume fluency with snow reports and plumes. Preserve scientific detail and precise measurement labels while making the main numbers readable on a phone.

Primary resorts: Alta, Snowbird, Solitude, Brighton. Include Park City, Deer Valley, and Snowbasin in a compact regional snowfall comparison; they do not need dedicated resort pages. Park City is the working interpretation of the user's “PC”; access/pass entitlement is not a product feature.

## Agreed architecture

- One full Next.js application deployed as one Cloudflare Worker service, one repository, one domain. Use a current stable Next.js version compatible with the chosen Cloudflare adapter; verify supported versions before installing.
- Use Next.js route handlers for the API, including same-origin `GET /api/report`.
- Add a scheduled handler to that same deployment for collection. OpenNext's documented custom Worker entrypoint is a researched route to combining Next.js request handling and `scheduled()`; verify the current integration before implementing.
- One global cron, `*/5 * * * *`, collects all source categories every five minutes. This supersedes earlier 15-minute and split-frequency proposals.
- Store the latest successful normalized data per source in Cloudflare KV. A SQL database, historical archive, separate collection microservice, and separate Pages deployment are outside v1.
- Render the web app client-side. The browser fetches the stored API snapshot on initial load and every minute, independently of page navigation. Page visits and API reads do not trigger upstream collection.
- Keep collection credentials server-side. The public API exposes report data, not operational secrets or private configuration.
- Access is public without authentication; an unlisted URL is acceptable. Include only public conditions data, never a household address. Browser preferences are stored locally.

The user's final choice is full Next.js with backend routes, not the earlier static-export-plus-Worker proposal. A serverless Cloudflare runtime is explicitly acceptable; “no backend” originally meant avoiding a server to administer.

## Navigation and design

The web app is a set of sections, each with its own page and URL, reached from a navbar that works on phones and desktops.

Default section order (implementation may adjust ordering for readability):

1. Regional snowfall comparison, centered on the four Cottonwoods resorts with compact secondary-resort rows.
2. Near-term Cottonwoods mountain weather: snow timing, snow levels, temperature, wind/gusts, today/tomorrow and the next storm where available.
3. University of Utah ensemble snow plumes: latest available run, original chart(s), initialization time, and preserved ensemble spread/full useful forecast range.
4. Alta report.
5. Snowbird report.
6. Solitude report.
7. Brighton report.
8. Traffic and road conditions for both canyons with two useful webcams.

Resort reports prioritize overnight, 24-hour, 48-hour and source-defined storm snowfall; base depth; temperature; wind/gusts; operational notices; individual lift status; notable named terrain openings; and report timestamps. Use source-provided definitions and units. Unsupported fields remain explicitly unavailable. Do not infer named terrain openings from aggregate counts or combine incompatible measurement windows.

Traffic uses fixed canyon-segment travel times rather than house-to-resort routing. Include segment endpoints, road closures, traction restrictions, avalanche-control notices, and parking information when available. Important closure notices persist across sections. Webcams serve as evidence, not decorative backgrounds.

Use a clean modern dark design, strong typography, large titles and key values, restrained meaningful color, minimal decorative imagery, and a clear hierarchy for technical detail. Design for phone and desktop browsing.

Browse controls: a navbar with every section, the current one highlighted.

## Freshness and failure semantics

Track these separately for each source:

- `sourceUpdatedAt`: upstream report publication/observation time, when supplied.
- `lastSuccessfulFetchAt`: most recent successful retrieval and validation.
- `lastAttemptAt`: most recent collection attempt.
- Collection status and useful server-side diagnostics.
- Model initialization time for plume forecasts.

Show source report time and last successful check in the UI. Display local report times in America/Denver with clear date context. A new fetch of yesterday's report does not make the observation current. Unknown publication time remains unknown.

On source failure, preserve its last successful payload and mark it stale/degraded. Other sources continue updating independently. Distinguish zero snowfall from missing data; where space is tight, unavailable and not-yet-reported data may share one “no data” mark (the data model keeps them separate). Preserve original measurement windows and source attribution. Freshness thresholds can be source-aware and documented; do not silently call all data live. KV propagation delay adds to collection interval and upstream reporting delay.

Required for a successful v1 release: real snowfall reports for all four primary resorts and the latest available Utah plumes. Detailed lift/terrain data, secondary resorts, traffic, and webcams may degrade independently. Development fixtures are allowed when explicitly identified; never present fabricated data as live. If required live feeds cannot be made reliable, report the release blocker rather than claiming completion.

## Source reconnaissance — verify during implementation

These were preliminary HTTP/documentation checks, not production-ready integrations:

- Utah plume selection (implementation factual correction: `PALT` is Palisades Tahoe, CA; `CLN` is Alta-Collins, UT, verified against the original chart and station menu): <https://weather.utah.edu/index.php?t=ensgefsds&d=PL&r=CLN>. The page selected run `2026102912` during research and referenced a dated PNG. Discover the latest run dynamically; do not hardcode that example. Browser cross-origin reading of the discovery HTML was unavailable.
- Alta: <https://www.alta.com/status>. HTML includes snow/weather/status information; direct browser fetch/framing is constrained. Worker fetching and extraction still need validation.
- Snowbird: <https://www.snowbird.com/the-mountain/mountain-report/current-conditions-weather/>. CORS was permissive in the initial check; actual data completeness and extraction reliability remain unverified.
- Solitude: <https://www.solitudemountain.com/mountain-and-village/conditions-and-maps>.
- Brighton: <https://www.brightonresort.com/conditions>. Some lift/terrain fields rendered as “Loading…” in extracted HTML; investigate the underlying data endpoints.
- UDOT: <https://cottonwoodcanyons.udot.utah.gov/road-information/>. Official dashboard: <https://uplan.maps.arcgis.com/apps/dashboards/2f5973a7e20a4a5689eee2074c980009>.
- Dashboard route layer: <https://services.arcgis.com/pA2nEVnB6tquxgOW/arcgis/rest/services/CC_Routes_TT/FeatureServer/0>. Anonymous queries worked, but sampled observation timestamps appeared older than edit timestamps. Establish actual measurement freshness before showing live travel times. These are fixed segments, not door-to-door ETAs.
- UDOT developer API: <https://www.udottraffic.utah.gov/developers/doc>. Initial documentation indicated developer-key access and rate limits. Verify current requirements; request necessary credentials through the available secret mechanism. Camera-image display and embedding still need validation.
- No dependable structured API for every resort has yet been established. Cloudflare hosting alone does not guarantee upstream access. Prefer official structured data when available, otherwise isolate and validate extraction per source.

Platform references:

- Full Next.js on Workers: <https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/>.
- Custom Worker entrypoint: <https://opennext.js.org/cloudflare/howtos/custom-worker>.
- Cron: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>.
- KV consistency: <https://developers.cloudflare.com/kv/concepts/how-kv-works/>.

## Implementation sequence and completion evidence

1. Establish the compatible Next.js/Cloudflare deployment skeleton and one end-to-end source path through collection, KV, API, and display. Completion: local runtime/build verifies both request and scheduled entrypoints; the real source's timestamps and normalized values are inspectable.
2. Implement source adapters with independent failure handling and the remaining core feeds. Completion: required real snowfall feeds and latest-plume discovery work, or specific reproducible blockers are documented.
3. Implement the section pages and navbar against the normalized contract. Completion: every agreed section exists, missing/stale cases are explicit, and preferences persist.
4. Validate and document operation. Completion: appropriate type/build/runtime checks and meaningful tests cover parsing, timestamp semantics, partial collection failures, API output, and navigation behavior. Provide local setup, deployment/binding/cron instructions, and source limitations.

Deployment provisioning depends on account access. Implement and test locally with available tooling; identify the remaining steps precisely. Do not claim deployed status without evidence. No production deployment, external resource provisioning, or PR publication is requested by this brief alone.
