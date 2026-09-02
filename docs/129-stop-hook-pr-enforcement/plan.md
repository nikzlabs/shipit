---
issue: planning#189
---

# 129 — Stop-hook enforcement of agent-driven PR creation

## Summary

Convert the existing "open a PR at end-of-turn" instruction from a *prompt-level
hope* into a *Stop-hook enforcement*. When `autoCreatePr` is on, the Claude
CLI is launched with `--settings /etc/shipit/managed-settings.json`, which
registers a Stop hook that refuses to let a turn finish while the branch has
unmerged commits and no PR. The hook hands the work back to the agent — the
agent itself writes the title and body, with full conversation context.

This is the answer to the empirically-observed compliance problem with the
existing system-prompt nudge (`agent-instructions.ts:62-81`): agents read
"please run `gh pr create`" and routinely don't. The hook makes the prompt
non-optional without taking the title/body authorship away from the agent.

> **Update (docs/130-block-branch-ops):** the gating mechanism described
> below changed. `managed-settings.json` is now passed to the Claude CLI
> *unconditionally* (for the `claude` agent) so it can also register an
> always-on PreToolUse branch-block hook. PR enforcement stays opt-in: the
> Stop hook self-gates on the `SHIPIT_AUTO_CREATE_PR` env var, which
> `agent-execution.ts` sets only when `autoCreatePrActive` is true. The
> "Wire-up", "Files", and "Why `--settings` flag" sections below describe
> the original conditional-`--settings` design; the decision table and
> fail-open posture are unchanged.

## Motivation

Two compounding facts:

1. **Server-side summarization of PR titles/bodies produces low-quality
   output.** The previous fallback (`generatePrDescription` in
   `services/github.ts`) feeds `git log` + `diffSummary` to an LLM. Those
   inputs describe *what* changed but not *why*. The agent that wrote the
   change knew why; a separate summarizer doesn't.
2. **Telling the agent "please call `gh pr create`" is unreliable.** It's a
   plain prompt instruction. Agents skip it routinely, especially on long
   turns where the instruction is far back in context.

The cleanest fix is *enforcement at the same layer that already enforces
other turn-end behaviors* — the Claude Code Stop hook. The hook runs
immediately before the agent finalizes a turn. If it exits with code 2, the
agent must continue, with the hook's stderr fed back as a system message.
At that exact moment the agent has full live context of the turn it just
did — perfect for authoring a real title and body.

