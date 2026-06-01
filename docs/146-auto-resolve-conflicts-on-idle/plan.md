---
status: done
priority: medium
description: When the PR poller sees the branch has conflicts with its base and the session's agent is idle, auto-start a rebase + agent-driven conflict resolution turn.
---

# 146 — Auto-Resolve Conflicts on Idle

## Summary

When a session's open PR transitions to `mergeable: CONFLICTING` (typically because `main` moved while the session was idle) and the session's agent is not currently running a turn, automatically kick off the rebase-onto-base + agent-driven conflict resolution flow built in doc 094. The user comes back to a session that has either resolved itself or, if it couldn't, surfaced a clear failure card — instead of a PR sitting on "conflicts must be resolved" until the user notices.

A new global user setting, `autoResolveConflicts`, gates the behavior. Default off.

## Motivation

Today, after doc 094 shipped, ShipIt can rebase + force-push when the user (or the auto-push) explicitly drives it. But the common silent-failure path is:

1. The agent finishes a turn, pushes, opens a PR.
2. The user closes the tab or switches sessions.
3. Someone else lands a PR to `main`, or the user lands a different ShipIt session's PR.
4. This session's PR now shows "conflicts must be resolved" on GitHub. Nothing in ShipIt is doing anything about it.
5. The user comes back hours later, sees the conflict banner, has to click "Update branch", wait for the agent to attach, and drive the resolution turn manually.

The poller already knows mergeable state (see `PrStatusSummary.mergeable` in `pr-status-poller.ts`). The rebase + agent resolution loop already exists (doc 094). The auto-fix-on-CI-failure pattern already exists (`auto-fix-manager.ts`). This feature is just wiring those together with an idle gate and a setting — no new primitives.

This satisfies CLAUDE.md §1 ("ShipIt is the surface — the user does not leave it"): today the user has to either drive the rebase themselves inside ShipIt or, worse, bounce to GitHub's web UI to understand what's wrong. The auto-resolve path keeps the cycle entirely inside the product.

### Relationship to doc 113

Doc 113 (`pr-mergeable-state`) explicitly placed "Auto-firing the rebase on poller detection" in its Out-of-scope section, with the reasoning: "this can fire while the user is mid-thought on something else, and the rebase grabs the agent for an indeterminate number of turns. Manual trigger preserves user control." This doc is the deliberate reversal of that decision. The new mitigations that make auto-fire acceptable:

- **Default-off global setting.** Users opt in; the doc 113 status quo is preserved for anyone who doesn't.
- **Idle gate.** The auto-resolve never fires while the agent is mid-turn. The "rebase grabs the agent while user is mid-thought" failure mode from 113 is structurally prevented — the user finishes their work, the agent goes idle, *then* the auto-resolve queues.
- **3-attempt cap + 5-minute cooldown.** "Indeterminate number of turns" is bounded at 3 outer attempts, each capped at 10 minutes wall-clock and 10 inner rebase iterations.
- **Failure banner only on exhausted.** A user who toggles the setting on and forgets won't see per-attempt UI noise; only the terminal "we gave up" state surfaces.

Update doc 113's Out-of-scope to cross-reference this doc when this lands, so the two stay consistent.

## Design

### Trigger: PR poller mergeable transition

Piggyback on the existing per-repo poll (`pr-status-poller.ts`, 15s cadence). After computing the new `PrStatusSummary`, the poller unconditionally calls `autoConflictResolveManager.handleTransition(sessionId, current, baseBranch, headSha)` for every tracked session — same call site / same cadence as the existing `autoFix.handleTransition`. The manager itself owns the edge / sticky / unknown filtering.

No new polling, no new API calls. The mergeable field is already in the existing GraphQL query and the rate-limit budget already absorbs it.

**`mergeable === "unknown"` handling.** GitHub returns `UNKNOWN` while it's computing mergeability — common right after a push (mapped to `"unknown"` in `pr-status-poller.ts`, near the REST fallback at line ~693). If we naively edge-detect, a single sticky conflict will oscillate `conflicting → unknown → conflicting` and re-fire on every flop-back. The manager carries forward the **last non-unknown value** of `mergeable` per session in `lastKnownMergeable` and runs the edge test against *that*, not the raw `prev` summary. An `unknown` poll is treated as "no change" and never triggers, never resets. (The filter has to live in the manager — not the poller — because UNKNOWN-flop-back protection needs the cached history, not just the raw `prev` summary.)

### Manager: `AutoConflictResolveManager`

Mirrors `AutoFixManager` in shape so future readers map between them on sight. Lives in `src/server/orchestrator/auto-conflict-resolve-manager.ts`.

```typescript
export const MAX_AUTO_RESOLVE_ATTEMPTS = 3;

export type RebaseAndResolveCb = (
  sessionId: string,
  baseBranch: string,
) => Promise<AutoResolveResult>;

export interface AutoConflictResolveState {
  attemptCount: number;        // resets when head SHA changes
  lastHeadSha: string;
  status: "idle" | "running" | "exhausted" | "deferred";
  lastError?: string;          // non-conflict failures (network, auth, dirty tree) surface here
  nextEligibleAt?: number;     // epoch ms; set on failure for the 5-min cooldown
  pendingReset?: boolean;      // set by resetForUserActivity while running; applied by writeBack
  lastEmittedDeferred?: string; // dedup tracker for back-to-back deferred WS emits
}

export class AutoConflictResolveManager {
  /** sessionId → state */
  private states = new Map<string, AutoConflictResolveState>();
  /** sessionId → last non-unknown mergeable value (UNKNOWN polls are ignored) */
  private lastKnownMergeable = new Map<string, "mergeable" | "conflicting">();

  constructor(
    private readonly onChange: (sessionId: string) => void,
    /**
     * Returns the live runner for a tracked session, or undefined if the
     * session has no runner (evicted, archived, never activated). The poller
     * tracks any session with an open PR — there is no guarantee a runner
     * exists. See the "Runner availability" subsection below.
     */
    private readonly getRunner: (sessionId: string) => SessionRunnerInterface | undefined,
    /**
     * Reads the global `autoResolveConflicts` setting at decision time. See
     * the "Wiring into the manager" subsection — we deliberately do not
     * mirror this value into per-session state, so toggling the global
     * setting takes effect on the next poll/idle event with no fan-out.
     */
    private readonly isGlobalEnabled: () => boolean,
    private rebaseAndResolveCb?: RebaseAndResolveCb,
  ) {}

  /**
   * Called from PrStatusPoller after each poll's summary is built. Async
   * because the pre-attempt gate's `runner.verifyRunningState()` is an HTTP
   * roundtrip to the worker for container runners. The poller's caller
   * site must `void`-suppress (fire-and-forget) the returned promise — the
   * poller's per-repo loop is sync today and we don't want to block other
   * sessions on one session's worker probe. Use `void manager.handleTransition(...).catch(err => log)`.
   */
  handleTransition(
    sessionId: string,
    current: PrStatusSummary,
    baseBranch: string,
    headSha: string,
  ): Promise<void>;

  /**
   * Called when a session's runner transitions to idle (agent finished AND
   * message queue empty). Wired by subscribing to the runner's existing
   * `"idle"` event at session-track time — see "Wiring the idle hook"
   * below. Async because it shares the pre-attempt gate with
   * `handleTransition`. The registry's listener adapter must `void`-wrap
   * the call: `runner.on("idle", () => { void cb(sessionId); })`.
   */
  onRunnerIdle(sessionId: string): Promise<void>;

  /**
   * Reset attempt budget on a WS-typed user input. Called from the WS
   * dispatch switch's `send_message` / `send_review_message` /
   * `answer_question` cases. NOT called from `runner.dispatch` or from
   * synthetic `handleSendMessage` invocations (e.g. `init_preview_config`).
   *
   * Effect: when status is NOT `"running"`, clears `attemptCount` to 0,
   * clears `nextEligibleAt`, clears `lastError`, AND sets `status =
   * "idle"` regardless of prior value (including `"exhausted"`).
   * Allowing reset from `"exhausted"` is deliberate: the user explicitly
   * re-engaged with the session, so give them a fresh budget.
   *
   * When status IS `"running"`, the immediate reset is deferred — do NOT
   * clear attemptCount/nextEligibleAt/lastError now, since the in-flight
   * wrapper's writeBack will overwrite them. Instead, set a
   * `pendingReset = true` flag on the state. `writeBack` checks this
   * flag at the very end: if set, apply the full reset (clear attempt,
   * cooldown, lastError; set status to idle) AFTER writing its terminal
   * status, and clear `pendingReset`. This honors the documented intent
   * ("the user explicitly re-engaged with the session, so give them a
   * fresh budget") for the case where the user types during an in-flight
   * attempt that subsequently exhausts. Without this, the user re-engages,
   * the attempt exhausts, and the failure banner appears for a user who
   * actively asked for retry semantics.
   */
  resetForUserActivity(sessionId: string): void;

  /**
   * Read the per-session state. Returns undefined if the session has no
   * entry (never had a conflict, or state was dropped on resolution).
   * Used by `attachAutomationState` to populate the SSE PR-status
   * snapshot's `autoResolve` block. Mirrors `AutoFixManager.get` at
   * `auto-fix-manager.ts:42-44`.
   */
  get(sessionId: string): AutoConflictResolveState | undefined;

  /**
   * Drop a session's state entirely. Called from `PrStatusPoller.untrackSession`
   * and from `handleTransition` when the PR transitions to CLOSED (without
   * merge). Clears both `states` and `lastKnownMergeable` for the session.
   */
  delete(sessionId: string): void;

  /**
   * Late-bind the rebase-and-resolve callback (constructor-time injection
   * via the optional `rebaseAndResolveCb` field requires the closure's
   * deps to exist at construction time, which they don't — the manager is
   * built inside the poller, before `app-lifecycle.ts` has finished
   * wiring `RebaseDriverDeps`). Mirrors `AutoFixManager.setFetchAndFixCb`
   * at `auto-fix-manager.ts:37-39`.
   */
  setRebaseAndResolveCb(cb: RebaseAndResolveCb): void;
}
```

`handleTransition` logic:

The algorithm relies on the cap + cooldown to prevent runaway firing, NOT on edge detection. There is no "fire only on the mergeable→conflicting edge" rule — that turns out to be both unnecessary (cap+cooldown gate it) and incompatible with retry semantics (a sticky conflict after the cooldown expires would be unable to re-fire). The `lastKnownMergeable` cache exists only to filter UNKNOWN polls.

