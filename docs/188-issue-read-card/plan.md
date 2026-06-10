---
issue: https://linear.app/shipit-ai/issue/SHI-89
description: Surface a read-only navigation card in the chat whenever the agent views an issue (`shipit issue view`), so any agent issue interaction — not just edits — leaves a quick jump-to-issue affordance in the transcript.
---

# Issue read navigation card

## What this decides

When the agent **reads** an issue (`shipit issue view <pointer>`), ShipIt surfaces
a small inline **navigation card** in the transcript recording that the agent
looked at the issue, with a jump-to-issue link. It is the read-path sibling of
the do-then-surface **write provenance card** (docs/177 / docs/187): together
they mean *any* agent issue interaction — edit or just a look — leaves a card the
user can follow.

The motivating request: "whenever the agent edits or interacts with an issue,
show a card so the user can quickly navigate to that issue." Writes were already
covered by `IssueWriteCard`; the gap was reads. This fills it.

## Why a separate, lighter card

`IssueWriteCard` carries an **undo lifecycle** (`available → undoing → undone |
failed`), which is why its payload lives in a client store keyed by `cardId` and
its terminal state is patched in place. A read has **no lifecycle** — nothing to
undo, nothing to patch. So `IssueRefCard` is deliberately simpler:

- The full payload rides directly on the persisted chat message
  (`PersistedMessage.issueRef`), and the component renders straight from it — **no
  client store, no seeding step** in `loadSessionHistory`. The history map's
  `...m` spread rehydrates it for free.
- There is **no follow-up WS update message** (the write card has
  `issue_write_update` for the undo transition).

This keeps the surface minimal while still obeying the persisted-transcript-card
contract (CLAUDE.md "Chat transcript content MUST be persisted"): the card is
emitted via `emitChatCard`, so it broadcasts live, buffers into the turn-event
log (survives reconnect), AND records in-band with the turn (survives switch /
reload).

## Navigation is a deep link (for now)

"Navigate to that issue" is a deep link to the issue in the tracker. ShipIt has
no **inline single-issue detail view** yet — the Issues tab is a list, and even
its own rows link out per-issue (`IssuesViewer` → `issue.url`, `target=_blank`),
as does `IssueWriteCard`. Matching that affordance is the consistent, in-scope
choice. An inline issue-detail view is the proper home for this link later
(CLAUDE.md §4 — "if we don't render it inline yet, that's a backlog item"); when
it exists, the card's link target moves inward with no data-model change.

## Per-turn dedup

The agent commonly re-views the same issue within a turn (e.g. to re-check
available statuses before a `status` write). `recordedCards` resets each turn, so
the view route skips emitting when a card for the same `tracker + identifier`
already exists in the current turn — one card per issue per turn. A later turn
that views it again gets a fresh card (it's a genuinely new interaction).

## Data flow

```
shipit issue view <pointer>
  → worker GET /agent-ops/issue/view?tracker=&id=   (injects SESSION_ID)
  → orchestrator GET /api/sessions/:id/issue/view
  → getIssueForTracker() → { tracker, issue }
  → emitIssueReadCard(): resolve runner, per-turn dedup, build IssueRefCard,
    emitChatCard({ type: "issue_ref_card" }, { …, issueRef: card })
  → return { tracker, issue } to the shim   (read output unaffected)
```

Emission is **best-effort**: a `view` still succeeds and returns the issue even
when no runner is attached (read fired outside an active turn) — the card just
doesn't appear. It never throws.

## Key files

- `src/server/shared/types/domain-types.ts` — `IssueRefCard` type.
- `src/server/shared/types/ws-server-messages.ts` — `WsIssueRefCard` + union.
- `src/server/orchestrator/api-routes-issues.ts` — `emitIssueReadCard()` helper,
  wired into the `issue/view` route.
- `src/server/orchestrator/chat-history.ts` — `PersistedMessage.issueRef`,
  `issue_ref` column, `toRow`/`fromRow`.
- `src/server/shared/database.ts` — `issue_ref` column migration.
- `src/client/components/IssueRefCard.tsx` — the read-only card.
- `src/client/components/MessageList.tsx` — `ChatMessage.issueRef` + render block.
- `src/client/hooks/message-handlers/issue-ref-card.ts` — live append (idempotent
  by `cardId`), registered in `message-handlers/index.ts`.
- `src/server/shipit-docs/issues.md` — agent-facing note that `view` surfaces a
  navigation card.

## Tests

- `chat-history.test.ts` — `issueRef` round-trips (comprehensive message + a
  focused persist-and-reload test).
- `integration_tests/agent-issue-read-card.test.ts` — a live WS viewer +
  `issue/view` inject asserts the `issue_ref_card` is emitted and recorded
  in-band, and that repeated views dedupe to one card.
- `hooks/message-handlers/issue-ref-card.test.ts` — live append is idempotent by
  `cardId`.
- `components/IssueRefCard.test.tsx` — render + deep-link affordance.
