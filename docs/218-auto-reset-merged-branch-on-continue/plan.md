---
issue: https://linear.app/shipit-ai/issue/SHI-189
title: Auto-move a merged session's branch to latest base when work continues
description: When a user resumes a merged session, fetch and reset the branch to the latest base before the turn runs, and tell the agent its branch was moved.
---

# Auto-move a merged session's branch to latest base when work continues

## Problem

After a session's PR merges, its branch is left **exactly where it was** at the
pre-merge tip. Nothing fetches, rebases, or resets it (the merge path only stamps
`merged_at` and prunes volumes — `markMergedAndPruneExcess`). So when a user keeps
the session alive and asks for the *next* slice of work, the branch still points at
the now-superseded merged commits, sitting behind the advanced base.

Today the only way the branch catches up is **manually**: the user (or the agent,
following the system-prompt instruction) runs `git fetch origin && git reset --hard
origin/<base>` (or a rebase) themselves, and ShipIt's **reactive** re-arm machinery
then notices and updates the PR card:

- **docs/202** — branch *rebased onto base + new work* → re-arm + new PR.
- **docs/216** — branch *reset to a clean base* → re-arm + clean "ready" card.

Both react to a git move the human already made. Neither **performs** the move. The
result: the user has to remember the incantation, or the agent burns a turn (and
risks getting it subtly wrong — wrong base, force-push lease staleness, conflict
handling) on plumbing before it can do the actual work. In a chat-shaped IDE the
expected behavior is that resuming a shipped session just *starts from latest* —
the box operates itself (CLAUDE.md §5: the agent is the actor).

## Goal

When a user sends a **new message** to a **merged** session whose branch **has not
moved since the merge**, ShipIt should, **before the agent turn runs**:

1. `git fetch origin` and **`git reset --hard origin/<base>`** — move the branch to
   the latest base, where `<base>` is the merged PR's own base branch.
2. **Inject a context message** into the turn telling the agent its previous PR
   merged and the branch was moved to the latest base, so it starts fresh against
   current code (and does not try to "re-apply" already-shipped work).

…and otherwise do nothing — a session that hasn't merged, or whose branch the user
has *already* moved past the merge, is untouched.

This is the **proactive** producer of the exact state docs/216 already detects:
after the auto-reset the branch sits at the base tip, so the existing post-turn
re-arm flows clear the stale merged card for free (see "Composition" below). No new
card logic is required.

## Why lazy (on continue), not eager (on merge)

The merge is detected in the **poller** (`pr-status-poller.ts`), a background loop
in the orchestrator. Resetting there is the wrong place:

- **The common case is "done."** Most merged sessions are finished — the work
  shipped, nobody resumes them. Resetting every merged branch eagerly is wasted
  work on branches no one will touch again.
- **No live container is guaranteed.** After merge → idle, the session container is
  destroyed and the workspace may be disk-evicted. The poller would have to
  rehydrate a clone just to maybe-never-use it, and risks lock races with anything
  else touching the clone.
- **It only matters when work continues.** The branch's position is irrelevant
  until the next turn needs to build on it. Continue-time is exactly when a live,
  rehydrated workspace exists and the move has a purpose.

So the trigger is the **pre-turn path** of an interactive message, mirroring how
docs/202/216 are **post-turn** and turn-gated.

## Why `reset --hard`, not rebase

GitHub's three merge methods all leave the branch's local commits **not replayable**
onto the new base:

- **Squash** — the branch's N commits never enter the base; the base gets one new
  squash commit. A rebase would replay N commits whose content is already present →
  git drops them as empty *or* conflicts. There is nothing to replay.
- **Merge / rebase-and-merge** — the content is in the base already.

Since the branch has **no new work** (that is the gate — see below), every commit on
it is already shipped. The correct, conflict-free operation is therefore a clean
**`reset --hard origin/<base>`**: discard the now-phantom merged commits and start
the branch from the latest base. A rebase is strictly worse here (slower, can
conflict, replays phantoms). This matches the user's chosen approach.

## The safety gate — "no new work since the merge"

A hard reset is destructive, so it must fire **only** when the branch carries
nothing that isn't already merged. The signal is a **SHA equality**, captured at
merge time and checked at continue-time:

> Auto-reset iff the session is merged **AND** the branch's current local `HEAD`
> equals the **merged head SHA** recorded when the merge was detected.

