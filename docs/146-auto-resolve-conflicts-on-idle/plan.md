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

Piggyback on the existing per-repo poll (`pr-status-poller.ts`, 5s cadence). Inside `handleTransition`-style processing, after computing the new `PrStatusSummary`, look at `summary.mergeable`:

- If `prev?.mergeable !== "conflicting"` and `current.mergeable === "conflicting"`: this is the transition we care about. Hand off to the new `AutoConflictResolveManager`.
- All other transitions: no-op.

No new polling, no new API calls. The mergeable field is already in the GraphQL query (`pr-status-parser.ts:89`) and the rate-limit budget already absorbs it.

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

  constructor(
    private readonly onChange: (sessionId: string) => void,
    private readonly isAgentRunning: (sessionId: string) => boolean,
    private rebaseAndResolveCb?: RebaseAndResolveCb,
  ) {}

  setEnabled(sessionId: string, enabled: boolean): AutoConflictResolveState { ... }

  /** Called from PrStatusPoller after each poll's summary is built. */
  handleTransition(
    sessionId: string,
    current: PrStatusSummary,
    prev: PrStatusSummary | undefined,
    baseBranch: string,
    headSha: string,
    baseSha: string,
  ): void;
}
```

`handleTransition` logic:

1. State must be `enabled`. If not, drop.
2. If head SHA changed since last attempt → reset `attemptCount = 0`, `status = "idle"`.
3. If mergeable didn't transition from non-conflicting → conflicting, return. We only fire on the *edge*, not on every poll that sees a sticky conflict.
4. If `attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS` → `status = "exhausted"`, emit, return.
5. If `isAgentRunning(sessionId)` → set `status = "deferred"`, emit, return. The next poll after the agent finishes will see the same conflict and re-evaluate (without re-incrementing, because we never moved past step 5).
6. Otherwise → `status = "running"`, `attemptCount++`, fire `rebaseAndResolveCb(sessionId, baseBranch)` async.

The `deferred` state is the key idle-gate primitive. We don't queue or schedule anything — we just record "we wanted to fire but the agent was busy." The next poll naturally retries. This means an attempt counts only when we actually attempt; a long-running turn doesn't burn the budget.

### The rebase + resolve callback

The `rebaseAndResolveCb` reuses doc 094's `rebaseOntoBase()` service end-to-end. New service function in `services/git.ts`:

```typescript
/**
 * Drives the full rebase-then-resolve loop, including agent invocation for
 * conflict files and force-push on completion. Used by auto-conflict-resolve;
 * not exposed as an HTTP endpoint (the user-initiated path stays the existing
 * step-by-step endpoints from doc 094).
 *
 * Emits status WS events through the runner so the user sees what happened
 * when they return: rebase_started, rebase_conflicts (with agent message
 * group), rebase_complete, or rebase_aborted with reason.
 */
