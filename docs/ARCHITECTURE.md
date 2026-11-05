# Architecture

[← README](../README.md)

Next.js exports 42 fixed dashboard pages into `out/`. Cloudflare Static Assets serves HTML, navigation payloads, scripts and styles. A plain Worker (`worker.ts`) handles APIs, share images and the five-minute collection cron. There is no request-time Next.js server.

```text
Browser → static pages → /api/report → source snapshot + nine publication states
Cron → due sources → source snapshot / local snow log / per-area storm memory
     → atomic publication reservation → Workers AI → channel archive + state
Link crawler → /daily-snow[/region]/opengraph-image → channel-specific PNG
```

## Catalog and routes

`src/lib/catalog.ts` owns the 14 favorites, eight editorial regions, time zones, 12 mountain forecast areas, reporting locations and 12 plume stations. An editorial region can span several independent forecast areas: Utah has LCC, BCC and Snowbasin; Colorado has Winter Park, Steamboat and Telluride.

The main navigation is Resorts, Daily Snow, Weather and Plumes. `/` always lists all 14 favorites in catalog order; each has `/<resort-id>`. Daily Snow defaults to the Western overview. The eight fixed regional children of `/daily-snow`, `/weather` and `/plumes` are statically generated. Weather and Plumes remember the last region, initially Utah; explicit paths win. Choosing Western leaves that preference intact.

The root AppShell polls once on load and every minute. Client navigation shares that report. Pages never collect or invoke AI. Roads, dedicated travel/highway-camera feeds, the recommendation backend and homepage teaser are removed.

## Collection and history

Each source independently retains its last good payload through failures. Resorts and resort cameras run every five minutes; NWS every 15; plumes, numerical CLN guidance and forecast discussions every 30. Failed sources retry on the next cron. Manual source selections bypass cadence.

NWS resolves catalog coordinates through `/points`, caching the grid/office mapping for 24 hours and invalidating it when coordinates change. Point failures retain that point with its own error and check time. Discussions deduplicate the nine verified issuing offices. Plumes isolate failures per station. Regional rendering recalculates source age from the selected points/stations.

All sources live at `snapshot:v1`, with a 14-day snow log and per-forecast-area storm memory. Source writes merge newer attempts against the latest snapshot. This is best effort: KV propagation and the read/put gap can still lose overlapping source updates. Publication reservations use a Durable Object instead of a KV lock.

Snow days end at **6 AM destination local time**, including 23/25-hour DST days. A morning capture accepts a resort's published 24-hour window only when its timestamp is recent enough for that morning. Rolling windows are never added. Each forecast area retains the NWS forecast a day began with. History starts with collection; there is no imported or fabricated backfill.

## Publications and artifacts

Nine independent states use `daily-state:v2:<channel>`. Archives and stills live under `channel:v1:<channel>:`, with the existing date/revision keys below that prefix. Cropped live plume panels remain shared keys `plume-panel:v1:<station>:<run>:<panel>`.

`PublicationCoordinator` serializes short storage operations: one active lease per channel, at most four running channels, three attempts per channel/local date, two reserved requests per attempt, and 64 reservations per rolling 24 hours. Inference remains in the collection job. The cron runs up to four regional attempts together. A due Western edition gets a separate cron once today's regional editions exist, keeping even two model timeouts inside the cron deadline. Subsequent crons pick up remaining regions. Channel states are written separately from source snapshots.

`GET /api/daily-snow?channel=<id>&date=YYYY-MM-DD` serves a retained edition. Figure URLs include the channel and a SHA-256 revision. Same-day rewrites preserve earlier referenced stills. Articles, stills and storm archives have 30-day retention; neighboring-edition links retain their original expiry.

## Images and runtime

The collector crops accumulated snow and SLR panels from source PNGs without reading their values. Live panels expire after four days, refresh after three, and retry failed crops hourly up to three times. Expired/unavailable panels fall back to original UTC charts. Daily Snow copies available panels into immutable edition stills and draws a frozen local-time axis and posting marker.

The branded share image is static. Daily Snow share images read the selected channel, never generate prose, and use short caches. Workerd image rendering uses `@cf-wasm/og`, the precompiled HarfBuzz adapter and the pinned dependency overrides.

Source HTTP requests have 15-second deadlines and an 8 MB decoded-body budget; copied article stills are capped at 3 MB. Tokens in public widget configs are redacted from diagnostics and never become public report fields.
