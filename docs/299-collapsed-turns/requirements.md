---
issue: planning#536
title: Collapsed turns — requirements
description: Collapse every turn but the newest, so a long conversation can be scrolled and understood.
---

# Collapsed turns

Replaces the display rules of [docs/296-compact-conversation](../296-compact-conversation/requirements.md),
which shipped as a client-side filter.

Loading speed is a separate feature:
[docs/300-transcript-load-speed](../300-transcript-load-speed/requirements.md).
The two were one document until 2026-09-13, when the user separated the
motivations. This one is about reading; that one is about transfer.

## User request

The user used the shipped compact view and reported four problems: the newest
turn collapsed although it is the one they want to read; a failed tool call kept
its whole tool group visible; an interrupted or failed turn never collapsed; and
the "Show full turn" control does not look like a button.

The purpose of the feature, in the user's words: a big session holds so much
content that it is hard to scroll and to understand what is going on. The user
wants to read the conversation quickly and see what it was about. For that they
need their own messages and the significant events.

## Required behavior

1. The most recent turn is never collapsed. When a newer turn arrives, the
   previous turn collapses like every earlier turn.
2. A collapsed turn hides all tool calls and all tool results. Whether a tool
   call succeeded or failed does not change this.
3. An interrupted turn and a failed turn collapse the same as a completed turn.
   Their outcome does not keep them expanded.
4. Opening a session shows every earlier turn collapsed. It does not matter
   whether the agent was working at that moment, or whether the viewer attached
   during a turn.
5. A collapsed turn shows the user's own message and the last agent message,
   complete. It shows no cards, so the user reads only the request and the
   reply. Requirements 11 and 12 are the exceptions to "no cards".
6. Moved to [docs/300-transcript-load-speed](../300-transcript-load-speed/requirements.md) req 2.
7. Moved to [docs/300-transcript-load-speed](../300-transcript-load-speed/requirements.md) req 3.
8. The control that expands a turn is easy to see, and the user can tell it
   apart from the content of the turn. It is a single caret in the accent
   colour, and it costs the turn no vertical space of its own. What the fold is
   holding — how many tool calls, how many messages, how many cards — is named
   where it needs no room: in the control's tooltip. On a touch screen it can be
   hit with a finger, and being hittable must not make it take more room.
9. The feature stays off by default. The user turns it on in Settings.
10. Moved to [docs/300-transcript-load-speed](../300-transcript-load-speed/requirements.md) req 4.
    In-app search keeps its current behavior here: it matches message text,
    including text hidden by a collapsed turn, and opens a turn that matches.
11. A collapsed turn keeps its error rows and its status notices visible. The
    user sees that a turn failed without expanding it.
12. A card that still needs the user stays visible when its turn collapses, and
    keeps its state. Examples: an action checklist that is not ticked, a bug
    report that is not submitted. A card the user has already acted on is
    hidden with the rest of the turn — except an **action card**, which stays
    visible whether or not it was sent.
13. Moved to [docs/300-transcript-load-speed](../300-transcript-load-speed/requirements.md) req 1.

14. The expand control sits on the rewind strip **below** the turn — the one
    that closes it — at the left of that strip. It is not above the turn and not
    between the user's message and the reply.

## Open questions

None.

## Resolved questions

2026-09-16 — Requirement 8 gained the touch clause, from *"it needs to have
mobile-friendly touch area"*. The two halves are both requirements and they pull
against each other — a finger needs about 44px, and the whole point of this form
is that it takes none. `plan.md` resolves it with a hit area that is not part of
the layout.

2026-09-16 — Requirement 14 named which strip, from *"it is not on the left of
the rewind strip, it is higher. I meant the strip below the turn, not above"*.
The first reading put the caret on the strip that OPENS the turn; the user meant
the one that CLOSES it. The control moved to the row after the run — the user
message that ended the turn owns that strip — which also retired the hoisting
that the earlier "anchor above the control" wording needed.

2026-09-16 — Requirements 8 and 14 put the caret on the rewind strip, from
*"let's try the single chevron on the left of this rewind anchor, so it doesn't
take vertical space. Make it accent color"*. This is the fourth form of the
control and it drops the fold rule's visible label: a row that carries text
carries its height, and the height is what was being paid. The counts survive as
the tooltip, so nothing the previous step added is lost. Requirement 14 changes
with it — "above the control" becomes "the same strip", which keeps what that
requirement was for: the anchor belongs to the user's message, the caret to the
reply.

2026-09-16 — Requirement 8 became the fold rule, from *"let's try fold rule, but
show not only tool calls, but also counts for cards, messages"*, chosen from
five prototypes. It is the third form of this control and the second the user
rejected: the bordered button with a text label was too heavy, and the chevron
that replaced it (*"let's try just showing a chevron with a ghost style button,
no text"*) was *"too big, blends with everything else, takes a lot of vertical
space"*. The rule answers all three — it is what tells the control apart from
the prose, at one 14px line — and the counts are the user's addition: the label
says what the fold holds, not what the control does. Nothing about the
behaviour changed at any step: the accessible name, `aria-expanded` and
`aria-controls` are the same as the first form's.

2026-09-16 — Requirement 12 carved out action cards, from *"action cards
shouldn't be hidden in the compact mode"*, said while looking at the seeded
dogfood transcript, where a submitted checklist had disappeared. It narrows the
2026-09-13 answer below: the submitted flag stays — it is still recorded and
persisted — but it no longer decides whether the card is on screen. A sent card
is the record of what the user took, and the offer is one they can still take
again.

2026-09-16 — Requirement 14 added from *"the 'rewind options' anchor should be
below the 'show full turn' section. I.e. that section should be a part of the
assistant reply, not a part of the user message"*, said while looking at a
collapsed turn in the dogfood instance. The shipped order drew the control
first and the anchor under it, which read as though the anchor opened the
reply and the control closed the request.

2026-09-13 — Is the feature on by default? The user answered: off by default.
They want to test it first and expect some iterations. Turning it on by default
can follow later. This is requirement 9.

2026-09-13 — Which cards stay visible in a collapsed turn? The user answered:
none of them. No card is relevant in a past turn. A collapsed turn shows only the
last agent message. This changed requirement 5, and requirement 12 later carved
out the cards that still need the user.

2026-09-13 — How much of the last agent message does a collapsed turn show? The
user answered: the whole message. No truncation rule. This is requirement 5.

2026-09-13 — Does a collapsed turn that failed show anything about that? The
user answered: keep the red error row visible. The question covered error rows
and status notices together, so requirement 11 keeps both.

2026-09-13 — A card can still need the user after its turn ends. Does it stay
visible? The user answered: yes. Action cards and bug reports that are not sent
yet must be kept. This is requirement 12.

2026-09-13 — Requirement 12 hides a card the user has already acted on, but an
action checklist keeps no record that it was submitted. Keep every checklist
visible, or add and store a submitted flag? The user answered: add and store the
flag. It is designed in [plan.md](./plan.md) as one optional field on the card,
with no new database column.

2026-09-13 — Is loading speed part of this feature? The user answered: no. The
motivation here is that a big session is hard to scroll and to understand.
Loading speed is a separate feature, not scheduled with this one. Requirements
6, 7, 10 and 13 moved to
[docs/300-transcript-load-speed](../300-transcript-load-speed/requirements.md),
and their numbers are left in place so earlier citations still resolve.

2026-09-13 — What does the measurement of requirement 6 measure? The user
answered: loading a big session on a mobile network is very slow, and they want
a significant improvement. The goal is the load time a user feels, not a byte
count. This is requirement 13, and it means requirements 6 and 7 cannot be
dropped because a byte measurement looks small.
