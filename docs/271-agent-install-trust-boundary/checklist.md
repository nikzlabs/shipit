# Checklist — `agent.install` trust boundary

The feature was built, reviewed, and then **removed** when its founding
requirement was withdrawn (2026-08-21). Both halves are checked off: the build
happened, and so did the removal.

## Build (2026-08-17 → 2026-08-20)

- [x] `requirements.md` written from the issue before any design
- [x] Open questions put to the requester; answers recorded as dated receipts
- [x] Route verified at the source (both mounts, both execution paths, the uid
      equality that rules out writer attribution)
- [x] Gate module, gate call, transcript notice, unit and runner-level tests
- [x] Independent reviews; findings fixed and each verified at the source

## Removal (2026-08-21)

- [x] Req 1 replaced by the requester — plugin code sits at the `package.json`
      dependency trust level
- [x] Reqs 2, 4, 5, 12 retired as superseded/subsumed; full text preserved
- [x] Req 3 retired, with 7, 8 and 11 following it
- [x] `requirements.md` and `plan.md` rewritten to describe what remains
- [x] Gate module and both test files deleted
- [x] Call sites removed: runner, warm pool, fork, claim, overlay publish
- [x] Orphaned `dependency-reset` gap phrase removed
- [x] Pre-existing fixes deliberately kept (`unverified`, `_installInFlight`)
      and documented as such in `plan.md`
- [x] Suite shrank rather than grew — 2 files and 50 tests removed, none added
- [x] `npm run typecheck`, `npm run lint:dev`, `npm test` green
- [x] Independent review of the removal
- [x] planning#400 updated
