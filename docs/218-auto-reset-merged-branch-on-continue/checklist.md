# Checklist — auto-update merged branch on continue

Three phases, each a self-contained PR. The reset mechanism and its persisted card
ship **together** (a destructive op must never run without a durable record); the
explicit control + default-on flip is the final phase.

## Phase 1 — Capture `mergedHeadSha` (the PR's head SHA) ✅

- [x] Extend `findPullRequestAnyState` to return the PR's `head.sha` (`github-auth-prs.ts`
      + the `GitHubAuthManager` wrapper in `github-auth.ts`); `head_sha: string | null`,
      fail-closed to null on a malformed/partial response
- [x] `merged_head_sha TEXT` column + migration (`shared/database.ts`)
- [x] `SessionRow.merged_head_sha` + `fromRow` parse (`sessions.ts`)
- [x] `SessionInfo.mergedHeadSha?: string` (`shared/types/domain-types/session.ts`)
- [x] `setMergedHeadSha(id, sha)` setter on `SessionManager`; **also** cleared in
      `clearMerged` (a docs/202 re-arm drops the stale merged tip)
- [x] Persist `mergedHeadSha = pr.head_sha` in `verifyMissingPr` (`pr-status-poller.ts`),
      in the `isMerged && !alreadyTerminal` block before the merge side effects; fail
      closed if absent (warn + no SHA stored, merge detection still proceeds)
- [x] `sessions.test.ts` — round-trip + cleared-on-`clearMerged`; `pr-status-poller.test.ts`
      — captured on merge, fails closed when head.sha absent (stub gains `setMergedHeadSha`)
- [x] `npm run typecheck` + `npm run lint:dev` green

## Phase 2 — Pre-turn reset mechanism + persisted card (behind a global setting, default OFF) ✅

- [x] `git.ts` — `resetHardToRemoteBase(base)` (returns `{from, to}`); `currentBranchOrNull()`
      (detached → null); `isMergeOrSequencerInProgress()` (MERGE/CHERRY_PICK/REVERT_HEAD);
      reused `isClean()` + `isRebaseInProgress()`
- [x] `services/pre-turn-reset.ts`:
  - [x] `computeResetEligible(session, prStatus, git)` — safety-only (merged + SHA recorded +
        `HEAD === mergedHeadSha` + clean tree + on `session.branch`, not detached + no
        in-progress sequencer)
  - [x] `autoResetMergedBranchOnContinue` — gate → fetch → **re-gate** → reset →
        return `{ moved, base, prNumber, prUrl, fromSha, toSha, agentPrefix }`; fail-safe
- [x] Global setting `getAutoResetMergedBranch()` (default **off** this phase),
      sibling of `getAutoResolveConflicts`/`getAutoFixCi`
- [x] Wire into `runAgentWithMessage` (interactive only): reset pre-turn + prepend agent
      prefix to the prompt; card emitted via the new `TurnInput.afterUserMessagePersisted`
      hook (fires after the executor persists the user row, post `resetRunnerTurnState`) —
      keeps user → card → agent order without clobbering `recordedCards` (see plan "As built")
- [x] Persisted card: `emitChatCard`; `branchAutoReset` `PersistedMessage` field
      `{ cardId, base, prNumber, prUrl, fromSha, toSha, createdAt }` + column +
      `toRow`/`fromRow` + INSERT/UPDATE SQL + migration; rehydrates via `fromRow`;
      `CARD_MESSAGE_FIELDS` + `EVERY_OPTIONAL_FIELD_MESSAGE`; `BranchUpdatedCard` component
      + `branch_auto_reset_card` WS type + client handler (idempotent by cardId)
- [x] Tests: `pre-turn-reset.test.ts` (15 — gate matrix incl. detached/in-progress/dirty,
      re-gate-after-fetch, setting-off, fail-safe); `git-rearm-detect.test.ts` (+6 — git
      helpers on real repos); `chat-history.test.ts` (round-trip via `EVERY_OPTIONAL_FIELD_MESSAGE`);
      `branch-auto-reset-card.test.ts` (no-dup-on-replay); `visual-elements.test.ts` (guard)
