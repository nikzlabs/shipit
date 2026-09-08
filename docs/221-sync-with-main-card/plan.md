---
issue: planning#205
description: "Sync with <base>" now also fast-forwards the session clone's local base ref (e.g. main) and leaves a persisted "Synced with <base>" transcript card, like the docs/218 branch-updated card.
---

# 221 — Sync-with-main moves local `main` + leaves a persistent card

## Context

"Sync with `<base>`" — the `PrActionsMenu` overflow item, the `RebaseBanner`
"Update branch" button, and the push-rejected nudge — all call
`startRebase(sessionId, base)` → `POST /git/rebase` → `runRebaseFlow`
(`services/rebase-driver.ts`). That flow fetched origin, rebased the **session
branch** onto `origin/<base>`, force-pushed, and emitted **transient** WS events
(`rebase_started` / `rebase_complete`) that drive the `RebaseBanner`. On a no-op
it toasted "Already up to date".

Two gaps closed here:

1. **Local `<base>` was never moved.** A session clone is `git clone --local`; its
   `origin` remote uses the default refspec `+refs/heads/*:refs/remotes/origin/*`,
   so `git fetch` advances `origin/<base>` but leaves local `refs/heads/<base>`
   frozen at clone time (the same mechanism as docs/157, but on the per-session
   clone). After a sync the agent's `git diff main...HEAD` / `git log main..HEAD`
   still referenced a stale `main`. Syncing now fast-forwards local `<base>` to
   `origin/<base>`.
2. **The sync left no durable record.** It's transcript-worthy (it rewrote the
   branch and moved a ref) but only flashed a transient banner/toast — gone on
   reload. It now leaves a **persisted** "Synced with `<base>`" card, mirroring the
   docs/218 `branchAutoReset` ("Branch updated to latest base") card.

## How it works

Both changes live in `runRebaseFlow`.

### Local `<base>` fast-forward (unconditional)

After `fetch` + base-ref resolution, `syncLocalBaseRef(git, baseBranch)`:
resolves `origin/<base>`, reads local `<base>`, and if they differ — and the
session isn't somehow ON `<base>` (`git branch -f` refuses the current branch) —
force-moves the local ref via the new `GitManager.forceUpdateBranchRef(branch,
target)` (`git branch -f`, **no checkout**, so HEAD/worktree are untouched).
Best-effort: any failure logs and the rebase proceeds. Runs on every success path
(up-to-date, clean, conflicts-resolved) and on the automatic
conflict-resolve-on-idle path too — it's plain correctness.

### Persisted "Synced with `<base>`" card

The card is a sibling of the docs/218 `branchAutoReset` card, wired through the
same persistence stack so it survives a switch/reload (`BranchSyncedCard` shared
type → `WsBranchSyncedCard` → `PersistedMessage.branchSynced` → `branch_synced`
column + migration → `toRow`/`fromRow` → `CARD_MESSAGE_FIELDS` → client handler →
`BranchSyncedCard.tsx`).

The clean-rebase path is **not** an agent turn, so `emitChatCard` (which assumes
an in-progress turn) doesn't fit. `emitSyncCard` instead appends directly to chat
history **and** broadcasts over WS, sharing one `cardId` that the client handler
dedupes on (the `emitNoticePostTurn` shape). The append is best-effort: by the
time it runs the branch has been rewritten and pushed, so a failed history write
must not report that as a failed sync — and on the automatic path it would
additionally burn an attempt.

**On the two paths that actually rewrote the branch — clean rebase and
conflicts-resolved — the card is unconditional** (2026-08-17 incident, session
590c19aa). It was originally gated on `RebaseDriverDeps.recordSyncCard`, set true
only by the manual route, on the reasoning that the automatic conflict-resolve
path keeps its own `auto_resolve_result` envelopes. But those are transient WS
state that renders nothing in the transcript, so the automatic path left **no
durable record at all**: a user whose branch was rebased, whose conflicts were
resolved by an agent they never asked for, and whose history was force-pushed,
saw the conflict prompt scroll past and then nothing. That is the case that needs
the reassurance most, not least. The card lands last, after everything else the
flow emitted (including any warning it raised on the way), which is the only
order in which "it finished, your branch is fine" reassures anyone.

