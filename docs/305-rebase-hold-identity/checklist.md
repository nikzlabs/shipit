# Checklist

- [x] Reproduce both shapes against `runRebaseFlow`, red before the fix
- [x] Key the driver's release on the `systemHoldSeq` ticket, captured at every acquisition
- [x] Decide whether the re-take between resolution turns needs the same change
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
- [x] Raise the two 250ms auto-resolve deadlines that went red under a loaded full-suite run
- [x] Targeted suites green; the full suite belongs to CI on the pull request
- [x] Two independent reviews of the branch diff, acted on or filed (planning#566)
- [x] Point docs/304's "Filed, not fixed here" entry at this doc