- [ ] **Checkpoint deferred to Phase 3.** The live "enable the setting → observe reset +
      card" check needs the toggle UI, which lands in Phase 3 (Phase 2 ships dark, default
      OFF). Phase 2 is verified by the tests above; live observation folds into Phase 3.

## Phase 3 — Explicit composer control + per-send override + settings UI (default ON) ✅

- [x] `resetMergedBranch?: boolean` on the user message (`ws-client-messages.ts` →
      `send-message.ts` → `runAgentWithMessage`) — per-send intent threaded into the
      helper as the `intent` arg (`false` = skip; `true`/undefined = follow the setting)
- [x] Transient `reset_eligible` WS signal (NOT the poller — it excludes merged
      sessions): `isResetEligible` helper (safety-only); pushed on **activation**
      (`route-registry.ts`, mirroring the `pr_notable_files` re-seed) and **post-turn**
      (the `postTurnReArmReset` closure in `agent-execution.ts`). Client store:
      `pr-store.resetEligibleBySession` + `reset-eligible` handler
- [x] Composer control (placement B — inside the border, top row, `rounded-t-xl`, no
      border-radius change): shown iff `resetEligible && autoResetMergedBranch`, checked
      by default, per-send untick non-sticky (re-checks on each reappearance)
- [x] Settings UI toggle (`AdvancedTab.tsx`) for `autoResetMergedBranch`; full round-trip
      (credential-store + `GlobalSettings` + `WsGlobalSettings` + bootstrap PUT + settings
      store + `global_settings` handler + both bootstrap hydration points); **default flipped ON**
- [x] Tests: `pre-turn-reset.test.ts` (intent matrix + `isResetEligible`);
      `reset-eligible.test.ts` (store handler); `MessageInput.test.tsx` (control
      visibility off/on, default-checked send, per-send untick)
- [x] `npm run typecheck` + `npm run lint:dev` green

## Phase 4 — Heal the remote at reset (dropped-push fix) ✅

- [x] `autoResetMergedBranchOnContinue` force-pushes (`git.forcePush("origin")`)
      immediately after `resetHardToRemoteBase`, healing the remote so later plain
      auto-pushes fast-forward instead of silently failing as non-fast-forward;
      best-effort (a lease rejection / error is logged, the reset still stands)
- [x] Reverses the "never force-push at reset" decision — plan "Recovery / data-loss
      posture" superseded note + "Resolved decisions" + Phase 4 "As built"
- [x] Tests: `pre-turn-reset.test.ts` (heal called on success; moved:true on heal failure)
- [x] `npm run typecheck` + `npm run lint:dev` green

## Phase 5 — Hand the workspace back to the worker after the reset (docs/150 §7 bug class) ✅

Found by an Ops investigation, not by a test: the reset shipped without an ownership
handback and stayed silent for six weeks because the *visible* half of the workspace
self-heals while the broken half does not.

