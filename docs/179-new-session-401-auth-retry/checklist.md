# Checklist — new-session 401 auth retry (docs/179)

- [x] `ClaudeOAuthRefresher.ensureFresh` — single-flight pre-read heal (healthy = no spawn)
- [x] Pre-spawn heal in `prepareSessionAgentEnvironment` (Step 2a), time-bounded + fail-open
- [x] Pre-naming heal in `graduateSession` / `scheduleSessionNaming`
- [x] Runtime-401 auto-retry in `turn-executor` (`willRecoverAuth` / `recoverAuth`, `isAuthRetry`, `persistGuard`)
- [x] `auth_required` listener split: quiet recovery vs. `surfaceReauth`
- [x] `ensureAgentTokenFresh` hook in `buildApp`, keyed by agent (claude → refresher, codex → no-op)
- [x] Plumb the healer through AppCtx / ApiDeps / RunnerRegistryDeps / SystemTurnDeps / graduate / env-prep
- [x] Unit tests: `ensureFresh` (5 cases)
- [x] Unit tests: `auth_required` handler recovery (3 cases)
- [x] Integration test: end-to-end 401 → heal → re-dispatch (+ fallback + bounded)
- [x] Runtime rejected-resume recovery: guarded pointer clear + one fresh-conversation retry
- [x] Finalize visible first-attempt output before auth or stale-resume retry resets
- [x] typecheck + lint clean
- [x] Feature doc (this folder)

## 2026-08-02 incident (session `bf04d140`) — silent double 401

- [x] `ensureFresh(accountId, { force: true })` — validity probe (tier 2) on the runtime-401 path, replacing the expiry short-circuit that made every heal a no-op
- [x] Forced probe classifies `revoked` / `missing_credentials` as **not** healed, so the card surfaces instead of burning the recovery budget
- [x] Forced probe on a live token returns `noop` without bumping `failureCount` (no schedule backoff from a session 401)
- [x] Proactive env-prep sweep (Step 2a) left unforced — cheap short-circuit preserved
- [x] `repushSessionAgentToken` — unconditional source→session token push before the healed retry, bypassing the `srcExp <= dstExp` guard; route-aware (docs/150 account root vs shared root vs `claude-env-oauth` no-op)
- [x] Persist the `auth_required` notice via `emitChatCard` + `finalizeInProgress` (survives detached viewer / switch / reload)
- [x] Persist the stale-resume notice ("Couldn't resume the previous conversation…")
- [x] Persist the no-result / empty-retry error, and suppress it on the auth path (the listener already owns that row)
- [x] Regression test: session token with a **later** `expiresAt` than the source but dead
- [x] Regression tests: forced-heal semantics, repush ordering, notice durability via `GET /history`
- [x] `syncAgentTokenBack` and its call sites deliberately untouched (sibling session owns write-back timing)

## §3 detection — one failure, one signal (nikzlabs/shipit#1874)

- [x] `resultEventIndicatesAuthFailure` excludes `error_max_turns` /
      `error_during_execution` and a non-`api_error` `terminal_reason` before any
      text match (a turn-cap failure whose text mentions OAuth is not an auth failure)
- [x] Absent `terminal_reason` still detects — older CLIs omit it
- [x] `raiseAuthRequiredOnce` on both process classes: one auth failure emits two
      auth-shaped events, but the signal re-dispatches the turn, so it may raise once
- [x] Latch is per-**turn**, re-armed in `run()` / `sendUserMessage` (the streaming
      process is resident across turns)
- [x] Listener-side turn latch in `agent-auth-handler.ts` for a duplicate arriving
      from the raw-stderr path; `willRecoverAuth` deliberately NOT used as the gate
- [x] Non-array `tool_result.content` handled in `extractToolResults` /
      `stampToolDurations` (the TypeError that stranded the turn)
- [x] Tests: real two-event payload → exactly one heal + one re-dispatch; no-false-
      positive cases; the string-content turn survives and honors the follow-up steer

## §4 credential rewrites under a live process

- [x] Verified against CLI 2.1.219 that Claude re-reads `.credentials.json` **per
      request** (`ok → fail → ok` on one resident process); corrected the opposite
      claim in `services/provider-account-switch.ts`
- [x] `reusingResidentAgent` → `repairLeakedSubtrees: false` on the per-turn sync-in
- [x] System turns retire the resident process **before** env prep (`dispatched-turn.ts`)
      so "topology changes only at a spawn boundary" is a real boundary
- [x] `sessionHasLiveAgent` predicate; scheduled OAuth refresher (`bootstrap-managers.ts`)
      and post-sign-in re-push (`app-lifecycle.ts`) derive `repairLeakedSubtrees` from it
- [x] Both copy loops resolve the destination to the **container-visible** path, so a
      suppressed repair still lands the rotated token (the leaked absolute-symlink shape)
- [x] Tests: genuine leaked shape (symlink into the shared root), system-turn retire
      asserted as an ordering, `sessionHasLiveAgent` true for an idle session holding a
      resident process
- [x] Convergence (criterion 2) — **accepted unresolved, deliberately.** The writer that
      recreated the links between turns on the production install was never identified,
      and #1874 is closed without it: the leaked shape is unreachable for sessions
      provisioned after docs/150 req 19 (no root aliases created, existing ones retired,
      `copyCredentialPath` dereferences), a pre-req-19 session's repair converges after
      one pass (asserted by `session-agent-env.test.ts`), and the §4 fix makes
      repair-under-a-resident-process impossible whether or not repair converges. The
      criterion-7 `[env-prep]` line now distinguishes "repaired again" from "ran and
      found nothing", so a recurrence is diagnosable from one log line — reopen on that
      evidence rather than keeping the item open speculatively.