export async function rebaseAndResolveAuto(
  runner: SessionRunner,
  git: GitManager,
  githubAuth: GitHubAuthManager,
  baseBranch: string,
  agentFactory: AgentFactory,
): Promise<RebaseAutoResult>;
```

Implementation walks the same orchestrator-driven steps doc 094 spec'd: `fetch` → `rebase(baseRef)` → if conflicts, prompt the agent → on agent turn completion, `git add` + `rebaseContinue()` → loop until clean or aborted → `forcePush()`.

Key differences from the user-initiated path:

- **Quieter chat output.** The agent's resolution message group is the same compact summary doc 094 already produces; we don't add an extra "auto-resolve started" preamble. Less chatty when the user reopens.
- **Hard timeout.** 10-minute wall clock across the whole loop. On timeout: `rebaseAbort()`, set `status = "exhausted"`, emit a failure card. Prevents a stuck agent turn from holding state indefinitely.
- **Dirty tree check before starting.** If the working tree is dirty (uncommitted edits that aren't ours — shouldn't happen for an idle session, but defensive), skip with `lastError = "dirty_tree"`. We never stash silently on auto-paths.
- **GitHub auth check first.** No auth → set `lastError = "no_github_auth"`, no attempt counted (this isn't a resolvable failure). The card shows the auth prompt the user already knows from elsewhere.

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
- **Reset on user activity.** If the user sends a chat message to the session, reset `attemptCount` to 0. The user re-engaging with the session implies they're now driving; if they need auto-resolve again afterward, they get a fresh budget. Hook this in `send-message.ts` (or the post-turn handler — wherever we already know "the user just spoke").

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
- **Base branch isn't `main`.** Use `summary.baseRefName` from the GraphQL response, not a hardcoded `"main"`. Doc 094's `rebaseOntoBase` already takes the base branch as a parameter.
- **Conflicts in `package-lock.json` only.** The agent's resolution prompt from doc 094 covers this — it just edits the file. No special-casing here. If we later want a lockfile fast-path (regenerate instead of resolving textually), it lives in doc 094, not here.
- **The auto-commit on session boot creates the conflict.** Possible but rare. The same loop applies; the agent will resolve its own auto-commit's conflict if the base diverged in the same region. The attempt counter caps the damage.
- **Force-push race with a parallel manual rebase.** `--force-with-lease` handles this (doc 094 already specifies it). The auto-loop surfaces the lease failure as `lastError = "lease_failed"` and stops; no retries — the user clearly did something on the branch and we shouldn't fight them.
- **Setting toggled off mid-run.** Currently-running attempts complete (we don't abort mid-rebase — interrupting a rebase mid-flight is worse than letting it finish). New attempts won't start. The state map's `enabled` flag is checked at `handleTransition` entry only.
- **Multiple browser tabs.** The manager lives on the orchestrator; per-WS-connection state is not involved. Tabs receive the same WS events from the runner's broadcast (per CLAUDE.md's "WebSocket lifecycle MUST NOT affect server behavior").

## Implementation order

1. **`AutoConflictResolveManager`** (`auto-conflict-resolve-manager.ts`) — pure bookkeeping, unit-test in isolation.
2. **`rebaseAndResolveAuto` service** in `services/git.ts` — wraps doc 094's rebase + resolve loop with the timeout and emit envelope.
3. **Wire into `PrStatusPoller`** — instantiate manager in the poller's constructor, call `handleTransition` after the existing `autoFix.handleTransition`.
4. **Global setting** — extend `credentialStore`, `services/settings.ts`, and the client `settings-store.ts` for `autoResolveConflicts`.
5. **Settings UI** — single checkbox in the existing Settings panel.
6. **Failure banner on PR card** — render `auto_resolve_result` with `outcome: "exhausted" | "error"` as a PR-card sub-banner with retry.
7. **Tests** — see below.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/auto-conflict-resolve-manager.ts` | New manager (mirrors `auto-fix-manager.ts`) |
| `src/server/orchestrator/pr-status-poller.ts` | Instantiate manager; call `handleTransition` |
| `src/server/orchestrator/services/git.ts` | `rebaseAndResolveAuto()` — wraps the doc 094 loop with timeout + emit |
| `src/server/orchestrator/credential-store.ts` | `getAutoResolveConflicts()` / `setAutoResolveConflicts()` |
| `src/server/orchestrator/services/settings.ts` | Read/write `autoResolveConflicts` in get/update |
| `src/server/orchestrator/services/types.ts` | Add `autoResolveConflicts: boolean` to settings type |
| `src/server/orchestrator/ws-handlers/send-message.ts` | On user message, reset `attemptCount` |
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
3. Agent running → state = `deferred`, callback does NOT fire. Next poll with agent idle fires.
4. `attemptCount` resets when head SHA changes.
5. Hit `MAX_AUTO_RESOLVE_ATTEMPTS` → `status = "exhausted"`, no more fires.
6. Cooldown: failure → second transition within 5 min does NOT fire.
7. `setEnabled(false)` while `status="running"` → status unchanged (don't abort mid-run); future transitions don't fire.
8. User message hook → `attemptCount` reset, status returns to idle.

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