- [x] **The pre-turn auto-reset left the session worktree root-owned — the agent EACCESed on its first edit of the very turn the reset enabled.** `autoResetMergedBranchOnContinue` runs `git fetch` + `git reset --hard origin/<base>` as the **root orchestrator** against a worktree the non-root worker (uid 1000) owns, so every file the reset re-materializes lands `root:root` — and it never called `handWorkspaceBackToWorker`. Its sibling `resetBranchToBaseExplicit` (docs/239, same file, same reset core) has had the handback in a `finally` since 2026-07-31, with a docblock naming this exact failure; the docs/218 path (2026-06-22) was simply never backfilled, and `docs/218-*/` contained zero mentions of `chown`. **Why nothing repaired it:** the entrypoint's boot `chown -R /workspace` is sentinel-skipped on warm reuse (`.shipit-uid-1000` exists and is already 1000-owned, so the fast path correctly declines to re-walk); `selfHealWorkspaceOwnership` runs only from `createContainer`, i.e. on container (re)create, not on a plain restart and not mid-life; and the post-turn handback (`ws-handlers/post-turn.ts`) is `chownWorkspaceGitToSessionWorker` — **`.git`-only**. So `.git` self-heals and the session *looks* healthy (git status / commit / push all work) while the worktree stays unwritable. **Observed live** (read-only, 2026-08-03) on session `4e301c9f`, container up 22h and never recreated: two auto-resets fired inside its life (PRs #1873, #1897 — identifiable by the `[System] Your previous pull request…` prefix, produced only by `buildAgentPrefix`, private to this function), leaving **103 files under `src/` owned `root:root`**. Fleet-wide, not session-specific: the setting defaults ON, so any merged session resumed via the composer was exposed until its container was recreated. Fixed by calling `handWorkspaceBackToWorker(sessionDir)` in a `finally`, mirroring the docs/239 path.
- [x] **The handback is in a `finally`, and scoped to "we actually touched git".** `finally` rather than a post-success call because the surrounding `catch` is fail-safe: a reset that succeeds and *then* throws in the force-push heal has already re-rooted the tree, and returning `NOT_MOVED` would run the turn on a workspace the agent cannot write to — the worst version of the bug. Scoped via a `mutatedWorkspace` flag because this helper runs on **every** interactive turn (`ws-handlers/agent-execution.ts`) and the handback is a full worktree walk; the paths that bail before the fetch (setting off, `intent === false`, pre-fetch gate failure) only ever *read* git, so charging every turn of every session for a no-op walk buys nothing. The flag is set immediately before `git.fetch`, **not** before the reset, so the fetch's own root-owned `.git` writes (`FETCH_HEAD`, remote refs, new objects) are covered and a post-fetch TOCTOU bail still hands back. Trivially satisfies the docs/231 ordering constraint (handback after any `git lfs pull`) — this path runs no LFS pull, and the `finally` is last regardless.
- [x] **The non-root gate is confirmed ON in prod, so this is a live defect and not latent behind an unset flag** (Ops read-only host inspection, 2026-08-03). Both halves agree: the orchestrator container (`shipit-shipit-1`) carries `SHIPIT_SESSION_WORKER_UID=1000`, so `handWorkspaceBackToWorker` is live code there rather than a no-op; and every session container carries the same var with its worker running as uid 1000 (`docker top`). Independently reconfirmed from inside a session container: `id -u` = 1000 (`shipit`), `SHIPIT_SESSION_WORKER_UID=1000`, `/workspace` `1000:1000`, `SHIPIT_SKIP_WORKSPACE_CHOWN` unset. **An end-to-end repro is deliberately NOT the gate for this fix**, for two structural reasons rather than convenience: the auto-reset only fires for a session whose own PR has merged (`mergedAt` + `mergedHeadSha` + live `prStatus` + `HEAD === mergedHeadSha`), and a hand-run `git reset --hard` from inside the container runs as uid **1000**, not root — the root-ness of the writer *is* the entire mechanism, so an in-container reset cannot reproduce it. The Ops session that diagnosed it is read-only (hardened docker-socket-proxy: no exec, no writes), so no root-written repro can be staged on the live host either. The unit tests below are therefore the binding verification; the live host confirms only that the missing call is a real defect on this deployment.
- [x] Tests (`pre-turn-reset.test.ts`, new `workspace ownership handback` block): handback on the happy path, on the **reset-throws** path (the fail-safe `catch` must not skip it), on the force-push-heal failure (`moved: true`), and on the post-fetch TOCTOU bail; plus the negative half pinning the scoping — no walk when the setting is off, when `intent === false`, or when the pre-fetch gate fails. All four positive assertions fail without the fix.
- [x] `npm run typecheck` + `npm run lint:dev` green

## Cross-cutting

