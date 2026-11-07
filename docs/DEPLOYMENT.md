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

## GitHub Actions

CI typechecks, tests, builds and smoke-checks. Deployment requires `MITCHELLS_DEPLOYMENT_ENABLED=true`. The inherited `DEPLOYMENT_ENABLED` stays false so an older main workflow cannot deploy Cottonwoods while this feature PR is open.

On main, `npm run deploy` uploads assets and deploys the Worker, custom domain and cron. Cloudflare manages DNS/certificate for the custom domain. No production seeding or historical import is required.

Same-repository PRs deploy through **Worker Previews**. The `preview` job checks out the exact PR head, prepares dedicated data, and updates the stable `pr-<number>` alias. Fork and Dependabot PRs receive no deployment secrets. Preview jobs for one PR share a concurrency group, so a push, a data dispatch and cleanup never overlap, and each run checks that the PR is still open at the same head before it stores data or deploys.

Every PR receives a KV namespace named `mitchells-snow-report-pr-<number>`, preserved across pushes. A run prepares it in four steps:

1. **Load.** If the namespace has no seed marker, the run reads an allowlisted production baseline into memory: the source snapshot (including snow history), channel editions/history, retained article stills and live plume panels. Binary values and absolute expirations are preserved; production generation reservations, failures and request counters are not copied, and production is only read. Every other read falls through to the PR namespace over the KV REST API.
2. **Collect.** The branch's own `runCollection` runs in Node against that in-memory KV and refreshes **all branch-defined sources**, regardless of cadence, with AI disabled. A failed source keeps last-good data and is called out in the PR comment; partial failures do not fail deployment unless required data is missing. Successful fetches do not change upstream report publication times. Explicit Daily Snow generation then forces each requested channel through the same code (see below).
3. **Store.** Values the run changed are written over REST, then the status record, then, on a first run, the seed marker. Without the marker, the next run seeds again from production instead of trusting a partly written namespace. The marker also keeps later pushes from overwriting PR-generated content or resetting preview attempt caps. Cloudflare can acknowledge namespace creation before its KV write path recognizes the new ID, so writes retry only HTTP 404 / code 10013 with “namespace not found”, at 1/2/4/8/16-second intervals, then fail with the original API error.
4. **Deploy.** `wrangler preview` uploads the built site and Worker as `pr-<number>`, bound to the PR namespace, with AI disabled, no admin token, no routes and no cron.

No step reads KV through the Worker's binding before writing, so the copied baseline can't be overwritten by a refresh that ran before an edge location saw it. (Cloudflare can take up to about 60 s to make a REST write visible at the edge; on the public preview that only delays what a reader sees.) No preview cron runs and no AI generation happens automatically.

The Preview comment is built from the stored state: deployed commit, collection time and commit, source failures and freshness, plus each Daily Snow's edition date, posted time, model and generation commit. Copied editions are labeled production baseline, so old or absent articles cannot pass as output from a changed prompt. A failed run replaces the comment with the error and points to the Action log.

### Refresh or regenerate a hosted PR preview

After the workflow PR is merged to `main`, with GitHub CLI authenticated and permission to dispatch Actions:

```sh
npm run preview:refresh -- --pr 10
npm run preview:dailysnow -- --pr 10 --channel western-us
npm run preview:dailysnow -- --pr 10 --all
```

These commands dispatch **Refresh PR preview data** (`preview-data.yml`) on `main`; they do not require local Cloudflare secrets or a running dev server. The same workflow can be run from GitHub Actions with a PR number and `none`, a channel, or `all`. It checks out the PR's current head and runs that branch's own preview tooling and collection code, as the `preview` job does. The PR's Preview comment is the readiness result; the command prints the workflow-run listing URL.

`preview:refresh` fetches sources without AI. `preview:dailysnow` first refreshes sources, then forces the requested channel through the normal collection/publication code. `--all` processes the eight regions sequentially before Western. Western alone needs today's regional editions; use `--all` if its context is missing. These are paid calls to the Workers AI REST API (`/ai/run/<model>` with a `cf-aig-gateway-id` header), routed through the separate preview AI Gateway. The existing per-channel attempt caps, in-flight checks and single fallback still apply and survive pushes; caps/skips are reported rather than bypassed. A generation is attributed to a commit only when the run published it. Refreshing data without a push keeps the PR URL stable.

Closing or merging a PR runs **Delete closed PR preview**, using trusted `main` code. It rechecks that the PR is closed, removes the PR's Preview and its deployments, and then deletes only that PR's named KV namespace. Reopening creates a fresh namespace/baseline on deployment. The legacy shared namespace is not deleted or mutated by these tools. The generic `upload` npm command retains its legacy manual-deployment behavior; use the PR-numbered commands to prepare or refresh PR data. The checked-in static preview bindings remain for older workflows; the new workflow generates explicit per-PR bindings and never inherits production routes, crons or KV.

See [Cloudflare's preview resource isolation documentation](https://developers.cloudflare.com/workers/previews/resources/): different Preview deployments share KV when bound to the same namespace ID. Separate namespace IDs provide data isolation.

Encrypted Actions secrets are `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `PR_AGENT_CLOUDFLARE_TOKEN` (Workers AI Read and AI Gateway Run only, for PR review and preview generation). Preview preparation uses `CLOUDFLARE_API_TOKEN`, which requires account Workers edit, KV namespace create/list/read/write/delete, production KV read, and AI Gateway read/create (the tooling creates the separate preview Gateway once if absent). Explicit generation sends model calls with the narrower `PR_AGENT_CLOUDFLARE_TOKEN`, passed to the tool as `WORKERS_AI_TOKEN` only when a channel is requested. Keep the dedicated deployment token in Actions and out of logs. Preview commands use `gh` authentication; they do not ask contributors to copy Cloudflare tokens locally.

The separate Gateway limits preview generation to 1,000 requests per sliding day across all PRs, with caching disabled and logging enabled. Source-only refresh does not provision or call it. Do not reset a PR's channel attempts or increase production limits to work around preview caps.

## Manual collection or publication

The admin endpoint returns 404 unless a temporary `ADMIN_TOKEN` is configured and requires its bearer token. Use the production procedure only for an owner-requested operation.

1. For an owner-requested production operation, set a random temporary secret using `wrangler secret put ADMIN_TOKEN`. Supply it privately via stdin. For PR previews, use the workflow commands above instead.
2. POST `/api/admin/collect`. Optional repeated `source=<id>` selects sources. Forced publication requires `?dailysnow=force&channel=<id>`; force one channel at a time, regions before Western.
3. Inspect the summary and `/api/report`: source results, article model/date/error, frozen figures and coverage.
4. Delete the production secret, remove the local temporary file, then verify the same admin POST returns 404.

Model calls are paid and can take up to ten minutes including fallback. Manual publication counts toward the channel and global caps. No request parameter bypasses them. `AI_ENABLED=false` suppresses generation for local collection.

Production reads are safe for investigation. Ask before production KV writes not requested by the owner. Tail with `npx wrangler tail mitchells-snow-report`; collection logs include source and channel outcomes.
