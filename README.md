# Mitchell's Snow Report

A snow and conditions web app for 16 favorite Western United States resorts, built for phones and desktop browsers.

**[Open the web app](https://mitchells-snow-report.huang.mx)**

- Compare resort snowfall day by day (past week, last 24 h, NWS week ahead), lift and terrain status, and webcams.
- Select eight regions for NWS mountain weather and University of Utah plumes.
- Read eight regional **Daily Snow** forecasts and a standalone **United States West** article covering this week (NWS mountain snowfall for days 1–3 and 4–7) and week two (the NOAA 8–14-day pattern map), labeled as AI with model attribution.

Next.js builds the static frontend. A Cloudflare Worker serves the APIs and collects upstream data on a five-minute cron through a single Durable Object, which keeps the latest successful results and copies them to KV for reads. Pages read that stored data; AI generation runs during collection. Shared snowfall consistency checks keep contradictory source amounts out of new AI and derived snow data while preserving the published figures with a warning on resort pages; see [data semantics](docs/FRESHNESS.md). Regional Daily Snow attempts start at 7 AM local time with an 11 AM cutoff; United States West starts at 8 AM Pacific with a noon cutoff. Webcam collection retries failed YouTube metadata lookups and uses official Snowbasin and Jackson Hole camera feeds; blocked or unsupported pages retain their official webcam links. See [source notes](docs/IMPLEMENTATION_NOTES.md#adapters) for coverage and retry behavior.

## Quick start

Requires Node 20+ (tested with Node 24.12).

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev -- --port 8787
```

Open [http://localhost:8787](http://localhost:8787). In another terminal, seed the local report from the real sources:

```sh
curl -X POST \
  -H "Authorization: Bearer change-me-local-only" \
  http://localhost:8787/api/admin/collect
```

The token comes from `.dev.vars`; keep that file local. Local cron does not run automatically, so repeat collection when you need fresh data. KV and the collector's Durable Object storage persist in `.wrangler/state`; delete that directory together for a clean start, since the collector only reads KV when its own storage is empty. The example sets `AI_ENABLED=false`: Workers AI remains remote even in local workerd, so enable it only for deliberate paid testing.

Worker edits reload automatically. For frontend edits, run `npm run build` in another terminal and refresh, or restart the dev command. Use a different free port for each worktree and use the same port in the collection URL.

## Common checks

```sh
npm test
npm run typecheck
npm run build
npm run smoke    # checks the built site and Worker locally
```

See [Local development](docs/DEVELOPMENT.md) for the full command reference, scheduled collection, AI access and troubleshooting.

## Documentation

The fork's approved scope is in the [Mitchell's expansion plan](docs/EXPANSION_PLAN.md).
The [repository setup](docs/REPOSITORY_SETUP.md) records isolated Cloudflare resources and CI readiness.

The fixed favorites are Alta, Snowbird, Solitude, Brighton, Park City, Deer Valley, Snowbasin, Palisades Tahoe, Mammoth Mountain, Jackson Hole, Big Sky, Winter Park, Steamboat, Telluride, Crystal Mountain and Mt. Bachelor. Routes are `/`, `/<resort-id>`, `/daily-snow`, `/weather`, `/plumes`, and the eight regional children of those three forecast pages. On a fresh visit, Daily Snow defaults to United States West and Weather and Plumes default to Utah. Selecting a region carries it across all three forecast tabs during the current visit, including detours through Resorts. Tabs link directly to the selected region without a delayed redirect. Selecting United States West in Daily Snow resets Weather and Plumes to Utah; viewing this fallback keeps Daily Snow on United States West when returning. Explicitly selecting a region in either dropdown switches all forecast tabs to that region. Explicit regional URLs remain authoritative; bare `/weather` and `/plumes` URLs always show Utah. Region dropdowns sit at the top of forecast pages; select a region there to read its Daily Snow. Resort details are reached from the homepage, without a second navigation row. History fills from deployment, with no imported backfill.

| Guide | What's inside |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Runtime, routes, collection, source cadences, storage and share images |
| [AI features](docs/AI_FEATURES.md) | Regional and Western Daily Snow, validation, scheduling and archive retention |
| [Freshness and data semantics](docs/FRESHNESS.md) | Badges, publication status, measurement windows and missing values |
| [Design](docs/DESIGN.md) | Layout, typography, charts, themes and phone behavior |
| [Deployment and operations](docs/DEPLOYMENT.md) | Production setup, PR previews, secrets, manual collection and usage |
| [Product brief](docs/IMPLEMENTATION_BRIEF.md) | Product requirements and original implementation scope |
| [Implementation notes](docs/IMPLEMENTATION_NOTES.md) | Source findings, design decisions and known limitations |

## PR previews

Every PR gets its own preview KV, seeded once from production reads and refreshed from real sources on deployment. Previews run no cron and do not automatically regenerate AI articles. The Action runs the branch's collection code in Node, writes the result to the PR's KV once, then deploys. The PR's Preview comment reports source freshness and which commit generated each article; see [preview operations](docs/DEPLOYMENT.md#refresh-or-regenerate-a-hosted-pr-preview).

```sh
npm run preview:refresh -- --pr 10
npm run preview:dailysnow -- --pr 10 --channel western-us
npm run preview:dailysnow -- --pr 10 --all
```

These dispatch the preview-data Action using your GitHub CLI login; no local Cloudflare credentials are required. `--all` generates regions before Western. Generation is paid, capped, and uses a separate preview AI Gateway. PR closure deletes its preview and dedicated KV. See [preview operations](docs/DEPLOYMENT.md#refresh-or-regenerate-a-hosted-pr-preview) for prerequisites, readiness, and cleanup.

## AI code review

PRs get a required PR-Agent review from GLM 5.3 on Workers AI through the `pr-agent` AI Gateway. Findings block the `review` check; `ai-review-override` explicitly bypasses it until the next push. Implementing agents monitor and address reviews automatically. See [AI code review](docs/AI_CODE_REVIEW.md) for the review loop, override and setup.
