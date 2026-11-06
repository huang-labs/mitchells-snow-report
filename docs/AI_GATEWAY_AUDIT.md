# Cloudflare AI Gateway audit

[← README](../README.md)

Audited **2026-11-06 UTC**, against repository commit `419233257a0d39389342677313ca1ed9e4cdbb28`, using authenticated `cf` CLI `1.0.0-beta.26` reads and Cloudflare's control-plane API. The exact capture time, selected configuration fields, deployed bindings, and request metadata are in [sanitized evidence](AI_GATEWAY_AUDIT_EVIDENCE.json). This is a point-in-time audit, not a configuration change or an ongoing monitor.

## Verdict

**The three relevant gateways have the documented settings and evidence of authenticated inference. Current production and the current PR preview select the intended gateways. Preview isolation is incomplete across retained deployments and alternate commands.** Five older previews still select the production gateway; the checked-in legacy preview configurations do too. Development replay and a missing gateway ID can bypass gateway controls entirely.

No gateway settings, deployments, secrets, KV values, or production content were changed. No inference, admin POST, rate-limit exhaustion test, or workflow dispatch was performed. Existing request logs were inspected without fetching prompt/response payloads.

## Feature and environment inventory

| Feature / execution path | Intended gateway | Observed result |
| --- | --- | --- |
| Eight regional Daily Snow editions, production collection | `mitchells-snow-report` | Production version has the AI binding and correct gateway variable. Shared helper routes both primary and fallback through it. |
| Western Daily Snow, production collection | `mitchells-snow-report` | Same helper and gateway; shares the production request budget with regions. |
| Explicit hosted PR generation, disposable runner | `mitchells-snow-report-preview` | Current tooling constructs an AI-enabled runner with this ID; gateway logs show successful binding requests. No runner remained at capture time, so no live runner binding was inspected. |
| Public current PR preview (`pr-18`) | Preview ID, inference disabled | Live deployment has `AI_ENABLED=false`, preview gateway ID, dedicated KV, no AI binding and no admin-token binding. |
| Retained previews `pr-5`, `pr-6`, `pr-7`, `pr-8`, `pr-9` | Preview ID, inference disabled | **Fail:** all have an AI binding and production gateway ID; no `AI_ENABLED=false`. These PRs are merged. |
| PR-Agent advisory code review | `pr-agent` | Trusted workflow selects this endpoint; authenticated GLM 5.3 requests and a successful recent review corroborate it. This is CI, not a deployed preview/production feature. |
| Local collection with example configuration | No inference | `.dev.vars.example` sets `AI_ENABLED=false`. Enabling AI without overriding the gateway uses the production ID from base Wrangler configuration. |
| `dailysnow:once` | No inference | Prints a digest/request or validates saved output; no gateway needed. |
| `dailysnow:replay` | Currently direct Workers AI | **Gap:** REST request omits `cf-aig-gateway-id`; no audited gateway budget or logs apply. It does not publish. |

Sources: [production/legacy config](../wrangler.jsonc), [preview config builder](../scripts/preview/workflow.ts), [preview gateway guard](../scripts/preview/cloudflare.ts), [model helper](../src/lib/ai/model.ts), [regional generation](../src/lib/dailysnow/index.ts), [Western generation](../src/lib/dailysnow/western.ts), [review workflow](../.github/workflows/review.yml), [replay](../scripts/dailysnow-replay.ts), and the evidence capture. Gateway listing also returned `snow-report` and `opencode`; neither is referenced by this repository's AI paths, so their suitability for other applications is outside this audit.

## Live gateway settings

| Setting | Production: `mitchells-snow-report` | Preview: `mitchells-snow-report-preview` | CI: `pr-agent` |
| --- | --- | --- | --- |
| Authentication | `true` | `true` | `true` |
| Collect logs | `true` | `true` | `true` |
| Cache TTL | `0` | `0` | `0` |
| Request limit | `64` | `1000` | `100` |
| Interval, seconds | `86400` | `86400` | `86400` |
| Technique | `sliding` | `sliding` | `sliding` |
| Invalidate cache on update | `false` | `true` | `true` |
| Log management / strategy | `10000000` / `DELETE_OLDEST` | Same | Same |
| Logpush / zero data retention | `false` / `false` | Same | Same |
| Retry maximum, delay, backoff | All `null` | All `null` | All `null` |

