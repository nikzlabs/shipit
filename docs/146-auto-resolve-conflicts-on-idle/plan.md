---
status: planned
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

The poller already knows mergeable state (`pr-status-parser.ts:155`, `:352-354`). The rebase + agent resolution loop already exists (doc 094). The auto-fix-on-CI-failure pattern already exists (`auto-fix-manager.ts`). This feature is just wiring those together with an idle gate and a setting — no new primitives.

This satisfies CLAUDE.md §1 ("ShipIt is the surface — the user does not leave it"): today the user has to either drive the rebase themselves inside ShipIt or, worse, bounce to GitHub's web UI to understand what's wrong. The auto-resolve path keeps the cycle entirely inside the product.

## Design

### Trigger: PR poller mergeable transition

Piggyback on the existing per-repo poll (`pr-status-poller.ts`, 15s cadence). Inside `handleTransition`-style processing, after computing the new `PrStatusSummary`, look at `summary.mergeable`:

- If `prev?.mergeable !== "conflicting"` and `current.mergeable === "conflicting"`: this is the transition we care about. Hand off to the new `AutoConflictResolveManager`.
- All other transitions: no-op.

No new polling, no new API calls. The mergeable field is already in the GraphQL query (`pr-status-parser.ts:89`) and the rate-limit budget already absorbs it.

**`mergeable === "unknown"` handling.** GitHub returns `UNKNOWN` while it's computing mergeability — common right after a push (`pr-status-parser.ts:352-355` maps it to `"unknown"`). If we naively edge-detect, a single sticky conflict will oscillate `conflicting → unknown → conflicting` and re-fire on every flop-back. The manager carries forward the **last non-unknown value** of `mergeable` per session and runs the edge test against *that*, not the raw `prev` summary. An `unknown` poll is treated as "no change" and never triggers, never resets.

### Manager: `AutoConflictResolveManager`

Mirrors `AutoFixManager` in shape so future readers map between them on sight. Lives in `src/server/orchestrator/auto-conflict-resolve-manager.ts`.

```typescript
export const MAX_AUTO_RESOLVE_ATTEMPTS = 3;

export type RebaseAndResolveCb = (
  sessionId: string,
  baseBranch: string,
) => Promise<void>;

export interface AutoConflictResolveState {
  enabled: boolean;            // mirrors the global setting; copied at session-track time
  attemptCount: number;        // resets when head SHA changes
  lastHeadSha: string;
  lastBaseSha: string;         // tracks base too — base moving is what creates the conflict
  status: "idle" | "running" | "exhausted" | "deferred";
  lastError?: string;          // non-conflict failures (network, auth, dirty tree) surface here
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
    private readonly getRunner: (sessionId: string) => SessionRunner | undefined,
    private rebaseAndResolveCb?: RebaseAndResolveCb,
  ) {}

  setEnabled(sessionId: string, enabled: boolean): AutoConflictResolveState;

  /** Called from PrStatusPoller after each poll's summary is built. */
  handleTransition(
    sessionId: string,
    current: PrStatusSummary,
    baseBranch: string,
    headSha: string,
  ): void;

  /**
   * Called when a session's agent turn ends. Lets a `deferred` state
   * re-evaluate without waiting for another mergeable transition (which
   * won't come — the conflict is sticky). See issue #5 in the design
   * review for why this hook is required.
   */
  onAgentTurnEnd(sessionId: string): void;
}
```

`handleTransition` logic:

1. State must be `enabled`. If not, drop.
2. If `current.mergeable === "unknown"`: do nothing, do not update `lastKnownMergeable`. Return.
3. Read `prevKnown = lastKnownMergeable.get(sessionId)`; then `lastKnownMergeable.set(sessionId, current.mergeable)`.
4. If head SHA changed since last attempt → reset `attemptCount = 0`, `status = "idle"`.
5. If `prevKnown === "conflicting"` (sticky) or `current.mergeable !== "conflicting"` → return. We only fire on the *edge* mergeable→conflicting.
6. If `attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS` → `status = "exhausted"`, emit, return.
7. If no runner for the session (`getRunner(sessionId) === undefined`) or `runner.running === true` → set `status = "deferred"`, emit, return. The next poll after the runner is up and idle, OR the `onAgentTurnEnd` hook, will re-evaluate.
8. Otherwise → `status = "running"`, `attemptCount++`, fire `rebaseAndResolveCb(sessionId, baseBranch)` async.

