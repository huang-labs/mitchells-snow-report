# Architecture

[← README](../README.md)

Next.js exports 44 fixed web app pages into `out/`. Cloudflare Static Assets serves HTML, navigation payloads, scripts and styles. A plain Worker (`worker.ts`) handles APIs, share images and the five-minute collection cron, which runs collection in the `CollectorObject` Durable Object. There is no request-time Next.js server.

```text
Browser → static pages → /api/report → source snapshot + nine publication states
Cron → CollectorObject → due sources → source snapshot / local snow log / per-area storm memory
     → (back in the cron) per-channel attempt record → Workers AI → channel archive + state
Link crawler → /daily-snow[/region]/opengraph-image → channel-specific PNG
```

## Catalog and routes

`src/lib/catalog.ts` owns the 16 favorites, eight editorial regions, time zones, 14 mountain forecast areas, reporting locations and 12 plume stations. An editorial region can span several independent forecast areas: Utah has LCC, BCC, Park City, Deer Valley and Snowbasin; Colorado has Winter Park, Steamboat and Telluride.

The main navigation is Resorts, Daily Snow, Weather and Plumes. `/` always lists all 16 favorites in catalog order; each has `/<resort-id>`. Daily Snow defaults to the Western overview. The eight fixed regional children of `/daily-snow`, `/weather` and `/plumes` are statically generated. Weather and Plumes remember the last region, initially Utah; explicit paths win. Choosing Western leaves that preference intact.

The root AppShell polls once on load and every minute. Client navigation shares that report. Pages never collect or invoke AI. Roads, dedicated travel/highway-camera feeds, the recommendation backend and homepage teaser are removed.

## Collection and history

Each source independently retains its last good payload through failures. Resorts and resort cameras run every five minutes; NWS every 15; plumes, numerical CLN guidance and forecast discussions every 30. Failed sources retry on the next cron. Manual source selections bypass cadence.

NWS resolves catalog coordinates through `/points`, caching the grid/office mapping for 24 hours and invalidating it when coordinates change. Point failures retain that point with its own error and check time. Discussions deduplicate the nine verified issuing offices. Plumes isolate failures per station. A retained point, discussion or chart carries its own `lastError`; the source's update time comes from entries fetched that run, and a run in which every point, office or station fails is a failed collection, so the source goes stale on schedule. Regional rendering and regional digests recalculate source age from the region's own points, stations and offices.

The source snapshot (every source record, the 14-day snow log, per-forecast-area storm memory and resort operating times) has one writer: the `CollectorObject` Durable Object, a single instance (`src/worker/collector-object.ts`, logic in `src/lib/collector.ts`). Cron and admin collection both call it. It queues runs explicitly, because a Durable Object's input gate opens while it awaits upstream fetches. Each run reads the previous run's committed snapshot, so nothing is merged and overlapping runs cannot lose updates. A cron that arrives while another cron waits joins that run, and only the first caller publishes. The authoritative copy lives in the object's SQLite storage, one row per source and per other field (the whole snapshot was about 350 KB in November 2026; values may be up to 2 MB each). After every commit the object rewrites `snapshot:v1` in KV, the read copy behind `/api/report`. A failed KV write is logged and repaired by the next run. Editing `snapshot:v1` by hand does not change the collector, which never reads KV again after it first starts from an empty store.

Daily Snow publication runs after the collector returns, in the calling cron or admin invocation, so a model call of several minutes never delays the next collection. Publication attempts are recorded in separate per-channel state keys. Node tooling (`collect:once`, PR preview preparation) runs the same collection against KV directly, one run at a time.

Snow days end at **6 AM destination local time**, including 23/25-hour DST days. A morning capture accepts a resort's published 24-hour window only when its timestamp is recent enough for that morning. Rolling windows are never added. Each forecast area retains the NWS forecast a day began with. History starts with collection; there is no imported or fabricated backfill.

## Publications and artifacts

Nine independent states use `daily-state:v2:<channel>`. Archives and stills live under `channel:v1:<channel>:`, with the existing date/revision keys below that prefix. Cropped live plume panels remain shared keys `plume-panel:v1:<station>:<run>:<panel>`.

Each channel's state records its attempt before the model call: start time, attempts and model requests per local date. The cron skips a channel whose attempt is in flight (twelve minutes), allows three attempts and two requests per attempt per local date, and starts at most four regional channels, counting attempts still running from an earlier cron. Manual forced runs pass the same checks. Before publishing, a run re-reads its state and stops if a newer attempt has started, so an attempt that outlived its window cannot overwrite a newer one. KV has no compare-and-swap; the five-minute cron spacing, the in-flight window and the AI Gateway's 64-request sliding-day limit bound what a race could cost. Inference remains in the collection job. The cron runs up to four regional attempts together. A due Western edition gets a separate cron once today's regional editions exist, keeping even two model timeouts inside the cron deadline. Subsequent crons pick up remaining regions. A forced run never takes the separate Western cron: it runs the requested regions first, then Western, so the overview sees their editions. Channel states are written separately from source snapshots.

`GET /api/daily-snow?channel=<id>&date=YYYY-MM-DD` serves a retained edition. Figure URLs include the channel and a SHA-256 revision. Same-day rewrites preserve earlier referenced stills. Articles, stills and storm archives have 30-day retention; neighboring-edition links retain their original expiry.

## Images and runtime

The collector crops accumulated snow and SLR panels from source PNGs without reading their values. Live panels expire after four days, refresh after three, and retry failed crops hourly up to three times. Expired/unavailable panels fall back to original UTC charts. Daily Snow copies available panels into immutable edition stills and draws a frozen local-time axis and posting marker.

The branded share image is static. Daily Snow share images read the selected channel, never generate prose, and use short caches. Workerd image rendering uses `@cf-wasm/og`, the precompiled HarfBuzz adapter and the pinned dependency overrides.

Source HTTP requests have 15-second deadlines and an 8 MB decoded-body budget; copied article stills are capped at 3 MB. Tokens in public widget configs are redacted from diagnostics and never become public report fields.
