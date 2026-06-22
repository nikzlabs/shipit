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

## Phase 3 — Explicit composer control + per-send override + settings UI (default ON)

- [ ] `resetMergedBranch?: boolean` on the user message (`ws-client-messages.ts`,
      `send-message.ts`) — per-send intent threaded into the helper
- [ ] Surface transient `resetEligible` on session/PR state (recompute on activation
      + post-turn)
- [ ] Composer control (placement B — inside the border, top row): shown iff
      `resetEligible && getAutoResetMergedBranch()`, checked by default, opt-out non-sticky
- [ ] Settings UI toggle for `autoResetMergedBranch`; flip default to **on**
- [ ] Client + server tests (control visibility, override threading, opt-out non-sticky)

## Cross-cutting

- [ ] `npm run typecheck` + `npm run lint:dev` green each phase
- [ ] Update `plan.md` "as built" notes where reality diverges
- [ ] Comment progress on SHI-189 per PR (`Refs SHI-189`; final PR `Closes SHI-189`)
