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

## Cross-cutting

- [x] `npm run typecheck` + `npm run lint:dev` green each phase
- [x] Update `plan.md` "as built" notes where reality diverges
- [x] Comment progress on SHI-189 per PR (`Refs SHI-189`; final PR `Closes SHI-189`)
