---
issue: planning#209
description: Sandboxed gh shim for agent-driven PRs, plus gh run / gh workflow access (reads + own-branch re-run).
---

# 116 — Fake `gh` CLI Shim for Agent-Driven PR Creation

## Summary

Ship a small, sandboxed `gh` shim inside session worker containers that exposes only a curated PR-related subset of the real GitHub CLI. The agent uses it like `gh pr create …` from its bash tool; under the hood, the shim brokers the call through the session worker to the orchestrator, which mutates GitHub via the user's Octokit-authenticated `GitHubAuthManager`. The agent never sees the token, never reaches arbitrary GitHub APIs, and cannot escalate to repo/release/workflow surfaces.

The current harness-side auto-create flow (`quickCreatePr` → `generatePrDescriptionFromContext` → `generateText`) stays in place as a backstop. Because the orchestrator path already deduplicates against existing PRs, the two paths compose cleanly.

## Motivation

§5 of `CLAUDE.md` ("chat is the input surface; the agent is the actor") is in tension with how PR creation works today:

1. The harness extracts conversation context, builds a synthetic prompt, and calls a side-channel LLM via `generateText` to produce a PR description.
2. In production, `generateText` is a no-op (`app-di.ts:228-253` — `agentFactory` is `undefined` in production, so it returns `""`). **All auto-created PRs ship with empty bodies today.** This is a real, observable bug.
3. Even when `generateText` works (in tests), it operates on an extracted excerpt of the conversation, not the agent's live context — strictly less information than the agent already has.

The cleanest fix is to make the agent the actor: when it has finished a meaningful chunk of work, it runs `gh pr create` itself with a title and body it composes from full live context. The harness only fires its fallback if the agent didn't.

We deliberately do **not** install the real `gh`. Doing so would expose `gh api`, `gh repo create/delete`, `gh workflow run`, `gh release`, `gh secret set`, `gh ssh-key`, etc. — a large mutation surface backed by the user's GitHub token, reachable from any process the agent spawns. A purpose-built shim with a narrow allowlist eliminates that risk.

## Non-goals

- **Not** a general-purpose `gh` replacement. We do not aim to pass `gh`'s test suite.
- **Not** a wrapper around the real `gh`. The shim does not call out to GitHub directly; it always brokers through the orchestrator.
- **Not** a permanent allowlist. If a future feature legitimately needs another subcommand, we add it explicitly.
- **Not** a replacement for the orchestrator's PR routes. Those still serve the UI.

## Design

### Architecture

```
agent bash tool
   │
   │ gh pr create -t "..." -b "..."
   ▼
[/usr/local/bin/gh]  ← shim (Node script, ~200 lines)
   │
   │ POST http://localhost:9100/agent-ops/pr/create
   ▼
[session-worker.ts]  ← new /agent-ops/* router
   │
   │ POST http://orchestrator:3000/api/sessions/{id}/pr/quick
   │ (or /pr, /pr/edit — see route table)
   ▼
[api-routes-github.ts]
   │
   │ services/github.ts → GitHubAuthManager → Octokit
   ▼
GitHub
```

Three layers:

1. **Shim** (`/usr/local/bin/gh`, baked into the session worker image). Parses `gh <command> <subcommand> <args>`, validates against the allowlist, POSTs JSON to a localhost worker endpoint, prints the response in `gh`-compatible format on stdout.
2. **Worker broker** (`/agent-ops/*` routes in `session-worker.ts`). Receives requests from the shim, talks to the orchestrator over the existing Docker network. The worker's session ID is implicit — the agent never has to specify it.
3. **Orchestrator endpoints**. Mostly reuse existing routes (`POST /api/sessions/:id/pr/quick`, etc.); add new ones only where needed (`PATCH .../pr/{number}` for edits, `POST .../pr/{number}/comment`, etc.).

### Why the worker broker (not direct shim → orchestrator)

The shim *could* hit the orchestrator's HTTP routes directly, but routing through the worker buys two things:

1. **Allowlist gate at a single chokepoint**. The worker exposes only `/agent-ops/{operation}` routes. The shim cannot reach arbitrary orchestrator endpoints even if a future bug makes it want to.
2. **Session-scoping is automatic**. The worker knows its session ID. The shim doesn't transmit it; the worker injects it. There is no path by which the agent can request operations against a different session.

