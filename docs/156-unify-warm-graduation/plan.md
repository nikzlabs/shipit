---
status: planned
priority: high
description: One graduateSession() service every session-creation path must end with — closes the warm/quick/child/fork drift that produced the missing-name bug.
---

# Unify session creation across every surface

## Goal

Make the warm → active transition a single function — `graduateSession()` —
that **every** session-creation surface in the orchestrator must call. After
this change there is exactly one place that knows what it means to "promote a
session row to user-visible active." Any future surface (CLI shim, scheduled
agents, IDE plugin, future quick-capture variants) plugs into the same
function instead of re-implementing parts of it.

The missing-name bug on quick sessions was the symptom; the disease is that
four different files each hand-write a subset of the same six steps and
silently drift apart.

## Why this matters

There are currently four creation surfaces in `src/server/orchestrator/`:

1. **Warm graduation** — `ws-handlers/send-message.ts`, on first
   `send_message` in a warm session.
2. **Quick session** — `services/headless-sessions.ts`, behind
   `POST /api/sessions/headless` (quick-capture overlay).
3. **Child session** — `services/child-sessions.ts`, behind
   `POST /api/sessions/:parentId/spawn` (agent-spawned via the
   `shipit session create` CLI shim).
4. **Fork session** — `services/session-fork-merge.ts`, behind
   `POST /api/sessions/:id/fork` (fork an existing session at a commit).

Side-by-side, each one is hand-written and skips a different subset of the
shared steps:

| Step | warm | quick | child | fork |
| --- | --- | --- | --- | --- |
| `setWarm(id, false)` | ✅ | ✅ | ✅ | n/a (track inserts as active) |
| `track(id)` — refresh `last_used_at` | ✅ | ❌ | ❌ | ✅ (insert) |
| placeholder `rename(id, slice)` | ✅ | ✅ | ✅ | ✅ |
| AI naming (`scheduleSessionNaming`) | ✅ | ✅ (post-fix) | ❌ | ❌ (intentional) |
| `setBranchRenamed(id, true)` | via finalizer | via finalizer / sync | ✅ sync | ✅ sync |
| `repoStore.touch(remoteUrl)` | ✅ | ❌ | ❌ | ❌ |
| `sseBroadcast("session_list", ...)` | ✅ inline | ✅ at route | ✅ at route | ✅ at WS handler |
| `warmSessionForRepo(remoteUrl)` | ✅ inline | ✅ via claim | ✅ via claim | ❌ (n/a — fork clones from session, not cache) |

That table is the bug class. Four real consequences live in the ❌ cells:

- **`repoStore.touch()`** runs only in warm-graduation, so the "most recently
  used repo" sidebar ordering is wrong for any repo the user only interacts
  with via quick-capture, spawn, or fork.
- **`sessionManager.track()`** runs in warm-graduation but not in quick/child.
  In the common case it's a no-op (the claim path already calls `markStarted`),
  but the symmetry depends on a coincidence between two unrelated files.
- **AI naming** runs for warm + quick but not for child. So child sessions
  show up in the sidebar with truncated prompt titles (`"Implement the user…"`)
  instead of human-readable ones (`"Wire OAuth callback URL"`) — the same UX
  problem the user just reported for quick sessions, latent in the child
  surface. Fork is excluded by design (it always has a user-chosen branch and
  a derived title).
- **`setBranchRenamed(true)`** runs synchronously in three of four paths,
  asynchronously (via the AI-naming finalizer) in the fourth. Two different
  ownership models for the same flag is exactly the kind of subtle divergence
  that breaks PR-lifecycle gating on the next refactor.

These gaps exist because the four flows were written in different files at
different times, and there is no shared contract that says "after you have a
session row and a workspace, you must call this." This plan introduces that
contract.

## Why the route handlers still can't be the same

The boundary between the four surfaces is load-bearing and this plan does
**not** try to erase it:

