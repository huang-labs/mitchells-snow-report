# AI code review

[← README](../README.md)

Setup, reviewer selection and manual review commands for the advisory PR workflow.

The official [PR-Agent Action](https://github.com/marketplace/actions/the-pr-agent)
runs **one advisory review per eligible PR event** through OpenRouter. A short
routing step selects a model; PR-Agent owns inference, review formatting,
persistent comments, inline findings, coverage and failure reporting.

Apply exactly one author label. PR-number parity keeps the selected reviewer
stable across pushes while distributing reviews between the other two families:

| Author label | Even PR number | Odd PR number |
| --- | --- | --- |
| `author:codex` | Claude Opus 5.5 | GLM 5.3 |
| `author:claude` | GPT-6.1 Sol | GLM 5.3 |
| `author:glm` | Claude Opus 5.5 | GPT-6.1 Sol |

To choose the reviewer instead, add one `review:claude`, `review:gpt` or
`review:glm` label naming a family other than the author's. It overrides parity
for every later review on that PR; removing it returns to parity. A `review:`
label matching the author family, or more than one `review:` label, produces an
Actions notice without inference.

Setup: store a dedicated OpenRouter key as Actions secret `OPENROUTER_API_KEY`;
set its spending cap/reset period in OpenRouter. Defaults are
`anthropic/claude-opus-5.5`, `openai/gpt-6.1-sol`, and `z-ai/glm-5.3`. Optional
repository variables `AI_REVIEW_CLAUDE_MODEL`, `AI_REVIEW_GPT_MODEL`, and
`AI_REVIEW_GLM_MODEL` accept explicit same-vendor model IDs, without the
`openrouter/` prefix. Model fallbacks and auto routers are disabled. OpenRouter
may switch hosting providers serving the same model. Review content is sent to
OpenRouter and the selected provider under your account privacy settings.

Reviews run on open, reopen, ready-for-review, pushes and author- or review-label changes.
Drafts, forks, Dependabot and bot events are skipped. Missing/conflicting author
labels produce an Actions notice without inference. A collaborator with current
write/maintain/admin permission can post exactly `/review` to rerun; other
commands and arguments are ignored. Automatic description rewriting and code
suggestion generation are disabled. Review findings are advisory: keep this
workflow optional in branch protection. Model/run details identify the reviewer;
GitHub tests and preview deployment remain independent.

The `pull_request_target` workflow and review configuration come from trusted
base/default branches, with no checkout or execution of PR code. PR-Agent reads
PR data and default-branch AGENTS.md through GitHub's API. Repeated requests for
the same head cancel each other; different heads have separate concurrency groups
so delayed older jobs cannot cancel newer heads. Native PR-Agent owns how
in-progress/full-diff reviews and their persistent findings are updated.

Policy is in `.pr_agent.toml`: **high reasoning for all three models**, a 131,072-token
context budget and a 32,768-token completion allowance shared by reasoning and
the final review. Each model call has up to 20 minutes; the job allows 45 minutes
for startup and one transient-error retry. A diff over the budget is reviewed in
up to four chunks whose findings are merged; files that still do not fit are listed
in the review's coverage footer. Chunks are reviewed independently, so a chunk
cannot see code in another chunk. Captured fixtures (`test/fixtures/**`) and
`package-lock.json` are excluded from review.
An exhausted budget fails the review rather than lowering reasoning effort.
These limits are not dollar caps. The official Action wrapper is pinned
to v0.49.0's commit; its Dockerfile uses upstream's rolling `github_action` image.
Update deliberately and check live model compatibility after upgrades.

Automatic reviews activate after merging this workflow/config into main. Existing
PRs need a new eligible event. Provider/auth/credit failures appear in PR-Agent's
native output and Actions logs; fix the configuration and post `/review` to retry.
