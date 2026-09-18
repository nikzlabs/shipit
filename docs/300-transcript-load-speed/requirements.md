---
issue: planning#538
title: Transcript load speed — requirements
description: Stop sending the content of collapsed turns, so a large session opens quickly on a mobile connection.
---

# Transcript load speed

Split out of [docs/299-collapsed-turns](../299-collapsed-turns/requirements.md)
on 2026-09-13. That feature makes a long conversation readable; this one makes it
load quickly. They were one document until the user separated the two
motivations.

This work builds on docs/299: it can only stop sending content that the display
rules already hide.

## User request

The user reported that a big session loads very slowly on a mobile network, and
asked for a significant improvement. The mechanism they asked for is lazy
transfer: the server does not send what is hidden, and expanding one turn loads
that turn at that moment.

## Required behavior

1. A large session opens much faster on a slow mobile connection than it does
   today.
2. The server does not send the hidden content of a collapsed turn. Loading a
   session transfers only the content that is displayed.
3. Expanding one turn loads that turn's full content at that moment, and shows
   it.
4. In-app search stays on the client and searches the content that is loaded.
   While a search is active, the search bar offers a control that expands every
   turn and loads the full transcript.

## Open questions

None.

## Resolved questions

2026-09-13 — In-app search cannot match text that was never loaded. The user
answered: do not make search server-side, because that is a can of worms. Add a
control that expands all turns and loads the whole transcript instead. This is
requirement 4.

2026-09-13 — Where does that control go? The user answered: in the search bar,
only while a search is active. Turning the collapse setting off remains the way
to read the whole transcript without searching.

2026-09-13 — What does the measurement measure? The user answered: loading a big
session on a mobile network is very slow, and they want a significant
improvement. The goal is the load time a user feels, not a byte count. This is
requirement 1, and it means requirements 2 and 3 cannot be dropped because a
byte measurement looks small.
