---
issue: planning#550
title: Session status card
description: An agent-written card at the bottom of the conversation that says what the session is about, where it stands, what needs the user, and which follow-up actions the agent offers.
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
2. The card is concise: no padding, nothing the user does not need.
3. The card describes the session, not the last turn. The last turn's text is
   already on screen when the user arrives; a card that repeats it has no
   value.
4. The card has two fields: "Status" — what the session is about, how far
   it got, and whether it is done or ready to merge, including agent work
   not yet started — and "Needs you" — the decision or hand action, empty
   when there is none. Below them it carries the agent's offered follow-up
   actions (req 16).
5. The agent writes the card at the end of its turn, except a turn that
   ends with a question card (req 13).
6. The card sits at the bottom of the conversation, just above the input
   field: the place where the user already reads the agent's last sentences.
   It is a separate element that does not scroll away with the conversation,
   not a message in the transcript.
7. The card does not appear in the session sidebar. The sidebar already
   carries a lot, and one more line per session would not read at a glance.
8. The card is shown also on a turn that ends with a question card. The
   question card is the last thing in the conversation; the status card stays
   below it, just above the input field.
9. The card does not make a session "need attention". The needs-attention
   indicator works today; the user reads the card after the agent has
   finished, when they already know the session needs them.
10. The card is there whenever the user opens the session, however long after
    the turn that wrote it.
11. The card is kept current: after every turn it either reflects the session
    as of that turn — the two fields and the offered actions alike — or it is
    visibly marked as possibly stale (req 14). It is never presented as
    current when it may be behind.
12. ShipIt checks at the end of each turn that the agent updated the card.
    If it did not, ShipIt sends the agent a further turn that asks for the
    update, on every harness alike, except in the cases of req 13 and
    req 15. That turn is visible in the conversation, as a regular turn, for
    transparency.
13. A turn that ended with a question card is complete without a card
    update. The card may lag by a turn there; updating it would waste tokens
    and turns. The card then shows that it may be behind (req 14).
14. The card always shows whether it is current. Current means the last
    finished turn updated the whole card. When the last finished turn did not
    update it, whatever the reason, the card is visibly marked as possibly
    stale, in one visual language for every cause, so it is always clear to
    the user. Between turns and while a turn runs, the card shows the state
    as of the last finished turn. No title text is spent on it: a current
    card looks like a regular card; a stale card carries a small "Stale"
    label in its bottom-right corner, in the theme's accent color.
15. ShipIt nudges once per missing update. If the agent ignores the nudge,
    ShipIt does not nudge again for that turn; the card is marked stale
    (req 14) and the next ordinary turn is checked afresh.
16. The follow-up actions the agent offers are part of the status card. They
    are the same thing as the card: what can happen next in this session.
17. Offered actions persist across turns. A turn does not clear them; only
    the agent changes the list, by adding to it or replacing it. An action
    the user has taken — sent to the agent as a message — stays on the card,
    greyed out, unselected and not selectable again, until the agent removes
    it.
18. The card shows every offered action that is relevant. Concise means no
    padding, not fewer actions than the agent has to offer; a separate card
    would not save height either.
19. The existing follow-up action card remains as it is, and action cards
    already in a conversation keep working, whether the setting (req 21) is
    on or off.
20. "Needs you" and the actions stay distinct in meaning: "Needs you" is what
    only the user can do by hand; an action is agent work the user approves
    with a click.
21. The whole feature sits behind a global setting, off by default, so the
    user can try it for a few days before it is released. With the setting
    on, the agent offers actions through the status card and cannot post a
    follow-up action card. With the setting off, nothing changes from today:
    no card, no nudge, and the follow-up action card as it is now.
22. Before the first status write — a new session, or one whose first turn
    ended with a question — there is no card. The first ordinary turn
    produces it.
23. When the setting is turned off and later on again, the card shows the
    earlier status and its offered actions, marked stale. The next turn
    refreshes it.
24. While the card is marked stale, its offered actions can still be taken.
    Staleness is about the words; the agent owns the action list.

## Open questions

- None.

## Resolved questions

- 2026-09-14 — The three gaps the consistency review opened. Nik: no card
  before the first write; after the setting is turned off and on again, the
  earlier status marked stale; stale actions still selectable. → reqs 22–24.
- 2026-09-14 — Independent consistency review (ShipIt reviewer, run
  16538cd9), after Nik's review. Two contradictions fixed: req 5 now names
  req 13's exception; reqs 11 and 14 now say "current" means the whole card,
  actions included. Mechanism words removed from reqs 5, 16 and 21 (no tool
  names). Redundancy trimmed: req 19 keeps only what req 21 does not say. Two
  gaps closed by clarifying Nik's words: req 14 says the card shows the last
  finished turn's state between and during turns; req 17 says a taken action
  is not selectable again. Three gaps opened as questions above.
- 2026-09-14 — Review of this document by Nik. "The card is always up to
  date" contradicted the stale concept → req 11 rewritten as "kept current:
  reflects the session or is marked stale". "The existing action card is
  evolved into this" removed → req 19 now says the existing card remains and
  the status card replaces it if and only if the setting is on. "Stuck to the
  input field" → "just above the input field" everywhere. Historical
  parentheticals removed from the requirements; history lives here. Taken
  actions the agent did not remove are greyed out and unselected → req 17.
- 2026-09-14 — Is the card always on? No. Nik: the new card should be
  togglable in settings, and `propose_actions` is unavailable to the agent
  only while the new card is enabled. Then: "essentially the new feature
  would be behind a feature flag in settings, off by default. Need to try it
  myself for a few days before releasing." → req 21.
- 2026-09-14 — Should the follow-up action card be part of the status card?
  Yes. Asked for pros and cons, Nik answered the cons one by one: untaken
  offers should not vanish — the agent can add to or replace the list; the
  card is "concise but not smaller than needed", so all relevant actions are
  shown and a separate card saves no height; actions are not cleared each
  turn; the existing action card should be evolved to simplify the work; and
  the distinction between "Needs you" and actions holds on one card as on
  two. → reqs 4, 13, 16–20.
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
