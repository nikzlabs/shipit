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
3. The card describes the session, not the last turn, with one bounded
   exception: a single line of its own about the last turn (req 31). The
   status field itself never repeats the turn — the turn's text is already
   on screen when the user arrives, and a status that repeats it has no
   value.
4. The card has three fields: "Last turn" — one or two sentences on what the
   agent did, or the direct answer when the user asked something (req 31) —
   "Status" — what the session is about, how far it got, and whether it is
   done or ready to merge, including agent work not yet started — and
   "Needs you" — the decision or hand action, empty when there is none.
   Below them it carries the agent's offered follow-up actions (req 16).
5. The agent writes the card at the end of its turn, or confirms it when
   nothing changed (req 14), except a turn that ends with a question card
   (req 13).
6. The card sits at the bottom of the conversation, just above the input
   field: the place where the user already reads the agent's last sentences.
   While the agent is idle it is the last element of the conversation, unless
   a card waiting for the user's answer is there (req 32), and it scrolls with
   it, so that on a small screen it never takes space from the conversation.
   While a turn runs it moves out of the way (req 30). It is not a message in
   the transcript.
7. The card does not appear in the session sidebar. The sidebar already
   carries a lot, and one more line per session would not read at a glance.
8. The card is shown also on a turn that ends with a question card. Once that
   turn has ended, the question card is the last thing in the conversation and
   the status card sits above it (req 32).
9. The card does not make a session "need attention". The needs-attention
   indicator works today; the user reads the card after the agent has
   finished, when they already know the session needs them.
10. The card is there whenever the user opens the session, however long after
    the turn that wrote it.
11. The card is kept current: after every turn it either reflects the session
    as of that turn — the two fields and the offered actions alike — or it is
    visibly marked as possibly stale (req 14). It is never presented as
    current when it may be behind.
12. ShipIt checks at the end of each turn that the agent updated or confirmed
    the card.
    If it did not, ShipIt asks the agent for the update, on every harness alike,
    except in the cases of req 13 and req 15. Since req 38 the ask is a line in
    the next turn's prompt and costs no turn; it was a further turn of ShipIt's
    own, visible in the conversation for transparency, while it did.
13. A turn that ended with a question card is complete without a card
    update. The card may lag by a turn there; updating it would waste tokens
    and turns. The card then shows that it may be behind (req 14).
14. The card always shows whether it is current. Current means the agent
    confirmed the whole card at the end of the last finished turn. A
    confirmation may change nothing: when the status, "Needs you" and the
    offered actions still hold, the agent says so without rewriting them,
    and the card is current. When the last finished turn neither updated
    nor confirmed it, whatever the reason, the card is visibly marked as
    possibly stale — except a turn that could not have changed what the card
    says, which leaves it exactly as it was (req 36) — in one visual language
    for every cause, so it is always clear to the user. Freshness is judged when a turn ends. No title text
    is spent on it: a current card carries no mark at all; a stale one
    carries a small "Stale" label at the right-hand end of the Status cap
    (req 33), which covers the whole stack and is read first.
15. ShipIt asks once per missing update. If the agent ignores the ask, ShipIt
    does not repeat it for that turn; the card is marked stale (req 14) and the
    next ordinary turn is checked afresh. Since req 38 the ask is carried by the
    next turn's prompt, so "once per missing update" is one outstanding ask, not
    one attempt that can be lost when it cannot be sent.
16. The follow-up actions the agent offers are part of the status card. They
    are the same thing as the card: what can happen next in this session.
17. Offered actions persist across turns. A turn does not clear them; only
    the agent changes the list, by adding to it or replacing it. An action
    the user has taken — sent to the agent as a message — stays on the card,
    greyed out and unselected, until the agent removes it. It can be ticked
    and sent again: the agent may have crashed, or never acted on it, and
    telling it again must not need new machinery.
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
    on, the agent offers actions through the status card, and the means to
    post a follow-up action card is not in the agent's context at all: not
    present and refused, but absent. With the setting off, nothing changes
    from today: no card, no nudge, and the follow-up action card as it is
    now.
22. Before the first status write — a new session, or one whose first turn
    ended with a question — there is no card. The first ordinary turn
    produces it.
23. When the setting is turned off and later on again, the card shows the
    earlier status and its offered actions, marked stale. The next turn
    refreshes it.
24. While the card is marked stale, its offered actions can still be taken.
    Staleness is about the words; the agent owns the action list.
25. With the setting on, the agent has clear instructions for the card in
    the system prompt ShipIt injects: when to write or confirm it, what the
    two fields mean, how to offer actions. The gist is in that prompt, on
    every turn, not in a skill the agent has to load. A skill may carry a
    longer explanation of how to use the card.
