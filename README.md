# Cottonwoods Snow Report

A snow and conditions dashboard for Alta, Snowbird, Solitude and Brighton, built for phones and desktop browsers.

**[Open the dashboard](https://cottonwoods-snow-report.huang.mx)**

- Compare resort snowfall day by day (past week, last 24 h, NWS week ahead), lift and terrain status, and webcams.
- Check NWS mountain weather, University of Utah ensemble plumes, and canyon roads with UDOT webcams.
- Read an AI resort pick and the morning **Daily Snow** forecast, labeled separately from source data.

Next.js builds the static frontend. A Cloudflare Worker serves the APIs and collects upstream data on a five-minute cron, storing the latest successful results in KV. Pages read that stored data; AI generation runs during collection.

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

The token comes from `.dev.vars`; keep that file local. Local cron does not run automatically, so repeat collection when you need fresh data. KV persists in `.wrangler/state`; remote bindings, including paid AI, are disabled in this local mode.

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
Complete the [repository setup](docs/REPOSITORY_SETUP.md) before feature implementation.
The application still reflects the inherited Cottonwoods version.

| Guide | What's inside |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Runtime, routes, collection, source cadences, storage and share images |
| [AI features](docs/AI_FEATURES.md) | Resort pick, Daily Snow, validation, scheduling and archive retention |
| [Freshness and data semantics](docs/FRESHNESS.md) | Badges, publication status, measurement windows and missing values |
| [Design](docs/DESIGN.md) | Layout, typography, charts, themes and phone behavior |
| [Deployment and operations](docs/DEPLOYMENT.md) | Production setup, PR previews, secrets, manual collection and usage |
| [Product brief](docs/IMPLEMENTATION_BRIEF.md) | Product requirements and original implementation scope |
| [Implementation notes](docs/IMPLEMENTATION_NOTES.md) | Source findings, design decisions and known limitations |

## AI code review

PRs use an advisory reviewer from another model family. Apply exactly one author label: `author:codex`, `author:claude`, or `author:glm`. See [AI code review](docs/AI_CODE_REVIEW.md) for setup, model routing and the `/review` command.
