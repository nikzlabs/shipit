# Checklist — auto-update merged branch on continue

Three phases, each a self-contained PR. The reset mechanism and its persisted card
ship **together** (a destructive op must never run without a durable record); the
explicit control + default-on flip is the final phase.

## Phase 1 — Capture `mergedHeadSha` (the PR's head SHA)

- [ ] Extend `findPullRequestAnyState` to return the PR's `head.sha` (`github-auth-prs.ts`)
- [ ] `merged_head_sha TEXT` column + migration (`shared/database.ts`)
- [ ] `SessionRow.merged_head_sha` + `fromRow` parse (`sessions.ts`)
- [ ] `SessionInfo.mergedHeadSha?: string` (`shared/types/*`)
- [ ] Setter on `SessionManager`
- [ ] Persist `mergedHeadSha = pr.head.sha` in `verifyMissingPr` (`pr-status-poller.ts`),
      before the merge side effects; fail closed if absent (no SHA stored)
- [ ] `sessions.test.ts` — `mergedHeadSha` round-trips; poller test — captured on merge

## Phase 2 — Pre-turn reset mechanism + persisted card (behind a global setting, default OFF)

- [ ] `git.ts` — `reset --hard origin/<base>` helper; `isClean()`; detached-HEAD &
      in-progress-sequencer (rebase/merge/cherry-pick/revert) checks
- [ ] `services/pre-turn-reset.ts`:
  - [ ] `computeResetEligible(session, git)` — safety-only (merged + SHA recorded +
        `HEAD === mergedHeadSha` + clean tree + plain repo state)
  - [ ] `autoResetMergedBranchOnContinue` — gate → fetch → **re-gate** → reset →
        return `{ moved, base, prNumber, prUrl, fromSha, toSha }` + agent prefix; fail-safe
- [ ] Global setting `getAutoResetMergedBranch()` (default **off** this phase),
      sibling of `getAutoResolveConflicts`/`getAutoFixCi`
- [ ] Wire into `runAgentWithMessage` (interactive only): **persist user row → reset
      → emit card (anchored after user row) → prepend agent prefix → executeAgentTurn**
      (suppress the executor's duplicate user-row append)
- [ ] Persisted card: `emitChatCard`; `branchAutoReset` `PersistedMessage` field
      `{ base, prNumber, prUrl, fromSha, toSha }` + column + `toRow`/`fromRow` +
      migration; rehydrate in `loadSessionHistory`; `CARD_MESSAGE_FIELDS` +
      `EVERY_OPTIONAL_FIELD_MESSAGE` (`visual-elements.ts`); `BranchUpdatedCard` component
- [ ] Tests: `pre-turn-reset.test.ts` (gate matrix incl. detached/in-progress/dirty,
      re-gate-after-fetch, eligibility truth table); `chat-history.test.ts` (card
      round-trip + no-dup-on-replay); `visual-elements.test.ts`
- [ ] **Checkpoint:** enable the setting; verify reset + card on continue, and observe
      the docs/216 PR card (diagnose whether it's broken)

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
