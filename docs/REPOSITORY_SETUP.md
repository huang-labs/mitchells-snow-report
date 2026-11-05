# Mitchell's repository setup

[← README](../README.md) · [Approved plan](EXPANSION_PLAN.md)

The housekeeping [PR #1](https://github.com/huang-labs/mitchells-snow-report/pull/1) established working CI and AI review. The expansion starts from merged main.

## Configured resources

GitHub Actions and Blacksmith runners are enabled. Every PR receives an advisory GLM 5.3 review through the `pr-agent` AI Gateway; see [AI code review](AI_CODE_REVIEW.md).

Cloudflare account access was verified through the owner's authenticated `cf` CLI. Dedicated production and preview KV, the preview parent Worker, and an AI Gateway are configured. Account ID and a dedicated account/zone-scoped deployment token are encrypted GitHub Actions secrets. The application contains no token values.

`MITCHELLS_DEPLOYMENT_ENABLED` controls the updated workflow. The inherited `DEPLOYMENT_ENABLED` remains false so older main code cannot target Cottonwoods before this feature merges. Production deployment on merge uses only Mitchell's configuration.

## Verification and boundaries

The isolated preview collection succeeded for all 19 sources. Regional and Western AI output is seeded through the real collection/publication path. PR previews use Worker Previews. Each PR has its own isolated preview that reads preview-only KV, without a cron.

The feature PR's checks verify the deployment token, emitted preview URL, populated pages and share metadata. Production custom-domain/cron activation is deliberately left to the main deployment after merge. Production KV is not seeded and starts accumulating history naturally.

Temporary administrative access belongs on a disposable seed Preview. Remove the secret and delete that Preview after seeding; immutable deployment URLs otherwise retain earlier secret bindings. Never put the seed token on the PR preview or in Actions logs.

See [deployment and operations](DEPLOYMENT.md) for resource IDs, manual procedures and the current workflow. CI/reviewer/provider failures must be diagnosed independently; do not change to another runner/provider without checking the actual failure.

An initial setup token was superseded by the CI deployment token and is unused. The authenticated `cf` CLI cannot list or revoke API tokens (403), so revoke any unused token in [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens). The active CI credential has the corrected account and zone policy.