The cost is one new HTTP client (worker → orchestrator), and a small `/agent-ops` router. Both are mechanical.

### Allowlist (initial)

| Subcommand | Maps to | Notes |
|---|---|---|
| `gh pr create` | `POST /api/sessions/:id/pr/quick` (existing) or new `POST .../pr` | Title and body are the agent's input. Falls back to the existing description generator only if `--fill` is passed and body is empty. `-l`/`--label` (repeatable / comma-separated) applies labels best-effort after the PR opens. |
| `gh pr edit [<n>]` | new `PATCH /api/sessions/:id/pr/:number` | Updates title/body and/or adds (`--add-label`, alias `-l`/`--label`) and removes (`--remove-label`) labels — each repeatable / comma-separated, may be given alone. `<n>` defaults to current branch's PR. |
| `gh pr view [<n>] [--json …]` | existing PR status data via `prStatusPoller` | Read-only; returns JSON when `--json` requested. |
| `gh pr list [--json …]` | existing GitHub auth + Octokit list | Read-only; scoped to session's repo. |
| `gh pr status` | derived from `prStatusPoller` for current branch | Convenience read. |
| `gh pr comment [<n>] -b BODY` | new `POST /api/sessions/:id/pr/:number/comment` | Useful for the agent to leave a follow-up note. |
| `gh pr ready [<n>]` | new `POST .../pr/:number/ready` | Mark draft as ready. |
| `gh pr close [<n>]` | new `POST .../pr/:number/close` | Useful for abandoning superseded PRs. |
| `gh pr reopen [<n>]` | new `POST .../pr/:number/reopen` | Symmetric. |

Explicitly **rejected** with a helpful error and non-zero exit:

- `gh api …` — arbitrary endpoint access defeats the design.
- `gh repo create|delete|edit|fork|sync|view|list` — repo lifecycle is orchestrator-owned; not the agent's concern.
- `gh release …` — releases are deliberate human acts.
- `gh workflow run` — **dispatch** is arbitrary execution with the repo's
  secrets; `gh run cancel|delete` — these **destroy** state. (`gh run list|view`,
  `gh workflow list|view`, and — added later — `gh run rerun` ARE supported; see
  "Read-only workflow runs" and "`gh run rerun`" below.)
- `gh auth …` — auth is harness-owned.
- `gh secret …` — secret management is via ShipIt's own secrets surface.
- `gh ssh-key …`, `gh gpg-key …`, `gh codespace …`, `gh extension …` — irrelevant to the workflow.
- `gh issue …` — out of scope for v1; can be added later if there's demand.

The error message:

```
ShipIt's `gh` shim only supports a subset of pull-request operations.
Tried: gh repo create
See /shipit-docs/github.md for the full list.
```

### `--repo` flag

Not supported in v1. Operations are always scoped to the session's remote. Passing `--repo other/repo` errors with the same allowlist message. This is a non-trivial scoping benefit: even if the agent is confused about which repo it's working in, the shim cannot mutate a different one.

### Output formats

The shim must match real `gh` closely enough that the agent doesn't get confused on parse:

- `gh pr create` prints the PR URL to stdout, exits 0. (Real `gh` does this.)
- `gh pr view --json title,body,state` prints valid JSON with exactly the requested fields.
- Errors go to stderr; exit code is non-zero.
- `--help` prints a brief summary of supported subcommands and exits 0.

#### `-q` / `--jq` (added later)

`--json` alone forced the agent to shell out to a parser, so the idiomatic
`gh pr view N --json state -q .state` hit the generic unsupported-flag path and
exited **2 before ever calling the broker** — a polling loop that redirected
stderr saw an empty string forever, indistinguishable from "not merged yet"
(observed in production 2026-08-06 against an already-merged PR). Every read
verb that takes `--json` (`gh pr view|list`, `gh run list|view`,
`gh workflow list|view`) now also takes `-q`/`--jq`, applied to the
already-`filterJson`'d payload.

`applyJq` (`shim-common.ts`) is a **path walker, not a jq**: it parses only
`.`, `.field`, `.a.b`, `.[]`, `.[].field`, `.[0]` and `.field[].sub` into a
bounded step list, then walks the value it was handed. It evaluates no
user-supplied code and can reach nothing outside that payload — the parser is
the security boundary, so a pipe or `select(...)` is refused up front rather
than partially interpreted. Output matches `jq -r` (raw strings, one value per
line, nothing for an empty stream).

