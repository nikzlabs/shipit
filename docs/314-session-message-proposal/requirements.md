---
issue: planning#450
title: Propose a message to an unreachable session as a card
description: An agent that needs to reach a session it cannot address offers the message as a card; the user approves delivery with one click.
---

# Propose a message to an unreachable session as a card

What the feature must do, in the user's terms. Design lives in
[`plan.md`](plan.md).

## The gap this closes

`shipit session message` reaches **direct children only**. The refusal is
`assertChildOfParent` (`src/server/orchestrator/services/child-sessions.ts:545`),
which compares `child.parentSessionId !== parentSessionId` — an equality test on
one hop, not a walk up the tree. `view`, `wait` and `notify-on-merge` share that
helper; `list` uses `findChildren`, which is the same one hop.

One other session IS reachable: `shipit session report` resolves the caller's
**direct parent** from its own linkage and wakes it
(`orchestrator/services/session-report.ts:148`). That channel needs no card, so
it is not in scope here — a proposal for a direct parent is refused and points
at it (req 9).

Everything else is unaddressable: a **root** session (the case planning#450
names), a **sibling**, a **grandchild**, and any unrelated session on the box.
On 2026-08-19 an operator had to drive the `send_message` WS handler by hand for
want of any agent-facing route.

That scoping is a security property — it is what stops one session injecting a
turn into an unrelated one — and it is not widened here. A human approval is
what makes the unreachable case possible without giving it up.

## Requirements

1. An agent that needs to send a message to a session it cannot address can
   offer that message to the user as a card in its own chat transcript.
2. The card names the session the message would go to and shows the whole
   message, before the user acts on it.
3. The user approves delivery from the card. The user does not copy the message,
   does not open the target session, and does not paste anything into a
   composer.
4. One approval delivers the message to the target session and starts its turn
   there — the same result as the user typing the message into that session.
5. An approval delivers exactly the message on the card, once. It grants the
   proposing session no standing ability to send further messages; a second
   message is a second card and a second approval.
6. The receiving session can see where the message came from — the proposing
   session, named — the same way it already sees a message sent from its parent.
7. Until a human approves a card, nothing reaches the target. An agent's reach
   without approval is exactly what it was before this feature.
8. A target the agent got wrong is refused when the agent asks for the card, not
   when the user clicks it. That covers a session id that does not exist, the
   proposing session itself, and any session that could not receive the turn if
   the user did click — for whatever reason ShipIt already refuses one.
9. An agent that can already reach the target directly is told to use the direct
   route instead of proposing a card. Today that means a session it spawned
   (`shipit session message`) and the session that spawned it
   (`shipit session report`).
10. An agent that hits the existing "not found" refusal from a direct-message
    attempt is told that the proposal card exists, so the dead end names its own
    way out.
11. The agent names the target session itself, from the prompt it was given.
    ShipIt adds no agent-facing API for enumerating the sessions on the box.
12. The card stays in the transcript after the turn ends and after a page
    reload, and records whether the message was delivered.

## Open questions

None.

## Resolved questions

- 2026-09-22 — *What shape does the fix take?* The requester: "Let's do like we
  have in the case of a proposed session in another repo: a card that the user
  can approve." Recorded on planning#450. This settles reqs 1–4 and rules out
  both fixes the issue had proposed — the clearer error message, and a
  token-scoped inbound channel a session opts into.
- 2026-09-22 — *One message, or a standing channel?* Carried by the answer
  above. The issue put a standing channel on the table as its item 2; the
  requester chose a proposal card over it. A card approves what is printed on
  it, and what is printed on it is one message (req 5).
- 2026-09-22 — *Which targets need a proposal — any session, or only a root
  one?* Carried by the answer above, read at its plain words: the card covers
  any session the caller cannot already address (reqs 1, 9). Restricting it to
  root sessions would be a carve-out with nothing behind it, since the human
  approval that makes a root session safe to reach is the same approval that
  makes a sibling safe to reach — and it would leave the sibling case, inside an
  orchestration cohort, exactly as dead as it is today.

## Requirement provenance

The requester supplied one sentence — the shape. It is quoted verbatim in the
first resolved question above, and reqs 1–4 are that sentence made observable.
Everything below is derived, and is flagged here so review can see what was not
asked for:

- **Reqs 5, 9** — read off the requester's answer, as recorded above.
- **Req 7** — the security property planning#450 states and the issue's own
  "don't widen `message`" constraint. Restating it as a requirement is what
  lets a reviewer fail the feature on it.
- **Req 6** — derived. The mechanism already exists and is already user-visible:
  a dispatched message carries a `SessionMessageOrigin`
  (`src/server/shared/types/domain-types/chat.ts:4`) and the receiving
  transcript renders "From … session · title"
  (`src/client/components/MessageList/TranscriptRow.tsx:226`). Showing less
  than a parent message shows would be the odd choice.
- **Req 8** — carried over from `propose_repo_session`, which resolves the
  target at call time so a bad address fails back to the agent while it can
  still fix it, rather than under the user's click.
- **Req 10** — planning#450's own item 1, folded in. It is one string, and
  without it an agent that hits the dead end still has to guess the way out.
- **Req 11** — mirrors `docs/303-cross-repo-session-proposal req 7`. The issue's
  case already hands the id over in a prompt, and session inventory is
  deliberately Ops-only today (`api-routes-host-sessions.ts:13`).
- **Req 12** — CLAUDE.md, "Chat transcript content MUST be persisted".
