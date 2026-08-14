---
issue: planning#243
title: Safe child-session report delivery
description: Delivery eligibility and loop prevention for parent and cohort session reports.
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

- **Explicitly completed session:** a session with a durable, authoritative
  completion state set by an explicit lifecycle action. A merged or closed PR
  does not set this state by implication.
- **Resolved session:** the existing UI lifecycle classification for a session
  whose single PR merged and that received no user message after the merge. A
  merge alone is not sufficient because a later user message makes the session
  active again.
- **Cohort delivery:** `shipit session report --to cohort`, which can address the
  reporter's parent and siblings.
- **Direct delivery:** a report to the reporter's parent, or an existing
  parent-to-child `shipit session message`; direct-message policy is decided
  separately from cohort-broadcast policy.

## Requirements

1. An archived, explicitly completed, or resolved session must not receive a
   report card, direct session message, or wake turn through either cohort or
   parent-child delivery.

2. Delivery eligibility must be evaluated by the server for each recipient at
   delivery time. A sender cannot select a session ID or override a recipient's
   lifecycle state.

3. A merged or closed PR, by itself, must not make a session ineligible. The
   session can continue on the same branch, open a later PR, or coordinate its
   children after that PR reaches a terminal state.

4. A session that the existing UI classifies as resolved — its single PR merged
   and it received no user message after that merge — must be excluded from
   cohort broadcasts. The eligibility check must reuse the existing resolved
   classification rather than create a different report-specific approximation.

5. The same recipient eligibility rule applies to direct parent-to-child and
   child-to-parent delivery. A resolved recipient cannot receive direct
   coordination. A new user message that moves the session out of the existing
   resolved classification makes it eligible again.

6. When a recipient is ineligible, the system must use one consistent outcome:
   omit delivery entirely. It must not persist an actionable or audit card in
   the resolved recipient's transcript.

7. When delivery is skipped because a recipient is resolved, the synchronous
   command response to the sender must name that recipient, say that it is
   resolved, and state that it received no message, card, or wake turn.

8. FYI wake policy must be explicit. A persisted FYI card and an agent wake are
    separate effects; low-urgency information must not consume a turn unless the
    selected policy requires it.

9. `warn` and `blocker` reports that are eligible must retain the current
   non-preempting behavior: a busy recipient queues the system turn, and an idle
   recipient starts it through the shared wake path.

10. The existing per-reporter rolling rate limit remains the volume bound for
    eligible recipients. No causal-chain tracking, content fingerprinting, or
    other smart duplicate suppression is added in this remediation.

11. Tests must cover archived and explicitly completed recipients, merged and
    re-armed sessions, the existing resolved classification, direct-message
    policy, every severity, and reporter-visible delivery outcomes.

## Open questions

### Q3. Should an FYI report wake the recipient agent?

- **A — Card only (recommended).** Persist the FYI in the recipient transcript,
  but do not start or queue an agent turn. `warn` and `blocker` keep wakes.
- **B — Card and wake.** Keep the current behavior: every FYI starts or queues an
  agent turn after its card is persisted.

## Resolved questions

- 2026-08-14 — Which terminal-PR sessions are eligible for cohort broadcasts?
  Chosen: exclude sessions that the existing UI classifies as resolved. For this
  decision, that is a session whose single PR merged and that received no user
  message after the merge. Reuse that classification for report eligibility; do
  not treat every merged PR as completion and do not invent a separate idle/queue
  approximation.
- 2026-08-14 — Does resolved-session ineligibility apply only to cohort reports?
  Chosen: no. Apply it to direct parent-to-child and child-to-parent recipient
  delivery too. Do not persist an actionable card and do not wake a resolved
  recipient. A later user message can move the session back to active and make it
  eligible again.
- 2026-08-14 — When delivery to a resolved recipient is blocked, what remains in
  that recipient's transcript? Chosen: no card. The sender's command response
  must clearly name the resolved recipient and state that it received no message,
  card, or wake turn.
- 2026-08-14 — Should this remediation add report-chain IDs, content fingerprints,
  or other smart duplicate suppression? Chosen: no; smart deduplication is out of
  scope. Keep the existing per-reporter rolling rate limit and fix recipient
  eligibility without adding semantic inference.