`recordSyncCard` survives as "a human asked for this sync out of band", and still
gates two narrower things: the **agent-facing notice** below, and the card on the
**up-to-date** path — a manual sync confirms "already current" as a record of the
action the user took, while an automatic no-op has no action to confirm.

Every manual sync emits the card, including when the branch and local base were
already current. This gives the menu action one durable confirmation in every PR
state instead of falling back to an ephemeral "Already up to date" toast. The
card renders truthful outcome-specific copy for a rebased branch, a local-base-only
move, or an already-current branch. `WsRebaseComplete.baseMoved` suppresses the
redundant toast whenever this durable card is emitted.

planning#369 added a fourth line to that copy: an already-current sync that
nonetheless **pushed** (the branch held commits origin had never seen, which is
what kept the PR marked conflicting) says so, instead of reading "nothing
happened" at the exact moment the PR state changed.

### Agent-facing notice (manual route only)

The card above tells the **user**. Nothing told the **agent** — and the agent is
the one whose view of the repository the sync invalidates. A manual sync rewrote
the working tree while the agent sat resumed on a conversation that predates the
rewrite, and the next turn carried on against files it had read before.

The docs/218 post-merge reset does not have this problem because it runs *inside*
the turn it describes, so it prepends its `[System] …` prefix directly. A manual
sync has no turn to prepend to: `runRebaseFlow` refuses to start while one is
running, and it is driven from an HTTP route. So the sentence is **parked** and
the next turn delivers it — on either transport (see the reversed non-goal below;
it was interactive-only until nikzlabs/shipit#2349):

| | |
|---|---|
| Write | `sessions.pending_agent_notice` — one nullable column, set by `SessionManager.setPendingAgentNotice` |
| Read | `SessionManager.consumePendingAgentNotice` — read-and-clear in one transaction, so a notice is delivered exactly once |
| Drain | `runAgentWithMessage` (`agent-execution.ts`) **and `runDispatchedTurn` (`dispatched-turn.ts`)** — a message queued during the sync is released onto the dispatched path, so the interactive-only drain missed it (nikzlabs/shipit#2349). Prepended ahead of the docs/218 reset prefix on both (chronological: the sync happened first) |

Persisted rather than held on the runner for the `secretBlock` reason: the runner
dies when the session goes idle, but the rewritten branch does not, and "synced,
walked away, came back tomorrow" is exactly the case where the resumed agent most
needs telling.

Two writers, both gated on "a human asked for this, out of band":

- **`runRebaseFlow`** (`buildBranchSyncAgentNotice`) on the two paths where the
  branch actually **moved** — clean rebase and conflicts-resolved — still gated on
  `recordSyncCard`, which the card on those paths no longer is. A sync that only
  fast-forwarded the local `<base>` ref leaves the working tree byte-identical, so
  there is nothing to warn about, and the auto-conflict-resolve path stays silent:
  its own conflict-resolution turns ran *inside* the rewrite, so nothing about the
  agent's view of the repository arrived from outside the session.
- **`POST /branch/reset-to-base`** (`buildManualResetAgentNotice`, via
  `recordManualResetAgentNotice`) — the merged fork of the *same* "Sync with
  `<base>`" menu item. `runner.running` discriminates this route's two callers:
  the `shipit branch reset-to-base` shim can only run inside an agent turn and
  reads the outcome in its own tool result, so a turn in flight means the agent
  already knows; anything arriving with no turn running (the menu click, or a
  human running the shim in the terminal panel) is news.

Both writes are best-effort — the sync itself already succeeded and is recorded
for the user, so a failed notice must not turn that into a reported failure.

The drain is skipped for `/compact` for the docs/178 reason the reset is: a
maintenance command must not be handed a "your branch moved" instruction to react
to. The notice stays pending and the user's next real turn gets it.

### Pre-rebase workspace preparation (2026-09-07 incident)

A manual sync on session 43c732e1 ran `git rebase origin/main` against a
workspace whose index was not empty, and git refused: `cannot rebase: Your index
contains uncommitted changes`. The route answers `{ status: "started" }` and
reports later failures only through a **transient** `rebase_aborted`, so the
banner cleared and nothing in the transcript said why.

The flow's guards could not see that state. `runner.running` and
`runner.systemTurnInProgress` describe a **turn**, and the post-turn commit runs
with both already false — `tryDrain` clears `running` at `agent_result`, and
`runCommitAndPr` (`git add -A` + `git commit`) runs several awaits later
(`turn-executor.ts`). A sync clicked in that window passed both guards and ran a
rebase alongside a live `git add -A` on the same workspace. The **automatic**
path had pre-flighted a dirty tree since docs/146; the manual path had nothing.

`prepareWorkspaceForRebase` runs first, before the fetch, so a refusal has
written nothing:

1. **An in-progress rebase is named on its own** — `autoCommit` refuses to commit
   into one by design, so reporting it as a dirty tree would tell the user to
   commit work that cannot be committed.
2. **The per-workspace mutex is taken** (`withWorkspaceLock`, the same one
   `postTurnCommit` holds for its whole `add`+`commit`, shared with the
   plugin-install path). Queueing behind it *is* the synchronisation the turn
   flags could not provide. The index-writing git ops — `git.rebase`, and
   `stageAll` + `rebaseContinue` as one step — are held under the same mutex.
   The **final** inspection sits *inside the same critical section as*
   `git.rebase`, not merely before it: preparation releases the mutex between
   its steps and the fetch takes seconds, and `systemTurnInProgress` does not
   exclude every writer — a file save from the editor (`api-routes-files.ts`)
   writes before taking the commit mutex and guards only on `running`. Two
   separately-locked operations do not preserve the condition the first
   established; a late writer is now refused with an explanation instead of
   surfacing as git's raw "index contains uncommitted changes".
3. **A still-dirty tree is SAVED, never stashed and never discarded**, through
   the established pipeline (`RebaseDriverDeps.commitPendingWork` →
   `savePendingWorkForSync` → `postTurnCommit`), so the secret scan, the
   conflict refusals and the ops/sandbox auto-commit gate all still decide. A
   refusal stops the sync with the tree untouched and persists an explanation
   pointing at the notice `postTurnCommit` already wrote.

`commitPendingWork` is wired by the **manual** route only. The automatic path
must never commit work the user did not ask it to commit, so it keeps deferring;
the refusal is a `ServiceError(409)`, which `runAutoResolveAttempt` already reads
as "defer, no budget burned". The refusal notice is persisted only when
`recordSyncCard` is set, for the same reason — a notice per poll would be noise.

The pre-sync commit's auto-push is **deferred**, not armed inline (the
`turn-executor.ts` reason: a debounced plain push racing the sync's own
force-push is rejected non-fast-forward and reported as a divergence that never
happened). Two properties of that deferral are load-bearing:

- **The flow owns the arm from the instant it exists**, handed over through a
  `deferPushArm` callback rather than returned. `postTurnCommit` produces the arm
  mid-flight and can then throw (its chat-history bookkeeping runs after the
  commit), and so can the post-save inspection — an arm travelling on a return
  value is an arm dropped on exactly the paths where the commit is already made.
- **"Prohibited" is not "not yet".** `pushIfAheadOfRemote` answers a three-way
  outcome, because clause 1 — the session is checked out on `<base>` — must be
  distinguishable from the ordinary "nothing to push". The deferred arm is a
  plain `git push origin <branch>`, so firing it on a `main` checkout would land
  the commit straight on `main` and bypass the pull request, which is precisely
  what that clause exists to prevent. There the commit stays local and a manual
  sync is told why.

Otherwise the arm fires from `runRebaseFlow`'s `finally`, so the commit never
sits local and unpushed in silence.

Finally, the route's `flowPromise.catch` **persists** the failure as well as
emitting `rebase_aborted`. That event is transient — the route already answered
`{ status: "started" }`, so it is the only thing the user gets and it is gone on
reload, which was the reporting half of the incident. Failures the driver has
already explained are tagged (`syncFailureAlreadyExplained`) so one failure never
produces two rows saying different amounts.

## Key files

| Layer | File |
|---|---|
| Local base move + card emit | `src/server/orchestrator/services/rebase-driver.ts` (`syncLocalBaseRef`, `emitSyncCard`, `recordSyncCard` dep) |
| Ref-move + ref-read helpers | `src/server/shared/git.ts` (`forceUpdateBranchRef`, `getRefHash`) |
| Manual-route flag | `src/server/orchestrator/api-routes-git.ts` (`recordSyncCard: true`) |
| Pre-rebase preparation | `src/server/orchestrator/services/rebase-driver.ts` (`prepareWorkspaceForRebase`, `refuseSync`, `commitPendingWork` dep) |
| Pre-sync save (manual route) | `src/server/orchestrator/api-routes-git.ts` (`savePendingWorkForSync` → `ws-handlers/post-turn.ts`), `api-routes.ts` + `route-registry.ts` (`ApiDeps.scheduleAutoPush`) |
| Agent notice — rebase | `src/server/orchestrator/services/rebase-driver.ts` (`buildBranchSyncAgentNotice`, `recordAgentNotice`) |
| Agent notice — merged reset | `src/server/orchestrator/api-routes-git.ts` (`recordManualResetAgentNotice`), `services/pre-turn-reset.ts` (`buildManualResetAgentNotice`) |
| Notice slot | `shared/types/domain-types/session.ts` (`pendingAgentNotice`), `orchestrator/sessions.ts` (`set`/`consumePendingAgentNotice`), `shared/database.ts` (migration) |
| Notice drain | `src/server/orchestrator/ws-handlers/agent-execution.ts` (prepended ahead of the docs/218 reset prefix) |
| `baseMoved` field + toast suppress | `shared/types/ws-server-messages/git.ts`, `client/hooks/message-handlers/rebase-complete.ts` |
| Card type | `shared/types/domain-types/chat.ts` (`BranchSyncedCard`), `…/ws-server-messages/cards.ts` + `index.ts` (`WsBranchSyncedCard`) |
| Persistence | `orchestrator/chat-history.ts` (field + row + SQL + `toRow`/`fromRow`), `shared/database.ts` (migration) |
| Render | `client/components/BranchSyncedCard.tsx`, `MessageList/cards/MessageCards.tsx`, `MessageList/types.ts`, `visual-elements.ts` (`CARD_MESSAGE_FIELDS`) |
| Client handler | `client/hooks/message-handlers/branch-synced-card.ts` + `index.ts` |

## Tests

- `git-sync.test.ts` — `forceUpdateBranchRef` moves a non-current branch without
  switching HEAD; `getRefHash` resolves / returns null.
- `rebase-driver.test.ts` (docs/221 block) — manual sync emits + persists the card
  and advances local `main`; the **auto path emits + persists it too**, and on an
  automatic conflict resolution the card is the **last** row in history; a failed
  card write does not fail the rebase; up-to-date-but-base-behind moves `main`,
  emits the card, flags `baseMoved`; truly-up-to-date emits no card.
- `chat-history.test.ts` — `branchSynced` in `EVERY_OPTIONAL_FIELD_MESSAGE`
  (self-enforcing via `CARD_MESSAGE_FIELDS`) round-trips.
- `branch-synced-card.test.ts` — live append, idempotent by `cardId`.
- `rebase-driver.test.ts` (agent-notice block) — a moved branch records a notice,
  the auto-resolve path records none, an unmoved branch records none.
- `api-routes-git.test.ts` — `recordManualResetAgentNotice` parks a notice for a
  UI-driven reset, stays silent when a turn is running or nothing moved, and does
  not throw when the write fails.
- `sessions.test.ts` — round-trip, consume-exactly-once, last-write-wins.
- `integration_tests/rebase-flow.test.ts` — after a clean sync the next turn's
  prompt carries the notice, and the turn after that does not.
- `rebase-driver.test.ts` (preparation block) — a sync started while a post-turn
  commit holds the workspace mutex waits for that commit before `git.rebase` is
  invoked at all (asserted on order, and it reproduces the incident's exact
  `cannot rebase: Your index contains uncommitted changes` without the fix); an
  orphaned dirty tree is saved through the pipeline and then rebased, without
  double-pushing; a refused save stops the sync with the tree untouched, persists
  an actionable notice and hands the auto-push back; the automatic path (no save
  pipeline) refuses silently with a 409; an in-progress rebase is named rather
  than blamed on the tree; and a refusal still releases the session hold.
- `rebase-driver.test.ts` (pre-sync save block) — the pre-sync commit is never
  published when the session is checked out on the base branch (it stays local
  and the user is told why); the deferred push is still armed when preparation
  throws *after* the save; a tree dirtied between preparation and the rebase is
  refused with an explanation rather than surfacing as git's raw error; and only
  the failures the driver explained carry the already-explained tag.
- `integration_tests/rebase-flow.test.ts` — end to end through the real route: a
  sync over a workspace with one unstaged and one staged file commits both and
  rebases, leaving `git status` clean.

## Out of scope

- ~~Surfacing the card on the automatic conflict-resolve-on-idle path (kept to its
  existing `auto_resolve_result` envelopes).~~ **Reversed (2026-08-17 incident).**
  `auto_resolve_result` is transient client state that renders nothing in the
  transcript, so "it keeps its own envelopes" amounted to leaving no record at
  all of a rebase the user never asked for. The card is now unconditional on the
  two paths that rewrote the branch; only the agent-facing notice and the
  up-to-date card stay gated on `recordSyncCard`.
- Moving local base for non-rebase flows (only the sync/rebase entry point).
- ~~Draining the pending agent notice on **dispatched** turns (CI auto-fix,
  `shipit session message`). Same scope boundary docs/218 drew: a human resuming
  is the signal. Nothing is lost — the notice is not consumed, so the user's next
  interactive turn still delivers it.~~ **Reversed (nikzlabs/shipit#2349).** The
  reasoning held for the turns it named and missed the one that matters. A
  message sent while the sync is still settling is QUEUED — the flow holds
  `systemTurnInProgress` through its own teardown — and `releaseQueuedTurn`
  releases *every* queued entry, interactive ones included, onto
  `runner.dispatch`. So the turn most likely to need the notice, the one the user
  typed while watching the sync finish, was the one guaranteed not to get it, and
  "the user's next interactive turn" may simply never come: that message IS the
  turn, and it runs dispatched. `dispatched-turn.ts` now consumes it too, with
  the same `postTurn: "none"` exclusion the reset uses — and **re-parks it** when
  that turn dies before the agent ever sees the prompt. The consume is
  read-and-clear, which is what makes delivery exactly-once and what makes a
  spawn failure burn the notice permanently: the branch stays rewritten and
  nothing ever says so again. Same hazard docs/218 solved for its card with
  `ensureRecorded`, same shape of answer. Found because #2349's LFS restore
  widened the settling window enough to make the drop deterministic.

## Follow-up — merged PR cards

The same menu action now branches on lifecycle state. Open and ready branches
continue through `runRebaseFlow`, while a merged PR calls the existing
`POST /api/sessions/:id/branch/reset-to-base` flow. A merged branch must not replay
its already-shipped commits (especially after squash merge), so this path uses the
docs/218 safety-gated hard reset. That endpoint also heals the remote branch,
re-arms the lifecycle card, clears reset eligibility, and persists the standard
"Branch updated to latest base" transcript card—the same result as an agent-driven
`shipit branch reset-to-base`.