This pattern is option **F** in the design conversation (see also the
discussion of why options A/D are dead — both rely on the same compliance
that's already failing).

## Design

### Wire-up

```
                                 autoCreatePr on?
                                       │
                       ┌───── yes ─────┴──── no ─────┐
                       ▼                             ▼
       agent-execution.ts adds                 no --settings;
       --settings /etc/shipit/                 no Stop hook;
       managed-settings.json to                turn ends normally
       AgentRunParams
                       │
                       ▼
       claude.ts → claude CLI sees --settings → registers Stop hook
                       │
                       ▼
       on turn end: /etc/shipit/agent-hooks/stop-pr-check.sh
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
       changes ahead of base &&    everything else
       no PR exists                (no diff, PR exists,
            │                       gh auth failure,
            ▼                       not a git repo, etc.)
       exit 2 with stderr:         exit 0 — turn ends
       "run gh pr create ..."
            │
            ▼
       agent receives stderr      [normal post-turn:
       as a system message and    auto-commit, auto-push,
       continues the turn →       harness-fallback quickCreatePr
       calls gh pr create with    no-ops because PR now exists]
       its own title + body
```

### Files

| File | Role |
|---|---|
| `docker/agent-hooks/stop-pr-check.sh` | The hook itself. POSIX shell. Reads Claude's Stop-hook JSON on stdin, examines git state and gh state, exits 0 or 2. |
| `docker/agent-hooks/managed-settings.json` | Claude Code settings file that registers the Stop hook by absolute path. |
| `docker/Dockerfile.session-worker.{dev,prod,dogfood}` | `COPY` both files into `/etc/shipit/` inside the session-worker image. The `.docker` variant inherits via `BASE_IMAGE`. |
| `src/server/shared/types/agent-types.ts` | `AgentRunParams.settingsPath?: string` — new optional field. |
| `src/server/session/claude.ts` | When `settingsPath` is set, append `--settings <path>` to the spawn args. |
| `src/server/session/agents/claude-adapter.ts` | Forward `settingsPath` from `AgentRunParams` into `ClaudeRunOptions`. |
| `src/server/orchestrator/ws-handlers/agent-execution.ts` | Set `settingsPath = "/etc/shipit/managed-settings.json"` iff `autoCreatePrActive && agentId === "claude"`. Single source of truth: `autoCreatePrActive` also drives the system-prompt nudge and the harness fallback. |
| `src/server/session/claude.test.ts` | Regression: `--settings` flag is forwarded when `settingsPath` is set, omitted when it isn't. |
| `src/server/session/agent-shim/stop-pr-check.test.ts` | Functional tests for the script: runs the real `/bin/sh` against a real temp git repo with a stubbed `gh` on PATH. Covers the full decision table — stop-hook-active, not a repo, no diff, default branch, PR exists, gh auth failure, and the blocking case. |

### The hook script in detail

The hook is a small POSIX shell script (~50 lines of logic). Its decision
table mirrors the inline doc comment at the top of the file:

| Condition | Action |
|---|---|
| `stop_hook_active: true` in stdin envelope | exit 0 (we've already blocked once on this turn — don't loop) |
| Not inside a git repo | exit 0 |
| No resolvable base branch (`origin/HEAD` / `origin/main` / `origin/master`) | exit 0 |
| `HEAD` is on the default branch | exit 0 (no PR concept) |
| `git rev-list --count base..HEAD == 0` | exit 0 (no commits to PR) |
| `gh pr view` exits 0 (PR exists) | exit 0 |
| `gh pr view` errors with anything other than "No pull request found" | exit 0 (fail open — auth not configured, no remote, etc.) |
| `gh pr view` errors with "No pull request found" | exit 2, stderr tells the agent what to run |

The fail-open posture matters: users on a session with no GitHub auth, or no
remote, should not see their turns blocked by an enforcement that can't
succeed. The hook only blocks when there's a clear "PR is missing and could
be created" state.

### Why `--settings` flag, not `/root/.claude/settings.json`

`/root/.claude` in the session-worker image is a *symlink to
`/credentials/.claude`* (see the Dockerfile). That target is the user's
persisted Claude credentials volume — writing settings.json there pollutes
user data and creates an implicit dependency on volume layout. The
`--settings <file>` CLI flag is the documented way to point Claude at a
managed settings file from a known image-baked path. It's also conditional
(no flag → no hook), which gives us the autoCreatePr gating for free.

### Codex (out of scope)

The `codex-adapter` does not have an equivalent Stop hook mechanism in its
current CLI surface. The `settingsPath` field on `AgentRunParams` is silently
ignored by non-Claude adapters; the `agentId === "claude"` guard in
`agent-execution.ts` keeps the flag off for Codex sessions. If a future Codex
version exposes a hook surface, plumb it the same way.

### Loop safety

Claude's Stop-hook envelope includes a `stop_hook_active` boolean that's
`true` when the hook is being re-invoked after a previous block on the same
attempt. The first check in our script honors that flag — if a block-loop
ever forms (e.g., `gh pr create` keeps failing for some reason), the hook
yields after one round and lets the turn end.

The harness fallback (`quickCreatePr` in `post-turn.ts`) still runs after
the agent's turn finalizes. So the worst-case is: agent ignores the hook
guidance, hook gives up after one block, harness fallback fires its existing
no-context summarizer. This is no worse than today; on the happy path the
agent now creates the PR with its real understanding of the work.

## Integration with prior auto-PR docs

| Doc | Role | Relationship |
|---|---|---|
| `docs/099-auto-pr-on-meaningful-turn` | Established `autoCreatePr` setting + harness fallback after meaningful commits | This doc keeps that fallback as the backstop. |
| `docs/116-fake-gh-cli-shim` | Ships the `gh` shim the hook depends on | The hook's `gh pr view` and the agent's `gh pr create` both go through the shim → `/agent-ops/*` broker → orchestrator. |
| `docs/116-fake-gh-cli-shim` Phase 3 (planned) | "Reduce harness fallback to true backstop with delay" | This doc moves us closer: with the hook reliably forcing the agent to create the PR, the harness fallback rarely fires. |

## Tests

| Test | What it covers |
|---|---|
| `claude.test.ts` "includes --settings flag when settingsPath is provided" | Plumbing: ClaudeProcess wires the flag through. |
| `claude.test.ts` "does not include --settings when settingsPath is omitted" | Plumbing: flag is conditional. |
| `stop-pr-check.test.ts` (7 cases) | Script-level decision table — every branch from the table above is exercised against a real temp git repo with a stubbed `gh`. |

End-to-end coverage (orchestrator → worker → CLI flag) is implicitly
covered by the existing `agent-driven-pr.test.ts` integration test plus
the new unit tests; a dedicated e2e for the hook would require running the
actual Claude CLI against a managed-settings.json, which is out of scope.

## Update — merged/closed-aware, net-diff-gated enforcement (duplicate-PR fix)

A long-running session whose PR was **merged mid-session** (with rebases
between turns) created a *new* PR on every subsequent turn (#1302 → #1312 →
#1314 → #1316). The Stop hook printed "no PR exists yet" each turn, and
`gh pr status` reported "No PR for the current branch" even right after a
merge. One offending turn was a net-zero revert.

### Root cause

Every PR-detection surface resolved the branch's PR via
`GitHubAuthManager.findPullRequest(owner, repo, head)`, which queries
`?head=owner:branch&state=open`. The lookup is **by branch name** (rebase-stable
already — the `head` filter matches the ref, not a commit SHA), but it is
**open-only**:

- The Stop hook's `gh pr view --json url` → `viewPullRequest` (no-number) →
  `findPullRequest` (open) → a merged PR returns `null` → "No pull request
  found" → the hook blocked and re-prompted `gh pr create`.
- `gh pr status` → `getPrStatus` → same open-only lookup → "No PR".
- `gh pr create` → `agentCreatePr` short-circuited only on an **open** PR, so
  once the prior PR merged it cheerfully created a duplicate.

Separately, the hook gated on `git rev-list --count base..HEAD` (commits-ahead)
and **never** on a net diff, so a revert that nets to zero still re-prompted.

### Fix

1. **State-aware, rebase-stable PR resolution** (`services/github.ts`). New
   `findBranchPr()` prefers an open PR, then falls back to
   `findPullRequestAnyState()` (the `state=all` query that already backed the
   poller's restart probe). `getPrStatus`, `viewPullRequest` (no-number), and
   `agentCreatePr`'s short-circuit all route through it. `getPrStatus` now
   returns `state` + `merged`; `gh pr status` / `gh pr view` surface a
   merged/closed PR instead of looking PR-less.
2. **`agentCreatePr` never duplicates** (defense-in-depth for H4). When a PR
   exists in any state it returns that PR's metadata with
   `alreadyExisted: true`. It pushes only to a still-**open** PR (a merged PR's
   branch may be deleted on the remote); a merged/closed PR is returned without
   a push or a second `createPullRequest`.
3. **Net-diff gate in the hook** (`stop-pr-check.sh`). After the commits-ahead
   check, `git diff --quiet "$BASE...HEAD"` fails open (exit 0) on an empty net
   diff — a revert, or a branch merged-then-rebased onto the updated base so its
   content already lives there. The `if` suspends `set -e` so a non-empty diff
   doesn't abort the script. The existing `gh pr view` check now recognizes
   any-state PRs (via fix #1), so an already-PR'd branch is never re-prompted.

The decision becomes: **block only when commits are ahead AND the net diff vs
base is non-empty AND the branch has never had a PR in any state.** First-PR
enforcement (a real change with no PR) is unchanged; the PreToolUse branch-block
hook (docs/130) and the `SHIPIT_AUTO_CREATE_PR` opt-in are untouched.

### Deliberate tradeoff

Once a branch's PR has merged/closed, neither the hook nor `agentCreatePr` will
open a *second* PR for genuinely new post-merge work — it returns the
prior (merged) PR instead. This is intentional: the ShipIt model is one branch =
one PR lifecycle, and silently spawning duplicate PRs every turn was the actual
bug. A user who wants a fresh PR for post-merge work can branch a new session or
create it explicitly.

### Tests

| Test | What it covers |
|---|---|
| `stop-pr-check.test.ts` "empty net diff vs base despite commits ahead" | Net-diff gate (revert) → exit 0 without reaching `gh`. |
| `stop-pr-check.test.ts` "merged PR already exists" | `gh pr view` succeeds for a merged PR → no re-prompt. |
| `stop-pr-check.test.ts` "commits + diff + no PR" (existing) | Genuine first change still blocks (exit 2). |
| `pr-status.test.ts` "surfaces a merged/closed PR" / "pr/view resolves a merged PR" | `getPrStatus` / `viewPullRequest` fall back to any-state. |
| `agent-driven-pr.test.ts` "does NOT create a duplicate PR when the prior PR merged" | `agentCreatePr` returns the merged PR, no second `createPullRequest`. |

## Update — fail open during transient git state (mid-rebase/merge)

A turn that ended while the working tree was **mid-rebase** got the agent stuck.
During a rebase HEAD is detached, so the branch-skip guard
(`git symbolic-ref --short HEAD` → empty) did **not** match the base branch and
fell through; the hook saw commits-ahead + a non-empty diff + no PR for the
(nonexistent) current branch and blocked with "run `gh pr create`". But
`gh pr create` then failed to push, because HEAD isn't a branch:

```
error: The destination you provided is not a full refname (i.e., starting
with "refs/") ... 'HEAD'
```

So the hook forced the agent into an action that *cannot succeed* until the
operation completes.

### Fix

A new **transient-state guard** in `stop-pr-check.sh`, placed right after the
`git rev-parse --git-dir` repo check and before any base/commits logic, exits 0
(fail open) when ANY of these hold:

- **Detached HEAD** — `git symbolic-ref --quiet HEAD` fails (mid-rebase, or a
  bare-SHA checkout).
- **Rebase in progress** — the `rebase-merge` or `rebase-apply` dir exists
  (`git rev-parse --git-path …`).
- **Merge / cherry-pick / revert / bisect in progress** — `MERGE_HEAD`,
  `CHERRY_PICK_HEAD`, `REVERT_HEAD`, or `BISECT_LOG` exists.

The rationale matches the existing fail-open posture: a PR cannot (and should
not) be created while the tree is in a transient state — the real PR check
belongs **after** the operation finishes and HEAD is back on a branch, which a
later stop re-evaluates. The branch-skip guard is also hardened to exit 0 on an
empty `HEAD_BRANCH` (defense-in-depth) so a detached HEAD can never fall through
and block.

### Tests

| Test | What it covers |
|---|---|
| `stop-pr-check.test.ts` "HEAD is detached" | Detached HEAD + commits + diff + no PR → exit 0, `gh` never reached. |
| `stop-pr-check.test.ts` "rebase is in progress" | `rebase-merge` marker present → exit 0. |
| `stop-pr-check.test.ts` "merge is in progress" | `MERGE_HEAD` present → exit 0. |

## Update — a dead PR only silences the hook while the branch hasn't progressed

The "Deliberate tradeoff" above — *once a branch's PR has merged/closed, neither
the hook nor `agentCreatePr` will open a second PR* — stopped being true of
`agentCreatePr` in **docs/202**: a merged/closed PR now blocks creation only
while the branch has NOT moved past it, and once the branch sits on the current
base tip with new work on top, `gh pr create` opens a replacement. The `gh`
shim gained the matching wording in `existingPrNotice`
(`session/agent-shim/gh.ts`) so a reprinted URL can no longer be misread as a
fresh PR.

The Stop hook was left on the older any-state rule, and that turned into a
silent hole: a branch whose OLD PR had merged suppressed the backstop
*completely*. An agent that never ran `gh pr create` finished the turn with its
work unshipped and nothing said so — the exact failure the hook exists to
catch, made invisible by the guard that was added to stop it over-firing.

### Fix

`stop-pr-check.sh` now asks for `--json state,merged,baseRefName` instead of
`--json url`, and splits the answer:

- **OPEN** → exit 0. The work shipped.
- **MERGED / CLOSED** → run the same gate the orchestrator runs
  (`GitManager.mergedBaseProgress`, docs/202), in shell against the PR's own
  base: the branch must **contain** the current `origin/<base>` tip AND have a
  non-empty two-dot diff on top. Only `progressed` blocks; `base-not-contained`,
  `no-new-work` and `base-unknown` all exit 0.

`state` is GitHub's REST spelling, so a merged PR reads as `closed` — the
`merged` boolean is what tells a merge from an abandon, and it only selects the
wording of the block message.

The hook **fetches** `origin/<base>` (`timeout 20`) before the containment
check: that is the documented precondition of `mergedBaseProgress`, and against
a stale ref clause 1 is trivially satisfied, so an un-rebased branch would read
as "progressed" and the hook would nag about work that merged yesterday. A
fetch that fails or times out therefore **exits 0** rather than deciding from
the ref it already had — an unrefreshable ref is one more thing the hook does
not know, and every other unknown here fails open. (Review finding: the first
draft swallowed the failure and continued, which recreated the very
duplicate-PR nag this file guards against.)

### The judgement call

Firing only on `progressed` is deliberate, and narrower than "a dead PR is
never proof". `progressed` is exactly the state in which `gh pr create`
succeeds, so the hook never demands an action that cannot work — the same
posture as the transient-state guard above. The two states it stays quiet in
are the ones that would nag: a branch still sitting at the merged tip before
ShipIt resets it (indistinguishable, locally, from real new work whose base
moved on) and a branch with an empty diff. Both are refused by the shim, so
blocking would only produce a reprinted URL and a wasted turn.

### Tests

| Test | What it covers |
|---|---|
| `stop-pr-check.test.ts` "branch has progressed past its merged PR" | The hole: merged PR + branch on the base tip with new work → exit 2. |
| `stop-pr-check.test.ts` "last PR was abandoned" | `state: closed, merged: false` → blocks, wording says *closed*, not *merged*. |
| `stop-pr-check.test.ts` "base has moved on under the branch" | `base-not-contained` → exit 0; the new base tip exists only on the remote, so it also guards the fetch. |
| `stop-pr-check.test.ts` "base cannot be resolved in this clone" | Unresolvable PR base → exit 0 rather than silently substituting the local base. |
| `stop-pr-check.test.ts` "base ref exists but cannot be freshened" | A FAILED fetch → exit 0, not a decision from the stale ref that is left behind. |
| `stop-pr-check.test.ts` "no new work over the PR's own base" | `no-new-work` → exit 0. Reachable because the early three-dot gate uses the repo's default base while the progress check uses the PR's. |
| `stop-pr-check.test.ts` "an open PR already exists" | Unchanged: OPEN still exits 0 with no fetch and no gate. |

## Future extensions

- **Per-session opt-out** — currently auto-PR is global. If we add a
  per-session toggle (`SessionMetadata.autoCreatePr?: boolean`), this doc's
  `autoCreatePrActive` predicate is the single line to update.
- **Diff-size threshold** — skip the hook for very small diffs (typo fixes,
  comment-only edits). Probably handled better by the agent's own judgment
  in the PR body than a hard rule here.
- **Codex hook parity** — when/if the Codex CLI ships a Stop-hook
  equivalent, mirror this wiring in `codex-adapter` and drop the
  `agentId === "claude"` guard.
- **PR template integration** — if a repo ships `.github/pull_request_template.md`,
  surface it to the agent in the hook's stderr so the body matches house style.