- **Transport.** Warm uses WebSocket. The others use HTTP — they're
  initiated from views where no WS to the new session can exist.
- **Workspace acquisition is different.** Warm reuses an existing
  warm-pool workspace. Quick + child claim from the warm pool. Fork
  `clone --local`s from the active session's worktree. Workspace prep
  must stay in each route's pre-graduate phase.
- **Activation semantics.** Warm activates the session (user is viewing
  it). Quick + child + fork explicitly do not (user stays where they are).
- **Parent linkage.** Child sets `parentSessionId` / `spawnedByTurn`; the
  others don't.

So this plan unifies **everything downstream of "I have a session id, a
workspace, and either a first prompt or an explicit title/branch"**, not the
route boundary itself.

## Design

### One new service: `graduateSession()`

Location: `src/server/orchestrator/services/graduate-session.ts` (new file).
Folds in the previous PR's `scheduleSessionNaming` as a private helper.

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
  /**
   * First-message text. Drives the placeholder title and the AI-naming
   * prompt. Pass `""` for surfaces that have no first message (fork) — AI
   * naming will still skip if `explicitTitle`/`explicitBranch` are set.
   */
  userText: string;
  /** Effective agent id for the AI-naming CLI call. */
  agentId: AgentId;
  /**
   * When set, the caller has chosen this title/branch and AI naming must
   * NOT touch them. The placeholder title becomes the explicit title, and
   * `setBranchRenamed(true)` is set synchronously. Either field alone is
   * enough to opt out of AI naming, matching the pre-fix headless behavior.
   */
  explicitTitle?: string;
  explicitBranch?: string;
  /** Optional model override (child + quick). */
  model?: string;
  /** Optional parent linkage (child only). */
  parentSessionId?: string;
  spawnedByTurn?: string;
}

export function graduateSession(deps, opts): void;
```

Body, in order:

1. `setWarm(id, false)` (no-op when already false).
2. `track(id)` — refresh `last_used_at`; idempotent on existing rows.
3. `rename(id, explicitTitle ?? userText.slice(0,60) ?? "New session")`.
4. If `model` set → `setModel(id, model)`.
5. If `parentSessionId` set → `setParentSession(id, parentSessionId, spawnedByTurn)`.
6. **Naming policy.** If `!explicitTitle && !explicitBranch && session.workspaceDir`:
   `scheduleSessionNaming(...)` (private helper inside this module). Otherwise:
   `setBranchRenamed(id, true)`.
7. If session has `remoteUrl` → `repoStore.touch(remoteUrl)`.
8. `sseBroadcast("session_list", { sessions: sessionManager.list() })`.
9. If session has `remoteUrl` and `warmSessionForRepo` is wired:
   `void warmSessionForRepo(remoteUrl)` (fire-and-forget).

Synchronous return. AI naming + warming are already async inside their own
steps.

### The contract comment (drift prevention)

Top of `graduate-session.ts`:

```ts
/**
 * graduateSession — SINGLE SOURCE OF TRUTH for warm → active session
 * transition. Every session-creation surface in the orchestrator MUST end
 * with a call to this function. The current call sites are:
 *
 *   - ws-handlers/send-message.ts   (warm-graduation on first message)
 *   - services/headless-sessions.ts (POST /api/sessions/headless)
 *   - services/child-sessions.ts    (POST /api/sessions/:parentId/spawn)
 *   - services/session-fork-merge.ts (POST /api/sessions/:id/fork)
 *
 * If you are adding a fifth, it MUST end here too. If you find yourself
 * calling any of these directly outside this module:
 *
 *   sessionManager.setWarm(id, false)
 *   sessionManager.track(id)
 *   sessionManager.setBranchRenamed(...)
 *   scheduleSessionNaming(...)
 *   repoStore.touch(remoteUrl)
 *   sseBroadcast("session_list", ...)  // as part of session creation
 *   warmSessionForRepo(remoteUrl)       // as part of session creation
 *
 * STOP and call graduateSession() instead. Hand-rolling subsets of these
 * is the bug class docs/156 was opened to make impossible.
 */
