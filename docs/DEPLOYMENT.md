# Deployment and operations

[← README](../README.md)

Production configuration, PR previews, credentials and usage.

Live at **https://cottonwoods-snow-report.huang.mx**. It runs as the Worker `cottonwoods-snow-report` on the Cloudflare account "Huang Inc." (Workers Paid).

| Piece | Where |
| --- | --- |
| Worker + cron (`*/5 * * * *`) | `wrangler.jsonc` |
| KV namespace `SNOW_KV` | id `25451aae36fb40b68f530ee747940440` (in `wrangler.jsonc`) |
| Workers AI | binding `AI`; AI Gateway `snow-report` (`AI_GATEWAY_ID`) with logging, no caching and a daily request limit |
| Domain | Workers custom domain `cottonwoods-snow-report.huang.mx` (DNS record and certificate managed by Cloudflare). `workers.dev` is disabled; per-PR preview URLs are enabled. |
| Logs | Workers Logs (`observability.enabled`). Each cron logs one `{"event":"collection",…}` line, including the `recommendation` and `dailySnow` outcomes. Live tail: `npx wrangler tail cottonwoods-snow-report` |
| Plain vars | `AI_GATEWAY_ID`, `COLLECTOR_CONTACT` (site URL, sent in the User-Agent) |

**Deploys are automatic** (`.github/workflows/deploy.yml`):

- In this fork, production and preview uploads require the repository Actions
  variable `DEPLOYMENT_ENABLED` to be exactly `true`. It is `false` until isolated
  Mitchell's resources are configured; the test job runs independently. Follow
  [repository setup](REPOSITORY_SETUP.md) before enabling uploads.
- Every push to `main` typechecks, tests, builds, and smoke-checks the local Worker, then runs `npm run deploy` (static export + `wrangler deploy`).
- Every pull request from this repository passes the same checks, then is uploaded with `wrangler versions upload` as a non-deployed Worker version with a stable preview URL (`pr-<number>-cottonwoods-snow-report.huang-inc.workers.dev`), linked in a PR comment. Previews share production bindings, so they read the live KV snapshot; crons stay on the deployed version.

The workflow uses two repository secrets:

- `CLOUDFLARE_API_TOKEN`: the user API token "cottonwoods-snow-report deploy (GitHub Actions)". It is limited to this account (Workers Scripts, Workers KV, Workers Tail, Account Settings read) and the `huang.mx` zone (Workers Routes, Zone read). To rotate it, roll the token in the dashboard (My Profile → API Tokens), then run `gh secret set CLOUDFLARE_API_TOKEN`.
- `CLOUDFLARE_ACCOUNT_ID`.

Optional secrets (`npx wrangler secret put …`):

- `UDOT_API_KEY`: enables UDOT Traffic API events (closures, avalanche control). Requires a free UDOT Traffic developer key.
- `ADMIN_TOKEN`: enables `POST /api/admin/collect`. Unset in production, so the route returns 404.

To deploy by hand, set `CLOUDFLARE_API_TOKEN` (or run `npx wrangler login`), then run `npm run deploy`.

**Plan and usage:** Workers **Paid** is required. Cropping a new plume run costs roughly 100–130 ms CPU per station (PNG decode and encode), a few times a day, and an ordinary collection is close to the free plan's 10 ms CPU limit for cron invocations. Static frontend requests and asset storage are free with asset-first routing. KV: one snapshot write per run (288/day) plus one read per write (~290/day), one more write after each AI attempt, four panel writes per new plume run, one archive write, up to six figure writes, and one read plus one write to link the previous post per Daily Snow post, and one read per dashboard poll (1,440/day per open screen). Workers AI requests are capped in code (resort pick: 40/day reserved; Daily Snow: 12/day reserved) and by the gateway limit.
