---
issue: planning#484
title: First send creates the session
description: The /new page holds a draft until Send, and Send is the transaction that claims a session, delivers the first message, and survives failure.
---

# First send creates the session

Prerequisite for [docs/285-network-mode-at-session-creation](../285-network-mode-at-session-creation/plan.md).
That feature needs the session's network mode chosen *before* any runner exists, which is
only possible if `/new` stops claiming on arrival — and moving session creation to Send is a
platform change with its own contract, extracted here so it can be reviewed on its own terms.

It is a **prerequisite, not a subset**: docs/285 cannot land before it, and the cost of that
feature is honestly the sum of both docs.

1. Landing on `/{owner}/{repo}/new` creates nothing. No session is claimed, no container is
   consumed, and nothing is left behind if I close the tab.
2. Pressing Send creates the session and delivers my first message. From my side it is one
   action, not a sequence I have to understand.
3. If any part of that fails, **nothing of my message is lost** — the text, attachments,
   dictation, the issue I started from, and the creation-time settings all survive, and I can
   retry.
4. Retrying after a failure does not leave a trail of half-made sessions. One Send produces
   at most one session, however many times the attempt failed.
5. My first message is delivered to the session that was created for it, and to no other
   session — including when I navigate away while it is in flight.
6. My first message is delivered **once**. A lost acknowledgement never results in the agent
   receiving it twice.
7. While composing, `@file` and `/skills` autocomplete work exactly as they do today —
   including a harness's built-in skills, not only the repository's own.
8. What I could do on `/new` before, I can still do: type, attach files, dictate, pick a
   harness / model / reasoning level / role / permission mode, and start from an issue.
   Only the live preview and the pre-warmed container are given up (docs/285, resolved
   2026-08-28).

## Open questions

- **How far must recovery reach?** If the browser reloads mid-Send, should the draft and its
  claimed session come back? And if the *orchestrator* restarts or is deployed mid-Send —
  which today deletes every ungraduated session (`startup-tasks.ts` ~288) — is that a case
  the design must survive, or an accepted loss with an honest error?
- **Does the composer freeze while a Send is in flight?** Either it locks until the message
  is accepted (simple, but the input dies for a beat on every first message), or it stays
  editable and the design must say precisely what gets cleared on acceptance — clearing "the
  draft" would erase text typed after the send.

## Resolved questions

- 2026-08-29 — *Is this separable from docs/285, or is splitting it a way of making that
  feature look smaller?* Separable, and it should be extracted now rather than "if it grows
  further" — it is already a platform-sized contract (transaction ownership, delivery,
  idempotency, recovery) with no network content in it at all. The split is only honest if
  the total cost stays visible, which is what this doc's opening paragraph is for.