The request limits match [deployment policy](DEPLOYMENT.md), [AI feature policy](AI_FEATURES.md), and [review policy](AI_CODE_REVIEW.md). These are gateway-wide request windows, not per-feature budgets, local-calendar-day quotas, or dollar caps. Regions and Western share 64; all PR generators share 1,000; review calls share 100. Application attempt reservations are separately stored per channel/local date: nine channels × three attempts × two reserved requests = 54 reservations per set of channel dates. That accounting is not a guarantee about any arbitrary rolling 24 hours, especially with manual runs or daylight-saving changes. Cloudflare documents rate-limit rejection as HTTP 429; exhaustion was not tested. [Cloudflare rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)

Both application models receive `gateway: { id, skipCache: true }`. PR-Agent supplies `cf-aig-skip-cache: true`. Production's different cache-invalidation flag is not a defect with TTL zero and explicit bypass. Null gateway retry fields do not prove an effective retry count; this audit verified application fallback code, not undocumented platform defaults. [Cloudflare binding options](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/), [caching](https://developers.cloudflare.com/ai-gateway/features/caching/)

Workers AI binding calls authenticate within the Worker's account; they do not need an extra gateway secret. The observed binding successes corroborate that configuration. PR-Agent's existing `Authorization` token works for its Workers AI gateway path, as demonstrated by authenticated successful logs; its secret value and actual permission grants were not inspected. Gateway-run token permissions are account scoped, so distinct gateway names are operational separation, not a gateway-specific IAM boundary. [Cloudflare authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/), [Workers AI provider authentication](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/)

Logging is enabled and metadata records exist. Payload collection can include source digests or review content; `zdr=false` is consistent with that. Do not interpret `log_management=10000000` as a retention duration. Cloudflare distinguishes newer Workers Logs retention from Legacy Logs by account gateway history; this audit did not verify the account's applicable retention tier. No Logpush export or payload-retention requirement is documented in the repository, so their absence is not marked a failure. [Cloudflare logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)

## Runtime evidence

