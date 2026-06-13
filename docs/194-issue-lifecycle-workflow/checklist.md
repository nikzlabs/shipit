# Issue lifecycle workflow — checklist

Implementation, roughly in dependency order:

## started (no session state)
- [x] Seed path: at session creation from an issue, fire one-shot brokered `status started` from the pointer in the creation payload (idempotent; pointer not persisted) — wired in `api-routes-session.ts` headless route → `markIssueStartedFromSeed` (`issue-lifecycle.ts`)
- [x] Non-seeded: agent guidance to call existing `shipit issue status <pointer> started` — no new code (`agent-instructions.ts`, `shipit-docs/issues.md`)
- [x] Confirm the `started` write reuses the docs/177 provenance card (`surfaceWriteCard` builds the same `IssueWriteCard`; suppressed only on a no-op transition)

## Completed-on-merge
- [x] Parse merged `pr.body` for `Closes/Fixes/Resolves <pointer>` **inside `verifyMissingPr`** (where the PR body is in scope), not the `onMergeDetectedCb(sessionId)` callback — new `onMergedPr` callback carries the body
- [x] For each pointer: brokered `status completed` + summary comment via `Tracker` adapter (`applyMergedPrIssueRefs`)
- [x] Non-closing `Refs <pointer>` → progress comment only, status untouched
- [x] No pointer at all → no-op / no comment (multi-PR case); closed-unmerged → no-op (only fires on `merged_at`)
- [x] Provenance card for the completion write

## Idempotency (duplicate-cards-on-reconnect fix)
- [x] Layer 1: persisted, effect-level fire-once guard keyed by `${prNumber}:${issueId}:${verb}` (`SessionManager.hasAppliedMergeIssueEffect` / `markAppliedMergeIssueEffect`, column `merge_issue_effects`) — gates the status flip, resolved-by comment, and progress comment independently; marked only on success so a transient tracker failure still retries (`issue-lifecycle.ts` `runMergeEffect`)
- [x] Layer 2: deterministic `cardId` (`issue-write-${sessionId}-${prNumber}-${issueId}-${verb}`) for merge-driven cards so the idempotent-by-id client store collapses a re-fire; seed path keeps random id
- [x] Tests: second-call no-op (no duplicate write/card), refs no-op, deterministic card id, retry-after-failure (`issue-lifecycle.test.ts`); poller re-entrancy + guarded-effect-once (`pr-status-poller.test.ts`); persisted guard round-trip + corrupt-JSON (`sessions.test.ts`)

## Agent guidance
- [x] Document `status started` (non-seeded) + the `Closes`/`Refs <pointer>` conventions in `shipit-docs/issues.md`
- [x] Extend PR-creation guidance in `agent-instructions.ts` (Closes for finishing PR, Refs for partial/progress)

## Tests
- [x] Merge-path parse: closes / refs-only / no-pointer / closed-unmerged / multi-pointer (close all) — `pr-issue-refs.test.ts`, `issue-lifecycle.test.ts`
- [x] Seed path fires `started`; card on real transition, suppressed on no-op — `issue-lifecycle.test.ts`
- [x] Poller fires `onMergedPr` with the body on merge — `pr-status-poller.test.ts`

## Reconciliation
- [x] Update docs/156 non-goal note ("issue status mutation") to point here as the superseding workflow