If `HEAD` has moved past the recorded merged head, the user already committed new
work (or manually rebased) — we must **not** blow it away. That case is already
owned by docs/202 (rebase + new work) / docs/216 (manual reset). The proactive
reset deliberately covers only the untouched-since-merge case.

### Recording the merged head SHA

Add a persisted session field `mergedHeadSha`, set when the merge is detected in
`pr-status-poller.ts#verifyMissingPr` (the same place that stamps the terminal
merged state). Preferred source: the merged PR object's **`head.sha`** (authoritative,
already in scope from the REST verify — no local git read needed). Fallback: a local
`getHeadHash()` on the session clone at merge time.

This follows the established persisted-session-field pattern (the docs/202
`previousMergedPr` breadcrumb is the template):

1. `merged_head_sha TEXT` column + migration (`shared/database.ts`).
2. `SessionRow.merged_head_sha` + parse in `fromRow` (`orchestrator/sessions.ts`).
3. `SessionInfo.mergedHeadSha?: string` (`shared/types.ts`).
4. A setter called at merge detection; written alongside `markMerged`.

Note it is set **at merge**, unlike `previousMergedPr` which is set at **re-arm**
(`clearMerged`). Both coexist on the session row.

## Detection & action — `autoResetMergedBranchOnContinue`

A new pre-turn helper (mirroring `services/pr-rearm.ts`), run from the interactive
message path **before** the agent executes:

```
session merged?                      no → return (untouched)
mergedHeadSha recorded?              no → return (fail safe — pre-feature/false merge)
prior base known?                    no → return (fail safe)
HEAD === mergedHeadSha?              no → return (user has new work; docs/202/216 own it)
                                     yes ↓
git fetch origin
git reset --hard origin/<base>
→ inject the agent context message for this turn
→ return { moved: true, base, fromSha, toSha }
```

