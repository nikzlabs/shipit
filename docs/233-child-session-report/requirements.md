---
issue: planning#243
title: Resolved child-session message eligibility
description: Resolved child sessions do not receive parent messages or cohort reports.
---

# Safe child-session report delivery — requirements

This document extends the shipped report design in [plan.md](./plan.md). It is
the human-owned source of truth for the production remediation. No implementation
starts while an item remains under [Open questions](#open-questions).

## Incident and verified current behavior

The production incident in session `7bc72326-c1ad-48fd-ac95-18fb82e2149a`
showed that the existing rate limit limits each sender but does not stop a
multi-session feedback loop:

- Seven children submitted 36 reports from 10:50:44 through 11:04:17 UTC.
- Most reports targeted the seven-member cohort, including the parent.
- The parent accumulated 25 queued messages. Many had repeated subjects from
  the same children.
- Each accepted report currently gets a random `reportId` and recipient-specific
  `cardId`, then queues a system wake turn. Client idempotence by `cardId` cannot
  identify two reports that mean the same thing.
- The deployed service limits each reporter to five accepted reports in a
  rolling ten-minute window. It has no content fingerprint and no causal-chain
  duplicate suppression.
- Credential-quota retries made the recipient queues drain more slowly. They did
  not cause the duplicate report calls.

Verified at `src/server/orchestrator/services/session-report.ts`: cohort
resolution currently excludes only `archived` and `userArchived` sessions; a
new random UUID identifies every accepted call; the card is persisted before
`wakeSessionWithTurn` is called for every severity.

Verified at `src/server/shared/types/domain-types/session.ts`: `mergedAt` and
`closedAt` describe a pull request, not a completed session. A session can be
re-armed after a merge and can open a later PR. There is no general durable
"session completed" field in `SessionInfo` today.

## Terms

- **Resolved session:** the existing UI lifecycle classification for a session
  whose PR merged or closed without merge and that had no later turn. Any turn,
  including a user turn, self merge-wake, CI fix, conflict remediation, or other
  system continuation, reactivates it when that turn starts. This targets
  sessions that completed one PR and then stopped.
- **Cohort delivery:** `shipit session report --to cohort`, which can address the
  reporter's parent and siblings.
- **Direct delivery:** an existing parent-to-child `shipit session message`.

## Requirements

1. A resolved child session must not receive a report card, direct parent
   message, or wake turn through either cohort or parent-to-child delivery.

2. Delivery eligibility must be evaluated by the server for each recipient at
   delivery time. A sender cannot select a session ID or override a recipient's
   lifecycle state.

3. A merged or closed PR, by itself, must not make a session ineligible. The
   session can continue on the same branch, open a later PR, or coordinate its
   children after that PR reaches a terminal state.

4. A child session whose PR merged or closed without merge and whose shared
   classification says it remains resolved must be excluded from cohort
   broadcasts. The eligibility check must call that classification rather than
   create a report-specific approximation.

5. The same recipient eligibility rule applies when a parent sends a direct
   message to its child. A resolved child cannot receive direct coordination. A
   new turn that moves the child out of the shared resolved
   classification makes it eligible again. Child-to-parent delivery and resolved
   parent behavior do not change.

6. When a recipient is ineligible, the system must use one consistent outcome:
   omit delivery entirely. It must not persist an actionable or audit card in
   the resolved recipient's transcript.

7. When delivery is skipped because a recipient is resolved, the synchronous
   command response to the sender must name that recipient, say that it is
   resolved, and state that it received no message, card, or wake turn.

8. Severity behavior must not change. Every eligible `fyi`, `warn`, and
   `blocker` report persists its card and starts or queues an agent wake turn.

9. Every eligible report retains the current non-preempting behavior: a busy
   recipient queues the system turn, and an idle recipient starts it through the
   shared wake path.

10. The existing per-reporter rolling rate limit remains the volume bound for
    eligible recipients. No causal-chain tracking, content fingerprinting, or
    other smart duplicate suppression is added in this remediation.

10a. Resolved children reduce sibling fan-out only. Parent delivery remains
     unchanged, so the existing rate limit remains the only volume bound for the
     parent-side queue growth observed in the incident.

11. Tests must cover the shared resolved-child classification, user and system
    turns making the child eligible again at turn start, parent-to-child direct messages,
    cohort delivery, all severities, and sender-visible skip outcomes.

## Open questions

### Q6. Does “resolved child” include a PR closed without merge?

The existing UI predicate verified at
`src/client/components/SessionSidebar/useSessionGrouping.ts:isRecentlyResolved`
and its server counterpart in `src/server/orchestrator/sessions.ts` treats both
`mergedAt` and `closedAt` as resolved, unless later turn activity reopens the
session. The approved wording above says “merged.” The implementation cannot
both reuse the UI predicate and exclude only merged PRs.

- **A — Reuse the complete UI predicate (recommended).** Block delivery to a
  child whose PR merged or closed without merge and that has no later turn
  activity. This keeps the sidebar and delivery eligibility consistent.
- **B — Merged PRs only.** Block delivery only when `mergedAt` is set and there
  is no later turn activity. A closed-without-merge child remains eligible even
  while the UI shows it under Recently resolved.

## Resolved questions

- 2026-08-14 — Which terminal-PR sessions are eligible for cohort broadcasts?
  Chosen: exclude sessions that the existing UI classifies as resolved. The
  initial answer described a single merged PR with no later user message; the
  later 2026-08-14 receipt below supersedes the merged-only part by including a
  PR closed without merge. Reuse the UI classification for report eligibility;
  do not invent a separate idle/queue approximation.
- 2026-08-14 — Does resolved-session ineligibility apply only to cohort reports?
  Chosen: no. Apply it when a parent directly messages its resolved child too.
  Do not change child-to-parent delivery or resolved-parent behavior. A later
  user message can move the child back to active and make it eligible again.
- 2026-08-14 — When delivery to a resolved recipient is blocked, what remains in
  that recipient's transcript? Chosen: no card. The sender's command response
  must clearly name the resolved recipient and state that it received no message,
  card, or wake turn.
- 2026-08-14 — Should this remediation add report-chain IDs, content fingerprints,
  or other smart duplicate suppression? Chosen: no; smart deduplication is out of
  scope. Keep the existing per-reporter rolling rate limit and fix recipient
  eligibility without adding semantic inference.
- 2026-08-14 — Should FYI reports stop waking agents? Chosen: no. Do not
  distinguish severities mechanically. Every eligible `fyi`, `warn`, and
  `blocker` report continues to persist a card and start or queue a wake turn.
- 2026-08-14 — Does “resolved child” include a PR closed without merge? Chosen:
  match the existing UI predicate. Both merged and closed-without-merge children
  are resolved. This receipt's original “later turn activity” wording is
  superseded by the user-started-only decision below.
- 2026-08-14 — What activity makes a resolved child active again? Chosen: only
  user-started activity. This answer is superseded by the later self merge-wake
  decision below.
- 2026-08-14 — Are pinned children and children still coordinating their own
  children eligible after their PR resolves? Chosen: match the rendered UI.
  Keep pinned children and child coordinators eligible while the UI treats them
  as Active. Put the complete resolved-session classification in exactly one
  shared code location used by every server and client consumer.
- 2026-08-14 — How should existing terminal-PR sessions be migrated to the new
  user-activity field? Chosen at the time: protect the incident population. The
  later self merge-wake decision removes the new field and migration entirely,
  so this choice is no longer applicable.
- 2026-08-14 — How does a self merge-wake affect resolution? Chosen: it
  reactivates the child persistently. A resolved session is a single-PR session
  that stopped after its PR reached a terminal state. A child that self-wakes to
  continue is active from the start of that wake and remains eligible; the same
  rule applies to other started continuation turns. No temporary liveness
  carve-out or separate user-only activity timestamp is needed.
