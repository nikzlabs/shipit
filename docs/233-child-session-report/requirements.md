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
- **Report chain:** one originating finding and any reports derived from it as
  recipients coordinate or escalate it.
- **Semantic duplicate:** a report that repeats the same material finding even
  if it was submitted as a new call with a new random ID.

## Requirements

1. An archived session or an explicitly completed session must not receive a
   cohort report card and must not get a wake turn from that cohort report.

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

5. Direct parent-to-child and child-to-parent delivery after PR merge or session
   completion must have its own rule. Cohort eligibility must not implicitly
   disable direct coordination.

6. When a recipient is ineligible, the system must use one consistent outcome:
   either omit delivery entirely or persist a non-waking audit card. It must not
   persist an ordinary actionable report card that looks as if the agent received
   it when no wake can occur.

7. Recipient filtering is only one safety control. The service must suppress
   causal duplicates so two active, eligible sessions cannot echo one finding
   around the cohort and create a feedback loop.

8. Each originating finding must have a stable report-chain identifier. A report
   derived from another report must preserve that identifier. A random delivery
   ID can still identify one API call or one rendered card, but it must not be the
   duplicate-suppression key.

9. For a configured suppression scope and duration, one recipient must receive
   at most one wake for the same report chain. Retries and fan-out overlap must
   be safe under concurrent delivery.

10. The service must also define semantic duplicate suppression for agents that
    fail to propagate a chain identifier. The fingerprint must be computed by
    the server from bounded report fields and must not treat a new random ID as
    new meaning.

11. Duplicate suppression must occur before card persistence, wake dispatch, and
    rate-limit charging. The response to the reporter must say which recipients
    were delivered, skipped as ineligible, or suppressed as duplicates.

12. FYI wake policy must be explicit. A persisted FYI card and an agent wake are
    separate effects; low-urgency information must not consume a turn unless the
    selected policy requires it.

13. `warn` and `blocker` reports that are eligible and not duplicates must retain
    the current non-preempting behavior: a busy recipient queues the system turn,
    and an idle recipient starts it through the shared wake path.

14. The existing per-reporter rolling rate limit remains a last-resort volume
    bound. It does not replace eligibility, causal deduplication, or semantic
    deduplication.

15. Tests must cover archived and explicitly completed recipients, merged and
    re-armed sessions, dormant terminal-PR sessions, direct-message policy,
    causal and semantic duplicates, suppression expiry, concurrent duplicate
    calls, every severity, and reporter-visible delivery outcomes.

## Open questions

### Q2. What remains deliverable after completion, and what audit remains when delivery is skipped?

- **A — Direct messages remain allowed; skipped cohort delivery creates no card
  (recommended).** An explicit parent can still contact a completed child, but a
  broadcast cannot write or wake it. The reporter receives the skip reason in
  the command result.
- **B — Direct messages remain allowed; skipped cohort delivery persists a
  clearly non-actionable audit card.** This gives the recipient a record but can
  add transcript noise and can still look like contact after completion.
- **C — Completion blocks direct and cohort delivery.** This makes completion a
  strict communication boundary and requires an explicit reopen before any
  coordination.

### Q3. What duplicate and FYI policy should apply?

- **A — Durable causal suppression plus a 30-minute cohort semantic window; FYI
  is card-only (recommended).** Suppress the same chain once per recipient for
  the life of the chain. Also suppress matching normalized
  reporter/cohort/subject/body fingerprints for 30 minutes. Persist one FYI card
  but do not wake an agent; `warn` and `blocker` keep wakes.
- **B — Causal suppression only; every severity wakes.** This is simpler but does
  not stop an echo when an agent submits a fresh report without the inherited
  chain ID.
- **C — Durable causal and semantic suppression; every severity wakes.** This
  closes both duplicate paths but a permanent semantic fingerprint can suppress
  a materially relevant recurrence after circumstances change.

## Resolved questions

- 2026-08-14 — Which terminal-PR sessions are eligible for cohort broadcasts?
  Chosen: exclude sessions that the existing UI classifies as resolved. For this
  decision, that is a session whose single PR merged and that received no user
  message after the merge. Reuse that classification for report eligibility; do
  not treat every merged PR as completion and do not invent a separate idle/queue
  approximation.
