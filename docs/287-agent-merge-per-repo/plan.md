---
issue: planning#499
title: Agent merge, granted per repository — design
description: Widen the docs/224 merge gate from a per-sandbox grant to a per-repository one, and make the agent's merge flush the turn's work before it lands.
---

# Agent merge, granted per repository — design

Implements [requirements.md](./requirements.md). Extends
`docs/224-sandbox-merge-capability` (the shim, the route, the guardrails) and
reuses two mechanisms the UI merge route already has:
`services/branch-sync.ts` (`guardMergeSync`) and `flushPendingTurnCommit()`.

## What changes, in one line

`mergeDisposition()` stops asking "is this a sandbox?" and starts asking "may an
agent merge here?" — and `agentMergePullRequest()` gains the pre-merge flush that
`agentCreatePr()` has had all along.

## 1. Storage — the grant (req 1, 2, 3)

A column on the `repos` table, copying the shape of `repos.trusted`
(docs/178) — the per-repository boolean this feature is a second instance of:

```sql
ALTER TABLE repos ADD COLUMN allow_agent_merge INTEGER NOT NULL DEFAULT 0
```

A new migration entry, appended — never an edit to an existing one. `0` is the
default, and unlike `trusted` there is **no backfill**: `trusted` backfilled
existing rows to 1 because the gate arrived after the repositories did, whereas
here every repository must start with the permission off (req 2).

Reads and writes live on `RepoStore` (`orchestrator/repo-store.ts`) beside
`isTrusted()` / `setTrusted()`, and they must match on `canonicalRepoKey(url)`
for the same reason those do: rows are keyed by the raw URL a repository was
first added with, so two spellings of one remote have to share one decision.
Getting this wrong fails silently — the grant reads as off and the feature does
nothing.

The value is read server-side only. Nothing writes it into the container, no
shim command reports it, and no workspace file feeds it (req 3). This is the same
rule `SessionInfo.kind` and `SessionCapabilities` already state in their
docstrings: set server-side, never inferred from workspace files, so an agent
cannot self-elevate.

**Rejected: `shipit.yaml`.** The agent can write that file, so a permission
declared there is a permission the agent can grant itself in one commit — and
untrusted text in an issue or a pull request can ask it to. The receipt is in
requirements.md.

## 2. The gate (req 4, 5, 6, 12, 13)

`mergeDisposition()` in `src/server/orchestrator/pr-target.ts` today:

```ts
if (session.kind !== "sandbox") return "not-sandbox";
return session.capabilities?.dangerousGitHubOps ? "allowed" : "not-granted";
```

It becomes a three-way decision over the session kind, with the repository grant
passed in by the route (the helper stays pure):

| Session | Decision |
|---|---|
| `kind === "sandbox"` | as today — `dangerousGitHubOps` decides (req 12) |
| `kind === "ops"` | `"ops-refused"` — never merges (req 13) |
| repo-bound | the repository's `allow_agent_merge` decides (req 4, 6) |

Each refusal keeps its own message, as docs/224 established, so the agent can
tell "not enabled here" from "wrong kind of session":

- `not-granted-repo` → "Agents cannot merge in this repository. The user turns on
  *Allow agents to merge their own pull requests* in Project Settings." (req 6)
- `ops-refused` → unchanged wording from today's `not-sandbox` message, pointing
  at the PR lifecycle card.

### The PR must be the session's own (req 5)

The gate answers *may this session merge*. A second check answers *may it merge
this pull request*. In a repo-bound session the route resolves the pull request
for the session's current branch — the same resolution `mergePullRequest()` uses,
`git.getCurrentBranch()` → `findPullRequest` — and refuses when the requested
number differs:

> `gh pr merge` can only merge this session's own pull request (#{own}). PR
> #{asked} belongs to another branch.

This also settles the `--repo` / `cwd` overrides that `resolvePrTarget()`
supports: in a repo-bound session they cannot reach another repository's pull
request, because the number must match the session's own. Sandbox sessions keep
the wider behaviour they have today — a sandbox merges an explicit number in a
repository that need not be its own, which `merge-attribution.ts` already records.

## 3. The merge sequence (req 14, 15, 16, 17)

This is the substance of the change. `agentMergePullRequest()`
(`services/github.ts`) runs its steps in a new order, because two of them must
happen *before* the pull request is read from GitHub.

```
1. flushPendingTurnCommit(git, { sessionId, runnerRegistry, chatHistory })   (req 14)
     · secretBlocked      → 422, no merge                                   (req 15)
     · unreadableBlocked  → 422, no merge                                   (req 15)
2. guardMergeSync(git)                                                      (req 14, 17)
     · "diverged" → hold, refuse, no push
     · "ahead"    → push, then hold: "merge again once its checks report"
     · cancelAutoPush(sessionId) — only when the push actually happened
3. viewPullRequest(...)   ← now, so `pr.head` is the head we just pushed     (req 16)
4. draft / closed / already-merged short-circuits                     (unchanged)
5. getCheckStatus(owner, repo, pr.head) → failure refuses, pending refuses    (req 7, 16, 17)
6. reviewDecision gate                                                       (req 8)
7. mergePullRequest(...) → logMergePerformed(via: "gh pr merge")
```

### Why the order matters

- **Steps 1 and 2 before step 3.** Today the function reads the pull request
  first and passes `pr.head` to `getCheckStatus()`. If a push moved the head
  after that read, the guardrail would clear the *old* head's green checks and
  merge commits CI never ran on — a worse fault than the one being fixed. Reading
  the pull request after the push removes the stale SHA rather than re-fetching
  around it.
