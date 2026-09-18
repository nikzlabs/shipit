---
issue: planning#243
title: Parent-mediated child-session reports
description: Child sessions report only to their parent; lateral child-to-child messaging is forbidden.
---

# Safe child-session report delivery — requirements

This document is the human-owned source of truth for child-session coordination.

## Context

The original report channel allowed a child to broadcast to its parent and all
siblings. A production incident showed that sender-local rate limits do not stop
a multi-session feedback loop: seven children submitted 36 reports, and the
parent accumulated 25 queued messages. Direct lateral wake-ups made each child
both a sender and a recipient, so one finding could cause a message storm.

## Requirements

1. A resolved child session must not receive a direct parent message or wake
   turn.

2. Delivery eligibility must be evaluated by the server at delivery time. A
   sender cannot override a recipient's lifecycle state.

3. A merged or closed PR, by itself, must not make a session ineligible. A later
   turn can reactivate the session according to the shared lifecycle
   classification.

4. A child session must not send a report or message to a sibling. A child
   report can reach only the session that directly spawned it.

5. When a parent sends a direct message to a child, the shared resolved-session
   classification controls eligibility. A later turn that makes the child active
   makes it eligible again.

6. When direct parent-to-child delivery is blocked because the child is
   resolved, the child must receive no message, card, or wake turn.

7. A blocked direct-message response must name the child and state that it
   received no message or wake turn.

8. Every valid `fyi`, `warn`, and `blocker` child report must persist a card in
   the parent's transcript and start or queue a parent wake turn.

9. A child report must not preempt a running parent turn. The report queues
   behind the current turn through the shared wake path.

10. The per-reporter rolling rate limit remains the volume bound for reports to
    the parent. The system does not add content fingerprints or semantic
    duplicate detection.

10a. The parent is the only coordination hub. It decides whether and how to send
     information to its other direct children.

11. Tests must prove that the CLI and server reject sibling/cohort targets before
    they create a card, runner, queue entry, or wake turn. Tests must also cover
    valid child-to-parent delivery, all severities, direct parent-to-child
    resolved-session behavior, and sender-visible errors.

## Open questions

_None._

## Resolved questions

- 2026-08-14 — Which terminal-PR sessions were eligible for the former cohort
  broadcasts? Chosen: exclude sessions that the existing UI classifies as
  resolved. The cohort-specific part is superseded by the 2026-08-27 decision;
  the shared classifier still governs direct parent-to-child messages.
- 2026-08-14 — Did resolved-session ineligibility apply only to cohort reports?
  Chosen: no. It also applies when a parent directly messages its resolved
  child. A later turn can move the child back to active.
- 2026-08-14 — What remains in a resolved child's transcript when direct
  delivery is blocked? Chosen: no card. The response must name the child and
  state that it received no message, card, or wake turn.
- 2026-08-14 — Should the remediation add report-chain IDs, content
  fingerprints, or smart duplicate suppression? Chosen: no. Keep the
  per-reporter rolling rate limit.
- 2026-08-14 — Should FYI reports stop waking agents? Chosen: no. Every valid
  `fyi`, `warn`, and `blocker` report persists a card and starts or queues a wake
  turn.
- 2026-08-14 — Does “resolved child” include a PR closed without merge? Chosen:
  match the existing UI predicate. Both merged and closed-without-merge children
  can be resolved.
- 2026-08-14 — What activity makes a resolved child active again? The first
  answer was user-started activity only. The later self merge-wake decision
  superseded it.
- 2026-08-14 — Are pinned children and children still coordinating their own
  children eligible after their PR resolves? Chosen: match the rendered UI.
  Keep pinned children and child coordinators eligible while the UI treats them
  as Active. The complete classification lives in one shared code location.
- 2026-08-14 — How should existing terminal-PR sessions be migrated to a new
  user-activity field? The first answer was to protect the incident population.
  The later self merge-wake decision removed the field and migration.
- 2026-08-14 — How does a self merge-wake affect resolution? Chosen: it
  reactivates the child persistently. Every started continuation turn updates
  `lastUsedAt`; no separate user-only activity timestamp is used.
- 2026-08-27 — Child sessions must not message one another. Cohort broadcasts
  are an anti-pattern that causes message storms. All child reports go only to
  the direct parent, which coordinates other children when needed.
