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

The two halves are what make req 7 hold mechanically: a session container can
reach the propose route and cannot reach the deliver route, because
`containerAccessible` is set on one and not the other, and the guard refuses any
unflagged route to a recognised container peer
(`api-container-guard.ts:184`). Nothing in this change relaxes
`assertChildOfParent`. The guard's own boundary is container origin, not
"browser" — an install with no container manager (local mode) has no boundary to
enforce, which is inherited and not introduced here.

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
| Target is the proposer's own parent | 400 | `shipit session report` already wakes it, with no card (req 9). |
| Target is a warm-pool session | 400 | A pooled empty session is not work the user is following; a turn would claim it. |
| Target archived / `userArchived` | 400 | It cannot take a turn; the user would click into a failure. |
| Target has no `workspaceDir` | 400 | Same. |
| Target repository is not trusted | 403 | The same admission `dispatch` applies (`assertSessionCanDispatch`); without this the card is approvable and the delivery is not. |
| No runner for the *proposing* session | 409 | There is no transcript to post the card into. |

The target is re-resolved at **deliver** time too — a session can be archived
between the card and the click — and a failure there sets `state: "failed"` with
the reason on the card, which is the docs/303 behaviour.

## Once, and only once (req 5)

Three guards, because each covers what the others cannot:

1. A process-lived in-flight set, for two clicks racing inside one process.
2. The persisted `delivered` state, which is terminal server-side and hides the
   send button client-side. This is the one that survives a reload.
3. Dispatch is the point of no return: once `deliverSessionMessage` returns, a
   later throw (persisting the terminal state, say) must NOT mark the card
   failed, because `failed` offers a *Try again* that would deliver it twice.
   The route answers 500 with `delivered: true` and leaves the card alone. It
   still tells the viewer `delivered`, because that is true, and it remembers the
   card in a process-lived set that makes the deliver and decline routes refuse
   it — the stored card still reads `delivering`, so without that a reload would
   offer a second send, or a decline over a message that already landed.

The residual is an orchestrator that stops between the dispatch and the write,
or restarts after a failed write. The card is then left `delivering`, which is
deliberately retryable — a card that spins forever is worse than one the user
can re-send — so that window trades once-only for liveness. The same leftover
can also be declined, and the agent is then told "declined" about a message
that may have landed. Closing it needs a target-side delivery identity to
reconcile against, which is more machinery than the case is worth.

## Reporting what actually happened

The card's "queued" line comes from the dispatch's own `TurnHandle.admitted`,
not from whether the target's runner was running when we looked. A *running*
target that is steerable takes the message immediately (`steered`), and an
*idle* one under a merge hold queues it — so the runner's state is the wrong
question, and answering it that way would print "Queued behind…" over a message
that already arrived.

## Message length

Capped at 4,000 characters, matching `propose_repo_session`'s prompt and not
`shipit session message`'s 50,000. The reason is req 2: the user approves this
text, so it has to be readable in full in a transcript card. The card clamps the
body and offers "Show the whole message" whenever the clamp actually hides
something — **measured** (`scrollHeight > clientHeight`), not inferred from the
character count. A count cannot answer it: seven short lines, or a narrow
column that wraps, clip a message far under any cap, and the hidden part is
precisely what the user is approving unseen.

## What the receiving session sees (req 6)

`SessionMessageOrigin.relation` gains `"proposed"`, alongside
`parent | child | sibling`. The delivered turn's user message carries
`{ sessionId, sessionTitle, relation: "proposed" }` for the **proposing**
session.

`TranscriptRow` rendered the origin as `From {relation} session · {title}`,
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

## Declining, and telling the agent (reqs 13, 14)

The same shape as `docs/303-cross-repo-session-proposal` reqs 10 and 11, so the
two cards cannot drift apart in how they treat the user's choice.

```
user clicks "Decline"
  → POST    /api/sessions/:sessionId/session-message-proposals/:cardId/decline
            (NOT container-accessible, like deliver)
            refused while a delivery is in flight, or once delivered
            patch state=declined + declinedAt   (persist, then emit)

next turn of the proposing session (any kind but compaction)
  → prepareSessionMessageOutcomeNotice: cards whose state is delivered / failed /
    declined and differs from agentNotifiedState
  → "[ShipIt] Since your last turn, the user acted on a card you posted…"
  → on the agent's result: agentNotifiedState = the state the notice carried
```

**Declined is terminal.** The deliver route refuses a declined card, and the
card offers nothing more. Nothing reaches the target (req 7 is unchanged).

**Every transition is persisted before it is emitted.** A viewer shown a state
that was never stored would lose it on reload, and the agent would never be told
of it. The deliver route used to emit first; it now shares the decline route's
order.