`onAgentTurnEnd(sessionId)`:

1. Read `state = states.get(sessionId)`. If not `enabled` or status is not `deferred`, return.
2. Read `mergeable = lastKnownMergeable.get(sessionId)`. If not `"conflicting"`, the conflict resolved itself — set `status = "idle"`, return.
3. Otherwise re-run the gate from step 6 of `handleTransition` (cap, runner, cooldown). On pass, fire the callback.

The `deferred` state is the key idle-gate primitive. We don't queue, schedule, or set timers — we record "we wanted to fire but the agent was busy" and rely on two re-evaluation triggers: the next poll *that sees an edge transition* (rare — usually the conflict is sticky) and the `onAgentTurnEnd` hook (the normal case). Attempts count only when we actually attempt; a long-running turn doesn't burn the budget.

### Runner availability

`PrStatusPoller` tracks any session with an open PR. There is no requirement that the session has a live container or runner — sessions get evicted by the idle enforcer, archived, or simply never activated since the last orchestrator restart. The poller talking to a session it can't drive is normal.

For auto-resolve, "no runner" is treated as identical to "agent running": go to `deferred`. We do **not** wake the container just to run an auto-resolve. Rationale:

- Spinning up a container costs Docker resources and counts against the idle cap. Auto-resolve is a background nicety, not worth burning a container slot for.
- The user's normal interaction path (clicking the session, sending a message, etc.) activates the runner. At that point `onAgentTurnEnd` (or the first poll cycle after activation) re-evaluates and fires the auto-resolve.
- Restricting to "runner already up" means auto-resolve only ever fires for sessions the user (or another foreground action) recently touched — exactly the population most likely to be looking at the PR.

This is documented in the `getRunner` injection contract above. The poller injects `(id) => this.runnerRegistry.get(id)`, which returns `undefined` for sessions without a live runner.

### The rebase + resolve callback

**Reuse `runRebaseFlow` from `src/server/orchestrator/services/rebase-driver.ts:81` end-to-end.** That function already implements every step described in doc 094: fetch → rebase → if conflicts, prompt the agent → stage → `rebaseContinue()` → loop → force push. It also already sets `runner.running = true/false` around the agent invocation (`rebase-driver.ts:230, 260, 273`) and throws `ServiceError(409)` if `runner.running` is already true at entry (`rebase-driver.ts:87-89`). We do not write a parallel implementation.

What we add is a thin wrapper, `runAutoResolveAttempt`, alongside `runRebaseFlow` in `services/rebase-driver.ts` (same module so it shares helpers):

```typescript
/**
 * Wraps `runRebaseFlow` for the auto-conflict-resolve path:
 *   - Adds a 10-minute wall-clock timeout. On timeout, calls
 *     `git.rebaseAbort()` and resolves with { outcome: "error", lastError:
 *     "timeout" }.
 *   - Translates a `ServiceError(409)` from runRebaseFlow's
 *     `runner.running` guard into { outcome: "deferred" } rather than
 *     bubbling. This is the TOCTOU backstop: the manager's gate may pass
 *     but the runner could have started a turn between the gate and the
 *     driver entry. Treat as deferred, not error — no attempt counted.
 *   - Maps other failures (dirty tree, no GitHub auth, lease failure,
 *     other ServiceErrors) to { outcome: "error", lastError: <reason> }.
 *   - Emits `auto_resolve_started` / `auto_resolve_result` envelopes via
 *     `runner.emitMessage` (NOT `ctx.send`). emitMessage broadcasts to
 *     every attached viewer and buffers into the turn-event log, so a
 *     viewer reconnecting after the auto-resolve completes still sees
 *     the result. This is the pattern CLAUDE.md's WS-lifecycle section
 *     requires for any state mutation that must outlive a single socket.
 *
 * Does NOT emit the inner `rebase_started` / `rebase_conflicts` /
 * `rebase_complete` events itself — those are emitted by runRebaseFlow
 * as a side effect, so the existing UI from doc 094 lights up exactly
 * as it would on a user-initiated rebase.
 */
export async function runAutoResolveAttempt(
  runner: SessionRunner,
  git: GitManager,
  githubAuth: GitHubAuthManager,
  baseBranch: string,
  agentFactory: AgentFactory,
): Promise<AutoResolveResult>;
```