- **Step 1's two aborts are not optional.** `agentCreatePr()` already refuses
  with a 422 on both, for the reason stated in its comments: a blocked commit
  means the work is *not* on the branch, so continuing publishes the previous
  state while the agent believes its change shipped. A merge makes that
  irreversible (req 15).
- **`cancelAutoPush` only after a real push.** The debounced auto-push is
  session-keyed in `services/auto-push-scheduler.ts`; cancelling one that was
  never replaced by a synchronous push simply loses it. So `MergeSyncVerdict`
  grows a discriminator rather than the caller reading the prose:

  ```ts
  type MergeSyncVerdict =
    | { action: "proceed" }
    | { action: "hold"; reason: "pushed" | "push-failed" | "diverged"; message: string };
  ```

  The UI merge route takes the same field and ignores it, so there is one shape.
  (Its docstring already forbids parsing the message — "so the caller never
  parses prose" is the same rule one level up.)

### The refusal after a push (req 17)

`guardMergeSync` already says the right thing — *"Pushed N commits that had not
reached GitHub yet … merge again once its checks report."* The agent path appends
one clause: `--auto` arms merge-when-green, which the shim already forwards. The
command never waits by itself; the receipt for that is in requirements.md.

The practical loop is therefore two shim calls when the agent has just done work:
`gh pr merge --squash` (flush, push, refused as pending) then
`gh pr merge --squash --auto` (armed). `src/server/shipit-docs/github.md` must
say this plainly, or agents will read the first refusal as a failure.

## 4. After the merge (req 9, 10, 11)

- **The record (req 9).** `emitNoticeInTurn()` from
  `orchestrator/chat-card-persistence.ts` — it routes through `emitChatCard`, so
  it emits, records in-band and persists in one call, and it decides on
  `runner.running` whether the row rides the turn. No new card type, no column,
  no migration. `logMergePerformed()` stays as the ops-log half.
- **Poller state (req 11).** The route calls
  `poller.forceVerifySessionPrState(sessionId)` after a successful merge, exactly
  as the UI route does. Without it the card holds the pre-merge state until the
  next tick, and the two merge paths visibly differ.
- **A shippable branch (req 10).** After the merge the branch sits on the merged
  tip, so the post-turn auto-push is refused by the merged-push guard and the
  session cannot open its next pull request. `forceVerifySessionPrState` sets the
  docs/218 reset eligibility; the merge result then tells the agent, in the words
  docs/239-self-merge-wake already uses: run `shipit branch reset-to-base` before
  further work. The reset is the agent's own step, so no user action is needed.

## 5. UI (req 1)

One toggle — *Allow agents to merge their own pull requests* — in the per-repo
**Project Settings** dialog (`src/client/components/ProjectSettings.tsx`), with
help text naming what it permits: this session's own pull request, with checks
green and branch protection still enforced by GitHub.

It goes in a new **Agents** tab. The three existing tabs are Deployments,
Secrets and Appearance, and the permission is none of those; the Appearance tab's
own comment sets the precedent for that reasoning ("it gets its own tab rather
than riding along in Deployments or Secrets because neither is about how the repo
is displayed"). The alternative — a section at the foot of Deployments — keeps
the tab count down but files a permission under a heading about hosting.

## Key files

| File | Change |
|---|---|
| `src/server/shared/database.ts` | migration: `repos.allow_agent_merge` |
| `src/server/orchestrator/repo-store.ts` | `allowsAgentMerge()` / `setAllowAgentMerge()`, keyed by `canonicalRepoKey` |
| `src/server/orchestrator/pr-target.ts` | `mergeDisposition()` widened |
| `src/server/orchestrator/services/github.ts` | `agentMergePullRequest()` flush + order |
| `src/server/orchestrator/services/branch-sync.ts` | `reason` discriminator on the hold verdict |
| `src/server/orchestrator/api-routes-github.ts` | gate, own-PR check, poller refresh, notice |
| `src/server/orchestrator/api-routes-session-repos.ts` | the grant route, shaped like `/api/repos/trust` |
| `src/client/components/ProjectSettings.tsx` | Agents tab + toggle |
| `src/server/shipit-docs/github.md` | agent-facing: the grant, the flush, `--auto` |

## Tests

- `pr-target.test.ts` — every `mergeDisposition` branch: sandbox granted/not, ops,
  repo-bound granted/not.
- `services/github-agent-merge.test.ts` — flush ordering (the pull request is read
  *after* the push), both 422 aborts, `cancelAutoPush` only on `reason: "pushed"`,
  the pending-checks refusal wording, `--auto` still arming.
- `services/branch-sync.test.ts` — the `reason` discriminator on each hold.
- `integration_tests/agent-driven-pr.test.ts` — repo-bound merge allowed with the
  grant, 403 without it, 403 for another session's pull request, and the persisted
  notice surviving a history reload.
- A guard that fails if the grant is ever read from a workspace file: the
  container-facing session payload must not carry it.

## Risks

- **The own-PR check depends on branch resolution.** A session on a detached HEAD
  or a renamed branch resolves no pull request; the check must then refuse rather
  than fall through to "allowed" (fail closed — the opposite of `guardMergeSync`,
  where "cannot tell" correctly proceeds, because there the fallback is the
  status quo and here it is a merge).
- **A repository is keyed by URL.** Two spellings of one remote are two rows, so
  the grant must match on `canonicalRepoKey` as `isTrusted()` does. A miss reads
  as "not granted", which is safe but silent — the feature would simply appear
  not to work.
- **The refusal is the common path, by design.** Any turn in which the agent
  edited a file ends in a push, so the first `gh pr merge` refuses (req 17). If
  the agent-facing docs do not spell this out, agents will report a failure to
  the user instead of merging with `--auto`.