Failure modes are given distinct exit codes precisely because the original bug
was an *indistinguishable* one — a caller that swallows stderr still gets a
signal: **3** unsupported expression (message names it), **1** supported
expression that doesn't fit the data, **2** usage errors including `-q`
without `--json` (which real `gh` also refuses, before any network call).

#### `gh pr list --state` (added later)

The same indistinguishable-failure shape recurred one flag over. `--state` was
forwarded unvalidated, and the orchestrator route coerced anything that wasn't
`closed`/`all` to `"open"` — so `gh pr list --state merged`, which real `gh`
accepts, answered with the repository's **open** pull requests, exit 0, no
warning. A caller reasonably read that as "this repository has no merged PRs".
Observed in production 2026-09-02 during an ops investigation, where the wrong
answer stood until an unrelated cross-check contradicted it.

Two changes, mirroring how `--json` field names are already handled:

- **`--state` is validated by name**, in `handlePrList` before the network call
  (exit 2, message listing `open, closed, merged, all`), and again at the route,
  which now answers 400 for an explicitly-supplied unknown value. An **absent**
  `state` still means `open` — in-container callers depend on that default, so
  only a supplied-and-unrecognised value is refused.
- **`merged` is supported for real** rather than merely rejected, and it is the
  one state that does **not** go to REST. REST has no merged state — a merged PR
  is a closed one carrying `merged_at` — so REST could only fetch closed PRs and
  filter, and a filter over one page is not a bound: a repository whose most
  recently updated closed PRs happen to be unmerged answers "no merged pull
  requests", reproducing the original wrong-but-plausible answer through a
  second mechanism. Widening the page only moves that boundary. So
  `listPullRequests` (`github-auth-prs.ts`) sends `merged` to GraphQL's native
  `pullRequests(states: MERGED)`, where the selection happens server-side and 30
  merged rows are 30 merged rows however old they are. Both shapes normalise to
  the same row: `state` stays `"closed"` (GitHub models a merge that way) and
  `mergedAt` is what distinguishes it. `mergedAt` is a `--json` field, and the
  plain-text row prints `merged` rather than REST's `closed`.

#### A failed list is not an empty one (added later)

Reviewing the `--state` fix surfaced the same shape a third time, on the same
read. `listPullRequests` ended `if (!res.ok) return []`, so a 403 on a private
repository, a rate-limit response and a GitHub 5xx all reached the shim as
`{ prs: [] }` and printed **"No pull requests found."** — an unreadable
repository and an empty one were the same answer, for every `--state`.

The read now carries its outcome (`ListPullRequestsResult`: `{ ok: true, prs }`
or `{ ok: false, error }`), and `ok: true` with an empty `prs` is the only way
to say "none". `services/github.ts` raises `ServiceError(502, …)` on a failure
and the route's existing `ServiceError` handler answers non-2xx, which the
shim already renders through `formatError`. The merged path needs its own
guard: GraphQL reports a permission failure as an `errors` array in a **200**,
so `res.ok` is not enough there.

This is the same fix `viewPullRequestResult` applies to the single-PR read
(docs/255), and it is deliberately shaped the same way — except that a list has
no analogue of that read's 404, where absence is a genuine answer. No status on
this path means "there are none".

### Auth and identity

The shim never sees the GitHub token. The orchestrator owns it. If GitHub auth is not configured for the session, the worker rejects the request with a clear error: *"GitHub is not connected for this ShipIt session. Ask the user to connect GitHub in the UI."* The shim prints this verbatim.

The workspace's git config still uses the user's identity (`/credentials/.gitconfig`); the agent's commits keep their existing authorship. The shim only touches GitHub-side state.

### Push semantics

`gh pr create` requires a pushed branch. Two options:

1. **Mirror `quickCreatePr`**: the orchestrator pushes synchronously before creating the PR (current behavior of the harness path). The agent doesn't have to push manually.
2. **Require push first**: the agent runs `git push` before `gh pr create`. But `git push` doesn't have credentials inside the container today (no helper configured) — would require its own surface.

We pick (1). `gh pr create` behind the shim does push-then-create, just like `quickCreatePr` already does. The agent doesn't need a separate push affordance.

