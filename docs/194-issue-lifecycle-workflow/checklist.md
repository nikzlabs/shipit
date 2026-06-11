# Issue lifecycle workflow — checklist

Design doc only so far. Implementation work, roughly in dependency order:

## started (no session state)
- [ ] Seed path: at session creation from an issue, fire one-shot brokered `status started` from the pointer in the creation payload (idempotent; pointer not persisted)
- [ ] Non-seeded: agent guidance to call existing `shipit issue status <pointer> started` — no new code
- [ ] Confirm the `started` write reuses the docs/177 provenance card

## Completed-on-merge
- [ ] Parse merged `pr.body` for `Closes/Fixes/Resolves <pointer>` **inside `verifyMissingPr`** (where the PR body is in scope), not the `onMergeDetectedCb(sessionId)` callback (sessionId-only, no body)
- [ ] For each pointer: brokered `status completed` + summary comment via `Tracker` adapter
- [ ] Non-closing `Refs <pointer>` → progress comment only, status untouched
- [ ] No pointer at all → no-op / no comment (multi-PR case); closed-unmerged → no-op
- [ ] Provenance card for the completion write

## Agent guidance
- [ ] Document `status started` (non-seeded) + the `Closes`/`Refs <pointer>` conventions in `shipit-docs/issues.md`
- [ ] Extend PR-creation guidance in `agent-instructions.ts` (Closes for finishing PR, Refs for partial/progress)

## Tests
- [ ] Merge-path parse: closes / refs-only / no-pointer / closed-unmerged / multi-pointer (close all)
- [ ] Seed path fires `started` once at creation; idempotent if already started

## Reconciliation
- [ ] Update docs/156 non-goal note ("issue status mutation") to point here as the superseding workflow
