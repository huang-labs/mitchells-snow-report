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
| Preview AI Gateway | `mitchells-snow-report-preview`, separate sliding 64 requests/day |
| Workers AI Gateway | `mitchells-snow-report`, logging, no cache, sliding 64 requests/day |
| PR review AI Gateway | `pr-agent`, logging, sliding 100 requests/day; see [AI code review](AI_CODE_REVIEW.md) |
| Production cron | `*/5 * * * *`; local publication hours evaluated in code |

## GitHub Actions

CI typechecks, tests, builds and smoke-checks. Deployment requires `MITCHELLS_DEPLOYMENT_ENABLED=true`. The inherited `DEPLOYMENT_ENABLED` stays false so an older main workflow cannot deploy Cottonwoods while this feature PR is open.

On main, `npm run deploy` uploads assets and deploys the Worker, custom domain and cron. Cloudflare manages DNS/certificate for the custom domain. No production seeding or historical import is required.

Same-repository PRs deploy through **Worker Previews**. The `preview` job checks out the exact PR head, prepares dedicated data, and updates the stable `pr-<number>` alias. Fork and Dependabot PRs receive no deployment secrets. Preview mutation jobs share a per-PR concurrency group, finish cleanup before another operation, and check that the PR is still open at the same head before deployment.

Every PR receives a KV namespace named `mitchells-snow-report-pr-<number>`, preserved across pushes. Its first preparation copies an allowlisted production baseline: the source snapshot (including snow history), channel editions/history, retained article stills and live plume panels. Binary values and absolute expirations are preserved. Production is read only; production generation reservations, failures and request counters are not copied. A completed seed marker prevents later pushes from overwriting PR-generated content or resetting preview attempt caps. Interrupted initialization resumes missing values. Unavailable or expired production data remains unavailable; no history or article is fabricated.

Each deployment then refreshes **all branch-defined sources through the real collection path**, regardless of their cadence, with AI disabled. Successful fetches do not change upstream report publication times. A failed source keeps last-good data and is called out in the PR comment; partial source failures do not fail deployment unless required data is missing. No preview cron runs and no AI generation happens automatically.

The Preview comment shows requested/deployed commits, collection time and commit, source failures and freshness, plus each Daily Snow's edition date, posted time, model and generation commit. Copied editions are explicitly labeled production baseline. Old or absent articles therefore cannot silently pass as output from a changed prompt. A refresh/inference failure is also reported there and in the Action logs.

### Refresh or regenerate a hosted PR preview

After the workflow PR is merged to `main`, with GitHub CLI authenticated and permission to dispatch Actions:

```sh
npm run preview:refresh -- --pr 10
npm run preview:dailysnow -- --pr 10 --channel western-us
npm run preview:dailysnow -- --pr 10 --all
```

These commands dispatch **Refresh PR preview data** (`preview-data.yml`) on `main`; they do not require local Cloudflare secrets or a running dev server. The same workflow can be run from GitHub Actions with a PR number and `none`, a channel, or `all`. It uses trusted workflow tooling from `main` to build/deploy the PR's actual current code, including older open PRs that lack these scripts. The PR's Preview comment is the readiness result; the command prints the workflow-run listing URL.

`preview:refresh` fetches sources without AI. `preview:dailysnow` first refreshes sources, then forces the requested channel through the normal collection/publication code. `--all` processes the eight regions sequentially before Western. Western alone needs today's regional editions; use `--all` if its context is missing. These are paid calls using the separate preview AI Gateway. The existing per-channel attempt caps, in-flight checks and single fallback still apply and survive pushes; caps/skips are reported rather than bypassed. A successful generation is attributed to a commit only after the new stored edition is visible. Refreshing data without a push keeps the PR URL stable.

Public PR previews have AI disabled and no admin token. Writes target immutable deployment URLs, with a read-only readiness probe before any POST so route propagation cannot send a request to a superseded runner. The tooling uses disposable `seed-pr-<number>` runners with generated, short-lived admin secrets supplied through a private secrets file, and deletes the **entire runner and all immutable deployments** in `finally`. An `always()` Action step also removes abandoned runners after failures/cancellation. Both stable runner aliases and immutable deployment URLs are checked for revocation after control-plane deletion is confirmed. Cloudflare may return its branded 1101 error page for a deleted Preview instead of HTTP 404; arbitrary server errors are not treated as proof of revocation. Never retain an admin token on a public PR preview. A manually force-killed local tool may need `scripts/preview-run.ts cleanup-runner --pr <number>` with authenticated Cloudflare environment variables; normal commands run in Actions so cleanup is automatic.

Closing or merging a PR runs **Delete closed PR preview**, using trusted `main` code. It rechecks that the PR is closed, removes both public/runner Previews and all their deployments, and then deletes only that PR's named KV namespace. Reopening creates a fresh namespace/baseline on deployment. The legacy shared namespace is not deleted or mutated by these tools. The old generic `upload` npm command is removed; use the PR-numbered commands instead. The checked-in static preview bindings remain for older workflows; the new workflow generates explicit per-PR bindings and never inherits production routes, crons or KV.

See [Cloudflare's preview resource isolation documentation](https://developers.cloudflare.com/workers/previews/resources/): different Preview deployments share KV when bound to the same namespace ID. Separate namespace IDs provide data isolation.

Encrypted Actions secrets are `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `PR_AGENT_CLOUDFLARE_TOKEN` (Workers AI Read and AI Gateway Run only, for PR review). Preview preparation requires account Workers edit, KV namespace create/list/read/write/delete, and production KV read. Explicit generation also requires Workers AI and AI Gateway read/create permissions; the tooling creates the separate preview Gateway once if absent. Keep the dedicated deployment token in Actions and out of logs. Preview commands use `gh` authentication; they do not ask contributors to copy Cloudflare tokens locally.

The separate Gateway limits preview generation to 64 requests per sliding day across all PRs, with caching disabled and logging enabled. Source-only refresh does not provision or call it. Do not reset a PR's channel attempts or increase production limits to work around preview caps.

## Manual collection or publication

The admin endpoint returns 404 unless a temporary `ADMIN_TOKEN` is configured and requires its bearer token. Use the production procedure only for an owner-requested operation.

1. For an owner-requested production operation, set a random temporary secret using `wrangler secret put ADMIN_TOKEN`. Supply it privately via stdin. For PR previews, use the workflow commands above instead.
2. POST `/api/admin/collect`. Optional repeated `source=<id>` selects sources. Forced publication requires `?dailysnow=force&channel=<id>`; force one channel at a time, regions before Western.
3. Inspect the summary and `/api/report`: source results, article model/date/error, frozen figures and coverage.
4. Delete the production secret, remove the local temporary file, then verify the same admin POST returns 404.

Model calls are paid and can take up to ten minutes including fallback. Manual publication counts toward the channel and global caps. No request parameter bypasses them. `AI_ENABLED=false` suppresses generation for local collection.

Production reads are safe for investigation. Ask before production KV writes not requested by the owner. Tail with `npx wrangler tail mitchells-snow-report`; collection logs include source and channel outcomes.