Pre-flight gates (run before `runRebaseFlow` is invoked, so they don't burn an attempt):

- **GitHub auth check.** No auth → return `{ outcome: "error", lastError: "no_github_auth" }`. Not retried — the user needs to fix auth, and the existing auth prompt elsewhere in the UI surfaces that.
- **Dirty tree check.** `git.statusPorcelain()` non-empty → return `{ outcome: "error", lastError: "dirty_tree" }`. Defensive; shouldn't happen for an idle session, but we never stash silently on auto-paths.

After-the-fact handling:

- **Lease failure on force push.** `runRebaseFlow` will throw; we map to `lastError: "lease_failed"` and never retry — the user did something on the branch and we shouldn't fight them.
- **Quieter chat output.** No extra preamble. The user's first signal that auto-resolve ran is the existing doc 094 compact message group.

### Setting: `autoResolveConflicts`

Global user setting, parallels `autoCreatePr` and `liveSteering`:

- **Storage:** `credentialStore.getAutoResolveConflicts() / setAutoResolveConflicts()`. Persisted to the same JSON as the other global settings.
- **API:** Extend `services/settings.ts` `getSettings` + `updateSettings` to read/write `autoResolveConflicts`. Existing `GET /api/settings` + `POST /api/settings` already serialize/deserialize the whole settings object — no new endpoint needed.
- **Default:** `false`. Conflict resolution force-pushes; we don't enable that by default.
- **Wiring into the manager:** On session-track (`PrStatusPoller.track`), copy the current global value into the per-session state's `enabled` field. On `POST /api/settings` updates, the orchestrator walks every tracked session and updates `enabled` to match. Per-session opt-out is **not** offered in this iteration — the user said global was sufficient. If we later regret this, the manager state is already per-session and adding a per-session override is a UI change only.

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

The retry button just toggles `attemptCount` back to 0 and waits for the next poll to retry. The "open conflict files" link uses the existing conflict file viewer from doc 094.

### Loop protection beyond the per-session counter

- **Per-repo concurrency cap.** Only one auto-resolve run per repo at a time. If a second session on the same repo flips to conflicting while one is mid-loop, the second goes to `deferred` and retries on a later poll. Prevents two sessions thrashing on top of each other's force-pushes (rare but possible during cascading lands).
- **Cooldown after a failed attempt.** 5 minutes before the same session retries. Implemented as a `nextEligibleAt` timestamp on the state, checked at step 5 of `handleTransition`.
- **Reset on user activity.** If the user sends a chat message to the session, reset `attemptCount` to 0. The user re-engaging with the session implies they're now driving; if they need auto-resolve again afterward, they get a fresh budget. Hook this in `send-message.ts` (or the post-turn handler — wherever we already know "the user just spoke"). Note that "viewing the failure banner" does not reset the counter — the explicit retry button on the banner is the only other reset path. This is intentional: a passive page load shouldn't quietly re-arm a loop that just exhausted itself.

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
  lastError?: string;
}
```

The existing `rebase_started` / `rebase_conflicts` / `rebase_complete` / `rebase_aborted` events from doc 094 fire as a side effect of the underlying rebase service — we don't duplicate them. These two messages just wrap the auto-resolve outer envelope so the client can mark its UI state correctly.

## Edge cases

- **PR was just merged.** If `current.mergeable === "conflicting"` but `current.state === "MERGED"` (race), don't fire. The poller already drops merged sessions before this point (`mergedSessions` set in `pr-status-poller.ts`), so this falls out for free.
- **Session has no PR yet.** `mergeable` is undefined; trivially no transition.
- **Base branch isn't `main`.** Use `summary.baseBranch` from `PrStatusSummary` (`github-types.ts:249`), not a hardcoded `"main"`. `runRebaseFlow` already takes the base branch as a parameter.
- **PR is closed (not merged).** A closed-without-merge PR is not a merge candidate; don't auto-resolve. Gate at the same point we check `mergedSessions` — if `current.state === "CLOSED"`, drop the session from the manager's state map and return.
- **Conflicts in `package-lock.json` only.** The agent's resolution prompt from doc 094 covers this — it just edits the file. No special-casing here. If we later want a lockfile fast-path (regenerate instead of resolving textually), it lives in doc 094, not here.
- **The auto-commit on session boot creates the conflict.** Possible but rare. The same loop applies; the agent will resolve its own auto-commit's conflict if the base diverged in the same region. The attempt counter caps the damage.
- **Force-push race with a parallel manual rebase.** `--force-with-lease` handles this (doc 094 already specifies it). The auto-loop surfaces the lease failure as `lastError = "lease_failed"` and stops; no retries — the user clearly did something on the branch and we shouldn't fight them.
- **Setting toggled off mid-run.** Currently-running attempts complete (we don't abort mid-rebase — interrupting a rebase mid-flight is worse than letting it finish). New attempts won't start. The state map's `enabled` flag is checked at `handleTransition` entry only. When `setEnabled(false)` is called while `status === "running"`, the manager records `pendingDisable = true` on the state; the running attempt's completion handler reads that flag and flips `status` directly to `idle` (mirrors `AutoFixManager.setEnabled` in `auto-fix-manager.ts:59-61`). Without this, the status would remain stuck at `running` after the disable.
- **Multiple browser tabs.** The manager lives on the orchestrator; per-WS-connection state is not involved. Tabs receive the same WS events from the runner's broadcast (per CLAUDE.md's "WebSocket lifecycle MUST NOT affect server behavior").

## Implementation order

1. **`AutoConflictResolveManager`** (`auto-conflict-resolve-manager.ts`) — pure bookkeeping, unit-test in isolation.
2. **`runAutoResolveAttempt` wrapper** in `services/rebase-driver.ts` — sits next to `runRebaseFlow` and adds the 10-min timeout, the 409→`deferred` translation, the pre-flight gates (GitHub auth, dirty tree), and the `auto_resolve_started` / `auto_resolve_result` envelope via `runner.emitMessage`.
3. **Wire into `PrStatusPoller`** — instantiate manager in the poller's constructor, call `handleTransition` after the existing `autoFix.handleTransition`. Also wire `onAgentTurnEnd(sessionId)` into the post-turn flow (`ws-handlers/post-turn.ts` or `agent-execution.ts` "done" event) so a sticky-conflict + previously-deferred state re-evaluates the moment the agent finishes its current work, without waiting for an unlikely mergeable edge transition.
4. **Global setting** — extend `credentialStore`, `services/settings.ts`, and the client `settings-store.ts` for `autoResolveConflicts`.
5. **Settings UI** — single checkbox in the existing Settings panel.
6. **Failure banner on PR card** — render `auto_resolve_result` with `outcome: "exhausted" | "error"` as a PR-card sub-banner with retry.
7. **Tests** — see below.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/auto-conflict-resolve-manager.ts` | New manager (mirrors `auto-fix-manager.ts`) |
| `src/server/orchestrator/pr-status-poller.ts` | Instantiate manager; call `handleTransition` |
| `src/server/orchestrator/services/rebase-driver.ts` | New `runAutoResolveAttempt()` wrapper around the existing `runRebaseFlow` (timeout, 409→deferred translation, pre-flight gates, `auto_resolve_*` envelope) |
| `src/server/orchestrator/credential-store.ts` | `getAutoResolveConflicts()` / `setAutoResolveConflicts()` |
| `src/server/orchestrator/services/settings.ts` | Read/write `autoResolveConflicts` in get/update |
| `src/server/orchestrator/services/types.ts` | Add `autoResolveConflicts: boolean` to settings type |
| `src/server/orchestrator/ws-handlers/send-message.ts` | On user message, reset `attemptCount` |
| `src/server/orchestrator/ws-handlers/post-turn.ts` | Call `autoConflictResolve.onAgentTurnEnd(sessionId)` on agent turn completion |
| `src/shared/types/ws-server-messages.ts` | `WsAutoResolveStarted`, `WsAutoResolveResult` |
| `src/client/stores/settings-store.ts` | `autoResolveConflicts` + setter |
| `src/client/components/SettingsPanel.tsx` | New toggle row |
| `src/client/components/PrLifecycleCard.tsx` | Failure sub-banner with retry |
| `src/server/orchestrator/auto-conflict-resolve-manager.test.ts` | Unit tests for the state machine |
| `src/server/orchestrator/integration_tests/auto-resolve-conflicts.test.ts` | Integration tests (below) |