The production deployment at `2026-11-06T00:22:27.190919Z` serves version `0fe268e3-d8af-4a62-aaf2-46de71893edb` at 100%. It binds AI, `AI_GATEWAY_ID=mitchells-snow-report`, and production KV. The current public `pr-18` deployment is `0fc7f718-c476-4ad2-9bb2-03b09ef6add8`, created `2026-11-06T01:08:33.618102Z`; its binding isolation is described above. [Recent preview workflow](https://github.com/huang-labs/mitchells-snow-report/actions/runs/42141520122)

The log query requested the newest 50 entries per gateway, ordered descending by creation time, with no time or success filter. It returned 43 production, four preview and 42 review records. All 89 metadata rows are captured in the evidence file. These are retained records, not a completeness claim about lifetime traffic or current quota remaining.

- Production: 43 authenticated HTTP 200 responses, none cached, from `2026-11-05T07:06:48.130Z` through `2026-11-05T21:10:09.237Z`. Models: 40 GLM 5.3 Flash, three gpt-oss-120b. HTTP success does not establish semantic validation or publication success.
- Preview: four authenticated HTTP 200 responses, none cached, from `2026-11-05T17:44:48.809Z` through `2026-11-05T19:13:11.485Z`, all GLM 5.3 Flash. Preview fallback has code coverage by the shared routing path, but no observed fallback call in these records.
- Review: 42 authenticated GLM 5.3 records, from `2026-11-05T15:51:09.793Z` through `2026-11-06T01:07:21.587Z`; 41 HTTP 200 and one HTTP 408. The timeout at `2026-11-05T17:14:57.479Z` lasted 235,629 ms and has no rejection reason. Its cause is unproven; it is not evidence of an auth or rate-limit failure. One early successful result at `2026-11-05T15:51:11.965Z` was cached. Current TTL/bypass settings and the newest five uncached successes do not suggest a current cache defect. [Recent successful review](https://github.com/huang-labs/mitchells-snow-report/actions/runs/42141520069)

These observations predate some current deployments/settings. Production's gateway was modified at `2026-11-06 01:08:45`, after its newest retained inference record, so successful inference under that exact current settings revision is not established. No morning publication was forced to close this gap. Logs have no feature/channel/PR metadata, so gateway traffic alone cannot prove every regional channel's routing or attribute historical production calls to retained previews.

## Findings and recommended follow-ups

### 1. Retained legacy previews still point at production — priority: high

Live `pr-5`, `pr-6`, `pr-7`, `pr-8`, and `pr-9` deployments have `AI_GATEWAY_ID=mitchells-snow-report`, an AI binding, and shared legacy preview KV. GitHub reports all five PRs merged. None has an admin-token binding in its latest deployment. The preview list contained no `seed-pr-*` runner.

**Impact:** these artifacts are not isolated at the AI-binding level. If inference is invoked by their deployed code or a later operational change, it uses the production request budget. No historical misuse or publicly callable inference exploit was demonstrated. Read APIs do not normally generate AI, and an AI binding alone does not initiate requests.

**Recommendation:** remove these five closed-PR previews through the documented cleanup path after confirming ownership. Inspect the preview parent and immutable historical deployments as part of cleanup. Verify stable and immutable URL revocation using the existing cleanup checks. This audit performed no deletions.

### 2. Alternate preview commands preserve the production gateway — priority: medium

`wrangler.jsonc` has production gateway IDs in both `previews.vars` and `env.preview.vars`, and neither disables AI. `npm run upload` consumes the checked-in preview configuration instead of the current generated configuration. The active Actions workflow uses `scripts/preview-run.ts` and its allowlisted `previewConfig`, which correctly chooses the preview ID and disables AI for public previews.

**Recommendation:** align or retire the legacy preview settings and upload path. Default local/preview inference to disabled, and use the preview gateway for deliberately enabled development calls. Add a focused configuration check covering every supported deployment command. Production bindings should remain explicitly production-scoped.

### 3. Missing gateway IDs and development replay bypass controls — priority: medium

`askWithFallback` passes empty run options when `gatewayId` is absent. The live production binding has the ID, so this is a drift risk rather than an observed production failure. `dailysnow:replay` intentionally sends direct Workers AI requests with only authorization and content-type headers. It does not reserve the publication attempt budget.

**Recommendation:** require an explicit gateway whenever deployed inference is enabled. Route paid replay through the preview gateway and set an explicit cache bypass, or require an intentional, clearly named unmetered development mode. Workers AI REST requests can select a gateway with `cf-aig-gateway-id`; the hostname alone does not determine whether a request bypasses it. [Cloudflare REST routing](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)

### 4. Gateway drift checks cover only preview rate settings — priority: medium

`ensureGateway` verifies the preview limit, interval and technique before generation, but does not validate existing authentication, logging, or cache settings. Its create body does not explicitly specify authentication; the live gateway reports it enabled. No equivalent production/review configuration assertion is present in the deployment/review workflows.

**Recommendation:** add a reusable read-only audit that compares all three gateways with an explicit policy and reports each failure separately. Validate deployed gateway selection as well as gateway existence. Keep configuration repair separate from audit execution; do not silently raise limits. Include model/channel/PR/commit metadata on future requests for attribution without reading payloads.

## Repeating the audit

Run from the repository with authenticated account access. These commands read configuration and request metadata; they do not generate AI:

```sh
cf accounts list
cf ai-gateway gateways list --per-page 100
cf ai-gateway gateways get mitchells-snow-report
cf ai-gateway gateways get mitchells-snow-report-preview
cf ai-gateway gateways get pr-agent
cf ai-gateway logs list --gateway-id mitchells-snow-report --per-page 50 --order-by created_at --order-by-direction desc
cf ai-gateway logs list --gateway-id mitchells-snow-report-preview --per-page 50 --order-by created_at --order-by-direction desc
cf ai-gateway logs list --gateway-id pr-agent --per-page 50 --order-by created_at --order-by-direction desc
cf workers deployments list --worker mitchells-snow-report --per-page 1
# Substitute the version ID in the active deployment, not an arbitrary latest upload.
cf workers versions get <active-version-id> --worker-id mitchells-snow-report
```

The log API rejected `per_page=100` with HTTP 400/code 7001; retrying with its supported maximum of 50 succeeded. This was a query-validation error, not an authentication failure.

The installed CLI's command discovery did not expose preview inspection. Authenticated read-only GETs using its existing OAuth session inspected these account API paths instead, following the same Worker Preview API used by repository tooling:

```text
/accounts/{account}/workers/workers/mitchells-snow-report-preview/previews
/accounts/{account}/workers/workers/mitchells-snow-report-preview/previews/{name}/deployments
```

Use the serving deployment's `env` fields to check gateway ID, AI enablement, AI binding, KV namespace, and admin-token binding presence. Never print token values. Compare preview names with GitHub PR states. Record query bounds and paginate if a page fills; do not mistake a truncated log page for a total.

Validation for this documentation: live reads of three gateway detail resources, three bounded log queries, active production version bindings, six preview deployment bindings, GitHub PR states and recent workflow results; local link/content review and `git diff --check`. Application tests, typecheck, build, browser checks, new model runs, token permission enumeration, billing/spend-limit resources, and historical deployment secret/revocation checks were not run. No claim is made about account-wide spend protection or unused account gateways.
