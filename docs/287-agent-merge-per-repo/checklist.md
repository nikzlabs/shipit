# Checklist — Agent merge, granted per repository

Implements [plan.md](./plan.md) against [requirements.md](./requirements.md).

## Storage and grant

- [ ] Migration: `repos.allow_agent_merge INTEGER NOT NULL DEFAULT 0`, no backfill
- [ ] `RepoStore.allowsAgentMerge()` / `setAllowAgentMerge()`, matched on `canonicalRepoKey`
- [ ] Route to read and set the grant, shaped like `/api/repos/trust`
- [ ] The grant never reaches the container (guard test on the session payload)

## Gate

- [ ] `mergeDisposition()` takes the repo grant; ops / sandbox / repo-bound branches
- [ ] Distinct refusal message per branch (`not-granted-repo`, `ops-refused`)
- [ ] Own-PR check: resolve the session's branch PR, refuse a different number
- [ ] Own-PR check fails closed when the branch resolves no pull request

## Merge sequence

- [ ] `flushPendingTurnCommit()` first, with `chatHistory` for the notice
- [ ] 422 on `secretBlocked` and on `unreadableBlocked`
- [ ] `guardMergeSync()` before the pull request is read
- [ ] `MergeSyncVerdict` gains `reason: "pushed" | "push-failed" | "diverged"`
- [ ] `cancelAutoPush(sessionId)` only on `reason: "pushed"`
- [ ] `viewPullRequest()` moved after the push, so `pr.head` is current
- [ ] Pending-checks refusal names `--auto`
- [ ] `reviewDecision` gate (docs/174) applied on this path

## After the merge

- [ ] `emitNoticeInTurn()` record of the merge (persisted, survives a reload)
- [ ] `poller.forceVerifySessionPrState()` after a successful merge
- [ ] Result message tells the agent to run `shipit branch reset-to-base`

## UI and docs

- [ ] Agents tab in `ProjectSettings.tsx` with the single toggle
- [ ] Toggle help text: own pull request only, checks and branch protection still apply
- [ ] `shipit-docs/github.md`: the grant, the flush, and the two-call `--auto` loop

## Quality

- [ ] `pr-target.test.ts` — every disposition branch
- [ ] `services/github-agent-merge.test.ts` — order, aborts, cancel, refusals
- [ ] `services/branch-sync.test.ts` — the `reason` discriminator
- [ ] `integration_tests/agent-driven-pr.test.ts` — granted, not granted, foreign PR, notice reload
- [ ] Each new guard proved red on its own before the fix
- [ ] `npm run lint:dev` and `npm run typecheck` green
- [ ] Independent review via `shipit agent run --role reviewer`
