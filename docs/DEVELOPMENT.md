# Local development

[← README](../README.md)

Requires Node 20+; Node 24 is used in CI.

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run dev -- --port 8793
curl -X POST -H "Authorization: Bearer change-me-local-only" http://localhost:8793/api/admin/collect
```

Use a free port per worktree. KV persists in `.wrangler/state`; worktrees do not share local state. Worker changes reload; frontend changes require `npm run build` and refresh. `npm start -- --port <port>` serves an existing export.

**Workers AI remains remote even with local workerd.** The example sets `AI_ENABLED=false` so local collection makes no inference requests. Set it to true only for deliberate paid AI testing with authenticated remote bindings. Local scheduled events do not run automatically.

| Command | Behavior |
| --- | --- |
| `npm test` | Source, calendar, publication, API and UI regression tests |
| `npm run typecheck` | Generate Next route types and typecheck |
| `npm run collect:once` | Real source collection in memory; `-- --json` prints the report; no AI binding |
| `npm run build` | Static export |
| `npm run cf:build` | Static export and Wrangler bundle dry run |
| `npm run smoke` | Credential-free workerd routing, assets, APIs, images and metadata checks |
| `npm run preview:refresh -- --pr <number>` | Dispatch hosted PR source refresh without AI |
| `npm run preview:dailysnow -- --pr <number> --channel <id>` | Refresh sources and regenerate a hosted PR edition; `--all` runs regions before Western |
| `npm run share:render` | Regenerate the checked-in branded PNG |
| `npm run preview:scheduled` | Local build/runtime with scheduled-event testing |

## Model evaluation

`dailysnow:once` is read-only: it prints a real model request or digest, without inference or storage writes. It defaults to Mitchell's production report and Western; specify a local/preview report for unreleased features. Regional digests are rebuilt from the report's sources, per-area storm memory (`areaStorms`) and operating history (`resortLastOperatingAt`), the same inputs the collection cron passes to publication.

```sh
npm run -s dailysnow:once -- --url http://localhost:8793/api/report --channel utah --digest
npm run -s dailysnow:once -- --channel tahoe --save-digest /tmp/tahoe-digest.json > /tmp/tahoe-body.json
npm run -s dailysnow:once -- --channel tahoe --validate /tmp/tahoe-response.json
```

Options: `--url`, `--channel`, `--now`, `--model`, `--digest`, `--save-digest`, `--validate`. Utah optionally supports `--live-ensemble`. Keep saved third-party source text and raw model output out of commits.

For paid development replay, `dailysnow:replay -- <regional-digest.json> --model <id> --out <dir>` uses the Workers AI REST endpoint with the production five-minute timeout. It needs account/token environment variables and does not publish. The `cf ai run` client times out after 30 seconds, so it is unsuitable for longer articles. Inspect both schemas and semantic attribution. Publishing through the admin endpoint is separately coordinated/capped; see [operations](DEPLOYMENT.md).

Legacy `?slide=<id>` links still redirect to their page. Current regional links use explicit paths and article dates use `?date=`. A missing local report usually needs seeding; an empty Daily Snow additionally needs deliberate generation. Do not solve an empty local page by writing production KV.
