---
status: planned
priority: high
description: Extract a single graduateSession() service so warm-graduation (send_message) and quick-session creation (POST /api/sessions/headless) stop drifting.
---

# Unify warm-graduation across send_message and quick sessions

## Goal

Make the warm → active session transition a single function (`graduateSession()`)
that both the per-session WebSocket `send_message` handler and the
`POST /api/sessions/headless` HTTP route call. After this change there is one
code path that owns "what it means to graduate a warm session," and any future
surface (CLI shim, scheduled-agent endpoint, future quick-session variants)
plugs into the same function instead of re-implementing parts of it.

## Why this matters

The previous fix (docs/145 + the immediate-prior PR) extracted
`scheduleSessionNaming` because quick sessions weren't getting AI-generated
titles or `shipit/<slug>-<random>` branches. While doing that, it became clear
that **naming was only the most visible piece of a larger drift**. Side-by-side,
the two flows do most of the same work, but each one is hand-written and
the quick-session side silently omits steps:

| Step | `ws-handlers/send-message.ts` (warm graduation) | `services/headless-sessions.ts` (quick session) |
| --- | --- | --- |
| `sessionManager.setWarm(id, false)` | ✅ | ✅ |
| `sessionManager.track(id)` (refresh `last_used_at`) | ✅ | ❌ missing |
| Placeholder `rename(id, slice)` | ✅ | ✅ |
| `scheduleSessionNaming(...)` | ✅ | ✅ (post-fix) |
| `sseBroadcast("session_list", ...)` | ✅ (inline) | ✅ (at route layer) |
| `repoStore.touch(remoteUrl)` | ✅ | ❌ missing |
| `warmSessionForRepo(remoteUrl)` (re-warm pool) | ✅ | ✅ (via `claim-session.ts` rewarmPool) |
| `setBranch(id, ...)` | ❌ (warm pool already set it) | ✅ (caller can override) |

The two real bugs this exposes:

- **`repoStore.touch()` is never called for quick-session repos.** The
  "most recently used" repo ordering in the sidebar misses any repo the user
  only interacts with through quick capture. Today this is mostly invisible
  because quick-capture defaults to a recently-used repo, but it's a real
  ordering bug if the user picks a less-recent repo from the overlay.
- **`sessionManager.track()` is skipped for quick sessions.** The claim
  service does call `markStarted()`, which refreshes `last_used_at`, so the
  practical impact is small — but it's another quiet asymmetry that depends
  on a coincidence (two different update sites) rather than one shared
  contract.

The reason these gaps exist isn't carelessness; it's that the two flows were
hand-written in different files at different times. Every time we add another
warm-graduation side-effect (a new SSE event, a new metric, a new
provisioning step), there are two places that could drift. The structural
fix is to make graduation a single function so the next side-effect lands in
one place and both surfaces inherit it for free.

## Why the route handlers still can't be the same

The boundary between the two surfaces is load-bearing for three reasons, and
this plan does *not* try to erase it:

1. **Transport.** Normal sessions use the per-session WebSocket the user
   already has open. Quick sessions are sent from any view to a session that
   does not yet exist and that the user is not viewing — there is no WS to
   send through, so the request shape has to be HTTP request/response.
2. **Session lookup vs. creation.** `send_message` takes an existing
   `sessionId` (warm-pool-created or earlier-claimed). The quick path
   *creates* the session by calling `claimSessionService.claim(repoUrl)` as
   part of the request.
3. **Activation.** `send_message` implies "the session you are viewing" and
   calls `activateSession(...)`. Quick capture is the opposite by design:
   the user stays where they are; the new session runs in the background.
   Merging the handlers would require a `dontActivate` flag the WS handler
   currently has no concept of.

So this plan unifies **everything downstream of "we have a session id and a
prompt to dispatch"**, not the route boundary itself. The two surfaces stay
separate; the body of warm-graduation moves into one shared function.

## Design

### One new service: `graduateSession()`

Location: `src/server/orchestrator/services/graduate-session.ts` (new file).