```

Plus a one-line comment at each call site:

```ts
// graduate-session.ts owns the warm → active transition (docs/156).
// Do not inline setWarm/setBranchRenamed/scheduleSessionNaming/repoStore.touch
// here — call graduateSession() instead.
```

This is the closest a comment can get to a compile-time check. We could also
add an ESLint `no-restricted-syntax` rule for direct calls to
`setBranchRenamed` and `scheduleSessionNaming` outside the
`graduate-session.ts` file, but the maintenance cost of the rule
configuration is roughly equal to the cost of catching the drift in code
review against the comment block — and the rule has a real false-positive
risk on tests. We rely on the comment + grep-discoverability.

### Per-surface refactors

**1. Warm graduation (`ws-handlers/send-message.ts`).**
The `if (session?.warm) { ... }` block (~30 lines) collapses to:

```ts
if (session?.warm) {
  graduateSession(
    {
      sessionManager: ctx.sessionManager,
      runnerRegistry: ctx.getRunnerRegistry(),
      repoStore: ctx.repoStore,
      createGitManager: ctx.createGitManager,
      prStatusPoller: ctx.prStatusPoller,
      sseBroadcast: ctx.sseBroadcast,
      warmSessionForRepo: ctx.warmSessionForRepo,
    },
    { sessionId: effectiveSessionId, userText, agentId: session.agentId ?? ctx.getActiveAgentId() },
  );
}
```

The previous fix's `scheduleSessionNaming` import goes away from this file.

**2. Quick session (`services/headless-sessions.ts`).**
The block that does `rename` / `setBranch` / `setWarm` / `setBranchRenamed` /
`scheduleSessionNaming` collapses to a single `graduateSession()` call. The
`HeadlessSessionGraduationDeps` interface + the `graduationDeps?` parameter
introduced by the previous fix are **deleted** — the deps are now mandatory
(passed at the route layer) and live in `GraduateSessionDeps`.

The branch-on-disk rename (`git branch -m`) and the explicit
`setBranch(branchName)` stay in this file: that's quick-session-specific
workspace prep, upstream of graduation. `graduateSession` is called *after*
that work with `explicitBranch` set when the caller supplied a `branch`.

**3. Child session (`services/child-sessions.ts`).**
Currently uses `rename` + `setBranchRenamed(true)` + `setWarm(false)` +
`setParentSession` + optional `setModel` inline. Collapses to a single
`graduateSession()` call.

**Intentional behavior change for child sessions**: today, child titles are
always `opts.title?.trim() || prompt.slice(0,60) || "Spawned session"` — no
AI naming, ever. After this refactor, when the agent does *not* supply
`opts.title`, AI naming runs (same as quick). The agent retains the ability
to pin a title (`shipit session create --title …`). This is a UX win that
falls out of the unification — child sessions get the same human-readable
sidebar entries quick sessions get.

The branch override decision in child stays as-is (the agent can't pick a
branch, comment in `child-sessions.ts:175-177` explains why), so
`explicitBranch` is never set for child. AI naming is gated on
`!explicitTitle && !explicitBranch`, so when the agent omits a title the
naming runs; when the agent provides one, it's authoritative — matches the
parallel quick-session behavior.

**4. Fork session (`services/session-fork-merge.ts`).**
Currently calls `track(id, title, dir)` to insert + then `setBranch` +
`setBranchRenamed(true)` + optional `setRemoteUrl`. Collapses to: keep the
`track(id, title, dir)` insert and the `setBranch`/`setRemoteUrl` (those are
fork-specific workspace identity), then call `graduateSession()` with
`explicitTitle` and `explicitBranch` both set. AI naming is suppressed
because the user chose both; `setBranchRenamed(true)` is set synchronously
inside `graduateSession`.

Fork has no `warmSessionForRepo` analog (the fork clones from the source
session's worktree, not from the bare cache, so re-warming the pool is
unrelated to fork). `graduateSession` calls `warmSessionForRepo` when wired,
which is correct: re-warming the pool after a fork is harmless — same as
after any other claim. The fork route doesn't have to special-case it.

### Surfaces that NEED a `remoteUrl` set before calling

`graduateSession` reads `session.remoteUrl` for `repoStore.touch` and
`warmSessionForRepo`. Every caller has already populated `remoteUrl` by the
time it would call graduate:

- warm: warm pool set it
- quick: claim set it
- child: claim set it
- fork: existing `setRemoteUrl` call moves *before* `graduateSession()`

This is documented in the function's JSDoc as a precondition.

### What `scheduleSessionNaming` becomes

It is folded into `graduate-session.ts` as a private (non-exported) helper.
The previous PR's `session-graduation.ts` + `session-graduation.test.ts`
files are deleted. The four naming tests migrate to
`graduate-session.test.ts`. No external import currently exists outside the
just-shipped fix, so this is a clean removal.

### Files touched

- **New**: `src/server/orchestrator/services/graduate-session.ts`
- **New**: `src/server/orchestrator/services/graduate-session.test.ts`
- **Delete**: `src/server/orchestrator/session-graduation.ts`
- **Delete**: `src/server/orchestrator/session-graduation.test.ts`
- **Modify**: `src/server/orchestrator/ws-handlers/send-message.ts` —
  warm-graduation block → single `graduateSession()` call.
- **Modify**: `src/server/orchestrator/services/headless-sessions.ts` —
  drop inline graduation steps; call `graduateSession()`. Delete
  `HeadlessSessionGraduationDeps`. Delete the optional `graduationDeps?`
  parameter.
- **Modify**: `src/server/orchestrator/services/child-sessions.ts` —
  drop inline `rename` / `setBranchRenamed` / `setWarm` / `setParentSession` /
  `setModel`; call `graduateSession()`. Add `runnerRegistry` + the other deps
  passthrough.
- **Modify**: `src/server/orchestrator/services/session-fork-merge.ts` —
  drop inline `setBranchRenamed`; reorder so `setRemoteUrl` runs *before*
  `graduateSession()`; call `graduateSession()` with `explicitTitle` +
  `explicitBranch`. Add `graduateSession` deps to the signature.
- **Modify**: `src/server/orchestrator/api-routes-session.ts` — wire the
  full `GraduateSessionDeps` into headless + spawn + fork routes. Drop the
  previous fix's `graduationDeps` conditional.
- **Modify**: `src/server/orchestrator/ws-handlers/rollback-handlers.ts` —
  the `handleForkSessionFromMessage` path forwards `forkSession`'s new
  deps. (Fork is also reachable from rollback; check it's covered.)
- **Modify**: `src/server/orchestrator/services/index.ts` — re-export the
  new module; drop the deleted re-exports.
- **Modify**: `src/server/orchestrator/services/headless-sessions.test.ts` —
  port the two structural assertions added by the previous fix against the
  new injection shape.
- **Modify**: `src/server/orchestrator/services/child-sessions.test.ts`
  (if any assertions cover the title/branchRenamed path) — confirm AI
  naming behavior is asserted or explicitly waived.

## Testing

Unit (`graduate-session.test.ts`):

- Port the four `scheduleSessionNaming` tests (success / null / throw /
  PR-already-exists).
- `setWarm(false)` and `track()` called synchronously.
- `repoStore.touch(remoteUrl)` called when `remoteUrl` is set; not called
  when it isn't.
- `warmSessionForRepo(remoteUrl)` called fire-and-forget when wired; not
  called when undefined.
- `sseBroadcast("session_list", { sessions })` fires every call.
- `explicitTitle` set → no AI naming, `setBranchRenamed(true)` sync,
  placeholder title = explicitTitle.
- `explicitBranch` set → no AI naming, `setBranchRenamed(true)` sync.
- Both explicit → no AI naming.
- `model` set → `setModel` called.
- `parentSessionId` set → `setParentSession` called with `spawnedByTurn`.

Unit (existing surface test files):

- `headless-sessions.test.ts` — keep the "defer vs immediate branchRenamed"
  assertion from the previous fix, retargeted at the new injection shape.
- `child-sessions.test.ts` — add an assertion that AI naming runs when no
  `opts.title` is supplied (the new behavior). Verify the agent-supplied-title
  path still skips AI naming.
- `session-fork-merge.test.ts` (if it exists; otherwise add coverage in
  rollback tests) — verify fork still synchronously gets `branchRenamed: true`.

Integration:

- **`quick-capture-headless.test.ts`** — add `repoStore.touch` assertion
  (proves the bug is fixed end-to-end).
- **`warm-sessions.test.ts`** — existing assertions should pass unchanged.
- **`agent-spawned-session.test.ts`** — existing assertions should pass;
  the title assertion may need an update for the new AI-naming behavior
  (the test currently asserts the prompt-slice title — that becomes the
  *placeholder*, and the post-naming title may differ in production but the
  test's mocked CLI returns nothing, so the placeholder sticks). Verify
  the test mocks `generateSessionName` or accepts the slice as-is.

Quality:

- `npm run lint:dev` clean (+ direct ESLint on the new files).
- `npm run typecheck` clean.
- Affected vitest scope passes (`graduate-session.test.ts`,
  `headless-sessions.test.ts`, `child-sessions.test.ts`,
  `quick-capture-headless.test.ts`, `warm-sessions.test.ts`,
  `agent-spawned-session.test.ts`, `home-screen.test.ts`).
- Full orchestrator-test sweep
  (`vitest run src/server/orchestrator/`).

## Intentional behavior changes (call out in the PR)

1. **Quick sessions** now call `repoStore.touch(remoteUrl)` →
   sidebar repo ordering updates correctly.
2. **Quick + child sessions** now call `sessionManager.track(id)` →
   `last_used_at` is refreshed consistently across surfaces.
3. **Child sessions** now run AI naming when the agent doesn't pin a
   title → human-readable sidebar entries for spawned sessions, same
   behavior as quick sessions. The agent's `--title` (when supplied)
   remains authoritative.

None of these are new features; they're the steps the warm-graduation flow
already runs. The other surfaces inherit them by going through the same
function.

## What this plan deliberately does NOT do

- **Does not merge the route handlers** (transport / workspace acquisition /
  activation differ — see "Why the route handlers still can't be the same").
- **Does not touch `claim-session.ts`.** Claim is upstream of graduation —
  it creates the row and assigns the workspace. Keeping graduation as a
  separate downstream step preserves the clean upstream/downstream
  boundary; merging them would entangle workspace provisioning with
  title/branch policy.
- **Does not change `mergeSession()`.** Merge is a session *operation*,
  not a session *creation* surface; it doesn't graduate anything.
- **Does not change the WS-handler context interface.** Every dep
  `graduateSession` needs is already on `AppCtx` (`sessionManager`,
  `repoStore`, `prStatusPoller`, `createGitManager`, `sseBroadcast`,
  `warmSessionForRepo`); the call site spreads them inline.
- **Does not add a new SSE event.** The existing `session_list` broadcast
  carries the post-graduation state; no client change is needed.

## Risk + rollback

Risk surface: bigger than a typical refactor because three surfaces are
touched, but each surface is already covered by integration tests, and the
intentional behavior changes are additive (the steps were already running
in warm; the other surfaces just inherit them now). The biggest concrete
risk is the **child-session AI-naming change** — the
`agent-spawned-session.test.ts` suite asserts on titles. Plan calls for
explicitly verifying that test's expectations match the new
"AI-naming-on-by-default" behavior, with a mocked CLI to keep the test
deterministic.

Rollback is a single PR revert. No DB migration, no client change, no
deploy ordering.