## Tests

### Unit tests (`auto-conflict-resolve-manager.test.ts`)

1. Transition non-conflicting → conflicting with `enabled=true`, agent idle → callback fires once.
2. Transition conflicting → conflicting (sticky) → callback does NOT re-fire.
3. Agent running (or no runner) → state = `deferred`, callback does NOT fire.
4. From step 3's `deferred` state: `onAgentTurnEnd` fires while `lastKnownMergeable === "conflicting"` → callback fires.
5. From step 3's `deferred` state: `onAgentTurnEnd` fires after the conflict resolved on its own (`lastKnownMergeable === "mergeable"`) → status flips to `idle`, callback does NOT fire.
6. `mergeable: "unknown"` poll between two `conflicting` polls → does NOT count as a new edge, callback fires only once.
7. `attemptCount` resets when head SHA changes.
8. Hit `MAX_AUTO_RESOLVE_ATTEMPTS` → `status = "exhausted"`, no more fires.
9. Cooldown: failure → second transition within 5 min does NOT fire.
10. `setEnabled(false)` while `status="running"` → `pendingDisable` recorded; completion flips status to `idle`. Future transitions don't fire.
11. User message hook → `attemptCount` reset, status returns to idle.
12. PR transitions to `state: "CLOSED"` (no merge) → manager drops the session's state entirely.