The base comes from the merged PR snapshot the poller already holds
(`prStatusPoller.getStatus(sessionId).baseBranch`), same source docs/202/216 use.
All git ops are local + a single fetch; fail-safe on any error (skip the reset,
run the turn normally — never block the user's message on a git hiccup).

### Hook point

The earliest point in the interactive turn where the session context is captured
and a git op can run before the agent: `ws-handlers/agent-execution.ts#runAgentWithMessage`,
between session-track and `executeAgentTurn`, alongside the existing
`turnStartHeadHash` capture. The helper runs there; its returned context message is
threaded into the prompt (next section).

Wire it through a **shared helper** so the dispatch / system-turn path
(`dispatched-turn.ts` / `runner-registry-factory.ts`) can opt in too, avoiding the
"silently fails in one path" trap docs/202 calls out. The interactive path is the
primary target; the system-turn path is lower priority (a CI auto-fix turn on a
merged session is rare) but should share the helper rather than diverge.

### The injected agent message

The prompt passed to the agent is a plain string (`assembleAgentPrompt(...)`).
Prepend a clearly-framed system note for this turn only:

```
[System] Your previous pull request (#<N>) was merged. This branch has been
moved to the latest <base> (reset --hard to origin/<base>) — it no longer
contains the merged commits and starts from current code. Build the new work
on top of this fresh base; do not re-apply or re-create anything from the
merged PR.
```

This is a per-turn prompt prefix (not persisted chat content), so it rides the
existing prompt-assembly path with no new persistence machinery. The `#<N>` and
base come from the merged-PR snapshot.

## Composition with docs/202 / docs/216 — no new card logic

After the pre-turn reset, `HEAD == origin/<base>`. The turn runs. The **existing**
post-turn hooks then settle the PR card with zero new code:

- Agent did **new work** → `HEAD` ahead of base, two-dot diff non-empty →
  `detectAndReArmMergedSession` (docs/202) → re-arm + **new PR**.
- Agent did **nothing committable** → `headIsAtBase` true →
  `detectAndReArmResetSession` (docs/216, every-turn hook) → re-arm + **clean
  "ready" card** carrying the `previousMergedPr` breadcrumb.

Either way the stale merged card is cleared by machinery that already exists and is
already tested. This feature's net addition is purely the **pre-turn reset + the
injected message**; the post-merge card lifecycle is unchanged.

Because docs/216 clears `merged_at` post-turn, the pre-turn gate (`session.mergedAt`)
is false on subsequent turns, so the reset naturally **fires once** per merge.

## Edge cases

- **User already has new work since merge** (`HEAD !== mergedHeadSha`). Skip the
  reset entirely — their work is sacred. docs/202/216 handle the card.
- **`mergedHeadSha` missing** (session merged before this feature shipped; or a
  rate-limit false-merge where no real merge sha exists). Fail safe → skip the
  reset. No silent data loss.
- **False merge positive.** The poller documents that a persisted "merged" can be a
  rate-limit false positive. The `HEAD === mergedHeadSha` gate means we only reset a
  branch the user hasn't touched, and a hard reset is **recoverable**: the old
  commits survive in the local reflog and (typically) on the still-present remote
  branch, and we do **not** force-push at reset time. As belt-and-suspenders, the
  helper may stamp a recovery ref (e.g. `refs/shipit/pre-reset/<shortSha>`) before
  resetting. Net risk: low and reversible. (Merged state is itself REST-confirmed by
  `verifyMissingPr`, not bulk-view-only, so genuine false positives are narrow.)
- **Dirty working tree.** A merged session is post-auto-commit, so the tree is
  clean and `HEAD === mergedHeadSha`. As a guard, skip the reset if the tree is
  dirty (don't hard-reset over uncommitted changes) and let the agent decide.
- **`origin/<base>` missing / fetch fails / workspace evicted.** Fail safe → skip,
  run the turn normally. The continue path rehydrates the clone before this hook, so
  in practice the workspace is live.
- **Base already equal to HEAD.** Harmless no-op reset; the gate would not have
  fired anyway (post-squash `HEAD != origin/<base>`).

## Product-principle check

- **§5 agent-as-actor / no shell-shaped affordance.** The user continues in chat;
  ShipIt operates the box (fetch + reset). No button, no manual incantation.
- **§1/§2 inline.** Nothing leaves ShipIt; the branch move and its explanation
  surface inline (the injected note to the agent; the docs/216 "ready" card to the
  user).

## Key files

| Area | File | Change |
|---|---|---|
| Capture | `src/server/orchestrator/pr-status-poller.ts` | At merge detection (`verifyMissingPr`), record the merged PR's `head.sha` as `mergedHeadSha` |
| Persist | `src/server/shared/database.ts` | `merged_head_sha TEXT` column + migration |
| Persist | `src/server/orchestrator/sessions.ts` | `SessionRow.merged_head_sha` + `fromRow` parse + setter (written with `markMerged`) |
| Type | `src/server/shared/types.ts` | `SessionInfo.mergedHeadSha?: string` |
| Detection + action | `src/server/orchestrator/services/pre-turn-reset.ts` (new) | `autoResetMergedBranchOnContinue` — gate → fetch → `reset --hard origin/<base>` → return injected message + move info; fail-safe |
| Git primitives | `src/server/shared/git.ts` | Reuse `getHeadHash`, `fetch`, `hardResetToCommit`; resolve `origin/<base>` tip via `revparse` (all exist) |
| Pre-turn wiring | `ws-handlers/agent-execution.ts` (+ shared with `dispatched-turn.ts` / `runner-registry-factory.ts`) | Call the helper between session-track and `executeAgentTurn`; prepend the returned note to `prompt` |

## Testing

- `git.test.ts` — already covers `getHeadHash`/`fetch`/`hardResetToCommit`; add a
  reset-to-`origin/<base>` integration if a gap exists.
- `pre-turn-reset.test.ts` (new) — gate matrix: non-merged → no-op; merged but
  `HEAD !== mergedHeadSha` → no-op; merged + equal + base known → fetch + reset +
  message returned; missing `mergedHeadSha`/base → no-op; dirty tree → no-op; git
  throw → fail-safe no-op.
- `sessions.test.ts` — `mergedHeadSha` round-trips (set at merge, read in `fromRow`).
- Integration — a continue turn on a merged untouched session resets the branch to
  base and the post-turn docs/216 hook clears the merged card; a continue turn on a
  merged session with new commits leaves the branch alone and follows docs/202.

## Open questions

- **User-visible signal at reset time.** The agent is told via the injected note;
  the user sees the state change via the post-turn docs/216 "ready" card. Is that
  enough, or do we also want a small inline note in the transcript ("Moved branch to
  latest <base>") at reset time? If yes, it must be **persisted** transcript content
  (CLAUDE.md "Chat transcript content MUST be persisted"), not an emit-only card —
  scope that as a follow-up rather than folding it in here.
- **Recovery ref.** Always stamp `refs/shipit/pre-reset/<sha>` before resetting, or
  rely on reflog + the surviving remote branch? Leaning reflog-only for simplicity,
  with the ref as a cheap optional safeguard.
