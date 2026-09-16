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
    If it did not, ShipIt sends the agent a further turn that asks for the
    update, on every harness alike, except in the cases of req 13 and
    req 15. That turn is visible in the conversation, as a regular turn, for
    transparency.
13. A turn that ended with a question card is complete without a card
    update. The card may lag by a turn there; updating it would waste tokens
    and turns. The card then shows that it may be behind (req 14).
14. The card always shows whether it is current. Current means the agent
    confirmed the whole card at the end of the last finished turn. A
    confirmation may change nothing: when the status, "Needs you" and the
    offered actions still hold, the agent says so without rewriting them,
    and the card is current. When the last finished turn neither updated
    nor confirmed it, whatever the reason, the card is visibly marked as
    possibly stale, in one visual language for every cause, so it is always
    clear to the user. Freshness is judged when a turn ends. No title text
    is spent on it: a current card carries no mark at all; a stale one
    carries a small "Stale" label at the right-hand end of the Status cap
    (req 33), which covers the whole stack and is read first.
15. ShipIt nudges once per missing update. If the agent ignores the nudge,
    ShipIt does not nudge again for that turn; the card is marked stale
    (req 14) and the next ordinary turn is checked afresh.
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
    "Follow-ups" are subtitles inside the middle one, with a rule between them.
    A taken action says "sent" on the row, so its grey is never a mystery.
29. Each manual step carries a toggle — "I've done this" — so the user can
    report by hand what they have done. What they ticked is sent to the agent
    together with the approved actions, in the same message; a step can be
    reported with no action approved. The submit button is labelled "Submit".
    A reported step behaves as a sent action does: greyed, unticked, and
    sendable again.

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
    req 33 the last of the three cards — never a convention inside the status
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
    in a stack, each with a coloured cap naming it — **Status** first,
    **Next steps** in the middle, **Last turn** last — and each drawn in the
    theme's accent colour, a filled cap with a tinted body. Nothing else in a
    conversation is coloured that way, so the stack is the one coloured object
    on the screen. "Next steps" holds the manual steps and the follow-ups
    together, under the one Submit they share (req 29). This does not make the
    session need attention (req 9): it makes the card easy to find once the
    user is in the session.

## Open questions

- None.

## Resolved questions

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