```ts
export interface GraduateSessionDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  prStatusPoller: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
  warmSessionForRepo?: (repoUrl: string) => Promise<void>;
}

export interface GraduateSessionOpts {
  sessionId: string;
  /** First-message text — drives placeholder title and AI naming. */
  userText: string;
  /** Effective agent id for the AI-naming CLI call. */
  agentId: AgentId;
  /**
   * Optional explicit title/branch supplied by the caller (quick-capture
   * power-user fields, CLI shim). When either is set, AI naming is skipped
   * and the explicit value becomes authoritative — same precedence as the
   * pre-existing behavior in `headless-sessions.ts`.
   */
  explicitTitle?: string;
  explicitBranch?: string;
}

export function graduateSession(deps, opts): void;
```

What it does, in order:

1. `sessionManager.setWarm(id, false)`
2. `sessionManager.track(id)` — refresh `last_used_at`
3. Set the placeholder title (`explicitTitle ?? userText.slice(0, 60) ?? "New session"`)
4. If neither `explicitTitle` nor `explicitBranch` is set and the session has
   a `workspaceDir`: kick off `scheduleSessionNaming(...)` (already extracted).
   Otherwise: `setBranchRenamed(id, true)` so the PR card progresses.
5. `repoStore.touch(remoteUrl)` if `remoteUrl` is set
6. `sseBroadcast("session_list", ...)`
7. `void warmSessionForRepo(remoteUrl)` if available and `remoteUrl` is set

Synchronous return. The async work (AI naming + the second warming) is
already fire-and-forget inside the steps it lives in.

### Call sites

**`ws-handlers/send-message.ts`** — replace the entire `if (session?.warm) { ... }`
block with a single `graduateSession(...)` call. Currently that block is
~30 lines covering steps 1–7 above.

**`services/headless-sessions.ts`** — after the claim + branch-on-disk rename +
agent provisioning + `runner.dispatch(...)`, call `graduateSession(...)` with
`explicitBranch` / `explicitTitle` set when the caller provided them. The
service stops calling `setWarm`, `setBranchRenamed`, and `scheduleSessionNaming`
directly. `setBranch(id, branchName)` stays here because it captures the
explicit branch from the request body before graduation runs (warm graduation
doesn't have an analog — the warm pool set the branch when it created the
session).

The route layer (`api-routes-session.ts`) stops needing to pass
`graduationDeps?` to `createHeadlessSession` — the deps are now wired through
the standard `ApiDeps` plumbing into `graduateSession`.

### What `scheduleSessionNaming` becomes

It stays a separate function — `graduateSession` calls it. The reason is
that AI naming is interesting on its own (testable, has its own three
finish paths) and the placeholder-title-only branch in `graduateSession`
doesn't want to drag the naming chain in. The new module
(`session-graduation.ts`) and the existing function move together into
`services/graduate-session.ts` as a co-located helper, since they no longer
have independent call sites. *(Implementation note: keep
`session-namer.ts` separate; only `session-graduation.ts` folds in.)*

### Existing types/exports to delete

- `HeadlessSessionGraduationDeps` interface (introduced by the prior fix)
  — replaced by `GraduateSessionDeps`.
- The optional `graduationDeps?` parameter on `createHeadlessSession`
  — gone; `graduateSession` is always called.

### Code-only behavior changes (intentional)

These were the bugs the existing drift was hiding. They get fixed *because*
the unified flow runs the full graduation, not because we added new code:

- Quick sessions now call `repoStore.touch(remoteUrl)` → repo ordering in the
  sidebar updates correctly when a user starts a quick session.
- Quick sessions now call `sessionManager.track(id)` → no observable effect
  in the common case (the claim path already updates `last_used_at` via
  `markStarted`), but it removes the dependency on a coincidence.

These are not "new features"; they're the steps the warm-graduation flow
already does. Quick sessions get them by inheriting the same code path.

## Files touched

- **New**: `src/server/orchestrator/services/graduate-session.ts`
- **New**: `src/server/orchestrator/services/graduate-session.test.ts`
- **Delete**: `src/server/orchestrator/session-graduation.ts` — folded into the
  new service module.
- **Delete**: `src/server/orchestrator/session-graduation.test.ts` — replaced by
  the new test file (assertions migrate verbatim).
- **Modify**: `src/server/orchestrator/ws-handlers/send-message.ts` — drop the
  inline warm-graduation block; call `graduateSession(...)` instead.
