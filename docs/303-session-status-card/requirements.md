---
issue: planning#550
title: Session status card
description: An agent-written card at the bottom of the conversation that says what the session is about, where it stands, and what needs the user.
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
4. The card has two fields: "Status" — what the session is about, how far
   it got, and whether it is done or ready to merge, including agent work
   not yet started — and "Needs you" — the decision or hand action, empty
   when there is none.
5. The agent writes the card at the end of its turn, with a tool call.
6. The card sits at the bottom of the conversation, stuck to the input
   field: the place where the user already reads the agent's last sentences.
   It is a separate element, always visible, not a message in the transcript.
7. The card does not appear in the session sidebar. The sidebar already
   carries a lot, and one more line per session would not read at a glance.
8. The card is always shown, also on a turn that ends with a question card
   or a follow-up-actions card. Those cards are the last thing in the
   conversation; the status card stays below them, at the input field.
9. The card does not make a session "need attention". The needs-attention
   indicator works today; the user reads the card after the agent has
   finished, when they already know the session needs them.
10. The card is there whenever the user opens the session, however long after
    the turn that wrote it.
11. The card is always up to date. A stale card has no value: the user would
    have to read what the agent did anyway.
12. ShipIt checks at the end of each turn that the agent updated the card. If
    it did not, ShipIt sends the agent a further turn that asks for the
    update, on every harness alike. That turn is visible in the conversation,
    as a regular turn, for transparency.
13. A turn that ended with a question card or a follow-up-actions card is
    complete without a card update. The card may lag by a turn there;
    updating it would waste tokens and turns. The card then shows that it may
    be behind (req 14).
14. The card always shows whether it is current. When the last finished turn
    did not update it — because that turn ended with a question or an actions
    card, or because the agent ignored the nudge — the card is visibly marked
    as possibly stale, in one visual language shared by both cases, so it is
    always clear to the user. No title text is spent on it: a current card
    looks like a regular card; a stale card carries a small "Stale" label in
    its bottom-right corner, in the theme's accent color.
15. ShipIt nudges once per missing update. If the agent ignores the nudge,
    ShipIt does not nudge again for that turn; the card is marked stale
    (req 14) and the next ordinary turn is checked afresh.

## Open questions

- None.

## Resolved questions

- 2026-09-14 — How is freshness shown? The prototype drew three variants
  (left rail, dot, tinted header), each with a header reading "Current" or
  "May be behind · the last turn did not update it". Nik: it is wasteful to
  spend the whole title on this state; the state should be represented by
  appearance only — up-to-date: the regular card color; stale: 70% opacity.
  This replaces the earlier amber/green direction. → req 14. Drawn and
  rejected the same day: "the opacity is barely visible and not clear what it
  is." Nik's next direction: the text "Stale" in the primary color in the
  bottom-right corner. Drawn in the two tokens that phrase can mean; Nik chose
  the theme accent (`--color-accent`) over the primary text color. → req 14 as
  it stands now.
- 2026-09-14 — The agent ignores the nudge too: one attempt or two? One. Nik
  added the part the design lacked: the card needs "some visual language for
  saying that the card is potentially stale", shown in this case and equally
  when a turn ends with a question and does not update the card, "so it's
  always super clear for the user" — perhaps orange for stale and green for
  updated; prototype it; the same language in both cases. → reqs 13–15. This
  also settles what the earlier receipt about staleness meant: a stale card
  presented as current is what has no value; a stale card that says so is
  required.
- 2026-09-14 — A turn ends with no card update, no question and no actions
  card: nudge, or show the previous card marked older? Nudge. Nik: a stale
  card "doesn't make any sense"; if it is stale the user has to read what the
  agent did, "spend a lot of time and mental effort", so the card is always
  up to date. On mechanism: the Claude Stop hook "is essentially another
  turn", so ShipIt sends the turn itself, universally, and makes it visible
  as a regular turn for transparency. Asked twice; the second time was a
  mistake — the first answer already ruled out any stale state. → reqs 11–12.
- 2026-09-14 — Does the card also appear on a turn that ends with a question
  or actions card? Yes; it is always shown. Nik reframed it: perhaps not a
  regular card but "a separate UI element that's always at the bottom, stuck
  to the input field, because it is what the session is about". The top of
  the conversation was considered and rejected: people look at the latest
  messages, so the bottom is already the attention field. On such a turn the
  card may be stale; updating it would waste tokens and turns. → reqs 6, 8,
  13.
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
  Later the same day Nik renamed the first field: "Where it stands" → "Status".
  He also ruled that merging is never a next step: "Merge after review" is the
  default ShipIt workflow, so readiness belongs in the status ("Status: Ready
  to merge"). Then, asked whether "Next" and "Needs you" differ — everything
  under Next waits for the user's go anyway — he chose two fields: Status and
  Needs you, with unstarted agent work stated in Status. → req 4 and the
  prompt guidance in plan.md.
