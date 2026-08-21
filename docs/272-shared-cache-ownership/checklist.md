# Checklist — shared git cache ownership

- [x] `requirements.md` written before any design or code
- [x] `plan.md` implementing it, citing requirements
- [x] `orchestrator/shared-tree-ownership.ts` — reclaim walk + cheap gate, injectable deps, inert below root
- [x] Gate wired into `RepoGit.fetchCache` and `RepoGit.cloneFromCache`
- [x] `cloneFromCache` docstring: which tree governs, who takes the destination
- [x] `handPluginCheckoutToWorker` in `session-worker-uid.ts`, used by `plugin-install.ts`
- [x] `git-tree-uid.ts`: answer the one-stat question; once-per-tree fall-through log
- [x] `repo-prefetch.ts`: ownership-shaped fetch failures name the ownership disagreement
- [x] `startup-janitor.ts`: boot pass over `repo-cache/` and `marketplace-cache/`
- [x] Census asks source **and** destination; new clone-argv census
- [x] A test that fails on today's code, written and watched fail first — two: the
      plain-recursive-chown census (which also found two call sites nobody had
      enumerated) and the `plugin-install` handover assertion
- [x] `shared-tree-ownership.test.ts` — repair, idempotence, inertness, object files included
- [x] `CLAUDE.md` + `git-architecture` skill: the EACCES-as-root debugging note and the invariant
- [x] Arming runbook Tables B/B2 corrected; the open `.git/objects` question answered
- [x] `npm run lint:dev` and `npm run typecheck` clean
- [x] Independent review via `shipit agent run --role reviewer`
- [x] Tracker synced (comment on planning#425 / #417 / #428)
