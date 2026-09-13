---
title: Lazy collapsed turns — requirements
description: Collapse every earlier turn, hide all tool work, and load a collapsed turn's content only when it is expanded.
---

# Lazy collapsed turns

Replaces the display rules of [docs/296-compact-conversation](../296-compact-conversation/requirements.md).
That feature shipped as a client-side filter. This one changes what is collapsed
and stops the collapsed content from being loaded at all.

## User request

The user used the shipped compact view and reported four problems: the newest
turn collapsed although it is the one they want to read; a failed tool call kept
its whole tool group visible; an interrupted or failed turn never collapsed; and
the "Show full turn" control does not look like a button. The user also stated a
second purpose for the feature: reduce how much data a session loads. Collapsed
turns must not be loaded from the server, and expanding one turn must load that
turn then.

The purpose of the feature, in the user's words: read the conversation quickly
and understand what it was about. For that the user needs their own messages and
the significant events.

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
5. A collapsed turn shows the user's own message and the last agent message. It
   shows no cards, so the user reads only the request and the reply.
6. The server does not send the hidden content of a collapsed turn. Loading a
   session transfers only the content that is displayed.
7. Expanding one turn loads that turn's full content at that moment, and shows
   it.
8. The control that expands a turn is clearly a button. It is easy to see, and
   the user can tell it apart from the content of the turn.

9. The feature stays off by default. The user turns it on in Settings.
10. A control expands every collapsed turn at once and loads the full
    transcript. In-app search stays on the client and searches the content that
    is loaded.

## Open questions

- Requirement 5 keeps the last agent message. How much of it — the whole
  message, or only its last paragraphs?
- Where does the expand-everything control of requirement 10 go?
- Does a collapsed interrupted or failed turn show a status marker?

## Resolved questions

2026-09-13 — Is the feature on by default now that it also reduces the load
size? The user answered: off by default. They want to test it first and expect
some iterations. Turning it on by default can follow later. This is requirement
9.

2026-09-13 — Which cards stay visible in a collapsed turn? The user answered:
none of them. No card is relevant in a past turn. A collapsed turn shows only the
last agent message. This changed requirement 5.

2026-09-13 — In-app search cannot match text that was never loaded. The user
answered: do not make search server-side, because that is a can of worms. Add a
control that expands all turns and loads the whole transcript instead. This is
requirement 10.