**The notice is a second module, not a second kind of line in the first.**
`services/session-message-outcome-notice.ts` mirrors
`services/repo-session-outcome-notice.ts` and reuses its quoting helper. Both
are at-least-once through the turn's `NoticeDelivery` receipt, and both ride
every turn but compaction, on the WebSocket path (`agent-execution.ts`) and the
dispatch path (`dispatched-turn.ts`). The reasoning is in
`docs/303-cross-repo-session-proposal` `plan.md`, and it applies here unchanged.

**What reaches the agent in ShipIt's voice.** The target session's id, whether
a delivery was queued, and fixed text. The target's title and a failure reason
are quoted as data, flattened to one line, with their quote and bracket
characters stripped. The message itself is never carried: the agent wrote it.
The notice says a queued delivery runs when that session is free, not why it
was queued — a merge hold queues one on an idle session too.

The tool result and the propose route's refusals quote the target's title the
same way. Another session's agent can rename that session, so its title is
text this agent must not read as ShipIt speaking.

**A second failed delivery is not reported again**, for the reason given in
`docs/303-cross-repo-session-proposal` `plan.md` → *Known limitations*: the
agent already heard that the delivery failed and that a retry is possible.

## Files

New:

- `src/server/shared/session-message-proposal-validation.ts` — shapes and
  lengths, shared by tool and route so they cannot disagree.
- `src/server/session/mcp-tools/propose-session-message.ts` — the MCP tool.
- `src/server/orchestrator/api-routes-propose-session-message.ts` — propose +
  deliver routes.
- `src/client/components/SessionMessageProposalCard.tsx` — the card.
- `src/client/hooks/message-handlers/session-message-proposal.ts` — WS handlers.
- `src/server/orchestrator/services/session-message-outcome-notice.ts` — the
  next-turn notice and its delivery receipt (req 14).

Changed:

- `orchestrator/services/child-sessions.ts` — extract `deliverSessionMessage`.
- `shared/types/domain-types/chat.ts` — `SessionMessageProposalCard`;
  `SessionMessageOrigin.relation` gains `"proposed"`.
- `shared/types/ws-server-messages/cards.ts` — the two WS messages.
- `shared/database.ts` — `session_message_proposal` column + migration.
- `orchestrator/chat-history.ts` — field, `toRow`/`fromRow`, `find…`/`list…`/`update…`.
- `orchestrator/ws-handlers/agent-execution.ts`, `orchestrator/dispatched-turn.ts`,
  `orchestrator/runner-registry-factory.ts`, `orchestrator/session-runner.ts` —
  the notice on both prompt paths.
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
- `integration_tests/propose-session-message-route.test.ts` — the refusals in
  the table above; the happy path emits and persists a card; and, observed at
  the **target**, that proposing delivers nothing and starts no turn. The last
  is the req 7 assertion that a card-state check cannot make: an eager dispatch
  that forgot to set `state` would pass the card check and fail this one.
- `integration_tests/propose-session-message-deliver.test.ts` — the click
  dispatches a turn into a **root** session and into a **sibling**; the message
  the target receives carries `relation: "proposed"`; a second delivery is
  refused; a target archived after the card fails the card, not the request; the
  reported `queued` matches the dispatch's admission; and a persistence failure
  **after** dispatch leaves the card un-retryable while the message still lands.
  Declining: recorded and emitted, refused once delivered, a declined card is
  never delivered, and a decline that could not be stored tells the viewer
  nothing. The WebSocket prompt path carries the outcome once.
- `services/session-message-outcome-notice.test.ts` — what is owed, the text,
  quoting, and the receipt. `integration_tests/repo-session-outcome-notice.test.ts`
  covers the dispatch prompt path for both cards.
- `child-sessions.test.ts` — `sendChildMessage` still refuses a non-child after
  the extraction (the guard that the split did not widen the scope).
- `chat-history.test.ts` / `visual-elements.test.ts` — the two self-enforcing
  guards; extend `EVERY_OPTIONAL_FIELD_MESSAGE`.
- `SessionMessageProposalCard.test.tsx` — approve, a second click while the
  first is in flight, failed + retry, delivered is terminal, and the expander
  for a **short** message the clamp still clips (jsdom lays nothing out, so the
  overflow is driven explicitly — without that the test proves nothing).

What is deliberately NOT tested here: the container guard is asserted through
route *registration* (`containerAccessible`), not by sending a request from a
container peer — the guard's own request-time enforcement has its own tests
(`api-container-guard.test.ts`), and duplicating a peer-IP fixture here would
test that file rather than this feature.
