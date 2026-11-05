# Deployment and operations

[← README](../README.md)

Mitchell's deployment uses Cloudflare account **Huang Inc.**. Production starts on merge and accumulates its own history; preview seeding does not write production KV.

| Resource | Configuration |
| --- | --- |
| Production Worker/domain | `mitchells-snow-report` / `mitchells-snow-report.huang.mx` |
| Production KV | `5fb1857843374e8ea427c2117b5f3955` |
| Preview parent Worker | `mitchells-snow-report-preview`, no production routes or cron |
| Preview KV | `f9e542e8a1d0405f8624beade1bba09b` |
| Workers AI Gateway | `mitchells-snow-report`, logging, no cache, sliding 64 requests/day |
| PR review AI Gateway | `pr-agent`, logging, sliding 100 requests/day; see [AI code review](AI_CODE_REVIEW.md) |
| Production cron | `*/5 * * * *`; local publication hours evaluated in code |

## GitHub Actions

CI typechecks, tests, builds and smoke-checks. Deployment requires `MITCHELLS_DEPLOYMENT_ENABLED=true`. The inherited `DEPLOYMENT_ENABLED` stays false so an older main workflow cannot deploy Cottonwoods while this feature PR is open.

On main, `npm run deploy` uploads assets and deploys the Worker, custom domain and cron. Cloudflare manages DNS/certificate for the custom domain. No production seeding or historical import is required.

Same-repository PRs deploy through **Worker Previews**:
`wrangler preview --worker-name mitchells-snow-report-preview --name pr-<number> --ignore-base-config`.
The workflow reads its machine-output URL and comments it on the PR. Each PR gets an isolated preview and shares the seeded preview-only KV. Previews run no crons. Fork and Dependabot PRs receive no deployment secrets.

See [Cloudflare's preview isolation documentation](https://developers.cloudflare.com/workers/previews/resources/). Keep preview vars, bindings and the image renderer's defines in the `previews` block.

Encrypted Actions secrets are `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `PR_AGENT_CLOUDFLARE_TOKEN` (Workers AI Read and AI Gateway Run only, for PR review). The deployment token is scoped to this account's Workers/KV/AI/Gateway and the huang.mx zone's routes/read access. No token value belongs in files or logs. An authenticated `cf` session can create/configure resources; use a dedicated API token for CI, not a short-lived OAuth token.

## Manual collection or publication

The admin endpoint returns 404 unless a temporary `ADMIN_TOKEN` is configured and requires its bearer token. Use the production procedure only for an owner-requested operation.

1. Set a random temporary secret using `wrangler secret put ADMIN_TOKEN` for production, or `wrangler preview secret put ADMIN_TOKEN --worker-name mitchells-snow-report-preview --name seed-<date>` for a disposable seed Preview. Supply it privately via stdin.
2. POST `/api/admin/collect`. Optional repeated `source=<id>` selects sources. Forced publication requires `?dailysnow=force&channel=<id>`; force one channel at a time, regions before Western.
3. Inspect the summary and `/api/report`: source results, article model/date/error, frozen figures and coverage.
4. Delete the secret with the matching secret-delete command, remove the local temporary file, then verify the same admin POST returns 404. For preview seeding, delete the entire disposable seed Preview afterward and verify its immutable deployment URLs close too. Deleting only its current secret does not revoke old immutable deployments; keep admin secrets off PR previews.

Model calls are paid and can take up to ten minutes including fallback. Manual publication counts toward the channel and global caps. No request parameter bypasses them. `AI_ENABLED=false` suppresses generation for local collection.

Production reads are safe for investigation. Ask before production KV writes not requested by the owner. Tail with `npx wrangler tail mitchells-snow-report`; collection logs include source and channel outcomes.
