# Issue lifecycle workflow — checklist

Design doc only so far. Implementation work, roughly in dependency order:

## started (no session state)
- [ ] Seed path: at session creation from an issue, fire one-shot brokered `status started` from the pointer in the creation payload (idempotent; pointer not persisted)
- [ ] Non-seeded: agent guidance to call existing `shipit issue status <pointer> started` — no new code
- [ ] Confirm the `started` write reuses the docs/177 provenance card

## Completed-on-merge
- [ ] Parse merged PR body for `Closes/Fixes/Resolves <pointer>` in the `onMergeDetectedCb` path
- [ ] For each pointer: brokered `status completed` + summary comment via `Tracker` adapter
- [ ] No closing line → no-op (multi-PR case); closed-unmerged → no-op
- [ ] Provenance card for the completion write

## Agent guidance
- [ ] Document `status started` (non-seeded) + the `Closes <pointer>` convention in `shipit-docs/issues.md`
- [ ] Extend PR-creation guidance in `agent-instructions.ts` (Closes for finishing PR, plain reference for partial)

## Tests
- [ ] Merge-path parse: closes / no-closes / closed-unmerged / multi-pointer (close all)
- [ ] Seed path fires `started` once at creation; idempotent if already started

## Reconciliation
- [ ] Update docs/156 non-goal note ("issue status mutation") to point here as the superseding workflow
