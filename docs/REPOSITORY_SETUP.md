# Mitchell's repository setup

[← README](../README.md) · [Approved plan](EXPANSION_PLAN.md)

The housekeeping [PR #1](https://github.com/huang-labs/mitchells-snow-report/pull/1) established working CI and AI review. The expansion starts from merged main.

## Configured resources

GitHub Actions and Blacksmith runners are enabled. Every PR receives an advisory GLM 5.3 review through the `pr-agent` AI Gateway; see [AI code review](AI_CODE_REVIEW.md).

Branch protection on `main` matches Cottonwoods: changes go through a PR (no approvals required), with required checks `test`, `preview` and `review` on an up-to-date branch. It applies to admins, and force pushes and deletion are blocked.

Cloudflare account access was verified through the owner's authenticated `cf` CLI. Dedicated production and preview KV, the preview parent Worker, and an AI Gateway are configured. Account ID and a dedicated account/zone-scoped deployment token are encrypted GitHub Actions secrets. The application contains no token values.

`MITCHELLS_DEPLOYMENT_ENABLED` controls the updated workflow. The inherited `DEPLOYMENT_ENABLED` remains false so older main code cannot target Cottonwoods before this feature merges. Production deployment on merge uses only Mitchell's configuration.

## Verification and boundaries

The isolated preview collection succeeded for all 19 sources. Regional and Western AI output is seeded through the real collection/publication path. PR previews use Worker Previews. Each PR now receives a dedicated KV namespace, seeded once from production reads and refreshed on deployment without a cron; the original shared preview namespace remains only for older workflows.

The feature PR's checks verify the deployment token, emitted preview URL, populated pages and share metadata. Production custom-domain/cron activation is deliberately left to the main deployment after merge. Production KV is not seeded and starts accumulating history naturally.

Preview preparation is automated through disposable seed runners, deleted with all immutable deployments after use. Never put their admin token on the public PR preview or in Actions logs. Source refresh and explicit AI regeneration are documented under [preview operations](DEPLOYMENT.md#refresh-or-regenerate-a-hosted-pr-preview).

See [deployment and operations](DEPLOYMENT.md) for resource IDs, manual procedures and the current workflow. CI/reviewer/provider failures must be diagnosed independently; do not change to another runner/provider without checking the actual failure.

An initial setup token was superseded by the CI deployment token and is unused. The authenticated `cf` CLI cannot list or revoke API tokens (403), so revoke any unused token in [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens). The active CI credential has the corrected account and zone policy.
