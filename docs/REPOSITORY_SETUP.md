# Mitchell's repository setup

[← README](../README.md) · [Approved expansion plan](EXPANSION_PLAN.md)

Prepare `huang-labs/mitchells-snow-report` before implementing the expansion.
The application and committed Cloudflare configuration still describe Cottonwoods
until the feature and deployment changes land.

## Verified fork state

Checked on November 5, 2026:

- GitHub authentication has repository admin access and the `workflow` scope.
- GitHub Actions is enabled. Reapplying the repository Actions permission
  registered the inherited **Deploy** and **AI review** workflows as active.
- The three author labels exist: `author:codex`, `author:claude`, `author:glm`.
- The repository variable `DEPLOYMENT_ENABLED` is `false`. The housekeeping
  workflow change requires exactly `true` for production and preview uploads;
  tests remain enabled independently.
- `OPENROUTER_API_KEY` is configured as an encrypted repository Actions secret.
  No Cloudflare Actions secrets or available organization Actions secrets exist.
- Blacksmith runner access is verified by the first PR's successful test job,
  including typecheck, application tests, Worker build, and smoke checks.
- The first ready-for-review event selected GLM 5.3 and posted a real advisory
  review successfully. It reported no major issues or security concerns.
- Production and preview uploads skipped under the readiness gate. Their
  credentials, environments, and isolated resources still need setup.

The [housekeeping PR](https://github.com/huang-labs/mitchells-snow-report/pull/1)
records the live validation. CI and AI review are verified; preview deployment is
not yet configured.

## CI and AI review

1. Run a PR's test job and verify the configured Blacksmith runners pick it up.
   If runner access is unavailable, grant this repository access in Blacksmith or
   explicitly choose GitHub-hosted runners before feature work.
2. Add an Actions secret named `OPENROUTER_API_KEY`. Use a dedicated key with an
   account-side spending limit. GitHub cannot reveal or copy the parent
   repository's secret value; supply the key through a private secret entry.
3. Preserve the trusted-base review workflow and `.pr_agent.toml`. Exactly one
   author label is required; Codex changes use `author:codex`.
4. Verify one real advisory review on a ready PR. The workflow skips drafts;
   missing labels skip inference. Provider, authentication and credit errors must
   be diagnosed separately from runner or workflow issues.

The default reviewer models and optional overrides are documented in
[AI code review](AI_CODE_REVIEW.md). Each job declares the permissions it needs;
there is no need to make the repository's default workflow token broadly writable.

## Deployment prerequisites

Leave `DEPLOYMENT_ENABLED=false` while committed configuration targets Cottonwoods.
The inherited workflow can otherwise upload a preview to the original Worker or
deploy the original production resources when main changes.

Before enabling deployment:

1. Configure a distinct Mitchell's Worker and `mitchells-snow-report.huang.mx`.
   Replace the Cottonwoods namespace, Gateway ID, collector contact, workflow
   URLs, and other operational defaults.
2. Create dedicated production KV and isolated preview storage. The preview must
   have real source data collected through the app's collection code, with
   temporary administrative access removed after seeding.
3. Add the publication coordinator binding and its migration as part of the
   expansion. Verify first-deployment and preview migration requirements.
4. Add Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with
   access to the Mitchell's resources. Configure the production and preview
   GitHub environments as needed for the deployment workflow.
5. Inspect the resolved Wrangler configuration and dry run. Confirm no write
   targets the original Cottonwoods Worker, KV, or Gateway.
6. Set `DEPLOYMENT_ENABLED=true`, then verify a PR preview upload, the bot's preview
   URL comment, correct metadata URLs, populated resort pages, and the intended
   production merge path. Preview versions must not run collection crons.

Do not seed production KV as a housekeeping step. Production writes outside an
explicitly requested operation require owner approval. Initial history should
accumulate naturally after launch.

## Completion checks

- [x] CI runs successfully on a PR.
- [x] The appropriate AI reviewer posts a real review. Every subsequent head
  needs its own review/checks, visible on the PR.
- [ ] Preview deployment uses Mitchell's resources and comments a working URL.
- [ ] Preview pages demonstrate real collected data and correctly scoped AI output.
- [ ] Production configuration names only Mitchell's resources.
- [ ] The expansion implementation starts from main after the housekeeping PR merges.
