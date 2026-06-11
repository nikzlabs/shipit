# Issue lifecycle workflow — checklist

Design doc only so far. Implementation work, roughly in dependency order:

## Linkage + started
- [ ] Add `issueRef` field to session metadata (`domain-types.ts`, `sessions.ts` row + `toRow`/`fromRow` + migration)
- [ ] Seed path: `headless-sessions.create({ issueRef })` records `issueRef` and marks `started` at creation
- [ ] Attach path: `shipit issue attach <pointer>` subcommand (shim + route + service) — records `issueRef` + marks `started`, idempotent
- [ ] Surface the `started` write via the docs/177 provenance card (reuse existing brokered-write card)

## Completed-on-merge
- [ ] Parse merged PR body for `Closes/Fixes/Resolves <pointer>` in the `onMergeDetectedCb` path
- [ ] For each pointer: brokered `status completed` + summary comment via `Tracker` adapter
- [ ] No closing line → no-op (multi-PR case); closed-unmerged → no-op
- [ ] Provenance card for the completion write

## Agent guidance
- [ ] Document `attach` + the `Closes <pointer>` convention in `shipit-docs/issues.md`
- [ ] Extend PR-creation guidance in `agent-instructions.ts` (Closes for finishing PR, plain reference for partial)

## Tests
- [ ] Merge-path parse: closes / no-closes / closed-unmerged / multi-pointer
- [ ] `attach` records `issueRef` + marks started; idempotent on repeat
- [ ] Seed path marks started at creation
- [ ] `issueRef` round-trips through the session row

## Reconciliation
- [ ] Update docs/156 non-goal note ("issue status mutation") to point here as the superseding workflow
