# Preemptive GitHub auth — implementation checklist

- [x] Verify the premise against real git 2.39.5 (anonymous first request, `extraHeader` fixes it, redirect behaviour, rejected-credential failure mode)
- [x] `requirements.md` from the human's four requirements, open question resolved with a receipt
- [x] `plan.md` citing the requirements
- [x] Tracker item filed and cross-linked (`planning#503`)
- [x] Preemptive `http.<origin>.extraHeader` delivered through `GIT_CONFIG_COUNT` in the child environment (req 1, req 3)
- [x] `allowUnsafeConfigEnvCount` scoped to the two instances that build their env from `sanitizeGitEnv` (`credentialledGit`, `RepoGit`)
- [x] `withPreemptiveAuthFallback` + `looksLikeAuthRejection`, applied to fetch/clone and deliberately not to push (req 4)
- [x] `RepoGit` resolves a credential per remote op; resolver injected at `createRepoGit` (req 1 — bare cache, prefetch, claim, unarchive, restore, warm pool)
- [x] `resolveTreeRemoteCredential` no longer gated on the uid drop; bounded by the github.com-only resolver instead (req 1 — pushes)
- [x] Cache-side LFS fetch carries the credential (req 1 — LFS cache fetch)
- [x] Dead `gitTreeUidDeps` seam removed from `GitManager` now that nothing reads it
- [x] Wire tests against a loopback HTTP server: header on the first request, none without a credential, unauthenticated retry on refusal, nothing for a declined remote
- [x] req 3 guard: token in the environment, never in the argv
- [x] Each new guard proven to fail with the fix reverted
- [x] `npm run lint:dev`, `npm run typecheck`, full `npm test`
- [x] Independent review via `shipit agent run --role reviewer`
- [x] PR opened