26. Every offered action carries a description as well as a label, and the
    card shows it, so the user knows what an item is before they tick it. The
    offers look and behave like the follow-up actions of the existing card:
    the card's own appearance is the product's, not the prototype's. It keeps
    what the existing card can do — the comment shortcut included — and adds to
    it rather than removing anything.
27. The status is markdown and may run to a short list rather than one
    sentence; the card renders it as markdown. "Needs you" is a list: one entry
    per thing only the user can do, carried as a repeated field in the API, and
    shown as a list when there is more than one.
28. The card is laid out as named sections, not as a labelled column: the
    status, the things only the user can do under the name "Manual steps", and
    the offered actions under the name "Follow-ups". Since req 33 the three
    top-level names are the caps of the three cards, and "Manual steps" and
    "Follow-ups" are subtitles inside the "Next steps" card, with a rule
    between them.
    A taken action says "sent" on the row, so its grey is never a mystery.
29. Each manual step carries a toggle — "I've done this" — so the user can
    report by hand what they have done. What they ticked is sent to the agent
    together with the approved actions, in the same message; a step can be
    reported with no action approved. The submit button is labelled "Submit".
    A reported step behaves as a sent action does: greyed, unselected, and
    sendable again. Since req 44 it keeps a tick as a record of what was
    reported; unselected is about what Submit would send, not about the box
    being empty.

30. The card is at the bottom only while the agent has stopped. When a turn
    starts, the card keeps the place it already had — the end of the finished
    conversation — and everything the running turn produces appears below it,
    so the card leaves the view of its own accord as the agent writes and the
    live output is what the user follows. It does not disappear while the turn
    runs. When the turn stops, the card is at the end of the conversation
    again, and that return never moves what a user who has scrolled up is
    reading.

31. The card carries one or two sentences saying what the agent did in the
    last turn, or the direct answer when the user asked something. It is a
    field of its own, written by the agent, and a section of its own — since
    req 33 the second of the three cards, between the status and the next
    steps — never a convention inside the status
    text, which goes on describing the session. When there is nothing worth
    saying about the turn, the section is absent. It is shown only while the card is current: on a
    stale card the line is hidden, because a turn line that is one turn behind
    misleads more than a stale session status does. And it is never carried
    forward — every card write either rewrites the line or drops it, since a
    line kept from an earlier write describes a turn that is over.

32. When the conversation ends with a card that waits for the user's answer —
    a question card, or a plan to approve — that card is the last element of
    the conversation. Everything else the turn produced, the voice-note card
    and the status card included, sits above it, so that what the view lands
    on is the control the user has to reach. This holds whether or not the
    status card also offers actions: the question is what holds the session
    up, and an offer can be taken at any later time.

33. The card is found at a glance. It does not blend into the conversation
    text, and it does not read as one more transcript card: it is three cards
    in a stack, each with a cap naming it, drawn in the theme's accent colour
    over a tinted body. Nothing else in a conversation is coloured that way, so
    the stack is the one coloured object on the screen. This does not make the
    session need attention (req 9): it makes the card easy to find once the
    user is in the session.

    The three are not equally loud, and the order follows what they ask of the
    user. **Status** comes first, quiet — a cap tinted in the accent with accent
    text — because it is read, not acted on. **Last turn** comes second and is
    quieter still: it carries no accent at all, only the ordinary card surface,
    because it is an aside beside a turn the user has usually just read.
    **Next steps** comes last, nearest the input field, and is the loud one — a
    cap filled with the accent — because it is the only card that asks
    something: it holds the manual steps and the follow-ups together, under the
    one Submit they share (req 29). The accent therefore means "the session,
    and what to do about it".

34. A turn that a message reached after it started is complete without a card
    update. When a message arrives into a turn already under way — the user
    steering it, a message from an agent interface or from another session, or
    a message a resident agent puts behind a turn of its own — answering that
    message is what ShipIt owes next, and it never sends the nudge instead. The
    card then shows that it may be behind (req 14), and the next turn is checked
    afresh, as after any nudge ShipIt did not send (req 15).

35. The card the agent is asked to keep current is in front of it every turn it
    could be asked to update: what the status says, each manual step, and each
    offered action with whether it has been sent. Reconciling the card is then
    reading, not remembering — a step the user has done or an offer no longer
    worth offering can be dropped because the agent can see that it is there.
    This holds on every harness and for an agent that stays running between
    turns. A session with no card yet carries nothing. The turn ShipIt sends
    when an update is missing (req 12) carries the same contents and asks the
    agent to go through the card line by line, rather than only asking for a
    call. The agent is never asked to reconcile the card without having been
    shown it: where it cannot be put in front of the agent during a turn, the
    turn that does the asking carries it.

