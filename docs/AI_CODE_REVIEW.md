# AI code review

[← README](../README.md)

Setup, enforcement and the implementing-agent review loop.

The official [PR-Agent Action](https://github.com/marketplace/actions/the-pr-agent)
runs **one required review per eligible PR event**. Every review uses GLM 5.3
(`@cf/zai-org/glm-5.3`) on Workers AI through the dedicated `pr-agent` AI Gateway.
PR-Agent owns inference, review formatting, persistent comments, inline findings,
coverage and failure reporting. No label is needed to request a review.

Setup: the `pr-agent` gateway (Huang Inc. account) is authenticated, logs requests,
and has a sliding limit of 100 requests per day. Actions secret
`PR_AGENT_CLOUDFLARE_TOKEN` holds a dedicated user API token limited to Workers AI
Read and AI Gateway Run on that account; the workflow builds the gateway URL from
`CLOUDFLARE_ACCOUNT_ID`. That token in `Authorization` also satisfies gateway
authentication. Every request sends `cf-aig-skip-cache`, so a re-push reruns
inference. Fallbacks are disabled. Review content goes to Cloudflare Workers AI and
is visible in the gateway's logs.

## Review gate and override

Reviews run on open, reopen, ready-for-review and pushes for same-repository,
non-draft PRs. Forks, drafts and Dependabot PRs are skipped. Bot pushes to eligible
PRs are reviewed too. There is no comment command: push a new commit to rerun
(`git commit --allow-empty` works). Duplicate events for a commit replace each
other; superseded or closed PR events are skipped. A review already running for
an older commit can finish, so rapid pushes can each use a request. Automatic
description rewriting and code suggestion generation are disabled.

Branch protection on `main` requires `review`, `test` and `preview` on an
up-to-date branch. The `review` check passes only when PR-Agent succeeds,
returns a valid structured result, reports zero key issues, and recommends
`no_concerns_found`. Both `needs_review` and `changes_required` block it. Missing
or malformed output and provider/auth/rate-limit failures also block it.
Resolving a GitHub thread alone does not turn the gate green: push to get a fresh
review. The gate reads PR-Agent's JSON Action output, never its rendered comments.

To explicitly bypass AI review, add **`ai-review-override`** in the PR's Labels
menu (or `gh pr edit <number> --add-label ai-review-override`). GitHub's existing
label permissions control who can do this, including users with triage access;
this is not an admin-only mechanism. The PR timeline records the actor, and the
Actions summary and an automatic audit comment identify the override and commit.
The gate requires that bot-authored audit record to match the current head, so a
stale label cannot bypass review during concurrent events. Leave a PR comment explaining
the reason. Adding the label cancels/replaces a pending review for that commit
and passes without another model request; it can also bypass a provider outage.
Removing it runs a fresh paid review and restores enforcement. Other label
changes also rerun the gate (and a paid review when no override is present), so
a skipped label-event job cannot accidentally supersede a failed required check.
The workflow clears the override on each push, reopen or
transition out of draft, so it does not authorize later commits. Agents need the
owner's explicit authorization for that PR to apply the label. `test` and
`preview` remain required throughout.

The label can be created once with:

```sh
gh label create ai-review-override --color D93F0B --description "Explicitly bypass AI review until the next push"
```

The `pull_request_target` workflow, gate helper and review configuration come
from trusted base/default branches. It checks out only the immutable base SHA,
with no persisted credentials, and never checks out or executes PR code.
PR-Agent reads PR data and default-branch AGENTS.md through GitHub's API. Label
removal uses `GITHUB_TOKEN`, so it does not recursively trigger another workflow.
The existing `review` check name is preserved; no branch-protection change is
needed. The deploy workflow runs the gate's dependency-free tests:

```sh
node --test .github/scripts/review-gate.test.cjs
```

## Implementing-agent review loop

Opening a PR or pushing a follow-up starts this loop automatically as part of the
implementation task; the owner does not need to ask for review fixes.

1. Link the PR to the implementing session. Read existing review summaries,
   inline threads and check failures, and confirm which commit each concerns.
2. Monitor the PR for the latest head's review and checks. In T3, call
   `watch_pull_request` and yield as the tool requires; it wakes the same session
   for new comments/reviews, failed checks, passed required checks or conflicts.
   Keep the watch active through follow-up pushes. Other agent hosts should use
   their supported monitoring mechanism; if none exists, report that limitation
   and the pending checks instead of claiming automatic follow-through.
3. On feedback, investigate every summary and inline finding. Fix actionable
   defects, add meaningful regression coverage where appropriate, run the
   relevant validation, update documentation and the PR description, and push to
   the same PR. Reply to review threads with the fix and validation, then resolve
   threads whose findings are addressed. Read the next review and repeat; a green
   Action exit alone is insufficient if comments remain unaddressed.
4. For a disputed finding, explain the evidence on the PR. Seek the owner's
   decision before dismissing it or applying an override. Diagnose provider,
   auth and rate-limit failures separately from code findings. Report blockers
   that require owner action rather than cycling unchanged commits indefinitely.
5. Finish only when `review`, `test` and `preview` pass for the current head and
   all review threads are resolved, or when an owner decision/external failure
   blocks progress. Report the PR, head, validation and any authorized override.
   Stop the watch when handing back a completed PR; leave merging to the owner.

GitHub automatically runs the reviewer. These instructions make review follow-up
part of each implementing agent's task; they do not launch arbitrary agents from
GitHub. Automatic session resumption requires a host such as T3 with PR watches.

## Model and operational limits

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
gateway logs; fix the configuration and push a new commit to retry.
