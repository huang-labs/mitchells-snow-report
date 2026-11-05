# AI code review

[← README](../README.md)

Setup and manual review commands for the advisory PR workflow.

The official [PR-Agent Action](https://github.com/marketplace/actions/the-pr-agent)
runs **one advisory review per eligible PR event**. Every review uses GLM 5.3
(`@cf/zai-org/glm-5.3`) on Workers AI through the dedicated `pr-agent` AI Gateway.
PR-Agent owns inference, review formatting, persistent comments, inline findings,
coverage and failure reporting. No labels are needed.

Setup: the `pr-agent` gateway (Huang Inc. account) is authenticated, logs requests,
and has a sliding limit of 100 requests per day. Actions secret
`PR_AGENT_CLOUDFLARE_TOKEN` holds a dedicated user API token limited to Workers AI
Read and AI Gateway Run on that account; the workflow builds the gateway URL from
`CLOUDFLARE_ACCOUNT_ID`. That token in `Authorization` also satisfies gateway
authentication. Every request sends `cf-aig-skip-cache`, so `/review` reruns
inference. Fallbacks are disabled. Review content goes to Cloudflare Workers AI and
is visible in the gateway's logs.

Reviews run on open, reopen, ready-for-review and pushes. Drafts, forks, Dependabot
and bot events are skipped. A repository owner, member or collaborator can post
exactly `/review` on an open PR to rerun; other commands and arguments are ignored. A newer push
or `/review` cancels an in-progress review of the same PR. Automatic description
rewriting and code suggestion generation are disabled. Review findings are
advisory: keep this workflow optional in branch protection. GitHub tests and
preview deployment remain independent.

The `pull_request_target` workflow and review configuration come from trusted
base/default branches, with no checkout or execution of PR code. PR-Agent reads
PR data and default-branch AGENTS.md through GitHub's API.

Policy is in `.pr_agent.toml`: high reasoning effort, a 131,072-token context
budget and a 32,768-token completion allowance shared by reasoning and the final
review. Each model call has up to 20 minutes; the job allows 45 minutes for
startup and one transient-error retry. A diff over the budget is reviewed in up to
four chunks whose findings are merged; files that still do not fit are listed in
the review's coverage footer. Chunks are reviewed independently, so a chunk cannot
see code in another chunk. Captured fixtures (`test/fixtures/**`) and
`package-lock.json` are excluded from review. These limits are not dollar caps;
the gateway's daily request limit is. The official Action wrapper is pinned to
v0.49.0's commit; its Dockerfile uses upstream's rolling `github_action` image.
Update deliberately and check live model compatibility after upgrades.

Workflow and policy changes take effect after merging into main. Provider, auth
or rate-limit failures appear in PR-Agent's native output, Actions logs and the
gateway logs; fix the configuration and post `/review` to retry.