36. ShipIt asks about the card only after a turn that could have changed what the
    card says. A turn the harness answers by operating on the conversation itself
    — compacting it — does nothing to the session: it produces no work of the
    agent's own, so there is nothing to report, the card is not behind, and
    ShipIt neither asks for an update after it nor marks the card stale. Every
    other turn ShipIt starts of its own is checked exactly as a turn the user
    typed is — a merged-PR wake, a result delivered from another agent, a message
    from a child session, a continuation after a quota refusal or a rebase, a CI
    fix — because each of them leads to work of the agent's own that the user
    wants on the card. The test is what the turn does, never which kind of turn
    it is or who started it, so a kind added later is covered without an entry on
    any list. This does not loosen req 15: a turn that did the session's work and
    did not update the card is still marked stale and still gets its one nudge.

37. A manual step can be answered, not only ticked. Each step carries a note of
    its own — one line the user writes against that step — so that a report can
    carry the detail the agent needs to carry on correctly ("done, but I named
    it `billing-prod`"), and so that a step can be refused, qualified or
    declared blocked ("no — use SQLite", "GitHub will not let me"), which the
    card cannot say at all while a step can only be ticked. A note can be sent
    without ticking the step: the row is then answered, not reported done, and
    the agent is told which of the two it is. The note belongs to its step in
    what the agent receives, however many steps are submitted at once. The
    field is not on the row until the user asks for it, so a card nobody
    annotates is the card of req 2.

38. Asking for a missing update costs no turn. When a turn ends without one, ShipIt
    asks for it in the next turn's prompt, beside the card, rather than by sending a
    turn of its own. Because the ask is free, it is made after every turn that missed
    — a turn the user steered, one they stopped, one whose agent is holding background
    work, one a git driver owns — and not only after the turns a further turn could
    safely be spent on. Four turns are still not asked: one that updated the card, one
    that ended with a question or a plan to approve (req 13), one that crashed, and one
    the harness answered by operating on the conversation (req 36). A turn the user
    stopped is not one of the four: it did the session's work, whether or not the
    harness answered the stop with a result. A session with no card yet is asked for its
    first one the same way. The ask stands until a call answers it — no later turn drops
    it, not even one that is itself exempt — so a turn ShipIt composes no prompt for
    defers the ask to the next turn that has one rather than losing it. This supersedes the mechanism of reqs 12 and 15 — the
    visible further turn, and the one attempt per miss — and leaves what they were for
    unchanged: every miss is asked about exactly once, and the card meanwhile says it
    may be behind (req 14).

39. The reconciliation the turn owes closes the card block. The block ends with the
    instruction, in the words ShipIt used when it spent a turn on it, so that the last
    thing read before the user's message is what to do about the card.

40. The block shows how long each manual step and each offer has been on the card,
    counted in turns — "offered 9 turns ago" — and how long ago the user sent an offer
    they took. Drift the agent has stopped noticing is then something it can see rather
    than remember. An entry whose turn was never recorded says so, and keeps saying so:
    nothing but the agent introducing an entry gives it an age.

41. Every part of the card the agent wrote renders as markdown, not the status alone:
    the last-turn line, each manual step, and each offer's label and description. A link
    in any of them is a working link — into a file, an issue, or the running app — and
    clicking it does not tick the row it sits in. The same goes for the transcript
    action card, whose rows are the same rows.

42. The card can be collapsed into a single icon, so that a long session's
    growing list of steps, follow-ups and status does not take the screen. The
    card opens expanded; the user collapses it, and it stays collapsed for that
    session until they open it again. It never folds itself up: a new manual step
    is visible the first time, without a press. Collapsing hides the card's words
    and never the fact that something is waiting — what the collapsed icon shows
    still says that the user is needed. This is the pinned card at the end of the
    conversation; the transcript's own follow-up action card is unchanged.

43. The card is immediately above the input field whenever the conversation is
    shorter than the view — a short session, and the gap before the conversation
    has loaded — and it does not move when the conversation arrives. Where the
    conversation fills the view, the card goes on scrolling with it (req 6). What
    is below the card is unchanged: a running turn's output (req 30) and a card
    waiting for the user's answer (req 32) sit under it as they do in a long
    conversation.

44. A row the user ticked and sent keeps a tick in its checkbox, so the card goes
    on showing which rows they ticked rather than only that something was sent.
    The tick is a record of what went, and is told apart at a glance from a row
    ticked now and waiting for Submit. A row sent with a note alone, never
    ticked, carries no tick: what is remembered is whether the row was ticked
    when it was sent. A recorded row is ticked and sent again exactly as req 17
    says, and unticking it before Submit cancels only that re-send and leaves the
    record. A record never makes the collapsed card (req 42) report outstanding
    work, and never adds a row to what Submit sends.

45. A manual step and a follow-up's description are markdown, so each has room
    for a long link: up to 1000 characters each.

## Open questions

- None.

## Resolved questions

- 2026-09-24 — Nik: "240/280 should be increased since they are markdown. Often
  the agent gives a long links, and they fail." Asked whether to count only the
  visible text of a link or to raise the raw limit, he chose "Raise to 1000
  each". Asked about "the total", he said the 8000-character limit on the card
  text sent to the agent each turn is fine as it is. → req 45.
- 2026-09-21 — Nik: "when a manual step or a follow-up is 'sent' and was checked
  (manual steps could be sent with comments only), it should be marked as checked
  in the checkbox". → req 44. Submitting cleared the selection, so a row came
  back greyed and tagged SENT with an EMPTY box, and the card no longer said
  which rows he had ticked. His parenthetical is the other half and is what makes
  the state per row: a manual step can be sent carrying only a note (req 37's
  ANSWERED path), and such a row was not ticked, so it must not show a tick.

  Decided here and not by him. **The record is a display state, not a second
  mechanism**: the checkbox is still the selection, and the record is drawn in
  the muted box rather than the accent, so a re-tick is louder than what it
  replaces and Submit sends what is selected and nothing more. That keeps req 17
  whole — a sent row is still tickable, a tick re-sends it, and unticking it
  cancels only the re-send — where making the record the input's own checked
  state would have re-sent every previously ticked row on the next Submit. **A
  re-send rewrites the record rather than accumulating**, so a step ticked once
  and later answered with a note alone loses the tick: the box says what the last
  send said about the row. **An offer needs no separate memory** — an offer can
  only be sent by ticking it, so every sent offer carries the record, including
  one the server reports taken from an earlier load.

- 2026-09-21 — Nik: "the cards should be visually right on top of the input if
  the conversation is short or didn't load yet. Now the cards are shown at the
  top while conversation is loading, and then they move down". → req 43. Not a
  question he was asked; the requirement is recorded here because req 6 says the
  card is the last element of the conversation, which puts it immediately above
  the input field only once the conversation is tall enough to fill the view.

- 2026-09-21 — Nik: "need a way to collapse the cards into a single icon, in a
  long session the list of steps/followups/status only grows". → req 42. Two
  things were put to him and both are in the requirement. **When it collapses**:
  he chose manual only — the card opens expanded, an icon collapses it, and it
  stays collapsed for that session until he opens it again; he rejected
  collapsing itself once long, and rejected collapsed by default, because a new
  manual step must be visible the first time without a press. **What it covers**:
  offered the transcript cards as well, he answered that there is only a single
  set of status cards. That is right for him — the transcript's
  `ActionChecklistCard` is the older follow-up card from before this feature and
  he does not see it — so the scope is the pinned card and that component is left
  alone.

  Decided here and not by him. **The collapsed state lives in this browser**, per
  session, beside the other per-session view state: it is what this viewer is
  showing, not something the agent or a second viewer decides, and it survives a
  reload and a session switch because the point is a long session staying quiet.
  **The icon carries what is outstanding** — a count of the manual steps not yet
  reported, a count of the offers not yet sent, and the "Stale" mark — counted on
  the same `taken` the rows grey themselves on, so the pill cannot disagree with
  the card underneath it. Without that, collapsing would turn the card into a
  hiding place the moment it was used. **An arriving step or offer does nothing
  more than raise its count.** He ruled out expanding, and no separate "new" mark
  was added beside the count: a mark means unseen, which needs a seen/unseen
  lifetime of its own to clear, and the count going from none to one already says
  the same thing in the place the user is looking.

  Same day, on the first drawing, he moved the control: "it needs to be at the
  bottom right on the bottom card, not in the 'status' necessarily." The first cut
  had put it in the Status cap because that cap is the one always drawn; the
  bottom-right of the last card is the corner nearest the composer, and so
  nearest his hand. Which card is last moves — "Next steps" is absent with
  nothing to do, and "Last turn" is absent on a stale card and when the agent had
  nothing to say — so the control follows it rather than sitting on a fixed card.
  The "Stale" mark stays in the Status cap, where the 2026-09-16 round put it.
  Requirement 42 is unchanged: it says the card collapses into a single icon and
  says nothing about where the control that does it lives, which is the design's
  to settle.

  And once it was in front of him collapsed: "the collapse button is on the
  right side, but the collapsed card is on the left. Move it to the right, too."
  So the icon is right-aligned and lands in the corner the control it replaced
  sat in, rather than jumping the width of the card.

- 2026-09-21 — Nik: "All parts of the cards should be rendered as markdown, not
  only status. Links etc. are useful." → req 41. Not a question he was asked; the
  requirement is recorded here because the card's fields were markdown in one
  place and plain text in three.
- 2026-09-20 — Nik, on `drift-measurement.md`, which counted 650 production turns:
  one work turn in four ends with no update, the nudge fires on 48% of the misses,
  and two calls in five say nothing about the manual steps or the offers. He approved
  the three changes the report proposes, and ruled out the fourth it names: a call
  that omits `needsYou` while manual steps are open must not be refused or discounted,
  because ShipIt shows the card and does nothing more (his 2026-09-16 ruling below).
  → reqs 38, 39, 40; reqs 12 and 15 superseded in mechanism by req 38.

  What the numbers support, and what they do not: the agent obeys an instruction that
  arrives in the turn prompt (81 of 81 nudged turns complied) and obeys the same rule
  in the system prompt about three times in four, while making the card *visible* moved
  the rate not at all. So the three changes are about where the instruction sits, not
  about how much data the agent has.

  Decided here and not by him. **Which exemptions survive**: `wasInterrupted` was one
  gate covering a question card, a plan approval and the Stop button; only the first two
  are req 13's, so the settlement now reads a narrower fact and a stopped turn is asked
  like any other. **A cardless session** is asked for its first card by the same block,
  because the nudge turn used to do that and its removal would otherwise take the only
  ask such a session gets. **The age is counted in turns settled against the card**, not
  in wall-clock time and not in card writes: it is the cheapest count that is honest,
  it needs no subsystem, and an entry stored before this change says "at an unrecorded
  turn" rather than claiming an age of zero.

  Four defects the independent review found, all fixed before the PR: an exempt turn
  settling on top of an outstanding ask dropped it; a stop the harness answered by
  exiting rather than by a result was read as a crash; the first bare confirmation after
  this change gave every legacy manual step a birthday it had not earned; and a
  driver-owned turn was left as a fifth exemption, which the review was right to reject —
  withholding the ask there was about not starting a turn inside the driver's interval,
  and there is no turn to start.

  On the report's finding 2 — a text-only turn updated the card 0 times in 46 — the
  0 is definitional: the report defines a text-only turn as one that used no tool at
  all, and `session_status` is a tool. What is real in that finding is that those 46
  turns got no ask either, and the code was read and probed rather than guessed at: a
  plain text-only turn IS nudged on `main`, so no gate keys on tool use. Three gates
  produce the class instead, each reproduced against `main` — a steer (`steered`,
  req 34), a user stop (`wasInterrupted`), and a resident agent holding background
  work, where the dispatch is refused with no log line at all. Req 38 covers all three.

- 2026-09-18 — Nik: "manual steps sometimes require the user to enter something,
  or the user wants to leave a comment per step." Five options were drawn in
  `look-step-comment.html`, in the card's real place and in four themes,
  including the two cheap ones so the comparison was honest: **A** nothing, and
  the detail typed in the composer; **B** the card's existing "Add comment…",
  which rides the same Submit; **C** a note per step, revealed by a control on
  the row; **D** a field under every step, always; **E** the agent declaring
  which step needs a value and naming the field.

  The thing put to him to judge was **attribution**, not typing convenience:
  ticking a step and typing the detail in the composer already works and costs
  the same one turn, so a per-step field earns its place only if it keeps the
  sentence attached to its step. A and B lose that — B's prefill attributes one
  ticked step by accident and nothing once two are ticked, and it cannot carry a
  note for a step the user is *not* reporting done, so the refusal half is
  unreachable there. D buys the same contract as C for about a row per step on
  every card. E was drawn although it was not recommended, and the drawing is
  what makes the case: the agent writes a step before the user has hit the thing
  that needs naming, and a step it did not mark cannot be answered at all, so C
  has to exist underneath it. He chose **C**. → req 37.

  Asked separately whether a note should be sendable on a step that is *not*
  ticked, he chose **yes**: the toggle becomes not done · done · answered, and
  that is the half the card could not express. → req 37's third sentence, and
  the second heading in the submit message.

  Decided here and not by him: the note is client-side only and nothing stores
  it — it rides one message and is gone, as the "SENT" grey does — so no
  identity is added to `needsYou`, which stays a list of strings; an answered
  step greys as a reported one, because the agent has been told either way; and
  the control is a toggle, where an earlier cut closed an empty field on blur.
  That was withdrawn on review evidence rather than by preference: closing on
  blur removes the field on *mousedown*, which lifts everything under it before
  mouseup lands, so pressing Submit with an empty note open submitted nothing —
  reproduced in a real browser, and invisible to a test that dispatches blur and
  click separately.

- 2026-09-17 — Nik, on the shipped card: "'Context compacted' event shouldn't
  require a nudge, and any similar case" (planning#594). Reproduced before
  changing anything, because the design already exempted a `silent` turn and
  ShipIt's own pre-turn compaction dispatches with `silent: true`: that half does
  work, and what is nudged is a compaction the **user** asks for. A user-typed
  `/compact` is an ordinary interactive turn — not silent, since the user's own
  row is in the transcript — so the card was marked stale and one `[ShipIt]`
  follow-up turn went out beside the "Context compacted" card. The third
  candidate, a stale mark landing where the nudge does not, was not what
  happened: both fired together.

  The second half of his report is answered by → req 36, which replaces the
  `silent` entry on the exemption list rather than adding a second one beside it.
  `silent` named a kind of turn (ShipIt's own, no user row) and named it wrongly;
  req 36 names the property underneath (the turn produced no work of the agent's
  own, so the card cannot be behind), which covers both compactions and separates
  them from every other ShipIt-started turn. Those stay checked: each was walked
  against the rule and tabulated in `plan.md`.

  The stale **mark** follows the rule with the nudge. His words were about the
  nudge, so he was asked: should a compaction still mark the card stale, for one
  visual language with no exceptions, or leave it reading current because a
  compaction cannot put the card behind? He chose the second. The argument put to
  him was that the mark is inside his report rather than beside it — its own third
  candidate named a mark landing around a compaction as a defect shape — and that
  req 14's purpose, never presenting the card as current when it may be behind, is
  preserved rather than weakened, since a compaction cannot put it behind. A
  driver-owned turn keeps its existing split (not nudged, because a git driver
  owns the interval, but still marked, because work did happen). → req 14 amended
  to name the exception.

  Considered and rejected while writing the rule: treating a `/goal` command as
  the same class. It is delivered verbatim for the same reason a compaction is,
  which made it look identical — but the harness answers it by *starting work*
  (Grok's `set` and `resume` re-enter its planner and verifier,
  `agents/grok/grok-goal.ts`), so exempting it would let the card read current
  while the session moved on. "Delivered verbatim" and "produced no work" are two
  properties, and only the second is req 36's.

- 2026-09-17 — Nik, after several days of the shipped card: "the agent very
  frequently forgets to update the card — every turn, I would say... what often
  happens is that the agent may not update it fully, but would just say 'Okay,
  everything is good', or update only one field. The card would contain stale
  manual steps or stale follow-ups" (planning#591). The cause was found by
  reading the code rather than inferred from the symptom: the card's contents
  reach the agent nowhere — not in the injected prompt, which uses the setting
  only to choose a section, not in the turn, and not in the nudge, which carries
  the offer labels and their taken state and nothing else. So a bare confirming
  call is the only honest call an agent that cannot see the card can make, and a
  finished offer or a done manual step can never be dropped by an agent that has
  forgotten it exists. → req 35. Asked whether ShipIt should also refuse a bare
  confirmation while the card still has open manual steps or offers, he chose
  not to: that forces the symptom rather than removing the cause, and is worth
  doing only if the card still goes stale once it is visible.

- 2026-09-16 — Nik, on the shipped card: "Some weird behavior when steering the
  agent that is waiting for background tasks. ShipIt immediately nudges about
  the card update when I send a message." (planning#589). Reproduced: the user
  steers a running turn, the CLI acknowledges the message, the turn ends, and
  the nudge goes out — a system turn, so it retires the resident process that
  holds what he just sent. A first fix tried to nudge only when the steer was
  still *unanswered*, and an independent review showed the orchestrator cannot
  tell: the transcript-group count it inferred that from both misses a pending
  steer (the turn's own last text arrives before the acknowledgement) and hides
  an answered one (an answer appends to the existing group). → req 34 added:
  the whole turn is complete without an update, which is the plain reading of
  his report and needs no such inference. Cost, accepted: a turn a message
  reached and the agent then answered without touching the card is not nudged
  either; the card is marked stale and the next turn is checked afresh, exactly
  as for a nudge ShipIt was unable to send.

  Two widenings beyond his words, decided rather than asked, because stopping at
  them would leave the same harm reachable and req 34 would then not describe
  the code. A steer is recorded identically for a message from an agent
  interface or from another session, and the nudge destroys those just as
  surely. And a message submitted to a *resident* agent that puts it behind a
  turn of its own reaches the user the same way — he sent a message, the turn
  that ended next was not his, and the nudge retired the process holding it.

- 2026-09-16 — Nik, fifth round: "Can we use some other color for 'Last turn'?
  What tokens do we have available?" Only five tokens exist in all 20 themes
  with a tint to build a cap and a body from — `accent`, `info`, `pr`,
  `success`, `warning` — and the inventory ruled three of them out before he
  chose: `success` and `warning` already mean passed and caution, so they would
  claim something about the turn that may be false, and **`--color-info` is the
  same value as `--color-accent` in the `light`, `cool-light` and `antigravity`
  themes**, so the best-named candidate would differentiate nothing in three of
  them. Shown `pr` (distinct everywhere, but it is the pull-request colour) and
  a neutral card (the ordinary surface, no accent), he chose **neutral**.
  → req 33 amended: three tones, not two.
- 2026-09-16 — Nik, on the three capped cards, fourth round: "make 'status' and
  'last turn' soft caps, they should attract less attention then next steps.
  Make next steps last card." → req 33 amended: two tones rather than one, and
  the order becomes Status · Last turn · Next steps. The reading is that
  loudness follows what a card asks of the user — the two that are read are
  quiet, the one that carries the Submit is loud and sits nearest the composer
  — and the "Stale" mark, which lives on the now-soft Status cap, is drawn in
  the accent rather than in the inverse text. This supersedes the previous
  round's single filled-cap treatment and its Status · Next steps · Last turn
  order, which had put the last turn last as the part the user may already have
  read.
- 2026-09-16 — Nik, on the shipped card: "so the card is very bleak, blends
  with the conversation text. Let's iterate on the UI a bit." Three rounds were
  drawn. Round 1 kept the card's shape and changed its surface (solid, an accent
  spine, an elevated panel, a recessed tray): "in all cases the view is very
  similar to other cards in the transcript. It needs to attract attention."
  Round 2 went louder (accent-tinted surface, an accent header cap, a
  full-bleed band, a larger card, and all three at once) — and was drawn under
  a PR lifecycle card, which he corrected: "this card is at the top, very far
  away from the status card, at least on desktop", so the round was redrawn
  with the card's real neighbours, agent prose and the composer. He chose
  **Tinted**, and added the shape: "let's separate the card into three:
  'Last Turn' (should be shown last), 'status' (first), and 'steps/follow-ups'
  middle. Each card would have a cap from the 'Capped' option." Round 3 drew
  that with three sub-questions, each ruled: **filled caps with tinted bodies**
  (over caps-only colour and a softer tinted cap); **one middle card** named
  "Next steps" holding both lists under one Submit (over a card each); and the
  "Stale" mark **in the cap of the status card, to the right**. → req 33; reqs
  14, 28 and 31 amended. Req 14's "a current card looks like a regular card"
  went with it: the whole stack is now unlike a regular card, so what carries
  freshness is the presence of the mark, not the card's ordinary appearance.
  Decided here and not by him: the cap names, and that the "Next steps" card is
  absent when there is neither a manual step nor an offer.
- 2026-09-16 — Nik, from a phone, with a screenshot: "if the agent asks a
  question, it should be the last card. As you can see, the voice note and the
  status card are below the question, making me scroll." The view pins to the
  bottom, so what he landed on was the status card, and the question's options
  and Submit were off screen above it. → req 32, which REVERSES req 8: that
  requirement put the status card below the question card, and it was written
  when the card was fixed above the composer, where "below" cost nothing; once
  the card joined the scrolling conversation, "below" became "in front of the
  thing he has to answer". Req 6 amended with the same exception. Decided here
  and not by him: the rule is not specific to the question card but covers any
  card that ends a turn waiting for an answer — today the question card and the
  plan approval — while a voice note is not one of them, because it announces
  and carries no control; and a turn that ends with a question while the status
  card also offers actions still puts the question last.
- 2026-09-16 — Nik, still using the shipped card: "what I miss in the card is a
  summary of what happened last turn, or an answer to the question if the user
  asked it". Asked whether it should be its own section or folded into the
  status text, he chose its own section, first on the card; folding it in was
  rejected, because the status would then be two things at once and would drift
  back into repeating the turn. → req 31; reqs 3, 4 and 28 amended. This also
  bounds the 2026-09-14 receipt below where he rejected a card filled from the
  turn's last message: what he rejected was a card that IS the last turn
  instead of the session's state, and what he asks for now is one bounded
  agent-written line beside that state. Decided here and not by him: the
  section is absent when there is nothing worth saying; it is hidden while the
  card is stale; and it is the one field that is not a delta — every accepted
  write rewrites it or drops it.
- 2026-09-16 — Nik, after a few days of using the shipped card: "I have
  enabled the session card, and it works well. Let's iterate on the user
  experience. It should not always be at the bottom. It should be at the bottom
  only when the agent turn has stopped. Because what happens now is that if I
  send the actions, I see only the card, especially on mobile, but I don't see
  what's happening. It does not scroll up. Sometimes I want to see what the
  agent is doing." Asked how the card should get out of the way while a turn
  runs, he chose: it scrolls up and away — the card keeps its place at the end
  of the finished conversation, the running turn's output renders below it, so
  it slides out of view by itself as the agent writes, and it returns to the
  bottom when the turn stops. He rejected removing the card during a turn,
  because it must not blink out from under his finger the moment he presses
  Submit. → req 30; reqs 6 and 8 amended, since they said the card is the last
  element of the conversation without qualification and that now holds only
  while the agent is idle.
- 2026-09-15 — Nik, on the drawn card, seventh round: "What happens if I send
  an item and agent crashes or doesn't do it? It should be possible to re-sent
  the same action or manual step" — and, on the first answer, which grew a
  "Send again" control: "wait, just make it possible to select them. Why invent
  new UI?" So a sent row stays greyed and tagged SENT but remains tickable, and
  ticking it again re-sends it. → reqs 17, 29. Also: the checkbox sat a couple
  of pixels below its text; it now centres on the row's first line.
- 2026-09-15 — Nik, on the drawn card, sixth round: "for manual steps, let's
  have some control at the beginning of each step, a toggle 'I've done this'.
  This information needs to be sent together with the actions. The button
  'Submit X actions' should be just 'Submit'." → req 29. A reported step goes
  quiet ("SENT") until the agent rewrites the card, as a taken offer does.
- 2026-09-15 — Nik, on the drawn card, fifth round: the subtitles must be more
  visible, "not gray", and still "blend with the text" when only bold — so a
  subtitle became an accent icon beside a larger semibold label, as the
  transcript action card's header row is. Then: "let's add separators before
  the subtitles", which reinstates a rule above each section (it replaces, not
  contradicts, the fourth round: the subtitle names the section, the rule opens
  it). And, asked why a greyed offer was grey, the row now says "SENT". → req 28.
- 2026-09-15 — Nik, on the drawn card, fourth round: "remove Status/Needs you
  column. Instead the 'Needs you' should be a subtitle, and rename to 'Manual
  steps'. The actions should be separated by another subtitle 'Follow-ups'
  instead of a separator." → req 28. The field keeps the name `needsYou` in the
  API; "Manual steps" is what the card calls it.
- 2026-09-15 — Nik, on the drawn card, third round: "Status: seed dogfood with
  longer text. It needs to be markdown with a list. Needs you: should be a
  repeated field in the API, and presented as a list, if there are multiple
  items." → req 27. The status cap rises from 240 to 1200 characters, because a
  list cannot fit in one sentence; each "Needs you" entry keeps the 240 cap.
- 2026-09-15 — Nik, on the drawn card, second round: "what happened to 'add
  comment'? ... the new card should be conceptually an extension of the action
  card, without removing functionality." The card therefore keeps the comment
  shortcut and the delivery-failure notice; the earlier design decision "one
  Send, no comment shortcut" is withdrawn. → req 26.
- 2026-09-15 — Nik, on the first drawn card: "mockup was inspiration, whereas
  the actual UI needs to be consistent with the current cards. In particular,
  every checkable item needs to have also description so the user can
  understand what this item is about." The compact wrapping row of the
  prototype as it then stood (`mockup-freshness.html`) is therefore not the
  appearance; the offers use the rows of the
  existing follow-up action card, and a description is part of every offer, not
  an optional extra. → req 26.
- 2026-09-15 — Second review of this document by Nik. The card must scroll
  away with the conversation, or the conversation is hard to read on mobile
  → req 6: the last element of the conversation, not a fixed one. "Current"
  means the agent issued the update call; the call may carry zero changes
  when the status and actions did not change, and the API must allow that
  → reqs 5, 12, 14. The tool that posts a follow-up action card must not
  even be in the agent's context while the setting is on → req 21. With the
  setting on, the agent needs clear instructions for the tool directly in
  the ShipIt-injected prompt, not in a skill; a skill may hold the longer
  explanation → req 25.
- 2026-09-14 — Whole-PR review (ShipIt reviewer, run 917edd86) found that
  the sentence "between turns and while a turn runs, the card shows the state
  as of the last finished turn", added by the agent as a clarification of
  req 14, forbade a status write from showing during the turn that made it,
  which nothing Nik said asks for. Replaced with "freshness is judged when a
  turn ends", the part that was Nik's.
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