### Integration tests (`auto-resolve-conflicts.test.ts`)

1. Setup: session with PR, fake GitHub returns `mergeable=MERGEABLE`. Settings: `autoResolveConflicts=true`. Then flip to `mergeable=CONFLICTING` → assert: `auto_resolve_started` WS event, doc 094's `rebase_started` fires, agent receives the conflict prompt, after agent "resolves" the test fixture's conflicts the force-push call is observed, `auto_resolve_result { outcome: "success" }` fires.
2. Setting off → flip to `CONFLICTING` → no rebase invocation.
3. Agent busy when conflict detected → no rebase. Agent finishes → next poll cycle triggers rebase.
4. Three failed attempts in a row → fourth conflict transition does NOT trigger; client receives `auto_resolve_result { outcome: "exhausted" }`.
5. Hard timeout: stub the agent to never resolve → after 10 minutes, `rebaseAbort()` observed, outcome = "error", `lastError = "timeout"`.
6. Two sessions on same repo both flip to conflicting → one runs, the other is `deferred` until the first finishes.
7. Force-push lease fails → outcome = "error", `lastError = "lease_failed"`, no retry.

## Out of scope

- **Per-session override of the global setting.** Manager state already supports it; UI is deferred until users ask.
- **Auto-resolve for `pull-request` merges into non-default branches.** Use the PR's actual base; we don't try to be clever about anything else.
- **Pre-empting the conflict by rebasing before main moves.** That's doc 145 (`proactive-git-prefetch`); this doc only reacts to detected conflicts.
- **Auto-resolve for sessions with no open PR.** A session with a pushed branch and no PR isn't visible to the poller; if/when that matters, we add a separate diverged-branch poll. Not now.
