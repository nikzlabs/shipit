---
issue: planning#550
title: Session status card
description: An agent-written card at the bottom of the conversation that says what the session is about, where it stands, what comes next and what needs the user.
---

# Session status card

Requirements as stated by the user (Nik), captured 2026-09-14 from a
voice-dictated design conversation. Statements are what the feature must do,
never how. Design lives in `plan.md`.

## Problem, in the user's words

Switching to a session, the user may have forgotten what it was doing: it was
a long time ago, or many sessions run in parallel. The agent prints a lot of
text, so the gist takes time to extract. And the newest message is often not
about the session's work at all — a rebase just happened, or something else
incidental. The user's current workaround is a custom instruction asking the
agent for a closing block; it is not reliable and less structured than wanted.

This is a step toward the coordinator of
[docs/280-fleet-coordination](../280-fleet-coordination/requirements.md),
taken inside one session, without building an agent that talks to many.

## Requirements

1. When the user switches to a session, they understand at once what the
   session is about, whether the work is done, and whether it needs a decision
   from them.
2. The card is very concise.
3. The card describes the session, not the last turn. The last turn's text is
   already on screen when the user arrives; a card that repeats it has no
   value.
4. The card has three fields: where it stands, what comes next, and what needs
   the user.
5. The agent writes the card at the end of its turn, with a tool call.
6. The card sits at the bottom of the conversation, just above the input
   field: the place where the user already reads the agent's last sentences.
7. The card does not appear in the session sidebar. The sidebar already
   carries a lot, and one more line per session would not read at a glance.
8. The card is one of the end-of-turn cards, together with the question card
   and the follow-up-actions card. The last card in the conversation is what
   the user looks at, and it is always at the bottom.
9. The card does not make a session "need attention". The needs-attention
   indicator works today; the user reads the card after the agent has
   finished, when they already know the session needs them.
10. The card is there whenever the user opens the session, however long after
    the turn that wrote it.
11. ShipIt checks at the end of each turn that the agent issued an end-of-turn
    card. A turn that ended with a question card or a follow-up-actions card
    counts as complete.

## Open questions

- A turn ends with no end-of-turn card at all. Does the user wait for ShipIt
  to nudge the agent into an extra turn that writes the card, or does the
  conversation show the previous status card marked as older than the last
  turn? The nudge is what the user first proposed; its cost differs per
  harness.
- A turn ends with a question card or a follow-up-actions card. Does the
  status card also appear on that turn, above them, or does the question or
  actions card stand alone? The user raised this themselves and left it open.

## Resolved questions

- 2026-09-14 — Should a card that the agent did not write be filled from the
  turn's last message? No. Nik: the last turn is already on screen, so a card
  showing it "would be literally no different from what we have today". What
  is wanted is the session's state: what it is about, whether the work is
  done, what needs a decision. → reqs 1–3.
- 2026-09-14 — Should the card's "needs you" field count as a reason the
  session needs attention? No. Nik: the card is shown after the agent finished,
  when the user already knows the session needs them for some reason; "the
  needs-me indicator is working fine already now". → req 9.
- 2026-09-14 — Where does the card appear? At the bottom of the conversation,
  above the input field, never in the sidebar. Nik: the sidebar "is already a
  lot of information", and every session has its own context, so one more
  line would not skim better than the titles already do. The bottom of the
  conversation is "the attention place of the user". The question card is
  already the last card and "working great"; the status card should be
  standardized with it. → reqs 6–8.
- 2026-09-14 — Which fields? Where it stands, next, needs you. → req 4.
