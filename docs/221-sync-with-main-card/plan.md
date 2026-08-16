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

### Persisted "Synced with `<base>`" card (manual route only)

The card is a sibling of the docs/218 `branchAutoReset` card, wired through the
same persistence stack so it survives a switch/reload (`BranchSyncedCard` shared
type → `WsBranchSyncedCard` → `PersistedMessage.branchSynced` → `branch_synced`
column + migration → `toRow`/`fromRow` → `CARD_MESSAGE_FIELDS` → client handler →
`BranchSyncedCard.tsx`).

The clean-rebase path is **not** an agent turn, so `emitChatCard` (which assumes
an in-progress turn) doesn't fit. `emitSyncCard` instead appends directly to chat
history **and** broadcasts over WS, sharing one `cardId` that the client handler
dedupes on (the `emitNoticePostTurn` shape). It's gated on a new
`RebaseDriverDeps.recordSyncCard`, set **true only by the manual rebase route**
(`api-routes-git.ts`) — the automatic conflict-resolve path keeps its own
`auto_resolve_result` envelopes and gains no card.

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
  branch actually **moved** — clean rebase and conflicts-resolved — under the same
  `recordSyncCard` flag as the card. A sync that only fast-forwarded the local
  `<base>` ref leaves the working tree byte-identical, so there is nothing to warn
  about, and the auto-conflict-resolve path stays silent as before.
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

## Key files

| Layer | File |
|---|---|
| Local base move + card emit | `src/server/orchestrator/services/rebase-driver.ts` (`syncLocalBaseRef`, `emitSyncCard`, `recordSyncCard` dep) |
| Ref-move + ref-read helpers | `src/server/shared/git.ts` (`forceUpdateBranchRef`, `getRefHash`) |
| Manual-route flag | `src/server/orchestrator/api-routes-git.ts` (`recordSyncCard: true`) |
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
  and advances local `main`; auto path emits no card but still moves `main`;
  up-to-date-but-base-behind moves `main`, emits the card, flags `baseMoved`;
  truly-up-to-date emits no card.
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

## Out of scope

- Surfacing the card on the automatic conflict-resolve-on-idle path (kept to its
  existing `auto_resolve_result` envelopes).
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