**Commit flush (added later):** since the agent calls `gh pr create` *mid-turn* — before the normal end-of-turn `postTurnCommit` has fired — the working tree typically still has uncommitted edits when the shim hits `/pr/agent-create`. Without a flush, the new PR would be opened against the branch's previously-committed state and the agent's just-made edits would not appear on the PR. The route now resolves the session's runner from the registry, commits any pending changes via `flushPendingTurnCommit` (using `runner.turnSummary` as the commit message), and clears any pending auto-push debounce before pushing synchronously. The "don't commit yourself" rule in the agent's system prompt stays intact — the shim handles it. Implementation: `services/github.ts` (`flushPendingTurnCommit`, `agentCreatePr`).

**Labels (added later):** `gh pr create`/`gh pr edit` accept `-l`/`--label` (repeatable and comma-separated, normalized to a string array in the payload). Labels are threaded shim → `/agent-ops/pr/*` worker route → orchestrator route → `agentCreatePr`/`editPullRequest`, then applied by the orchestrator via `GitHubAuthManager.addLabelsToPullRequest` (the issues `labels` endpoint, additive) — the GitHub token never reaches the container, same as PR creation. This is the *agent-driven* labeling path: the agent picks one primary label by semantic intent so the repo's `.github/release.yml` groups release notes correctly. It is complementary to — not a replacement for — the server-side **path-based** auto-labeler (a sibling effort): path heuristics catch what the agent forgets, the agent's intent catches what paths can't infer. Labeling is **best-effort**: a label name that doesn't exist on the repo (422), a token without label-write (403), etc. degrade to a non-fatal `labelWarning` on the result — the shim prints it on stderr while still printing the PR URL and exiting 0. A wrong label must never block opening a PR. Implementation: `github-auth-prs.ts` (`addLabelsToPullRequest`), `services/github.ts` (`applyPrLabels`).

**Label add/remove on edit (added later):** `gh pr edit` additionally supports the real-gh `--add-label` and `--remove-label` flags so the agent can correct/re-label a PR after creation (e.g. switch `documentation` → `enhancement`). Both are repeatable and comma-separated; `--label`/`-l` stays as an additive alias for `--add-label`. They thread through the payload as `addLabels` / `removeLabels` (shim → worker PATCH route → orchestrator PATCH `/pr/:number` → `editPullRequest`). Adds reuse the additive `labels` endpoint (`addLabelsToPullRequest`); removes call the per-label `DELETE issues/{n}/labels/{name}` endpoint once per name (`removeLabelFromPullRequest`). Both are best-effort with the same `labelWarning` contract — a typo'd add (422) or a forbidden remove (403) degrades to a non-fatal stderr warning while the edit still succeeds, and a remove of a label that isn't on the PR (404) is treated as success (idempotent). Implementation: `github-auth-prs.ts` (`removeLabelFromPullRequest`), `services/github.ts` (`removePrLabels`, `editPullRequest`).

**Read-only workflow runs (added later):** the shim now also brokers a
read-only GitHub Actions surface so a session can fetch the results of a
manually-dispatched (`workflow_dispatch`) — or any other — workflow run without
leaving ShipIt. Supported: `gh run list` (filter by `-w/--workflow`,
`-b/--branch`, `-s/--status`, `-L/--limit`), `gh run view [<run-id>]` (with
`--log` / `--log-failed` to append job logs; no id → the latest run for the
current branch, falling back to the latest run overall), `gh workflow list`, and
`gh workflow view <workflow>` (by name/filename/id, plus its recent runs). The
chain mirrors the PR ops exactly — shim (`run`/`workflow` command groups in
`gh.ts`) → `/agent-ops/{run,workflow}/{list,view}` worker routes → repo-aware
(`cwd`/`repo`) orchestrator routes `GET /actions/runs[/view]` and
`GET /actions/workflows[/view]` → `services/github.ts` → new
`github-auth-actions.ts` module → GitHub REST. The token never enters the
container, identical to PR creation. Logs
are assembled per-job from the plain-text `actions/jobs/{id}/logs` endpoint
(reusing the existing `getJobLogs`) and tail/total-capped to keep output sane;
GitHub masks registered secrets (`***`) in those logs. Implementation:
`github-auth-actions.ts`, `services/github.ts`
(`listWorkflowRuns`/`viewWorkflowRun`/`listWorkflows`/`viewWorkflow`),
`api-routes-github.ts`, `agent-ops-routes.ts`, `gh.ts`.

