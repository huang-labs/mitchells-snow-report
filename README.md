# Mitchell's Snow Report

A snow and conditions dashboard for 14 favorite Western United States resorts, built for phones and desktop browsers.

**[Open the dashboard](https://mitchells-snow-report.huang.mx)**

- Compare resort snowfall day by day (past week, last 24 h, NWS week ahead), lift and terrain status, and webcams.
- Select eight regions for NWS mountain weather and University of Utah plumes.
- Read eight regional **Daily Snow** forecasts and a standalone **United States West** article covering this week (NWS mountain snowfall for days 1–3 and 4–7) and week two (the NOAA 8–14-day pattern map), labeled as AI with model attribution.

Next.js builds the static frontend. A Cloudflare Worker serves the APIs and collects upstream data on a five-minute cron, storing the latest successful results in KV. Pages read that stored data; AI generation runs during collection. Webcam collection retries failed YouTube metadata lookups and uses official Snowbasin and Jackson Hole camera feeds; blocked or unsupported pages retain their official webcam links. See [source notes](docs/IMPLEMENTATION_NOTES.md#adapters) for coverage and retry behavior.

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

The token comes from `.dev.vars`; keep that file local. Local cron does not run automatically, so repeat collection when you need fresh data. KV persists in `.wrangler/state`. The example sets `AI_ENABLED=false`: Workers AI remains remote even in local workerd, so enable it only for deliberate paid testing.

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

The fixed favorites are Alta, Snowbird, Solitude, Brighton, Snowbasin, Palisades Tahoe, Mammoth Mountain, Jackson Hole, Big Sky, Winter Park, Steamboat, Telluride, Crystal Mountain and Mt. Bachelor. Routes are `/`, `/<resort-id>`, `/daily-snow`, `/weather`, `/plumes`, and the eight regional children of those three forecast pages. The Daily Snows navigation tab opens United States West by default; Weather and Plumes remember the last region. Region dropdowns sit at the top of forecast pages; select a region there to read its Daily Snow. Resort details are reached from the homepage, without a second navigation row. History fills from deployment, with no imported backfill.

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

Every PR gets its own preview KV, seeded once from production reads and refreshed from real sources on deployment. Previews run no cron and do not automatically regenerate AI articles. The PR's Preview comment reports source freshness and which commit generated each article.

```sh
npm run preview:refresh -- --pr 10
npm run preview:dailysnow -- --pr 10 --channel western-us
npm run preview:dailysnow -- --pr 10 --all
```

These dispatch the preview-data Action using your GitHub CLI login; no local Cloudflare credentials are required. `--all` generates regions before Western. Generation is paid, capped, and uses a separate preview AI Gateway. PR closure deletes its preview and dedicated KV. See [preview operations](docs/DEPLOYMENT.md#refresh-or-regenerate-a-hosted-pr-preview) for prerequisites, readiness, and cleanup.

## AI code review

PRs get an advisory PR-Agent review from GLM 5.3 on Workers AI through the `pr-agent` AI Gateway. See [AI code review](docs/AI_CODE_REVIEW.md) for setup and how to rerun a review.
