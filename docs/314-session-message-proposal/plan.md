---
issue: planning#450
title: Propose a message to an unreachable session — design
description: How the proposal card is built: an MCP tool that resolves the target at call time, a persisted card, and a user-click route that is the only path to delivery.
---

# Propose a message to an unreachable session — design

Implements [`requirements.md`](requirements.md). Requirements are cited as
`(req N)`.

## Shape

Modelled file-for-file on `docs/303-cross-repo-session-proposal`: an MCP tool
validates and POSTs to the worker, an orchestrator route resolves the target and
emits a **persisted** card, and a second route — deliberately **not**
container-accessible — is the user's click.

```
agent → propose_session_message (MCP)
      → POST /agent-ops/propose-session-message          (worker relay)
      → POST /api/sessions/:id/propose-session-message   (containerAccessible)
          ├─ refuses now: unknown target, self, a direct child, archived   (req 8, 9)
          └─ emitChatCard → persisted SessionMessageProposalCard           (req 12)

user click (browser only, NOT containerAccessible)                         (req 7)
      → POST /api/sessions/:id/session-message-proposals/:cardId/deliver
          └─ deliverSessionMessage(...) → runner.dispatch on the TARGET    (req 4)
```

The two halves are what make req 7 hold mechanically: the agent can reach the
propose route and cannot reach the deliver route, because
`containerAccessible` is set on one and not the other. Nothing in this change
relaxes `assertChildOfParent`.

## Where the delivery comes from

`sendChildMessage` (`orchestrator/services/child-sessions.ts:600`) already does
everything a delivery needs — dispose a runner that outlived its container,
`getOrCreate`, reconcile the agent, prepare the credential environment, wait for
the worker, then `runner.dispatch(prepareDispatch({...}))` with a
`messageOrigin`. Only its first three lines are child-specific:
`assertChildOfParent`, the `ResolvedChildMessageError` grouping check, and the
archived check.

So split it: the body below those checks becomes `deliverSessionMessage(...,
origin: SessionMessageOrigin)`, and `sendChildMessage` keeps its checks and
calls it with `relation: "parent"`. One delivery path, two callers with
different admission rules — a behaviour change to dispatch cannot diverge
between them.

The grouping check stays in `sendChildMessage` alone: `isResolvedForGrouping`
asks whether a *child* is finished for sidebar-grouping purposes, which is not a
question about an arbitrary session.

## Refusing at call time (req 8, 9)

The propose route resolves the target before writing any card, and each refusal
names the fix:

| Condition | Code | Why it is refused *now* |
|---|---|---|
| Target id unknown | 404 | The agent can correct the id this turn. |
| Target is the proposing session | 400 | A session messaging itself is a queued turn, not a proposal. |
| `target.parentSessionId === proposingId` | 400 | `shipit session message` already reaches it (req 9). |
| Target is a warm-pool session | 400 | A pooled empty session is not work the user is following; a turn would claim it. |
| Target archived / `userArchived` | 400 | It cannot take a turn; the user would click into a failure. |
| Target has no `workspaceDir` | 400 | Same. |
| No runner for the *proposing* session | 409 | There is no transcript to post the card into. |

The target is re-resolved at **deliver** time too — a session can be archived
between the card and the click — and a failure there sets `state: "failed"` with
the reason on the card, which is the docs/303 behaviour.

## Message length

Capped at 4,000 characters, matching `propose_repo_session`'s prompt and not
`shipit session message`'s 50,000. The reason is req 2: the user approves this
text, so it has to be readable in full in a transcript card. The card clamps the
body and offers "Show the whole message", as the repo card does for its prompt.

## What the receiving session sees (req 6)

`SessionMessageOrigin.relation` gains `"proposed"`, alongside
`parent | child | sibling`. The delivered turn's user message carries
`{ sessionId, sessionTitle, relation: "proposed" }` for the **proposing**
session.

`TranscriptRow` renders the origin today as `From {relation} session · {title}`,
which does not read for the new value. Replace that interpolation with a label
map:

- `parent` → `From parent session · …`
- `child` → `From child session · …`
- `sibling` → `From sibling session · …`
- `proposed` → `From another session, approved by you · …`

The approval clause is load-bearing, not decoration: a message from a session
with no relationship to this one is otherwise unexplainable, and "you approved
this" is the whole explanation.

## The dead end names its own way out (req 10)

`CHILD_NOT_FOUND` in `session/agent-shim/shipit-session.ts:37` is the string an
agent gets from `message`, `view` and `wait` on a target it cannot reach. It
gains a sentence pointing at `propose_session_message`. It is also corrected:
it says "not a descendant of this parent" and the check is one hop, so it now
says *direct child*.

## Files

New:

- `src/server/shared/session-message-proposal-validation.ts` — shapes and
  lengths, shared by tool and route so they cannot disagree.
- `src/server/session/mcp-tools/propose-session-message.ts` — the MCP tool.
- `src/server/orchestrator/api-routes-propose-session-message.ts` — propose +
  deliver routes.
- `src/client/components/SessionMessageProposalCard.tsx` — the card.
- `src/client/hooks/message-handlers/session-message-proposal.ts` — WS handlers.

Changed:

- `orchestrator/services/child-sessions.ts` — extract `deliverSessionMessage`.
- `shared/types/domain-types/chat.ts` — `SessionMessageProposalCard`;
  `SessionMessageOrigin.relation` gains `"proposed"`.
- `shared/types/ws-server-messages/cards.ts` — the two WS messages.
- `shared/database.ts` — `session_message_proposal` column + migration.
- `orchestrator/chat-history.ts` — field, `toRow`/`fromRow`, `find…`/`update…`.
- `client/components/visual-elements.ts` — `CARD_MESSAGE_FIELDS`.
- `client/components/MessageList/types.ts`, `.../cards/MessageCards.tsx`,
  `.../row-context.tsx`, `.../MessageList.tsx`, `.../TranscriptRow.tsx`,
  `client/App.tsx` — render and wire the click.
- `client/hooks/message-handlers/index.ts` — dispatch +
  `TRANSCRIPT_SCOPED_MESSAGES`.
- `session/mcp-shipit-bridge.ts`, `session/agent-ops-routes.ts` — register.
- `session/agent-shim/shipit-session.ts` — `CHILD_NOT_FOUND`.

## Transcript scoping

Both WS messages go in `TRANSCRIPT_SCOPED_MESSAGES`. They carry a `sessionId`
and they render in exactly one transcript — the **proposing** session's, which
is where the card lives and where its state changes. They are not messages
describing another session's state (the exempt class: `session_status`,
`pr_lifecycle_update`, …); the target session's id appears only as a *field on
the card*, never as the message's owner. So dropping on mismatch is correct, and
the card rehydrates from its owner's history.

## Tests

- `session-message-proposal-validation.test.ts` — caps and empty fields.
- `integration_tests/propose-session-message-route.test.ts` — every refusal in
  the table above, and the happy path emits and persists a card.
- `integration_tests/propose-session-message-deliver.test.ts` — the click
  dispatches a turn into a **root** session and into a **sibling**; the message
  the target receives carries `relation: "proposed"`; double-click is refused;
  a target archived after the card fails the card, not the request.
- `child-sessions.test.ts` — `sendChildMessage` still refuses a non-child after
  the extraction (the guard that the split did not widen the scope).
- `chat-history.test.ts` / `visual-elements.test.ts` — the two self-enforcing
  guards; extend `EVERY_OPTIONAL_FIELD_MESSAGE`.
- `SessionMessageProposalCard.test.tsx` — approve, failed + retry, delivered is
  terminal.
