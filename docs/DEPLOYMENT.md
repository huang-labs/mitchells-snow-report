# Deployment and operations

[← README](../README.md)

Mitchell's deployment uses Cloudflare account **Huang Inc.**. Production starts on merge and accumulates its own history; preview seeding does not write production KV.

| Resource | Configuration |
| --- | --- |
| Production Worker/domain | `mitchells-snow-report` / `mitchells-snow-report.huang.mx` |
| Production KV | `5fb1857843374e8ea427c2117b5f3955` |
| Preview parent Worker | `mitchells-snow-report-preview`, no production routes or cron |
| PR preview KV | One namespace per PR: `mitchells-snow-report-pr-<number>` |
| Legacy shared preview KV | `f9e542e8a1d0405f8624beade1bba09b`; retained for older PR deployments |
| Preview AI Gateway | `mitchells-snow-report-preview`, separate sliding 1,000 requests/day |
| Workers AI Gateway | `mitchells-snow-report`, logging, no cache, sliding 64 requests/day |
| PR review AI Gateway | `pr-agent`, logging, sliding 100 requests/day; see [AI code review](AI_CODE_REVIEW.md) |
| Production cron | `*/5 * * * *`; local publication hours evaluated in code |
| Collector Durable Object | `CollectorObject` (SQLite storage, migration `v1`), one instance; authoritative source snapshot |
| Channel Durable Objects | `ChannelObject` (SQLite storage, migration `v2`), one per channel id; authoritative Daily Snow state, generation in alarms |

## GitHub Actions

CI typechecks, tests, builds and smoke-checks. Deployment requires `MITCHELLS_DEPLOYMENT_ENABLED=true`. The inherited `DEPLOYMENT_ENABLED` stays false so an older main workflow cannot deploy Cottonwoods while this feature PR is open.

On main, `npm run deploy` uploads assets and deploys the Worker, custom domain, cron and Durable Object migrations. On first start each object imports the KV value its predecessor wrote (`snapshot:v1`, `daily-state:v2:<channel>`), so a switch keeps history. Work still running in the old Worker version as it deploys may be lost: one collection (the next cron repeats it) or, during a 7 AM–noon publication window, one channel's in-progress edition (the channel retries within its caps). Deploy changes to these objects outside those morning hours. Cloudflare manages DNS/certificate for the custom domain. No production seeding or historical import is required.

Same-repository PRs deploy through **Worker Previews**. The `preview` job checks out the exact PR head, prepares dedicated data, and updates the stable `pr-<number>` alias. Fork and Dependabot PRs receive no deployment secrets. Preview jobs for one PR share a concurrency group, so a push, a data dispatch and cleanup never overlap, and each run checks that the PR is still open at the same head before it stores data or deploys.

Every PR receives a KV namespace named `mitchells-snow-report-pr-<number>`, preserved across pushes, and its Preview gets its own `CollectorObject` and `ChannelObject` namespace, which Cloudflare keeps across the Preview's deployments and deletes with it. The objects are the only writers of the PR's snapshot and channel states, as in production. A run has five steps:

1. **Load.** If the namespace has no seed marker, the run reads an allowlisted production baseline: the source snapshot (including snow history), channel editions/history, retained article stills and live plume panels. Binary values and absolute expirations are preserved; production generation reservations, failures and request counters are not copied, and production is only read. The baseline is written to the PR namespace over REST. Cloudflare can acknowledge namespace creation before its KV write path recognizes the new ID, so writes retry only HTTP 404 / code 10013 with “namespace not found”, at 1/2/4/8/16-second intervals, then fail with the original API error.
2. **Deploy.** `wrangler preview` uploads the built site and Worker as `pr-<number>`, bound to the PR namespace and the Preview's own objects, with no routes and no cron. Workers AI is bound through the preview Gateway with automatic publication off (`DAILY_SNOW_AUTOMATIC=false`), so only an authenticated forced run generates. The run uploads the Preview's `ADMIN_TOKEN` as a secret file in the same command. The token is derived, not stored: an HMAC of the PR number keyed with `CLOUDFLARE_API_TOKEN`, so each run recomputes it, one PR's token opens no other Preview, and it never appears in config or logs.
3. **Seed.** `POST /api/admin/seed` sends the PR namespace's snapshot and channel states (the baseline, on a first run) in the request body. Only empty objects take it, so later pushes keep PR-generated content and attempt caps. Seeding through the body means no object initializes from an edge KV read that may not see a just-copied value yet.
4. **Refresh.** `POST /api/admin/collect` refreshes **all branch-defined sources**, regardless of cadence, through the Preview's collector. A failed source keeps last-good data and is called out in the PR comment; partial failures do not fail deployment unless required data is missing. Successful fetches do not change upstream report publication times. Explicit Daily Snow generation then forces each requested channel (see below).
5. **Report.** The comment is built from `GET /api/admin/report`, the objects' own state. The status record is written over REST, then, on a first run, the seed marker last. Without the marker, the next run copies the baseline again instead of trusting a partly written namespace.

No preview cron runs and no AI generation happens automatically.