- [x] `npm run typecheck` + `npm run lint:dev` green each phase
- [x] Update `plan.md` "as built" notes where reality diverges
- [x] Comment progress on SHI-189 per PR (`Refs SHI-189`; final PR `Closes SHI-189`)

## Phase 6 — SHI-295: neither the skipped reset nor the merged-branch push is silent ✅

From a production incident (session `37a74020`, PR #1963): the reset silently didn't
fire, the post-turn auto-push then **recreated** the branch GitHub had deleted at
merge, and the commit ended up an orphan belonging to no PR. The user diagnosed it
themselves — "Pr was actually already merged" — after previously reporting the same
class as "changes are missing from the merged PR". Two defects, one user-facing
failure, so one PR.

- [x] **A skipped reset now names the clause that refused it.** `computeResetEligible` became a thin wrapper over a new `computeResetBlocker`, which returns *which* clause failed instead of a bare boolean. One implementation rather than a parallel "explain why" helper, deliberately: a nine-clause safety gate and its explanation drift apart, and the half that drifts is the explanation — the exact surface a user reads to decide what to do.
- [x] **Three surfaces per skip, and only on a MERGED session.** A `[pre-turn-reset] skipped for <id> (<clause>)` `console.warn` (the incident was diagnosed by proving a negative — one session's log shows `[git] Reset --hard`, the broken one shows *nothing* — which is not a thing an investigation should have to do); a **persisted** transcript notice via `emitNoticeInTurn` on the existing `afterUserMessagePersisted` hook, sharing the branch-updated card's anchor so it lands after the user bubble and survives a reload; and an agent prompt prefix, because the agent was as blind as the user and went on to author a commit for a dead PR. Non-merged sessions stay silent — nothing to reset, nothing to say.
- [x] **`warn` for safety clauses, `info` for the two deliberate opt-outs** (global setting off, per-send untick). This narrows the plan's "a global opt-out means we don't nag" to what it should always have meant: hide the *control*, not the fact that a merged branch is stale.
- [x] **No clause was weakened and the reset fires in no new situation.** The incident's blocker was almost certainly `git.isClean()` (a dirty tree at 16:33:58) and that refusal is correct — `reset --hard` over uncommitted edits is the one irreversible loss. This phase adds visibility, not aggression.
- [x] **New `services/merged-push-guard.ts`, wired into `postTurnCommit`:** while the session is merged and the new commit is stacked on the merged tip, the *silent debounced* auto-push is refused and a persisted notice names the merged PR plus the two recovery routes. The commit still happens (work is never lost, and stays reflog-recoverable); an explicit `gh pr create` is untouched — it force-pushes through its own path, the same carve-out the ops-session gate makes. Blocking beat allow-with-a-warning because the notice is precisely what went unread last time, and by the time it is read the orphan branch already exists on GitHub: a refusal is reversible in one command, a resurrected branch is a support conversation.
- [x] **The `mergedHeadSha`-ancestry test is what keeps it precise.** Gating on `mergedAt` alone would false-positive on the flow ShipIt's own agent instructions prescribe after a merge (rebase onto the fresh base → commit → `gh pr create` again): `mergedAt` is still set at commit time there, because the docs/202 re-arm that clears it runs *after*. Limitation stated in the module docstring rather than papered over — the test discriminates cleanly only under a **squash** merge; under merge-commit / rebase-and-merge the anchor is in the base, so that push is blocked too (a notice that over-warns and a push deferred to the `gh pr create` the flow ends in — no lost commit).
- [x] Tests: `pre-turn-reset.test.ts` (`skip reporting` block — clause-per-gate-failure, level split, breadcrumb fallback, post-fetch TOCTOU, the log line, silence on a non-merged session and on a successful move); new `merged-push-guard.test.ts`; `post-turn.test.ts` (commit-but-no-push + persisted notice, the moved-HEAD variant, pushes normally once rebased off the merged tip, pushes normally when not merged, and a throwing notice not taking the turn down).
- [x] `npm run typecheck` + `npm run lint:dev` + `npm run test:dev` green