**`gh run rerun` (added later) — unbundling re-run from dispatch/cancel/delete:**
the Actions surface above shipped read-only, with `gh workflow run`, `gh run
rerun`, `gh run cancel` and `gh run delete` blocked together as "CI
manipulation". That grouping turned out to be wrong for one of the four. CI on
PR #2031 failed in GitHub's "Prepare all required actions" phase — 503 then 500
from action resolution, *before* checkout, on a tree whose previous run was
green. Nothing in the repo caused it and nothing in the repo could fix it; the
correct response was to re-run the job, and the agent could not. The only
in-ShipIt workaround was pushing an **empty commit** — a no-op in branch history
that also re-runs everything instead of the failed jobs — and the alternative was
sending the user to github.com to click "Re-run jobs", which §1/§4 call a product
failure, not a design.

The distinction that justifies the split: `gh workflow run` **dispatches** an
arbitrary workflow (effectively arbitrary execution with the repo's secrets);
`cancel`/`delete` **destroy** state; `rerun` re-executes *already-committed,
already-run* workflow content against an *existing* commit. It selects no
workflow and destroys nothing — and the agent already causes those same workflows
to execute on every turn, because ShipIt auto-pushes the branch. Blocking it
never removed the capability; it only forced the destructive path to it. The
other three stay blocked, and the surrounding module/route comments now state the
line rather than the old grouping.

**Three guardrails, in `services/github.ts` (`rerunWorkflowRun` / `rerunRefusal`).**
A Codex review of the first draft was right that "rerun adds no authority" is
false as stated — it named several capabilities re-run would grant that pushing
cannot. Each guardrail closes one, and together they reduce re-run to "the CI my
own push already caused":

1. **Same branch** — `run.headBranch === currentBranchOrNull()`. Without it an
   explicit run id re-executes a merged deploy or release workflow on
   `main`/`stable`. Deliberately NOT `getCurrentBranch()`, which masks a detached
   HEAD as `"main"` and would authorize exactly the runs the check exists to
   refuse; a detached HEAD is a 409.
2. **Same commit** — `run.headSha === getHeadHash()`. GitHub re-runs against the
   run's *original* `GITHUB_SHA`/`GITHUB_REF`
   ([docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)),
   so without this the agent could replay any historical commit's CI, whereas
   pushing can only ever run the current tree.
3. **Push / PR events only** — a `workflow_dispatch` run on this branch was
   started by a human, and replaying it is dispatching by proxy, which is the
   authority we just declined to grant.

(1) and (2) are both load-bearing and neither subsumes the other: a fresh session
branch points at its base branch's tip, so SHA alone would authorize `main`'s
run, while a long-lived branch has many runs under one name at different SHAs.

Two things the same review corrected in the write-up rather than the code, worth
recording because the first draft asserted both wrongly. Re-runs use the
privileges of the **original** triggering actor, not the re-runner's — so the
agent gains no elevated context. And "identical code runs again" is true only of
`--failed`: GitHub pins a failed-job re-run to the first attempt's reusable-workflow
SHA, while re-running *all* jobs re-resolves a mutable branch/tag ref and can
therefore execute different content
([docs](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#behavior-of-reusable-workflows-when-re-running-jobs)).
Both modes stay available — a `startup_failure` run has no failed jobs to
re-run, which is precisely the shape of the incident that motivated this — but
the agent-facing docs now steer to `--failed` first and say why.

Declined from that review, with reasons: gating re-run behind a
dangerous-operation grant or user confirmation (the empty-commit workaround needs
no grant and does strictly more damage, so gating only the safer path is
incoherent); making `--failed` mandatory (it cannot retry a `startup_failure`);
and a `requirements.md` for this doc (appending a capability to a feature that
predates the discipline is not the material rework the rule attaches to).

With no id, resolution is the latest run on the current branch; note the
deliberate divergence from `viewWorkflowRun`, which falls back to the latest run
*overall* — safe for a read, branch-escaping for a write. Chain: `gh run rerun
[<run-id>] [--failed]` → `POST /agent-ops/run/rerun` → `POST
/api/sessions/:id/actions/runs/rerun` → `rerunWorkflowRun` →
`actions/runs/{id}/rerun` or `…/rerun-failed-jobs`. The run id is validated
against `/^[1-9]\d*$/` at BOTH the shim and the route (the route is
container-reachable, and bare `Number()` would silently accept `1e3`, `0x2a`,
`1.5` and address a different run). GitHub's 403 is ambiguous, so the service
lists the common causes while keeping GitHub's own message — the fine-grained-PAT
case needs the repository's "Actions" permission set to *Read and write*, while a
classic token gets it from `repo`.

On token provenance, verified rather than assumed: every `github-auth-*.ts` REST
call — including this one — uses the connected user token (`this._token`), a
user-supplied PAT. The short-lived **GitHub App installation token** is minted
only for the git credential broker (`mintRepoScopedToken`, used by
`api-routes-github.ts`'s `/git/credential`), and its
`INSTALLATION_TOKEN_PERMISSIONS` deliberately omits `actions` — so it is not on
this path, and re-run does not widen it. That the existing read-only `gh run
list|view` already needs `actions:read` from the same token is the evidence: they
work today, so the token in play carries Actions permissions.

### Interaction with the harness fallback

`claude-execution.ts:259-301` calls `quickCreatePr` after the post-turn commit when `autoCreatePr` is on. `quickCreatePr` already short-circuits if a PR exists for the branch (`services/github.ts:242-254`). So:

- If the agent ran `gh pr create` mid-turn → PR exists → harness fallback no-ops with a "found existing PR" return.
- If the agent didn't → harness fallback fires the existing path, including the (currently empty) `generateText` description. **Fixing the empty-body bug is a side benefit, not the goal of this doc** — see "Open question" below.

There is no need to coordinate the two paths beyond the existing dedup.

### Agent-facing documentation

Update `src/server/shipit-docs/github.md` to tell the agent:

- It can run `gh pr create -t "<title>" -b "<body>"` at end-of-work.
- It should write a real title and a body that explains *why* (Summary / Rationale / Changes / Test plan).
- It should keep the PR body current with `gh pr edit` after later turns materially change behavior or rationale, maintaining a stable rationale section rather than appending raw logs.
- The list of supported subcommands and the rejected ones.
- That `gh` here is a ShipIt shim, not the real `gh`.

### Agent system prompt

The PR instruction in `agent-instructions.ts` is unconditional and static so prompt caching stays stable. It tells the agent:

> When you finish a meaningful chunk of work and there isn't already an open PR for this branch, run `gh pr create -t "<title>" -b "<body>"` to open one. Write a clear title and a markdown body with `## Summary`, `## Rationale`, `## Changes`, and `## Test plan` sections. Explain why meaningful behavior changes were needed, and use `gh pr edit` to keep that rationale current on later turns.

The prompt does not branch on whether a PR exists, whether files changed, or on the `autoCreatePr` setting; those runtime checks happen in the agent's actions and the orchestrator fallback, not in prompt assembly.

## Phasing

| Phase | Scope | Status |
|---|---|---|
| **1** | Build the shim + worker `/agent-ops/*` routes + supporting orchestrator endpoints. Update `shipit-docs/github.md`. **No agent prompt changes.** Harness path untouched. The agent *could* use `gh` if it decides to, but nothing nudges it. This phase is fully backwards-compatible. | done |
| **2** | Update `agent-instructions.ts` to recommend `gh pr create` when `autoCreatePr` is on. The agent now drives the happy path; harness is the backstop. This is when empty-body PRs go away in practice. | done |
| **3** *(optional)* | Reduce the harness fallback to a true backstop that only fires N seconds after turn-end if no PR was created by the agent. Removes the "double work, dedup-saves-us" pattern. Probably not worth doing until we have telemetry showing harness fallback rarely fires. | planned |

## Security model

Threats considered:

| Threat | Mitigation |
|---|---|
| Agent uses real `gh api` to call arbitrary GitHub endpoints | Real `gh` not installed. Shim rejects `gh api`. |
| Agent operates on a different repo (`--repo other/x`) | `--repo` flag rejected. Worker injects session's repo. |
| Agent reads the GitHub token (`echo $GITHUB_TOKEN`, `cat /credentials/...`) | Token never injected into container env or filesystem; only the orchestrator on the host has it. |
| Agent escalates from PR creation to repo/release/workflow mutation | Allowlist denies all of these. |
| Prompt injection in PR body (e.g., user-influenced text containing markdown that triggers GitHub Actions, autolinks, etc.) | Same risk surface as the existing harness path. Bodies are passed through unchanged. Mitigation is at GitHub, not us. |
| Spamming PRs / GitHub abuse | Agent only acts during user-driven turns; existing rate limits apply. Optional: add a per-session debounce in the worker (e.g., max 1 `gh pr create` per turn). |
| Shim binary tampered with by the agent | `/usr/local/bin/gh` is in the image, owned by root, not writable by the agent's process. The agent could `PATH=/something/else gh` but the shim doesn't gate security — the worker's allowlist does. |
| Worker `/agent-ops` reachable from outside the container | Bind to localhost only inside the container; orchestrator's existing reverse proxy doesn't forward this path. |

The trust boundary that matters: **the worker's `/agent-ops/*` allowlist**. Shim and prompt are conveniences; the worker is the security gate.

## Open questions

1. **Should Phase 1 also fix the empty-body bug independently?** The current `generateText` no-op is a separate, smaller bug. We could land a one-line fix that routes `generateText` through a session-scoped proxy agent (see `docs/116`'s sibling discussion of "approach #1") without doing this whole shim. Recommendation: **no — fix it via Phase 2 of this doc instead.** Two fixes for the same symptom is wasted work, and the shim is the better long-term answer.
2. **Do we want `gh issue create` in v1?** It's tempting because the agent often uncovers follow-up work it doesn't want to do now. But it widens the surface and complicates the trust story. Recommendation: defer.
3. **What about `git push`?** Currently authenticated only on the orchestrator side. The shim pushes implicitly via `gh pr create`. If the agent ever needs a standalone authenticated push, we add it later — out of scope here.
4. **Should the shim live in `src/server/session/` or `src/agent-shim/` or its own package?** Recommendation: `src/server/session/agent-shim/gh.ts` (compiled to `/usr/local/bin/gh` in the Dockerfile via `tsc` in the build stage). Keeps it close to the worker code that brokers it.

## Tests

Phase 1 coverage shipped:

- **[done] Shim unit tests** — `src/server/session/agent-shim/gh.test.ts` covers
  argument parsing (positional/value/boolean/`--flag=value`), allowlist
  enforcement, every supported subcommand's happy path, JSON-field filtering,
  `--body-file` markdown body handling (including backticks preserved outside
  shell argument evaluation), PR-number fallback to current branch, error
  formatting (auth/validation), and exit codes. 50 cases.
- **[done] Worker broker tests** — `src/server/session/agent-ops-routes.test.ts`
  covers every `/agent-ops/*` route, body+query forwarding, status
  pass-through, and the misconfigured-orchestrator-client failure mode.
  11 cases.
- **[done] Allowlist denial tests** — covered by the shim unit tests above
  (`gh api`, `gh repo`, `gh release`, `gh workflow`, `gh auth`, `gh secret`,
  `gh ssh-key`, `gh codespace`, `gh extension`, `gh issue`, `gh gist`,
  `gh run`, plus unknown subcommands and `--repo`/`--web` flags).
- **[done] Backstop interaction (regression) test** — `pr-auto-create-on-turn.test.ts`
  continues to pass unchanged: the harness fallback still fires when the
  agent doesn't drive PR creation.

Phase 2 coverage shipped:

- **[done] Agent-instructions unit tests** —
  `src/server/orchestrator/agent-instructions.test.ts` covers the static
  rendering of `buildAgentSystemInstructions` (the PR nudge, browser-tools
  section, branch guidance, and design-doc statuses). The earlier
  `autoCreatePr` / `previewUrl` / string-arg-form tests were removed when the
  builder was made unconditional to preserve the Anthropic prompt cache.
- **[done] Integration test** —
  `src/server/orchestrator/integration_tests/agent-driven-pr.test.ts` covers
  - The agent's system prompt unconditionally contains the `gh pr create`
    nudge — neither GitHub auth state nor the `autoCreatePr` setting gates it.
    (The earlier negative-gating tests were removed alongside the conditional.)
  - `POST /api/sessions/:id/pr/agent-create` (the orchestrator end of the
    shim chain) routes through to `GitHubAuthManager.createPullRequest` with
    the agent-supplied title and body — not a harness-derived description.
  - Dedup: when the agent has already created a PR for the branch, the
    harness backstop's `quickCreatePr` short-circuits via `findPullRequest`
    and does not double-create.

## Key files

| File | Change | Status |
|---|---|---|
| `src/server/session/agent-shim/gh.ts` | **New.** The shim entry point. Parses args, calls the worker, formats output. | done |
| `src/server/session/agent-shim/gh.test.ts` | **New.** Unit tests for parsing, allowlist, every subcommand, error formatting. | done |
| `src/server/session/session-worker.ts` | Register `/agent-ops/*` routes; accept a `createOrchestratorClient` injection point. | done |
| `src/server/session/agent-ops-routes.ts` | **New.** The narrow allowlist router. Pipes shim requests to the orchestrator. | done |
| `src/server/session/agent-ops-routes.test.ts` | **New.** Tests every relay route + misconfig path. | done |
| `src/server/session/orchestrator-client.ts` | **New.** Tiny HTTP client for worker→orchestrator. Reads `SHIPIT_HOST`/`SHIPIT_PORT`/`SESSION_ID` from env. | done |
| `src/server/orchestrator/api-routes-github.ts` | New routes: `POST /pr/agent-create`, `PATCH /pr/:n`, `GET /pr/list`, `GET /pr/view`, `POST /pr/:n/{comment,ready,close,reopen}`. | done |
| `src/server/orchestrator/services/github.ts` | Added `agentCreatePr`, `editPullRequest`, `commentOnPullRequest`, `markPrReady`, `closePullRequest`, `reopenPullRequest`, `viewPullRequest`, `listPullRequests`. | done |
| `src/server/orchestrator/github-auth-prs.ts` | Added `updatePullRequest`, `addPullRequestComment`, `markPullRequestReady`, `listPullRequests`, `viewPullRequest` (REST + GraphQL via fetch). | done |
| `src/server/orchestrator/github-auth.ts` | Wrapper methods on `GitHubAuthManager` for the new PR operations + the read-only Actions reads. | done |
| `src/server/orchestrator/github-auth-actions.ts` | **New.** Read-only GitHub Actions REST wrappers: `listWorkflowRuns`, `getWorkflowRun`, `listWorkflowRunJobs`, `listWorkflows`, `getWorkflow`. Backs `gh run`/`gh workflow`. | done |
| `docker/Dockerfile.session-worker.{dev,prod}` | Install shim at `/usr/local/bin/gh` as a small `sh` wrapper that runs `/app/node_modules/.bin/tsx …/gh.ts`. The `.docker` image inherits via `BASE_IMAGE`. The shim invokes tsx by absolute path rather than `node --import tsx`, because the bare specifier resolves against cwd's `node_modules` — fine in the ShipIt repo (which depends on tsx) but fails with `Cannot find package 'tsx'` from /workspace in any user repo that doesn't. | done |
| `src/server/shipit-docs/github.md` | Documents the shim — supported / rejected subcommands, push semantics, auth model. | done |
| `src/server/orchestrator/agent-instructions.ts` | *(Phase 2)* Includes the "use `gh pr create`" instruction unconditionally. The builder takes no arguments — keeping the rendered prompt static preserves the Anthropic prompt cache across turns. | done |
| `src/server/orchestrator/agent-instructions.test.ts` | *(Phase 2)* Unit tests for the static rendering (PR section, browser tools, branch guidance, design-doc statuses). | done |
| `src/server/orchestrator/ws-handlers/agent-execution.ts` | *(Phase 2)* Calls `buildAgentSystemInstructions()` with no arguments. The `autoCreatePr` setting still drives the post-turn harness fallback and the Stop hook env var — just not the prompt itself. | done |
| `src/server/orchestrator/services/settings.ts` | *(Phase 2)* Renders `agentSystemInstructions` for the Settings UI via the static `buildAgentSystemInstructions()`. | done |
| `src/server/orchestrator/integration_tests/agent-driven-pr.test.ts` | *(Phase 2)* End-to-end coverage of the agent-driven path: system-prompt nudge, orchestrator → `GitHubAuthManager` wiring, harness dedup. | done |
| `src/server/orchestrator/integration_tests/test-helpers.ts` | *(Phase 2)* `StubGitHubAuthManager` now records `createPullRequest` calls in `createPullRequestCalls`, so tests can assert on the title/body the orchestrator sent. | done |

## Future extensions

- **`gh issue *`** subset for follow-up tracking.
- **Per-repo allowlist policy** — `shipit.yaml` could let advanced users opt in to a wider surface (e.g., `gh release create`).
- **Telemetry** on which subcommands the agent uses, to inform future allowlist changes.
- **Replace harness fallback entirely** once Phase 2 has been stable for a while and we have data showing the agent reliably uses the shim.
