# Architecture

[← README](../README.md)

Next.js exports 44 fixed web app pages into `out/`. Cloudflare Static Assets serves HTML, navigation payloads, scripts and styles. A plain Worker (`worker.ts`) handles APIs, share images and the five-minute collection cron, which runs collection in the `CollectorObject` Durable Object. There is no request-time Next.js server.

```text
Browser → static pages → /api/report → source snapshot + nine publication states
Cron → CollectorObject → due sources → source snapshot / local snow log / per-area storm memory
     → ChannelObject ×9 → reserve attempt → alarm → Workers AI → channel archive + state
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

After the collector returns, the calling cron or admin request asks each channel's `ChannelObject` whether to publish, then returns; model calls run in those objects' alarms and never hold up collection. Node tooling (`collect:once`, `dailysnow:once`, tests) runs the same collection against KV directly and publishes in-process (`runChannels`), one run at a time.

Snow days end at **6 AM destination local time**, including 23/25-hour DST days. A morning capture accepts a resort's published 24-hour window only when its timestamp is recent enough for that morning. Rolling windows are never added. Each forecast area retains the NWS forecast a day began with. History starts with collection; there is no imported or fabricated backfill.

## Publications and artifacts

Nine independent states use `daily-state:v2:<channel>`. Archives and stills live under `channel:v1:<channel>:`, with the existing date/revision keys below that prefix. Cropped live plume panels remain shared keys `plume-panel:v1:<station>:<run>:<panel>`.

Each channel has one writer: a `ChannelObject` Durable Object addressed by the channel id (`src/worker/channel-object.ts`, logic in `src/lib/dailysnow/publisher.ts`). It owns the channel's state, archive and figure stills, keeps the authoritative state in SQLite storage, and rewrites `daily-state:v2:<channel>` in KV (the read copy behind `/api/report`, `/api/daily-snow` and share images) after every change. On first start it imports that KV state. After every collection, the cron asks all nine objects to decide. A publication then has two steps:

1. **Request.** The object checks the schedule (in-flight window, three attempts and six model requests per local date, the regional activity gate; Western also needs at least one of today's regional editions) and reserves the attempt in storage. There is no network I/O between its decision and its reservation, so two requests (a cron and a forced run) cannot both reserve. The reservation is visible to readers at once.
2. **Alarm.** The object's alarm reads the latest committed snapshot from `CollectorObject` (Western also reads today's regional editions from the regional objects), calls the model and publishes. Each alarm has its own time budget, so channels never wait for each other or for a cron deadline; there is no concurrency cap or separate Western cron. The attempt is marked started before the model call: an alarm retried after an eviction records the attempt as interrupted instead of calling the model again. When the inputs no longer have anything to post, the reservation is refunded.

Forced runs (`POST /api/admin/collect?dailysnow=force&channel=<id>`) pass the same checks and return as soon as the attempt is reserved; `GET /api/admin/channel?channel=<id>` reports the object's state and whether the attempt is still pending. The AI Gateway's 64-request sliding-day limit remains the hard ceiling. Channel states are stored separately from source snapshots.

`GET /api/daily-snow?channel=<id>&date=YYYY-MM-DD` serves a retained edition. Figure URLs include the channel and a SHA-256 revision. Same-day rewrites preserve earlier referenced stills. Articles, stills and storm archives have 30-day retention; neighboring-edition links retain their original expiry.

## Images and runtime

The collector crops accumulated snow and SLR panels from source PNGs without reading their values. Live panels expire after four days, refresh after three, and retry failed crops hourly up to three times. Expired/unavailable panels fall back to original UTC charts. Daily Snow copies available panels into immutable edition stills and draws a frozen local-time axis and posting marker.

The branded share image is static. Daily Snow share images read the selected channel, never generate prose, and use short caches. Workerd image rendering uses `@cf-wasm/og`, the precompiled HarfBuzz adapter and the pinned dependency overrides.

Source HTTP requests have 15-second deadlines and an 8 MB decoded-body budget; copied article stills are capped at 3 MB. Tokens in public widget configs are redacted from diagnostics and never become public report fields.