- **Modify**: `src/server/orchestrator/services/headless-sessions.ts` — drop
  the inline `setWarm` / `setBranchRenamed` / `scheduleSessionNaming` calls;
  call `graduateSession(...)` instead. Remove `HeadlessSessionGraduationDeps`
  and the `graduationDeps?` parameter.
- **Modify**: `src/server/orchestrator/api-routes-session.ts` — stop wiring
  `graduationDeps` into `createHeadlessSession`. Wire the full
  `GraduateSessionDeps` once at the call site (via `deps`).
- **Modify**: `src/server/orchestrator/services/index.ts` — re-export the new
  module; remove the headless-sessions re-export of the deleted interface.
- **Modify**: `src/server/orchestrator/services/headless-sessions.test.ts` —
  the two structural tests added by the previous PR (`defers branchRenamed`
  / `marks branchRenamed immediately`) get rewritten against the new
  unified flow: the assertions stay the same in spirit (synchronous vs.
  async `branchRenamed`) but the dependency-injection shape changes.

## Testing

Unit:

- **`graduate-session.test.ts`** — port the four `scheduleSessionNaming` tests
  (success, null name, throw, PR-already-exists), then add:
  - `marks setWarm(false)` and `track()` synchronously.
  - calls `repoStore.touch(remoteUrl)` when present, skips when remoteUrl is
    empty.
  - calls `warmSessionForRepo(remoteUrl)` (fire-and-forget) when wired.
  - broadcasts `session_list` over SSE.
  - explicitBranch supplied → no AI naming, `setBranchRenamed(true)`
    synchronous.
  - explicitTitle supplied → no AI naming, `setBranchRenamed(true)`
    synchronous.

- **`headless-sessions.test.ts`** — keep the two structural assertions from
  the previous PR (defer vs. immediate `branchRenamed`), retargeted at the
  new injection shape.

Integration:

- **`integration_tests/quick-capture-headless.test.ts`** — extend with an
  assertion that `repoStore.touch(remoteUrl)` ran (check the repo's
  `lastUsedAt` advanced past its pre-claim value). Confirms the fixed bug
  end-to-end without coupling to internals.
- **`integration_tests/warm-sessions.test.ts`** — existing assertions cover
  the warm-graduation path; should pass without modification (the unified
  flow is behavior-preserving for that surface).

Lint + typecheck must be clean. CI's full test suite runs after the PR is
opened.

## What this plan deliberately does NOT do

- **Does not merge the two route handlers.** They stay separate for the
  three structural reasons in the "Why the route handlers still can't be
  the same" section above.
- **Does not touch `claim-session.ts`.** Claim is upstream of graduation —
  it creates the session row and assigns the workspace. Graduation is a
  separate concern (warm → active). Keeping them as two services preserves
  the clean upstream/downstream boundary; merging them would entangle
  workspace provisioning with title/branch policy.
- **Does not touch `child-sessions.ts` / `session-fork-merge.ts`.** Both
  also call `setBranchRenamed(true)` and could in principle use the same
  shared function, but they take explicit title + branch from the caller
  by design (agent-spawn passes a title; fork passes a branch name), so
  they're effectively the "explicit" branch of `graduateSession`. Folding
  them into `graduateSession` is a reasonable follow-up but out of scope
  here — the goal is to close the warm-graduation ↔ quick-session drift
  specifically.
- **Does not change the WS-handler context interface.** No new fields on
  `AppCtx` / `ConnectionCtx` / `RunnerCtx`. `graduateSession`'s deps are
  things already on `AppCtx` (`sessionManager`, `repoStore`,
  `prStatusPoller`, `createGitManager`, `sseBroadcast`,
  `warmSessionForRepo`); the call site just spreads them inline.

## Risk + rollback

Risk surface is small: this is a pure refactor of code paths covered by
the existing warm-sessions + quick-capture-headless integration tests.
The two intentional fixes (`repoStore.touch` and `track` for quick
sessions) are both additive — they cannot break anything that worked
before; they only correct the cases where quick sessions silently skipped
the step.

Rollback is a single PR revert. No DB migration, no client change, no
deploy ordering.