1. If `current.mergeable === "unknown"` → return. Do not touch the cache; UNKNOWN polls never participate.
2. Read `prevKnown = lastKnownMergeable.get(sessionId)` into a local **before** writing the cache. The local is the pre-poll snapshot used by the rest of the logic; the cache write at step 3 must not clobber it.
3. Write `lastKnownMergeable.set(sessionId, current.mergeable)`. This happens unconditionally — *before* the enable check at step 4 — so the cache stays accurate even while the feature is disabled. When the user later toggles the setting on, the first post-enable poll has the correct `prevKnown` for first-enable correctness (test 16).
4. If `isGlobalEnabled()` returns false → return.
4a. Read `state = states.get(sessionId)`. If undefined (first-seen for this session — common on first-enable, on first conflict after `delete()`, or after step 8 dropped a resolved-conflict entry), initialize as `{ attemptCount: 0, lastHeadSha: headSha, status: "idle" }` and write to `states`. All later steps (5–12) assume `state` is defined; this read+initialize is the only place it materializes.
5. If `status === "running"` → return. An in-flight attempt is still writing back; nothing to do this poll.
6. If `status === "exhausted"` → return. Terminal until `resetForUserActivity` or head-SHA-change clears it.
7. If head SHA changed since last attempt → reset `attemptCount = 0`, clear `nextEligibleAt`, clear `lastError`, set `status = "idle"`.
8. If `current.mergeable !== "conflicting"` → the conflict resolved itself. Drop the per-session state entirely: `states.delete(sessionId)` and `lastKnownMergeable.delete(sessionId)`. Return. (Step 3 just wrote `current.mergeable` ("mergeable") into the cache; step 8 then deletes the same entry. Net effect is "no cache entry for non-conflicting sessions" — the step-3 write is structured for the conflicting branch and harmlessly written-then-deleted on the non-conflicting branch. We don't keep an `idle` state around for sessions whose conflicts resolved — for a long-running orchestrator this lets the manager's maps shrink as conflicts come and go. If the conflict re-appears later, the session re-initializes from first-seen, which is correct.)
9. If `attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS` → `status = "exhausted"`, emit, return.
10. If `nextEligibleAt` is set and `now() < nextEligibleAt` → return. The cooldown gates retry; we'll re-check on a later poll.
11. Pre-attempt gate: if no runner for the session (`getRunner(sessionId) === undefined`) → set `status = "deferred"`, emit, return. Otherwise check `runner.running`: if false, fall through to step 12; if true, set `status = "deferred"` and emit first (so the state is correct in case of re-entrancy — see below), then call `await runner.verifyRunningState()`. If verify confirms `true`, return. If verify reset the runner from running→idle (the stranded-running safety net), do NOT fall through to step 12 from this method — return instead, and let the re-entrant `onRunnerIdle` that fires synchronously from inside `verifyRunningState` own the next fire.

   Four operational notes: (a) `verifyRunningState` on `ContainerSessionRunner` skips the HTTP roundtrip when `_isRunning === false` at entry (`container-session-runner.ts:1370`); the HTTP call only fires when `_isRunning === true`. Step 11 only calls verify when `runner.running === true`, so the HTTP call always fires on this path. On an unreachable worker, verify logs and returns the existing `_isRunning` (`true` in this branch — that's fine — we keep deferring), but a chronically-unreachable container means we eat the HTTP timeout per session per 15s poll. If this shows up under load, add a recent-failure short-circuit in `verifyRunningState` itself, not here. (b) `verifyRunningState` on `ContainerSessionRunner` can emit the runner's `"idle"` event when it detects a stranded `running=true` and resets it (`container-session-runner.ts:1392`), which re-enters `autoConflictResolveManager.onRunnerIdle(sessionId)` synchronously. By setting `status = "deferred"` BEFORE the verify call, the re-entrant `onRunnerIdle` sees the right status and re-runs the gate. The re-entrant call sets `status = "running"` and fires the callback before `await verifyRunningState()` returns — that's the *load-bearing contract* this design relies on: Node's EventEmitter runs listeners synchronously, so when `verifyRunningState` calls `this.emit("idle")` (line 1392) it returns to its caller only after the `onRunnerIdle` listener has fully run, status flip and callback dispatch included. The "false" branch above must `return` (not fall through) precisely because the re-entrant fire has already happened by the time `verifyRunningState`'s promise resolves. A unit test should pin this — a custom runner stub that emits `"idle"` synchronously inside `verifyRunningState` and asserts `rebaseAndResolveCb` was called exactly once across the whole `handleTransition`. (c) `SessionRunner` (the in-process variant used by integration tests) does not implement the stranded-running reset — `verifyRunningState()` just returns the local `_isRunning` flag (`session-runner.ts:585-587`) and never emits `"idle"`. The `return` instruction on a verify-false result is unreachable for in-process runners in practice (`runner.running` would have already been false at the prior local-flag check); the path is container-only. (d) Tests using in-process runners can't exercise the re-entrant recovery path; they exercise the simpler "verify confirms running → defer" branch only.
12. Set `status = "running"`, fire `rebaseAndResolveCb(sessionId, baseBranch)` async. **Do not increment `attemptCount` here** — the increment happens in `writeBack` after the wrapper reports whether real work was done. The wrapper's `auto_resolve_started` emit reads `state.attemptCount + 1` as the `attempt` field so the started/result envelopes pair correctly (started.attempt = N matches result.attempt = N for the same attempt; both are 1-indexed). The actual `attemptCount` only increments in writeBack after `didWork: true`.

The retry story: after `writeBack` on a failed attempt records the cooldown, the next polls within the cooldown short-circuit at step 10 and the next poll *after* the cooldown expires falls through to step 12 (assuming the runner is still idle). No edge transition needed — `handleTransition` itself handles retry.

The `onRunnerIdle` hook plays a smaller role with this design: it lets a `"deferred"` state re-evaluate the moment the runner becomes idle (don't wait up to 15s for the next poll). It is no longer load-bearing for cooldown-driven retry.

`onRunnerIdle(sessionId)`:

1. Read `state = states.get(sessionId)`. If status is not `deferred`, return. (Cooldown-driven retry runs through `handleTransition`, not here — see the retry story note.)
2. If `isGlobalEnabled()` is false, return.
3. Read `mergeable = lastKnownMergeable.get(sessionId)`. If not `"conflicting"`, the conflict resolved itself — set `status = "idle"`, return.
4. Otherwise re-run the cap gate (step 9 of `handleTransition`), the cooldown gate (step 10), and the runner gate (step 11). The `verifyRunningState` call is redundant here (the `"idle"` event implies `_isRunning === false` AND queue empty) but the two-stage check ensures the cheap path takes precedence. On pass, set `status = "running"` and fire the callback.

#### Completion handler

`handleTransition`/`onRunnerIdle` fire the callback as `rebaseAndResolveCb(sessionId, baseBranch).then(writeBack(sessionId)).catch(writeBackError(sessionId))`. `writeBack` is the terminal-transition writer; it is the **only** place a `status === "running"` becomes anything else for that attempt, and the **only** place `attemptCount` is incremented:

| Wrapper outcome (`AutoResolveResult`) | Manager writeBack |
|---|---|
| `{ outcome: "success", forcePushed: true, didWork: true }` | `attemptCount++`; `status = "idle"`; clear `lastError`; clear `nextEligibleAt`; emit `auto_resolve_result { outcome: "success", forcePushed: true, attempt }` |
| `{ outcome: "success", forcePushed: false, didWork: true }` | `attemptCount++`; record `state.lastError = "force_push_failed"` (synthetic label — `tryForcePush` doesn't return a structured signal; see "Lease failure on force push"); if `attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS` → `status = "exhausted"`, emit `auto_resolve_result { outcome: "exhausted", lastError: "force_push_failed", forcePushed: false, attempt }`; otherwise `status = "idle"`, `nextEligibleAt = now() + AUTO_RESOLVE_COOLDOWN_MS` (same cooldown the error path gets — without this, a sticky lease conflict re-fires every 15s and burns the budget in <1min), emit `auto_resolve_result { outcome: "success", forcePushed: false, attempt }`. The exhausted envelope's `lastError: "force_push_failed"` is what the failure banner renders — without the synthetic label, the banner would render "Last error: undefined." |
| `{ outcome: "error", lastError, didWork: true }` | `attemptCount++`; **always record `state.lastError = lastError`**; if `attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS` → `status = "exhausted"`, emit `auto_resolve_result { outcome: "exhausted", lastError, attempt }`; otherwise `status = "idle"`, `nextEligibleAt = now() + AUTO_RESOLVE_COOLDOWN_MS`, emit `auto_resolve_result { outcome: "error", lastError, attempt }`. The "exhausted" outcome is *manager-emitted* — the wrapper never returns it. The exhausted envelope MUST carry `lastError` (the failure-banner copy depends on it). |
| `{ outcome: "deferred", lastError?, didWork: false }` | No increment; record `state.lastError = lastError` if present; `status = "deferred"`; emit `auto_resolve_result { outcome: "deferred", lastError?, attempt }`. Used for pre-flight failures (dirty tree, stale rebase, no-auth, 409 TOCTOU, `up_to_date` race). No budget burn. Pre-flight failures that are "couldn't even start" are deferred not errored — the user didn't get their work attempted, so it shouldn't count against them, and the banner won't flash up between retries. |
| Unhandled rejection (the `.catch` path) | Treat as `{ outcome: "error", lastError: getErrorMessage(err), didWork: true }` — defensive: an unexpected crash from the wrapper most likely happened mid-attempt, so we count it. Better to over-count occasionally than to spin forever on a wrapper bug. |

`writeBack` produces two outputs per attempt: (1) the SSE PR-status broadcast via `onChange(sessionId)` — same mechanism the auto-fix manager uses, which causes `attachAutomationState` to re-decorate the next snapshot with the updated `autoResolve` block; (2) the per-attempt WS `auto_resolve_result` envelope via `getRunner(sessionId)?.emitMessage(...)` — the same runner getter the gate uses. Per-attempt `success`/`error`/`deferred` envelopes are all emitted by `writeBack` (not by the wrapper) so that every `auto_resolve_result` emit goes through a single code path and pairs cleanly with the manager-emitted `exhausted` envelope.

If `getRunner(sessionId)` returns undefined at writeBack time (the runner was evicted while the attempt was in flight — rare but possible), drop the WS emit and just write the state. The state still reaches the next viewer because the per-session state rides on the SSE PR-status snapshot — see "SSE-snapshot threading" below.

### SSE-snapshot threading

The failure banner needs to survive viewer reconnects and page reloads (a user who hits exhausted, closes the tab, and comes back later should see the same banner). The WS `auto_resolve_result` emit is fire-and-forget; nothing replays it. So the per-session manager state has to ride on the SSE PR-status snapshot the same way `autoFix` and `autoMerge` state does today:

- **`PrStatusSummary` gains an `autoResolve` field** carrying `{ status, attemptCount, maxAttempts, lastError?, nextEligibleAt? }` (the subset of state the client cares about — internal cache fields like `lastKnownMergeable` don't ship). `maxAttempts` echoes the `MAX_AUTO_RESOLVE_ATTEMPTS` constant so the client renders "attempt 3/3" in the failure banner without hard-coding the constant client-side, matching the `autoFix` block's `maxAttempts: 3` pattern (`github-types.ts:274-279`). Unlike `autoFix` and `autoMerge` (which include an `enabled` flag because they're per-session toggles), `autoResolve` has no `enabled` flag — the setting is a single global boolean read from the client `settings-store.ts` (populated from `/api/bootstrap`'s `GlobalSettings`). The banner component reads the global from the client store and the per-session state from the snapshot; it only renders when both `settings.autoResolveConflicts === true` AND `autoResolve.status === "exhausted"`. The orchestrator-side `attachAutomationState` gate on `isGlobalEnabled()` (described above) belt-and-suspenders this — even if the client somehow rendered without checking the global, the snapshot wouldn't have the `autoResolve` block to render from.
- **`attachAutomationState` in `pr-status-poller.ts`** (the existing helper that decorates summaries with `autoFix` / `autoMerge` state at ~line 395) gets a third branch for `autoResolve`, pulling from `autoConflictResolveManager.get(sessionId)`.
- **Client banner reads from the snapshot first, then layers in any later `auto_resolve_result` envelope deltas.** Same model the auto-fix banner uses today.

This is what makes the dropped-WS-emit case above non-lossy: the runner may be evicted at writeBack time, but the state is still written, and the next snapshot poll attaches it for any future viewer.

#### Attempt accounting

The wrapper's `AutoResolveResult` carries an explicit `didWork: boolean` field so the manager knows whether real work was done (an agent turn was kicked off, or a force-push was attempted). The wrapper itself does NOT touch `attemptCount` — all increment/decrement logic lives in `writeBack`, which keeps the state-machine writes in one place and avoids the ordering race where `up_to_date` and 409 outcomes arrive *after* a wrapper-side increment but before `writeBack` could see them.

Detection rules inside the wrapper. The wrapper returns one of three shapes — `{ outcome: "success", forcePushed, didWork: true }`, `{ outcome: "error", lastError, didWork: true }`, or `{ outcome: "deferred", lastError?, didWork: false }`. There is intentionally no `{ outcome: "error", didWork: false }` shape: pre-flight failures (couldn't even start) are deferred, not errored, so the failure banner doesn't flash up on transient pre-flight conditions like a dirty tree the user is about to clean up.

**Cooldown after deferred outcomes.** Pre-flight failures (dirty tree, stale rebase, no-auth, `up_to_date` race) re-run on every 15s poll while the failing condition holds — each runs `verifyRunningState()` (HTTP roundtrip for container runners), constructs `RebaseDriverDeps`, invokes the wrapper, runs the pre-flight checks. To bound this cost, `writeBack` sets a shorter cooldown on deferred outcomes than on error outcomes: `nextEligibleAt = now() + AUTO_RESOLVE_DEFERRED_COOLDOWN_MS` (default 60s). Subsequent polls within that window short-circuit at step 10 *before* the verify HTTP call or the wrapper invocation — they pay only the cheap state-map lookup. After 60s the cooldown expires; if the deferred condition is still there, we re-check (and re-cooldown). The dirty-tree case stops costing per-15s polls and starts costing per-60s polls.

  Deferred outcomes do NOT count against the attempt cap (didWork: false), so a chronically-deferred session won't exhaust on its own. The dedup mechanism is also still useful for the WS-emit volume: `writeBack` skips the `auto_resolve_result` emit when the new deferred outcome is identical to the last (compare `lastError`); state writes still happen. Implementation: store `lastEmittedDeferred?: string` on the per-session state.

1. **Pre-flight stage** (before calling `runRebaseFlow`): dirty tree, stale rebase, no GitHub auth (see "No GitHub auth pre-flight" below) → `{ outcome: "deferred", lastError: "<reason>", didWork: false }`. Pre-flight is "we couldn't even start"; it's a defer (try again later, maybe the user fixes it), not an error against the per-session budget.
2. **Cheap entry checks** (before triggering an agent turn or a force-push): the wrapper inspects `runRebaseFlow`'s return for `{ status: "up_to_date" }` → `{ outcome: "deferred", didWork: false }`; catches `ServiceError(409)` from the running-guard → `{ outcome: "deferred", didWork: false }`.
3. **Anything after `runRebaseFlow` starts doing real work** (agent turn fires, or force-push happens) → `{ outcome: "success" | "error", didWork: true }`.

The boundary between (2) and (3) is "did `runRebaseResolutionTurn` start an agent turn, or did `tryForcePush` actually push?" Both happen inside `runRebaseFlow`, and we can't intercept them from the wrapper without modifying the driver. The wrapper approximates by treating the only two early-exit returns we know about (`up_to_date`, 409) as `didWork: false` and everything else as `didWork: true`. If `runRebaseFlow` ever gains a new early-exit path, the wrapper would need updating — call out the assumption when extending.

A specific case worth noting: `runRebaseFlow` throws `ServiceError(500, "Too many conflict iterations (>10) — rebase aborted")` after `MAX_REBASE_ITERATIONS` (`services/rebase-driver.ts:146-150`). The throw lands in the wrapper's `.catch` *after* multiple agent spawns — `didWork: true` is correct here, and this counts as one outer attempt against `MAX_AUTO_RESOLVE_ATTEMPTS`. Also: before throwing, `runRebaseFlow` already called `rebaseAbort()` and emitted `rebase_aborted` itself, so the wrapper must NOT call its timeout-teardown `rebase_aborted` emit again on this path. The timeout teardown (which DOES emit `rebase_aborted`) is for the wrapper-owned wall-clock timeout case only.

Another case worth being explicit about: `runRebaseFlow` calls `git.fetch("origin")` as its very first step (`rebase-driver.ts:106`), before any agent turn fires. A network failure here throws into the wrapper's `.catch` and would currently be classified `didWork: true`, burning a budget attempt for zero work. Special-case fetch failures (and any other throws *before* `runRebaseResolutionTurn` first spawns the agent) into `{ outcome: "deferred", lastError: "network", didWork: false }`.

The "agent was spawned" boundary is not directly observable from inside `runAutoResolveAttempt` — `runRebaseFlow` only signals via its return/throw, and the spawn happens deep inside `runRebaseResolutionTurn`. To make the boundary observable, extend `RebaseDriverDeps` with an optional `onAgentSpawned?: () => void` callback that `runRebaseResolutionTurn` fires immediately after `runner.setAgent(agent)` (`rebase-driver.ts:252`). The wrapper captures a local `didSpawn` flag, sets it in the callback, and in `.catch` checks `didSpawn` to decide between `didWork: false` (no spawn yet — fetch/ancestry/early-throw path) and `didWork: true` (spawn happened — real work was done). The cooldown-after-deferred behavior will dampen the network-failure loop in the same way it dampens the dirty-tree loop.

### No GitHub auth pre-flight

Doc 094's user-driven path treats "no GitHub auth" as a non-error: `tryForcePush` returns `false`, the local branch stays rebased, and the next manual push uses `--force-with-lease`. We deliberately diverge from that on the auto-path. If the auto-resolver runs without auth, the agent does real work, the rebase succeeds locally, the force-push silently no-ops — but the PR on GitHub still shows CONFLICTING. The next 15s poll sees the same CONFLICTING state, fires another auto-resolve, agent spends more tokens, still no remote effect. The MAX cap eventually stops the loop, but by then we've burned three back-to-back agent turns with no observable progress.

The auto-path is opportunistic, not intent-driven (unlike the user-clicked rebase), so the right response is to gate the *attempt* on auth being present. Wrapper pre-flight: if `!githubAuthManager.authenticated`, return `{ outcome: "deferred", lastError: "no_github_auth", didWork: false }`. The PR card already prompts for auth elsewhere; the auto-resolve quietly waits.

The `deferred` state is the key idle-gate primitive. We don't queue, schedule, or set timers — we record "we wanted to fire but the agent was busy" and rely on two re-evaluation triggers: the next poll *that sees an edge transition* (rare — usually the conflict is sticky) and the `onRunnerIdle` hook (the normal case). Attempts count only when we actually attempt; a long-running turn doesn't burn the budget.

### Wiring the idle hook

The runner already emits an `"idle"` event from `onAgentFinished()` (see `session-runner.ts`, where `_isRunning === false` AND the message queue is empty is the emit predicate — exactly what this feature wants). `SessionRunnerRegistry` already exposes an `onRunnerIdle` injection hook that subscribes the supplied callback to every new runner's `"idle"` event; `runner-registry-factory.ts` already wires `enforceIdleContainerLimit` through it. Add a second subscriber (auto-conflict-resolve) at the same site rather than threading the call through every post-turn site.

Why this beats hooking `post-turn.ts` or `agent-execution.ts`'s `agent.on("done")`:

- The turn-completion code paths are plural: `agent-execution.ts` (WS user turn), `dispatched-turn.ts` (system-dispatched turn, e.g. CI auto-fix), and `rebase-driver.ts`'s own `agent.on("done")` (the auto-resolve's own resolution turn). Hooking at the runner level reaches all three with one subscription.
- `post-turn.ts` doesn't actually contain the turn-completion site — it only exports `postTurnCommit`, which is *called from* `agent-execution.ts` inside the `agent_result` handler. Wiring there would miss the rebase-driver and dispatched-turn paths.
- The runner's `"idle"` predicate (`!_isRunning && _messageQueue.length === 0`) is the correct one. Hooking on `"done"` alone would fire while another queued message is still about to drain, triggering an auto-resolve in front of a queued user turn.

### Runner availability

`PrStatusPoller` tracks any session with an open PR. There is no requirement that the session has a live container or runner — sessions get evicted by the idle enforcer, archived, or simply never activated since the last orchestrator restart. The poller talking to a session it can't drive is normal.

For auto-resolve, "no runner" is treated as identical to "agent running": go to `deferred`. We do **not** wake the container just to run an auto-resolve. Rationale:

- Spinning up a container costs Docker resources and counts against the idle cap. Auto-resolve is a background nicety, not worth burning a container slot for.
- The user's normal interaction path activates the runner. The auto-resolve fires from one of two triggers afterward: (a) the user sends a message and finishes a turn, which triggers `runner.onAgentFinished()` → `"idle"` event → `onRunnerIdle` → re-evaluates and fires (the common case); or (b) GitHub's mergeable state genuinely flips off and back on (e.g., the user pushed a fix that made things mergeable, then a base-branch advance reintroduced conflicts), which `handleTransition` catches as a new edge.
- A freshly-activated runner that hasn't taken a turn yet won't emit `"idle"` on its own (the event only fires from `onAgentFinished`), so a session the user just re-opened *without* sending a message will not auto-resolve until the next genuine mergeable edge. This is acceptable: the user is already in front of the PR card and can click the Retry button, send a message, or initiate a manual rebase. Auto-resolve is an opportunistic background path, not a guaranteed eventual-consistency guarantee.
- Restricting to "runner already up" means auto-resolve only ever fires for sessions the user (or another foreground action) recently touched — exactly the population most likely to be looking at the PR.

This is documented in the `getRunner` injection contract above. The poller injects `(id) => this.runnerRegistry?.get(id)`, which returns `undefined` for sessions without a live runner. Note that `PrStatusPoller.runnerRegistry` is declared optional (`pr-status-poller.ts:101`) — degraded test setups can construct the poller without it. The auto-resolve feature requires the registry: instantiate the manager only when `runnerRegistry` is present in the poller constructor, and skip wiring `handleTransition` / `onRunnerIdle` when absent (the feature simply doesn't activate). Document this in `AutoConflictResolveManager`'s wiring section so test-author surprises are caught.

### The rebase + resolve callback

**Reuse `runRebaseFlow` from `src/server/orchestrator/services/rebase-driver.ts:81` end-to-end.** That function already implements every step described in doc 094: fetch → rebase → if conflicts, prompt the agent → stage → `rebaseContinue()` → loop → force push. It also already sets `runner.running = true/false` around the agent invocation (`rebase-driver.ts:230, 260, 273`) and throws `ServiceError(409)` if `runner.running` is already true at entry (`rebase-driver.ts:87-89`). We do not write a parallel implementation.

What we add is a thin wrapper, `runAutoResolveAttempt`, alongside `runRebaseFlow` in `services/rebase-driver.ts` (same module so it shares helpers):

```typescript
/**
 * Wraps `runRebaseFlow` for the auto-conflict-resolve path. Takes the
 * full `RebaseDriverDeps` because `runRebaseFlow` requires every field —
 * sessionManager, chatHistoryManager, usageManager, authManager, and
 * sseBroadcast are all consumed by `wireAgentListeners` inside
 * `runRebaseResolutionTurn` (see `rebase-driver.ts:236-281`). A thinner
 * signature would compile but couldn't actually invoke the flow.
 *
 * The orchestrator constructs `RebaseAndResolveCb` once at startup with
 * the *signature* `(sessionId, baseBranch) => Promise<AutoResolveResult>`,
 * mirroring how `fetchAndFixCb` is wired in `app-lifecycle.ts` (~line 601).
 * The closure looks up the runner via `runnerRegistry.get(sessionId)`
 * and constructs `RebaseDriverDeps` per-call from the captured shared
 * managers + per-session runner/git. The wrapper signature shown below
 * takes the full RebaseDriverDeps, but the manager doesn't see that
 * shape — it only calls the outer (sessionId, baseBranch) closure.
 *
 *   - Adds a wall-clock timeout (default 10 min, overridable via
 *     `deps.timeoutMs` for tests). On timeout, the wrapper owns the
 *     full runner-state teardown that `git.rebaseAbort()` alone does
 *     NOT cover. See "Timeout teardown" below.
 *   - Translates a `ServiceError(409)` from runRebaseFlow's
 *     `runner.running` guard into { outcome: "deferred", didWork: false }.
 *     This is the TOCTOU backstop: the manager's gate may pass but the
 *     runner could have started a turn between the gate and the driver
 *     entry. The 409 fires before any real work, so didWork=false tells
 *     writeBack not to count the attempt.
 *   - Translates a `runRebaseFlow` { status: "up_to_date" } result
 *     (GitHub said CONFLICTING but our local view disagrees) into
 *     { outcome: "deferred", didWork: false } for the same reason.
 *   - Pre-flight failures (dirty tree, stale rebase, no GitHub auth) →
 *     { outcome: "deferred", lastError: <reason>, didWork: false }.
 *     These are *not* errors — they're "couldn't even start, try again
 *     later" signals. The error+didWork:false shape is intentionally
 *     unused; see "Detection rules inside the wrapper".
 *   - Any other failure that arrives after runRebaseFlow has crossed
 *     its entry guards → { outcome: "error", lastError: <reason>,
 *     didWork: true }.
 *   - Emits the `auto_resolve_started` envelope via `runner.emitMessage`
 *     at the top of the attempt. Does NOT emit `auto_resolve_result` —
 *     that envelope is emitted by the manager's `writeBack`, so the
 *     terminal manager-derived `exhausted` case and the per-attempt
 *     `success`/`error`/`deferred` cases all go through one emit path.
 *     CLAUDE.md's WS-lifecycle section requires `runner.emitMessage`
 *     (NOT `ctx.send`) for any state mutation that must outlive a
 *     single socket — both the started emit here and the result emit
 *     in writeBack follow that rule.
 *
 * Does NOT emit the inner `rebase_started` / `rebase_conflicts` /
 * `rebase_complete` events itself — those are emitted by runRebaseFlow
 * as a side effect, so the existing UI from doc 094 lights up exactly
 * as it would on a user-initiated rebase.
 */
export async function runAutoResolveAttempt(
  deps: RebaseDriverDeps & {
    /** Wall-clock timeout for the whole attempt. Default 10 min. */
    timeoutMs?: number;
    /** Injectable clock (default `Date.now`) so cooldown logic is testable. */
    now?: () => number;
  },
  baseBranch: string,
): Promise<AutoResolveResult>;

/** Cooldown after a failed attempt before the same session retries. */
export const AUTO_RESOLVE_COOLDOWN_MS = 5 * 60 * 1000;
/** Shorter cooldown after a deferred outcome (dirty tree, no-auth, up_to_date race, etc.). */
export const AUTO_RESOLVE_DEFERRED_COOLDOWN_MS = 60 * 1000;
```

Both cooldown constants are exported so `AutoConflictResolveManager` and its unit tests reference one source of truth; unit tests stub `now()` on the manager via an injected getter (mirrors the wrapper's `now`).

Pre-flight gates (run before any real work, so they don't burn budget). All return the `{ outcome: "deferred", lastError, didWork: false }` shape (see "Attempt accounting"):

- **Dirty tree check.** `await git.isClean()` returns false → return `{ outcome: "deferred", lastError: "dirty_tree", didWork: false }`. Defensive; shouldn't happen for an idle session, but we never stash silently on auto-paths. (GitManager's underlying SimpleGit `status()` is private; this wrapper adds a new public `isClean()` helper for the pre-flight — see the Key files table row for `git.ts`.)
- **Stale rebase check.** `await git.isRebaseInProgress()` returns true → call `git.rebaseAbort()` to clean up, then return `{ outcome: "deferred", didWork: false }`. This guards against an orchestrator restart that interrupted a previous auto-resolve mid-flight: when the orchestrator died, the rebase was left active on disk; `runRebaseFlow` would call `git.rebase(baseRef)` which fails when a rebase is already in progress. Aborting and deferring lets the next poll retry from a clean state without burning budget.
- **No GitHub auth.** `!githubAuthManager.authenticated` → return `{ outcome: "deferred", lastError: "no_github_auth", didWork: false }`. See "No GitHub auth pre-flight" above for why the auto-path diverges from the user-path here.

After `runRebaseFlow` returns:

- **`status: "up_to_date"` (base is already an ancestor of HEAD — i.e., HEAD already contains every commit in base, so no rebase is needed).** GitHub said CONFLICTING but our local view disagrees — the poller's cache, the GitHub mergeability recompute, and our local fetch are racing. Translate to `{ outcome: "deferred", didWork: false }`: do not count this as an attempt. Suppress the `auto_resolve_result { outcome: "deferred" }` emit on this specific path — `runRebaseFlow` already emitted `rebase_complete { forcePushed: false }` (`rebase-driver.ts:117`), and sending a contradicting `auto_resolve_result deferred` after a `rebase_complete` flashes "rebase succeeded then deferred" in the UI. The state is still written (deferred + cooldown), so the SSE snapshot picks it up. The cooldown-after-deferred behavior (see "Cooldown after deferred outcomes" below) caps the per-poll cost so this race doesn't infinite-loop on the cheap path.
- **`status: "rebased" | "conflicts_resolved"`.** Translate to `{ outcome: "success", forcePushed }`. The `forcePushed` flag comes straight from the inner result and lets the UI optionally surface "rebased locally but push deferred" without treating it as an error.
- **Lease failure on force push.** `runRebaseFlow` does NOT throw on a lease failure — `tryForcePush` (`rebase-driver.ts:189-218`) catches every push error, emits `git_push_rejected` for non-fast-forward / lease failures or `github_push_result { success: false }` otherwise, and returns `false`. The inner WS events still fire, so the UI shows the push failure inline; the wrapper does not get a structured signal that the *specific* cause was a lease conflict. Two consequences: (a) no `lastError: "lease_failed"` outcome — all `forcePushed: false` cases report as `{ outcome: "success", forcePushed: false }`; (b) the cooldown applies on the next poll's *new* attempt only if there's another transition, so a stuck lease conflict will sit at `outcome: "success", forcePushed: false` until something resets the state. If we later want a structured "lease failed" terminal signal here, we'd need to extend `tryForcePush` to return a discriminated result rather than a boolean.
- **No extra preamble *from the wrapper itself*.** The wrapper does not emit chat messages of its own. However, the *inner* rebase machinery is loud: `runRebaseResolutionTurn` unconditionally emits a `system_user_message` carrying the full conflict-resolution prompt and broadcasts `session_agent_started` with `activity: "Resolving conflicts..."`. The chat will show a system bubble, the sidebar will show the activity label, and only then the agent's compact resolution group appears. The user's first signal that auto-resolve fired is therefore the rebase prompt system message — not silence. This mirrors the user-initiated path exactly and is fine in v1. If users find the auto-path's system message intrusive, the fix is to add an opt-in `suppressActivityLabel` / `suppressSystemMessage` flag to `RebaseDriverDeps` for the auto path; punt for now.

#### Timeout teardown

`runRebaseFlow` spawns a real agent turn via `runRebaseResolutionTurn`, which sets `runner.running = true`, wires `wireAgentListeners`, and sets `runner.setAgent(agent)` (see `rebase-driver.ts:251-281`). A 10-minute wall-clock timeout firing while the agent is mid-turn must clean up every piece of that state — `git.rebaseAbort()` alone is not enough. The timeout handler owes:

1. `agent.kill()` on the in-flight agent process (otherwise the process keeps streaming events into a now-detached listener set).
2. `runner.setAgent(null)` so the next turn doesn't pick up the dead agent reference.
3. `runner.running = false` (the listener's normal `agent_result` reset never runs because we killed before completion).
4. `runner.onAgentFinished()` so the runner emits `"idle"` and any deferred subscribers re-evaluate.
5. `git.rebaseAbort()` (best-effort — may already be aborted; swallow).
6. `runner.emitMessage({ type: "rebase_aborted" })` so the UI clears the rebase banner doc 094 raised.

Without (1)–(4) the session is left with `running = true` and a zombie agent reference, blocking every subsequent user turn until the orchestrator restarts. Without (6) the chat shows a stuck "Resolving conflicts..." activity. The wrapper must perform these in order before resolving with `{ outcome: "error", lastError: "timeout", didWork: true }`.

**Ordering caveat — writeBack vs. the `"idle"` event.** Step 4 (`runner.onAgentFinished()`) emits the runner's `"idle"` event, which routes to `autoConflictResolveManager.onRunnerIdle(sessionId)`. At that instant the manager's `state.status` is still `"running"` because the wrapper's promise hasn't resolved yet, so `onRunnerIdle` step 1 returns early (it requires `status === "deferred"`) — a no-op for this event, which is what we want. The wrapper then resolves and `writeBack` flips status to `idle` (or `exhausted`) with a fresh `nextEligibleAt`. Cooldown-driven retry runs through `handleTransition` step 10 on a later poll, NOT through `onRunnerIdle`, so the in-flight ordering doesn't matter for retry correctness.

**Inter-iteration `"idle"` events.** Even in the *normal* (non-timeout) completion path, `runRebaseResolutionTurn`'s `agent.on("done")` handler already calls `runner.onAgentFinished()`, which emits `"idle"` while the outer `runRebaseFlow` is still mid-flow (it may still need to run another conflict iteration, then `tryForcePush`). That `"idle"` event routes to `onRunnerIdle` with `state.status === "running"`, so step 1 returns early — a no-op, which is correct. The implication: for a multi-iteration rebase, the runner emits `"idle"` BETWEEN iterations while the manager still considers the attempt running. `"idle"` is not a single "the auto-resolve attempt has settled" signal — it's "the runner is currently between agent turns" — and the manager's `status === "running"` gate is what disambiguates.

**User message queued during the resolve turn.** The `"idle"` predicate is `!_isRunning && _messageQueue.length === 0` (`session-runner.ts`). If a user types a message while the auto-resolve's agent turn is mid-flight, the message lands in the runner's queue; when the resolve turn finishes, `onAgentFinished()` sees the queue is non-empty and does NOT emit `"idle"`. The drain must happen after the full auto-resolve attempt settles, not from `runRebaseResolutionTurn`'s `done` handler: the outer `runRebaseFlow` still has to `stageAll()`, `rebaseContinue()`, possibly run more conflict iterations, and force-push. Draining between the resolution agent exit and `rebaseContinue()` starts a normal user turn while git is still mid-rebase, which can hide the agent response and invite post-turn commit/push races. The production wiring therefore passes a `drainQueueForSession` callback into the auto-resolve wrapper and `runAutoResolveAttempt` calls it only after the race against the timeout has resolved and any rebase abort/complete work has happened. The drain starts the queued turn through `runner.dispatch()` and emits `queue_updated` first so the client clears queued UI before the system-dispatched turn echoes its `system_user_message`.


### Setting: `autoResolveConflicts`

Global user setting, parallels `autoCreatePr` and `liveSteering`:

- **Storage:** `credentialStore.getAutoResolveConflicts() / setAutoResolveConflicts()`. Persisted to the same JSON as the other global settings.
- **API:** Extend `services/settings.ts` `getGlobalSettings` + `saveGlobalSettings` to read/write `autoResolveConflicts`. Global settings ride the `/api/bootstrap` response on read; the mutation endpoint is `PUT /api/settings` in `api-routes-bootstrap.ts:58-77`. Both touchpoints need explicit edits — the route's `Body` type is a closed schema listing each field (`gitIdentity`, `systemPrompt`, `maxIdleContainers`, `agentSystemInstructionsEnabled`, `autoCreatePr`, `liveSteering`), and `saveGlobalSettings` takes each field as a positional parameter. Adding `autoResolveConflicts` requires extending the Body type, adding the positional parameter, and updating the client API call shape to send the new field. There's no shared serializer that picks it up "for free."
- **Default:** `false`. Conflict resolution force-pushes; we don't enable that by default.
- **Wiring into the manager:** The manager reads `credentialStore.getAutoResolveConflicts()` directly inside `handleTransition` and `onRunnerIdle` rather than mirroring the value into per-session state. The setting is a single global boolean with no per-session override (see "Per-session override" in Out of scope), so the per-session `enabled` field would just be a copy of the global with a propagation problem: `saveGlobalSettings` in `services/settings.ts` has no reference to `prStatusPoller` today, and threading one in would mean every settings update fanned out to every tracked session. Reading the global at decision time eliminates that propagation entirely — the moment the user toggles the setting, the next poll (or next idle event) sees the new value. Cost is one extra map lookup per poll per session; negligible.

  The manager constructor takes `() => credentialStore.getAutoResolveConflicts()` as an injected getter so unit tests can stub it without instantiating the credential store. If we later add per-session override, the override flag lives on the per-session state and `enabled` is computed as `override ?? global`.

### Client UI

Single new toggle in the Settings panel, in the same group as `Auto-create PR` and `Live steering`:

```
☐ Auto-resolve conflicts when the base branch moves
   Detects when the PR can no longer merge cleanly. When the agent isn't
   busy, runs a rebase and asks the agent to fix any conflicts. Force-pushes
   the result.
```

No card on the chat side beyond what doc 094 already renders. The user's first visual confirmation that auto-resolve happened is doc 094's existing "Rebasing onto main — N conflicts resolved" message group in the chat history. If the run *failed* — exhausted attempts, timeout, or `lastError` — emit a new lifecycle banner on the PR card:

> **Auto-resolve couldn't finish.** Last error: rebase timed out after 10 minutes. [Retry] [Open conflict files]

The retry button invokes `resetForUserActivity` via the HTTP route (see Implementation order step 9), which clears `attemptCount`, `nextEligibleAt`, `lastError` and sets `status = "idle"` (unless `running`). The retry route also fires `handleTransition` synchronously after the reset so the user doesn't wait up to 15s for the next poll — see step 9 for the latency-mitigation rationale. The "open conflict files" link uses the existing conflict file viewer from doc 094.

### Loop protection beyond the per-session counter

- **No per-repo concurrency cap.** Earlier drafts proposed serializing auto-resolve runs across sessions on the same repo to prevent "force-push thrashing." That risk is illusory: each session has its own feature branch, and `--force-with-lease` targets disjoint refs (`refs/heads/<session-branch>`). Two sessions resolving in parallel cannot stomp on each other's pushes. Per-session caps and the per-attempt agent-runtime ceiling are sufficient.
- **Cooldown after a failed attempt.** 5 minutes before the same session retries. Implemented as the `nextEligibleAt` timestamp on the state, checked at step 10 of `handleTransition` (and the equivalent gate path in `onRunnerIdle`). Cooldown-driven retry runs through `handleTransition` (the next poll after the cooldown expires sees the sticky conflict and re-fires), NOT through `onRunnerIdle`. The cap+cooldown design is what makes the "Retry" button work without needing to clear `lastKnownMergeable`.
- **Reset on user activity.** Reset `attemptCount` to 0, clear `nextEligibleAt`, clear `lastError`, and set `status = "idle"` (unless `running` — see `resetForUserActivity` semantics) when the user sends a chat message to the session — i.e., a turn originating from a WS-typed user input.

  The reset is wired at the **dispatch site** in `src/server/orchestrator/index.ts`, NOT inside `handleSendMessage` / `handleSendReviewMessage` / `handleAnswerQuestion` themselves. The reason: `handleSendMessage` is also called synthetically by the `init_preview_config` case in the WS dispatch switch (the `init_preview_config` case in `index.ts`), which constructs a hard-coded `send_message` payload to ask the agent to scaffold preview config — that's system-dispatched in spirit and must not reset the counter. Wiring at the dispatch site means only the three real user-input WS message types (`send_message`, `send_review_message`, `answer_question`) trigger the reset; the synthetic `init_preview_config` path bypasses it because it calls `handleSendMessage` directly rather than going through the case statement.

  Do NOT reset on system-dispatched turns. Two such paths exist: CI auto-fix (which uses `runner.dispatch(...)` from `app-lifecycle.ts:610`), and the auto-resolve's own resolution turn (which spawns the agent directly via `runner.setAgent(agent)` in `runRebaseResolutionTurn`, NOT through `runner.dispatch`). Neither flows through the WS dispatch switch, so wiring the reset there naturally excludes both — but be aware that the auto-resolve's resolution turn is structurally different from CI auto-fix and does not share the dispatch path. The criterion is "did this turn originate from a human keystroke in the chat input," not "is the agent active" and not "did it go through `runner.dispatch`."

  The reset is keyed on WS message *type* (the case statement in the dispatch switch), not on `handleSendMessage` *invocation*. If a future caller delivers user input through a different surface (e.g. an HTTP route), that caller must explicitly call `resetForUserActivity` itself — the reset doesn't auto-fire from inside the handler. Today `handleSendReviewMessage` (in `send-message.ts`) is a thin wrapper that directly calls `handleSendMessage`, but it has its own `send_review_message` case in the dispatch switch, so the reset fires once at the dispatch site — no double-fire.

  One additional non-WS path that DOES count as user activity and needs an explicit `resetForUserActivity` call: the user-driven rebase route `POST /api/sessions/:id/git/rebase` (the "Update branch" button from doc 094, in `api-routes-git.ts`). The user clicking that is an explicit intent to resolve conflicts; if the auto-resolve previously exhausted, the click should give it a fresh budget alongside the user-driven attempt. Add the reset call at the top of that route's handler.

  Two adjacent WS message types deliberately do NOT trigger the reset:
  - **`rewind_to_message`** — the user is reverting state, not driving forward. If they rewind past the commit that caused the conflict, the head SHA changes and `handleTransition` step 7 resets `attemptCount` anyway; if they rewind to somewhere else, an auto-resolve retry probably isn't what they want.
  - **`interrupt_agent`** — could be re-engagement or "stop doing this." Ambiguous; do not reset. The user can click Retry on the failure banner if they want a fresh budget.

  "Viewing the failure banner" does not reset the counter — the explicit retry button on the banner is the only other reset path. This is intentional: a passive page load shouldn't quietly re-arm a loop that just exhausted itself.

### WS messages

Two new server → client message types:

```typescript
interface WsAutoResolveStarted {
  type: "auto_resolve_started";
  sessionId: string;
  baseBranch: string;
  attempt: number;
}

interface WsAutoResolveResult {
  type: "auto_resolve_result";
  sessionId: string;
  outcome: "success" | "exhausted" | "deferred" | "error";
  /**
   * Attempt number this result corresponds to (1-indexed; matches the
   * `attempt` field on the earlier WsAutoResolveStarted). Carried on the
   * result envelope so each settle event is self-contained — the client
   * doesn't have to remember the last WsAutoResolveStarted and pair them,
   * which would be fragile across reconnects/replays.
   */
  attempt: number;
  /**
   * Only meaningful when outcome === "success". Mirrors the inner
   * WsRebaseComplete.forcePushed flag so the PR-card sub-banner can
   * optionally show "rebased locally, push deferred" without listening
   * to two separate channels. The inner WsRebaseComplete still fires
   * from runRebaseFlow regardless.
   */
  forcePushed?: boolean;
  lastError?: string;
}
```

The existing `rebase_started` / `rebase_conflicts` / `rebase_complete` / `rebase_aborted` events from doc 094 fire as a side effect of the underlying rebase service — we don't duplicate them. These two new envelopes carry information that doesn't fit on the inner rebase events: `attempt` (only meaningful in the retry-loop context), and the `exhausted` / `deferred` outcomes (which exist only in the auto path — a user-initiated rebase has no attempt counter).

**Considered and rejected alternative:** adding a `source: "user" | "auto"` discriminator to the existing `WsRebase*` envelopes and not introducing new types. That would minimize message-type surface but smear two distinct lifecycles across the same channel: the auto path has an outer attempt loop that wraps multiple inner rebase passes, and consumers (the PR-card sub-banner, the chat group, integration tests) need to distinguish "an auto attempt began" from "the rebase machinery emitted an event mid-attempt." Keeping the outer/inner separation in the type system is worth one extra message pair.

## Edge cases

- **PR was just merged.** A `current.mergeable === "conflicting"` + `current.prState === "merged"` race cannot reach `handleTransition`: the poller's GraphQL query filters to `states: [OPEN]`, and merged sessions short-circuit at `pr-status-poller.ts:533` (via the `mergedSessions` set) before `handleTransition` is called. No gate needed in the manager.
- **Session has no PR yet.** `mergeable` is undefined; trivially no transition.
- **Base branch isn't `main`.** Use `summary.baseBranch` from `PrStatusSummary` (`github-types.ts:249`), not a hardcoded `"main"`. `runRebaseFlow` already takes the base branch as a parameter.
- **PR is closed (not merged).** Same reachability story as the merged case — the GraphQL query filters to `states: [OPEN]`, so a `prState === "closed"` summary can't reach `handleTransition` via the normal poll. Closed-without-merge PRs are detected by `verifyMissingPr` (the REST verify) and added to `mergedSessions`, which short-circuits the next poll. The cleanup that needs to happen alongside that detection: call `autoConflictResolveManager.delete(sessionId)` from `verifyMissingPr`'s terminal-state branch (alongside `mergedSessions.add(sessionId)` at `pr-status-poller.ts:699`), so the manager's per-session state doesn't leak when a PR is closed or merged without an explicit `untrackSession`. Without this, the state is dormant-but-harmless (subsequent polls short-circuit before reaching the manager) but the map grows unbounded over the orchestrator's lifetime.

  `verifyMissingPr` also has a "stuck-merged recovery" branch (`pr-status-poller.ts:666-673`) that clears `mergedSessions` when an open PR is rediscovered after being wrongly promoted to merged. With the delete-on-merge wiring above, the per-session manager state was already discarded when the false-merge happened; after recovery the next conflict transition reinitializes from first-seen, which is intentional (no stale attempt-count or cooldown carries over). This is fine; just confirming the cleanup order is intentional rather than accidental.
- **Conflicts in `package-lock.json` only.** The agent's resolution prompt from doc 094 covers this — it just edits the file. No special-casing here. If we later want a lockfile fast-path (regenerate instead of resolving textually), it lives in doc 094, not here.
- **The auto-commit on session boot creates the conflict.** Possible but rare. The same loop applies; the agent will resolve its own auto-commit's conflict if the base diverged in the same region. The attempt counter caps the damage.
- **Force-push race with a parallel manual rebase.** `--force-with-lease` handles this (doc 094 already specifies it). On lease rejection, `tryForcePush` emits `git_push_rejected` and returns false; the wrapper sees `forcePushed: false` on an otherwise-successful rebase and reports `{ outcome: "success", forcePushed: false, didWork: true }`. The local branch is rebased but the push is held back. The user can either retry from the PR card (which goes through the user-driven rebase route) or push manually. Note: this differs from the no-auth case — there we pre-flight-skip the attempt entirely; here the agent did real work resolving conflicts and we just couldn't deliver the result, so the attempt counts.
- **Setting toggled off mid-run.** Currently-running attempts complete (we don't abort mid-rebase — interrupting a rebase mid-flight is worse than letting it finish). New attempts won't start. Because the manager reads `isGlobalEnabled()` at decision time rather than mirroring it into state, there is no per-session disable signal to thread or to clean up — the in-flight wrapper's `.then(writeBack)` runs to completion regardless of what `handleTransition` would do; `writeBack` writes the terminal status (idle / exhausted / error) as if the setting hadn't changed. The next `handleTransition` poll sees `isGlobalEnabled() === false` at step 4 and early-returns before reaching the state-machine logic, so no new attempt starts.

  However: writeBack also emits the `auto_resolve_result` envelope, so a user who toggled the setting off mid-run will still see the per-attempt envelope land — and if the attempt happened to hit `exhausted`, the failure banner appears on the PR card *after* they disabled the feature, which is confusing. To avoid this, `writeBack` checks `isGlobalEnabled()` at the start and SUPPRESSES the WS emit when false (but still writes the state). The state write matters because if the user re-enables the setting before the cooldown expires, the next poll should see the post-attempt state, not a stale one. Importantly, the *SSE snapshot* is also gated: `attachAutomationState` omits the `autoResolve` block when `isGlobalEnabled() === false`, so a disabled user does not see a lingering banner from the SSE snapshot either. Both channels are gated together — without the SSE-side gate, the WS suppression would be only half a fix (the banner would still appear via the snapshot on next reload).

- **Setting toggled off, then back on.** SSE `pr_status` broadcasts only fire on `prStatusEqual` mismatches (poll-detected summary changes). Toggling the setting off → on is not a poll event, so a session whose state has been gated out of the snapshot would not re-appear until the next genuine status change — which for a sticky-conflict session could be tens of minutes. To fix this, `saveGlobalSettings` (in `services/settings.ts`) detects when `autoResolveConflicts` flips from false → true and triggers a snapshot-broadcast pass: walk every session tracked by `prStatusPoller`, force-emit the current `pr_status` SSE so each session's snapshot is re-decorated with the now-ungated `autoResolve` block. The implementation just needs `prStatusPoller.broadcastAllSnapshots()` (a new public method) called from inside the settings-save handler. Sessions with no `autoResolve` state (no conflict ever seen) get an unchanged snapshot, which is harmless. (This is structurally simpler than `AutoFixManager.setEnabled` at `auto-fix-manager.ts:52-66`, which eagerly flips `status` to `idle` on disable-while-running — that pattern would race with our `writeBack`, since two writers would be competing for the same `state.status`. Letting `writeBack` win unconditionally avoids the race.)

- **Setting toggled off then back on (cooldown / exhaustion preserved).** Per-session state — including `attemptCount`, `nextEligibleAt`, `status === "exhausted"`, `lastError` — is preserved across toggle off → toggle on cycles. There is no manager-level hook on the setting change. This is intentional: toggling shouldn't be a cooldown bypass. If the user wants to clear an exhausted state or skip a cooldown after the auto-resolve hit its limit, the existing escape hatches are: (a) send a chat message to the session (`resetForUserActivity` resets everything), (b) click the explicit "Retry" button on the failure banner (calls a route that resets the per-session state), or (c) push a new commit to the branch (head SHA changes → step 5 resets attemptCount). Toggle-off-then-on is not on that list and shouldn't be.
- **Multiple browser tabs.** The manager lives on the orchestrator; per-WS-connection state is not involved. Tabs receive the same WS events from the runner's broadcast (per CLAUDE.md's "WebSocket lifecycle MUST NOT affect server behavior").
- **Orchestrator restart mid-attempt.** Manager state is in-memory only — on restart, every session resets to `{ attemptCount: 0, status: "idle" }`. The next poll's `handleTransition` will see CONFLICTING and re-fire from a clean slate, which is the right behavior. The git checkout may be left mid-rebase if the previous attempt was interrupted; the wrapper's `git.isRebaseInProgress()` pre-flight catches this and calls `rebaseAbort()` before retrying, so the restart-then-retry path lands cleanly. There is intentionally no state persistence — auto-resolve is a best-effort background path, not a durable workflow that needs to survive restart.
- **`verifyRunningState` lifecycle subtlety.** The container runner's `verifyRunningState()` itself emits the runner's `"idle"` event when it detects a stranded `running=true` and resets it (`container-session-runner.ts`). That means our `onRunnerIdle` subscriber can fire from two distinct origin points: the normal `onAgentFinished` post-turn path, AND a `verifyRunningState`-driven zombie reset. Both must produce the same downstream behavior — and they do: `onRunnerIdle` step 4 re-runs the same gate, which uses `verifyRunningState` again and now sees `running=false`, then fires the callback. The assumption that `"idle"` is a single semantic signal regardless of which path emitted it is load-bearing; if a future change ever introduces a third emit path with different semantics (e.g. an "idle" event that doesn't actually mean the queue is empty), this subscriber would need to disambiguate.

## Implementation order

1. **`AutoConflictResolveManager`** (`auto-conflict-resolve-manager.ts`) — pure bookkeeping, unit-test in isolation. Takes `isGlobalEnabled` and `getRunner` as injected getters.
2. **`runAutoResolveAttempt` wrapper** in `services/rebase-driver.ts` — sits next to `runRebaseFlow`, takes the full `RebaseDriverDeps` plus `timeoutMs` and `now`, and adds the wall-clock timeout (default 10 min) with the full runner-state teardown described in "Timeout teardown", the 409→`deferred` translation (with `didWork: false`), the pre-flight gates (dirty-tree via the new `git.isClean()` helper; stale-rebase via `git.isRebaseInProgress()` → abort+defer; **no-auth via `!githubAuthManager.authenticated` → defer**), and the `auto_resolve_started` / `auto_resolve_result` envelope via `runner.emitMessage`. The no-auth pre-flight is deliberately stricter than doc 094's user-driven path — see "No GitHub auth pre-flight" — because the auto-path will otherwise burn the agent-turn budget producing local rebases the remote never sees.
3. **Wire into `PrStatusPoller`** — instantiate the manager in the poller's constructor with `() => credentialStore.getAutoResolveConflicts()` as the global-enabled getter and `(id) => this.runnerRegistry?.get(id)` as the runner getter. Call `handleTransition` after the existing `autoFix.handleTransition`. Skip wiring when `runnerRegistry` is absent (the optional dep — the feature simply doesn't activate in test setups that omit it). Expose the manager as a public field on the poller so `app-lifecycle.ts` can pass `() => prStatusPoller.autoConflictResolveManager` as the `getAutoConflictResolveManager` lazy-getter into `runner-registry-factory.ts` (step 4). This mirrors the existing `prStatusPoller` lazy-resolution pattern used for `getPrStatusPoller`.
4. **Wire the runner-idle hook** — in `runner-registry-factory.ts`, extend the existing `onRunnerIdle: () => enforceIdleContainerLimit()` closure to compose a second call: `onRunnerIdle: (sessionId) => { enforceIdleContainerLimit(); getAutoConflictResolveManager?.()?.onRunnerIdle(sessionId); }`. The registry accepts a single callback (not a subscriber list), so composition has to happen in the closure body. The registry's `_onRunnerIdle` field is already typed `(sessionId: string) => void` (`session-runner.ts:633, 651`); the existing zero-arg closure just ignored its argument and satisfied the wider type, so the only change here is in the closure body — no registry-side type change. Surface-area edit required: `RunnerRegistryDeps` gains a new optional `getAutoConflictResolveManager?: () => AutoConflictResolveManager | undefined` field next to the existing `getPrStatusPoller` lazy-getter, and `index.ts` passes it. The codebase already uses the same lazy pattern for the poller itself (a `prStatusPollerRef` declared at `index.ts:~291`, populated after `createPrStatusPoller` returns, exposed as `getPrStatusPoller: () => prStatusPollerRef.ref ?? undefined`); the new `getAutoConflictResolveManager` chains off the same ref (`() => prStatusPollerRef.ref?.autoConflictResolveManager`) rather than adding a parallel ref. This is the single subscription point that covers all three turn-completion code paths (WS user, system-dispatched, rebase-driver's own turn) — no edits to `post-turn.ts` or `agent-execution.ts` needed. Verify the exact `onRunnerIdle` site before editing — line numbers drift; grep for the symbol.
5. **Wire the user-activity reset** — in the WS dispatch switch in `src/server/orchestrator/index.ts`, call `prStatusPoller?.autoConflictResolveManager?.resetForUserActivity(sessionId)` inside the three case statements for `send_message`, `send_review_message`, and `answer_question` BEFORE delegating to the handler. Access via `prStatusPoller.autoConflictResolveManager` (a public field on the poller — see step 3) rather than threading the manager through `AppCtx`. Both optional-chains are needed: `prStatusPoller` is itself injectable via `deps.prStatusPoller` in `app-lifecycle.ts:595` (some test setups omit it), and the inner `autoConflictResolveManager` is only present when the poller had a `runnerRegistry` at construction time. Wiring at the dispatch site (rather than inside the handlers) avoids resetting when `handleSendMessage` is invoked synthetically from the `init_preview_config` case in `index.ts`. Do NOT add this to system-dispatched paths (see "Reset on user activity" for the precise classification).
6. **Construct the `RebaseAndResolveCb`** in `app-lifecycle.ts` alongside the existing `fetchAndFixCb` construction (~line 601). Signature: `(sessionId, baseBranch) => Promise<AutoResolveResult>`. The closure looks up the per-session runner via `runnerRegistry.get(sessionId)`, constructs `RebaseDriverDeps` per call (using captured shared managers + per-session runner/git), and invokes `runAutoResolveAttempt`. Inject the callback into the manager via `setRebaseAndResolveCb`. Mirrors how `fetchAndFixCb` resolves its runner per-call.
7. **Global setting** — extend `credentialStore` with `getAutoResolveConflicts()` / `setAutoResolveConflicts()` (mirrors the `getAutoCreatePr` / `setAutoCreatePr` pair at `credential-store.ts:342-349`; both use `?? false` on read so the boolean is never `undefined` to consumers — `isGlobalEnabled()` doesn't need to handle three states); add an optional `autoResolveConflicts?: boolean` field to the `CredentialData` JSON shape. Extend `services/settings.ts` `getGlobalSettings` / `saveGlobalSettings` to read/write `autoResolveConflicts`; **add `autoResolveConflicts: boolean` to the `GlobalSettings` type in `services/types.ts`** (the source-of-truth type the serializer returns); **refactor `saveGlobalSettings` from 11 positional parameters to an options object** as part of this PR (see Key files row for `api-routes-bootstrap.ts`); extend the `PUT /api/settings` route's `Body` type and its `saveGlobalSettings` call in `api-routes-bootstrap.ts:58-77`; extend the client API call shape and `settings-store.ts` for the boolean. **No fan-out into the poller** — the manager reads the global at decision time. **Client-side fan-out:** there is no SSE broadcast for settings changes (same as `autoCreatePr` and `liveSteering` today); the new field reaches other tabs only on the next `/api/bootstrap` load or `PUT /api/settings` round-trip from that tab. Accept this — matching the existing pattern is more important than adding a one-off broadcast.
8. **Settings UI** — single checkbox in the existing Settings panel.
9. **Failure banner on PR card** — render the banner ONLY for `outcome: "exhausted"` (not per-attempt `"error"`). Mid-loop errors are transient and arrive between retries; the user has nothing useful to do with them, and flashing the banner up and down on every retry is noise. Only the terminal `"exhausted"` outcome is actionable — the manager has stopped retrying, the conflict still stands, the user has to intervene. Render `lastError` from the exhausted envelope in the banner copy. The Retry button hits a new `POST /api/sessions/:id/auto-resolve/retry` HTTP route in `api-routes-git.ts` (the natural neighbor of the existing `POST /api/sessions/:id/git/rebase` user-driven rebase route, which this retry mirrors). The route does two things synchronously: (1) call `autoConflictResolveManager.resetForUserActivity(sessionId)` — clears `attemptCount`, `nextEligibleAt`, `lastError`; sets `status = "idle"` unless `running`; (2) immediately fire `handleTransition` with the latest cached `mergeable` value (looked up from `lastKnownMergeable`), so the next attempt starts within the request rather than waiting up to 15s for the next poll. Without (2), the user clicks Retry and stares at a stale banner for a poll interval. If `status === "running"` at the time, the route returns 409 with `{ error: "auto-resolve already in flight" }` and the client banner ignores the click. The cap+cooldown design (not the edge-detection design) is what gates retries — after the immediate `handleTransition` call: step 9 sees `attemptCount = 0`, step 10 sees no cooldown, step 11 passes (runner idle), step 12 fires.
10. **Tests** — see below.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/auto-conflict-resolve-manager.ts` | New manager (shape parallels `auto-fix-manager.ts`, but reads global setting at decision time rather than mirroring it into per-session state) |
| `src/server/orchestrator/pr-status-poller.ts` | Instantiate manager in constructor and expose as public field `autoConflictResolveManager`; call `handleTransition` after `autoFix.handleTransition`; call manager's `delete(sessionId)` from both `untrackSession` AND `verifyMissingPr`'s terminal-state branch (where `mergedSessions.add(sessionId)` happens), so per-session state doesn't leak when a PR merges or closes without an explicit untrack |
| `src/server/orchestrator/services/rebase-driver.ts` | New `runAutoResolveAttempt(deps, baseBranch)` wrapper around the existing `runRebaseFlow` (configurable timeout with full runner-state teardown, 409→deferred translation with `didWork: false`, dirty-tree / stale-rebase / no-auth pre-flights, `auto_resolve_*` envelope) |
| `src/server/shared/git.ts` | New public helper `GitManager.isClean()` (or `isDirty()`) — wraps `this.git.status()` and returns the boolean. SimpleGit's `status()` is itself public; what's private is `GitManager.git` (the SimpleGit field), so external callers can't reach it. The new helper exposes a public surface for the dirty-tree pre-flight. |
| `src/server/orchestrator/runner-registry-factory.ts` | Extend the existing `onRunnerIdle` callback (~line 186) to also call `autoConflictResolveManager.onRunnerIdle(sessionId)` |
| `src/server/orchestrator/app-lifecycle.ts` | Construct pre-bound `RebaseAndResolveCb` alongside the existing `fetchAndFixCb` (~line 601); inject into manager |
| `src/server/orchestrator/credential-store.ts` | `getAutoResolveConflicts()` / `setAutoResolveConflicts()` |
| `src/server/orchestrator/services/settings.ts` | Read/write `autoResolveConflicts` in `getGlobalSettings` / `saveGlobalSettings` (no fan-out into poller — manager reads global at decision time) |
| `src/server/orchestrator/api-routes-bootstrap.ts` | Extend `PUT /api/settings` `Body` type and `saveGlobalSettings` call with `autoResolveConflicts`. **Required as part of this PR:** refactor `saveGlobalSettings` from its 11-positional-parameter signature to an options object. Adding `autoResolveConflicts` as the 12th positional is a smell the next reader will trip on — and the next setting added after this one will face the same friction. The refactor touches `services/settings.ts` (signature change) and `api-routes-bootstrap.ts` (call site). |
| `src/server/orchestrator/api-routes-git.ts` | New `POST /api/sessions/:id/auto-resolve/retry` route (neighbor of the existing user-driven rebase route); also call `autoConflictResolveManager.resetForUserActivity(sessionId)` at the top of the existing `POST /api/sessions/:id/git/rebase` route since a user-driven rebase counts as user activity |
| `src/server/orchestrator/services/types.ts` | Add `autoResolveConflicts: boolean` to settings type |
| `src/server/shared/types/github-types.ts` | Add `autoResolve?: { status, attemptCount, lastError?, nextEligibleAt? }` to `PrStatusSummary` so the SSE snapshot carries the manager state |
| `src/server/orchestrator/pr-status-poller.ts` (already in table) | Extend `attachAutomationState` (~line 395) to populate the new `autoResolve` block from `autoConflictResolveManager.get(sessionId)` |
| `src/server/orchestrator/index.ts` | Call `autoConflictResolveManager.resetForUserActivity(sessionId)` in the WS dispatch switch's `send_message` / `send_review_message` / `answer_question` cases (NOT inside the handlers themselves; NOT from `runner.dispatch` paths) |
| `src/server/shared/types/ws-server-messages.ts` | `WsAutoResolveStarted`, `WsAutoResolveResult` |
| `src/client/stores/settings-store.ts` | `autoResolveConflicts` + setter |
| `src/client/components/SettingsPanel.tsx` | New toggle row |
| `src/client/components/PrLifecycleCard.tsx` | Failure sub-banner with retry |
| `src/server/orchestrator/auto-conflict-resolve-manager.test.ts` | Unit tests for the state machine |
| `src/server/orchestrator/integration_tests/auto-resolve-conflicts.test.ts` | Integration tests (below) |

### Follow-up fix: per-spawn run-token guards the resolution turn's event stream

The rebase resolution turn reuses the runner's single `_agent` slot: the flow
kills the resident streaming process and spawns a fresh resolution agent into
the same slot. In prod this stranded the resolution turn's entire event stream
— rebase + force-push succeeded, but the agent's reply never reached chat.

Root cause: the killed resident process's late `agent_done` (code 143, SIGTERM)
arrived over SSE *after* the new proxy occupied the slot. The SSE relay
(`container-session-runner.ts` `handleSSEEvent`) blindly emitted that `done`
onto the live agent, whose object-identity-guarded done handler PASSED (it *was*
the current agent) and nulled `_agent` — so every subsequent event hit the
`(no _agent)` sse-drop branch. Object identity can't disambiguate spawns across
the SSE boundary, and `agentId` is the agent *type* (reused across turns), so
neither could catch it.

Fix — a per-SPAWN correlation token (`runToken`, a run epoch distinct from
`agentId`):

| File | Change |
|---|---|
| `src/server/orchestrator/proxy-agent-process.ts` | `ProxyAgentProcess.runToken` (a `randomUUID()` per spawn); passed to `_startAgentViaProxy` so the worker learns it on `/agent/start` |
| `src/server/session/session-worker.ts` | `/agent/start` reads `runToken`; `wireAgentEvents(agent, runToken)` captures it and stamps it onto `agent_done` / `agent_error` / `agent_auth_required` broadcasts |
| `src/server/orchestrator/container-session-runner.ts` | `isStaleSpawnEvent()` — the relay ignores a slot-ending event whose token ≠ the token of the proxy currently in the slot (logs the same `[sse-drop:…]` line). Threads `runToken` through `_startAgentViaProxy` / `_doStartAgentViaProxy` / `startAgentOnWorker` |
| `src/server/orchestrator/integration_tests/container-agent-wiring.test.ts` | Regression test: a stale `agent_done` (code 143) from a reused/killed spawn arriving after the new proxy takes the slot is ignored; the new turn's `agent_init`/`agent_assistant`/`agent_result` are delivered, and the new agent's own matching-token `done` still finalizes the turn |

Backward/forward compatible: a slot event with no `runToken` (legacy worker) or
against a proxy without one falls back to the existing object-identity guards
and the `verifyRunningState` safety net, preserving the "missed `agent_done`"
SSE-drop resilience.

## Tests

### Unit tests (`auto-conflict-resolve-manager.test.ts`)

Tests inject a fake clock (`now()`), a fake `isGlobalEnabled()`, a fake `getRunner()`, and a recording `rebaseAndResolveCb` so the state machine runs deterministically.

1. First conflicting poll with `isGlobalEnabled()` true and agent idle → callback fires once with `(sessionId, baseBranch)`.
2. While `status === "running"` (attempt in flight, no `writeBack` yet), additional `conflicting` polls do NOT re-fire — step 5 short-circuits.
3. Agent running (or no runner) → state = `deferred`, callback does NOT fire. `verifyRunningState()` is invoked in the agent-running branch.
4. From step 3's `deferred` state: `onRunnerIdle` fires while `lastKnownMergeable === "conflicting"` → callback fires.
5. From step 3's `deferred` state: `onRunnerIdle` fires after the conflict resolved on its own (`lastKnownMergeable === "mergeable"`) → status flips to `idle`, callback does NOT fire.
6. `mergeable: "unknown"` poll between two `conflicting` polls → cache is untouched on the UNKNOWN poll, manager does nothing on it. Callback fires only on the conflicting polls (subject to other gates).
7. `attemptCount` resets when head SHA changes (step 7).
8. `writeBack` with `{ outcome: "error", didWork: true }` three times in a row (each separated by an advance past `AUTO_RESOLVE_COOLDOWN_MS`) → state hits `MAX_AUTO_RESOLVE_ATTEMPTS`, `status = "exhausted"`; subsequent `conflicting` transitions do NOT fire (step 6 short-circuits).
9. Cooldown: `writeBack` error → second conflicting poll within `AUTO_RESOLVE_COOLDOWN_MS` does NOT fire (step 10); poll after the cooldown expires DOES fire — without any edge transition, just on the sticky conflict.
10. Global setting flipped off while `status="running"` → in-flight `writeBack` runs (it's outside the `handleTransition` gate entirely — the wrapper's `.then(writeBack)` is what carries the attempt to completion, NOT any step inside `handleTransition`). Subsequent polls early-return at step 4 (`isGlobalEnabled()` check). The step-4 ordering matters: it gates before step 5 (`status === "running"`), so even a disabled-mid-run poll doesn't reach the running short-circuit — it short-circuits earlier. No new attempts start.
11. `resetForUserActivity` hook → `attemptCount` reset, `nextEligibleAt` cleared, `lastError` cleared, status returns to idle (unless `running`). Next poll fires immediately (no cooldown, no cap).
12. `delete(sessionId)` (called from `untrackSession` or CLOSED PR) → both `states` and `lastKnownMergeable` cleared for that session; later transitions for the same id behave as first-seen.
13. `writeBack` with `{ outcome: "deferred", didWork: false }` → `attemptCount` unchanged; status set to `deferred`. Covers both the 409 race and the `up_to_date` race.
14. `writeBack` with `{ outcome: "success", forcePushed: false, didWork: true }` → `attemptCount++`, `status = "idle"`, no cooldown set, emits `auto_resolve_result { outcome: "success", forcePushed: false, attempt }`.
15. `writeBack` with `{ outcome: "error", lastError: "X", didWork: true }` and `attemptCount` already at MAX-1 → manager increments to MAX, status becomes `exhausted` (not `idle`), no cooldown set (exhaustion supersedes cooldown), emits `auto_resolve_result { outcome: "exhausted", lastError: "X", attempt: MAX }`. The exhausted envelope carries `lastError` — the failure banner needs it.
16. `lastKnownMergeable` is cached while disabled: with `isGlobalEnabled() = false`, call `handleTransition` with `mergeable=CONFLICTING` → state is otherwise untouched but `lastKnownMergeable.get(sessionId) === "conflicting"`. Enable the setting; next `handleTransition` with `mergeable=CONFLICTING` → callback fires (no edge filtering anymore; cap+cooldown gates are what protect, both clean here). This is the first-enable correctness test — confirms the cache is populated while disabled so the post-enable poll sees accurate state, and that no spurious retry happens because of stale state.
17. Toggle off then back on while `nextEligibleAt` is set → state preserved across the toggle; transitions within the cooldown still short-circuit.
18. Cache snapshot ordering: with `prevKnown === "mergeable"` and an incoming `mergeable=CONFLICTING` poll, step 2 reads `prevKnown` into a local before step 3 writes the cache — confirms the cache write doesn't clobber the snapshot used by later logic. (Mostly a regression test against the algorithm bug an earlier draft had.)

### Integration tests (`auto-resolve-conflicts.test.ts`)

Tests override `timeoutMs` to a short value (e.g., 1000ms) so the timeout path is observable within vitest's normal cap.

1. Setup: session with PR, fake GitHub returns `mergeable=MERGEABLE`. Settings: `autoResolveConflicts=true`. Then flip to `mergeable=CONFLICTING` → assert: `auto_resolve_started` WS event, doc 094's `rebase_started` fires, agent receives the conflict prompt, after agent "resolves" the test fixture's conflicts the force-push call is observed, `auto_resolve_result { outcome: "success", forcePushed: true }` fires.
2. Setting off → flip to `CONFLICTING` → no rebase invocation.
3. Agent busy when conflict detected → no rebase. Agent finishes (runner emits `"idle"`) → manager re-evaluates and triggers rebase.
4. Three failed attempts in a row → fourth conflict transition does NOT trigger; client receives `auto_resolve_result { outcome: "exhausted" }`.
5. Hard timeout (override `timeoutMs` to ~1s): stub the agent to never finish → after the timeout, all six teardown steps observed (agent killed, `setAgent(null)`, `running=false`, `onAgentFinished()` emitted `"idle"`, `rebaseAbort()` called, `rebase_aborted` emitted); outcome = "error", `lastError = "timeout"`; `rebaseAndResolveCb` was invoked **exactly once** despite the synchronous re-entry via the teardown's `"idle"` emit (the early-return in `onRunnerIdle` step 1 protects against re-fire because `state.status === "running"` at that instant — this assertion guards against future ordering changes silently breaking the no-op); a user-typed message immediately afterward succeeds (confirming the cooldown blocks auto-attempts but never blocks user input).
6. No GitHub auth → flip to `CONFLICTING` → wrapper short-circuits at the no-auth pre-flight; `auto_resolve_result { outcome: "deferred", lastError: "no_github_auth" }`; agent is NOT spawned; `attemptCount` stays at 0 (no budget burn). After auth is set up, next poll fires normally.
7. Force-push lease rejected by remote → `git_push_rejected` emitted from the inner rebase, `auto_resolve_result { outcome: "success", forcePushed: false }` — no `lastError`, no cooldown special-case. The wrapper has no structured lease signal; see "Lease failure on force push."
8. `up_to_date` race: stub git so `isAncestor(baseRef, "HEAD")` returns true (i.e., base is ancestor of HEAD) even though GitHub claims CONFLICTING → wrapper returns `{ outcome: "deferred", didWork: false }`, `attemptCount` stays at 0, three more polls in a row stay at 0 (confirming the race doesn't exhaust the budget).
9. Two sessions on the same repo both flip to conflicting → both run in parallel; force-pushes target disjoint refs (`refs/heads/<session-A-branch>` and `refs/heads/<session-B-branch>`), neither rejects.

## Out of scope

- **Per-session override of the global setting.** Manager state already supports it; UI is deferred until users ask.
- **Auto-resolve for `pull-request` merges into non-default branches.** Use the PR's actual base; we don't try to be clever about anything else.
- **Pre-empting the conflict by rebasing before main moves.** That's doc 145 (`proactive-git-prefetch`); this doc only reacts to detected conflicts.
- **Auto-resolve for sessions with no open PR.** A session with a pushed branch and no PR isn't visible to the poller; if/when that matters, we add a separate diverged-branch poll. Not now.
