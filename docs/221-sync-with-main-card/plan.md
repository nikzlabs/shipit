---
issue: https://linear.app/shipit-ai/issue/SHI-203
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

The card emits only when the sync **changed something** — the branch rebased
(`headFrom !== headTo`) or local `<base>` moved. If nothing changed, no card and
the "Already up to date" toast stays. To avoid a contradictory toast on the
up-to-date-but-base-moved path, `WsRebaseComplete` gained `baseMoved?: boolean`;
`handleRebaseComplete` suppresses the toast when it's set.

## Key files

| Layer | File |
|---|---|
| Local base move + card emit | `src/server/orchestrator/services/rebase-driver.ts` (`syncLocalBaseRef`, `emitSyncCard`, `recordSyncCard` dep) |
| Ref-move + ref-read helpers | `src/server/shared/git.ts` (`forceUpdateBranchRef`, `getRefHash`) |
| Manual-route flag | `src/server/orchestrator/api-routes-git.ts` (`recordSyncCard: true`) |
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

## Out of scope

- Surfacing the card on the automatic conflict-resolve-on-idle path (kept to its
  existing `auto_resolve_result` envelopes).
- Moving local base for non-rebase flows (only the sync/rebase entry point).