The Preview comment shows the deployed commit, collection time and commit, source failures and freshness, plus each Daily Snow's edition date, posted time, model and generation commit. Copied editions are labeled production baseline, so old or absent articles cannot pass as output from a changed prompt. A failed run replaces the comment with the error and points to the Action log.

### Refresh or regenerate a hosted PR preview

After the workflow PR is merged to `main`, with GitHub CLI authenticated and permission to dispatch Actions:

```sh
npm run preview:refresh -- --pr 10
npm run preview:dailysnow -- --pr 10 --channel western-us
npm run preview:dailysnow -- --pr 10 --all
```

These commands dispatch **Refresh PR preview data** (`preview-data.yml`) on `main`; they do not require local Cloudflare secrets or a running dev server. The same workflow can be run from GitHub Actions with a PR number and `none`, a channel, or `all`. It checks out the PR's current head and runs that branch's own preview tooling and collection code, as the `preview` job does. The PR's Preview comment is the readiness result; the command prints the workflow-run listing URL.

`preview:refresh` fetches sources without AI. `preview:dailysnow` first refreshes sources, then forces each requested channel through the Preview's `ChannelObject`: the request returns once the attempt is reserved, and the run polls `GET /api/admin/channel` until the channel's alarm finishes (up to 16 minutes), so no connection stays open during a model call. `--all` processes the eight regions one after another, then Western. Western alone needs today's regional editions; use `--all` if its context is missing. These are paid Workers AI calls through the Preview's binding, routed through the separate preview AI Gateway. The existing per-channel attempt caps, in-flight checks and single fallback still apply and survive pushes; caps/skips are reported rather than bypassed. A generation is attributed to a commit only when the run published it. Refreshing data without a push keeps the PR URL stable.

Closing or merging a PR runs **Delete closed PR preview**, using trusted `main` code. It rechecks that the PR is closed, removes the PR's Preview and its deployments, and then deletes only that PR's named KV namespace. Reopening creates a fresh namespace/baseline on deployment. The legacy shared namespace is not deleted or mutated by these tools. The generic `upload` npm command retains its legacy manual-deployment behavior; use the PR-numbered commands to prepare or refresh PR data. The checked-in static preview bindings remain for older workflows; the new workflow generates explicit per-PR bindings and never inherits production routes, crons or KV.

See [Cloudflare's preview resource isolation documentation](https://developers.cloudflare.com/workers/previews/resources/): different Preview deployments share KV when bound to the same namespace ID. Separate namespace IDs provide data isolation.

Encrypted Actions secrets are `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `PR_AGENT_CLOUDFLARE_TOKEN` (Workers AI Read and AI Gateway Run only, for PR review only). Preview preparation and explicit generation use `CLOUDFLARE_API_TOKEN`, which requires account Workers edit, KV namespace create/list/read/write/delete, production KV read, and AI Gateway read/create (the tooling creates the separate preview Gateway once if absent). Model calls run inside the Preview through its AI binding, so the token no longer calls Workers AI itself. The token also keys each PR's derived admin token; rotating it rotates every Preview's token on their next run. Keep the dedicated deployment token in Actions and out of logs. Preview commands use `gh` authentication; they do not ask contributors to copy Cloudflare tokens locally.

The separate Gateway limits preview generation to 1,000 requests per sliding day across all PRs, with caching disabled and logging enabled. Source-only refresh does not provision or call it. Do not reset a PR's channel attempts or increase production limits to work around preview caps.

## Manual collection or publication

The admin endpoint returns 404 unless a temporary `ADMIN_TOKEN` is configured and requires its bearer token. Use the production procedure only for an owner-requested operation.

1. For an owner-requested production operation, set a random temporary secret using `wrangler secret put ADMIN_TOKEN`. Supply it privately via stdin. For PR previews, use the workflow commands above instead.
2. POST `/api/admin/collect`. Optional repeated `source=<id>` selects sources. Forced publication requires `?dailysnow=force&channel=<id>`; force one channel at a time, regions before Western. The response returns once the attempt is reserved (`publications: [{channel, scheduled}]`); the channel's alarm then runs the model.
3. Poll `GET /api/admin/channel?channel=<id>` until `pending` is false, then inspect the summary and `/api/report`: source results, article model/date/error, frozen figures and coverage. `GET /api/admin/report` builds the same report from the Durable Objects directly, without waiting for KV propagation.
4. Delete the production secret, remove the local temporary file, then verify the same admin POST returns 404.

Model calls are paid and can take up to ten minutes including fallback. Manual publication counts toward the channel and global caps. No request parameter bypasses them. `AI_ENABLED=false` suppresses generation for local collection.

Production reads are safe for investigation. Ask before production KV writes not requested by the owner. In production, `CollectorObject` owns the source snapshot and each `ChannelObject` its channel state: a hand-edited `snapshot:v1` or `daily-state:v2:<channel>` is overwritten by the next write, so repairs go through the admin endpoints. Tail with `npx wrangler tail mitchells-snow-report`; collection logs include source and channel outcomes.
