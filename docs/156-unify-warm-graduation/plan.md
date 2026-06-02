---
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
  This is **defensive symmetry, not a user-visible bug**: `claim-session.ts`
  already calls `markStarted` (which writes `last_used_at = now`) on every
  claim path before quick/child reach graduation, so today's behavior is
  correct. The reason to add `track()` to graduate anyway is that the
  cross-file coincidence isn't load-bearing in the code — a future change to
  the claim path could quietly remove `markStarted` and quick/child sessions
  would silently lose their `last_used_at` write. Calling `track()` from one
  shared graduation function makes the invariant local to the graduation
  contract instead of distributed across two files.
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
   `scheduleSessionNaming({ skipBranchRename }, ...)` (private helper inside
   this module — see "Branch rename gating" below). Otherwise:
   `setBranchRenamed(id, true)`.
7. If session has `remoteUrl` → `repoStore.touch(remoteUrl)`.
8. `sseBroadcast("session_list", { sessions: sessionManager.list() })`.

Synchronous return. AI naming is already async inside its own step.

**`warmSessionForRepo` is deliberately NOT a step of `graduateSession`.** Why:

- For quick + child, `claim-session.ts` already calls `rewarmPool` → `warmSessionForRepo`
  at the end of every claim path. Calling it from graduate would double-fire,
  which the warm pool serializes but at the cost of one wasted clone setup.
- For fork, today no warming happens (fork clones from the source session's
  worktree, not from the cache). Adding it via graduate would silently
  introduce per-fork warming — material for the rollback fork path
  (`rollback-handlers.ts:308-320`) where the user may fork repeatedly while
  exploring rewind options, each one provisioning a fresh container + clone
  in the background. That inverts the "fork is local and cheap" UX
  assumption.
- The only path that needs `warmSessionForRepo` *because graduation
  happened* is warm-graduation — that surface never goes through claim, so
  there is no other site that refills the pool when its single warm clone
  gets consumed.

Conclusion: warm-graduation calls `warmSessionForRepo` inline (one extra
line in `send-message.ts`), the other three surfaces inherit nothing for
this concern.

### Branch rename gating

`scheduleSessionNaming` currently renames both the title AND the on-disk
branch (`shipit/<random>` → `shipit/<slug>-<random>`). For warm + quick that
is the intended behavior. For child this is a regression:

- `POST /api/sessions/:parentId/spawn` returns a JSON body containing
  `branch` (`child-sessions.ts:294`). The `shipit session create` CLI shim
  prints that value to the agent. If the branch is silently rewritten
  ~seconds later by the AI-naming flow, the value the shim printed is now
  stale and the agent's chat history points at a name that does not exist.
- The existing comment at `child-sessions.ts:175-177` explicitly chose the
  `shipit/<random>` shape because agent-supplied names drifted outside the
  namespace. A delayed AI rename re-introduces the same "branch name is a
  moving target" problem from a different angle.

The fix is to give `graduateSession` (and the private `scheduleSessionNaming`
helper) a `skipBranchRename: boolean` option that:

- defaults to `false` (rename branch — preserves warm + quick behavior),
- is set to `true` by the child call site,
- is set to `true` by the fork call site (fork branches are user-chosen and
  immutable by design — but fork passes `explicitBranch`, which already
  short-circuits naming, so the flag is belt-and-braces).

When `skipBranchRename: true` and AI naming returns a name, only the title
is updated; the branch row stays at its current value. `setBranchRenamed(true)`
still runs at the end of the finalizer so the PR card progresses.

### Removing the duplicate `session_list` broadcasts

Today `session_list` is broadcast from several places. The ones that fire
**as part of session creation** are duplicates after this refactor:

- `api-routes-session.ts:276` — `POST /api/sessions/:id/fork` (HTTP fork route)
- `api-routes-session.ts:334` — `POST /api/sessions/headless`
- `api-routes-session.ts:394` — `POST /api/sessions/:parentId/spawn`
- `ws-handlers/rollback-handlers.ts:339` — `handleRewindAtGap` (rewind-driven fork creation)
- `ws-handlers/send-message.ts:271` — warm graduation (inline)

**Plan: delete each of those five broadcasts.** `graduateSession` will
broadcast once. The inline broadcast in `send-message.ts` also goes away.

The following `session_list` broadcasts are NOT part of session
*creation* — they fire after archive/unarchive/delete/rewind-restore — and
**stay where they are**:

- `api-routes-session.ts:190` — `POST /api/sessions/:id/unarchive`
- `api-routes-session.ts:611` — session delete
- `ws-handlers/rollback-handlers.ts:421` — `handleRewindRestoreRequest`
  (fires after `archiveSession` of the snapshot's child — it's the
  archive-half of a rewind restore, not a creation)

(There is no separate HTTP "fork-from-message" route — fork-from-message
lives in `rollback-handlers.ts:handleRewindAtGap`, which is the `:339`
entry above.)

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
    },
    { sessionId: effectiveSessionId, userText, agentId: session.agentId ?? ctx.getActiveAgentId() },
  );
  // Warm-graduation is the only surface that doesn't reach graduation via
  // claim, so the warm pool's single warm clone was consumed but never
  // re-warmed. Refill it inline. The other three surfaces inherit re-warming
  // from claim-session.ts:rewarmPool — see graduate-session.ts step-list.
  if (session.remoteUrl) void ctx.warmSessionForRepo(session.remoteUrl);
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
to pin a title (`shipit session create --title …`).

**Child must pass `skipBranchRename: true`** (see "Branch rename gating" above)
because `POST /spawn` returns the branch name in its response body and the
CLI shim prints it to the agent — a delayed rename would make the printed
value stale. So child sessions get AI-named *titles* but their branch stays
at the `shipit/<random>` shape the claim cut. The agent's ability to pin a
branch is unchanged (it still can't — comment in `child-sessions.ts:175-177`
stands).

**4. Fork session (`services/session-fork-merge.ts`).**
Currently calls `track(id, title, dir)` to insert + then `setBranch` +
`setBranchRenamed(true)` + optional `setRemoteUrl`. Collapses to: keep the
`track(id, title, dir)` insert and the `setBranch`/`setRemoteUrl` (those are
fork-specific workspace identity), then call `graduateSession()` with
`explicitTitle` and `explicitBranch` both set, and `skipBranchRename: true`
(belt-and-braces — the explicit-fields gate already short-circuits naming,
but a future change to the naming policy must not be able to silently
rename a fork branch the user chose). AI naming is suppressed because the
user chose both; `setBranchRenamed(true)` is set synchronously inside
`graduateSession`.

Fork has no `warmSessionForRepo` analog — and since `graduateSession` does
not call `warmSessionForRepo` (see step-list note above), no special-casing
is needed at the fork call site.

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
  previous fix's `graduationDeps` conditional. **Delete** three
  `deps.sseBroadcast("session_list", { sessions: result.sessions })` lines:
  `:276` (fork route), `:334` (headless), and `:394` (spawn) — graduation
  broadcasts once now. **Keep** the broadcasts at `:190` (unarchive) and
  `:611` (delete); they are not session-creation events.
- **Modify**: `src/server/orchestrator/ws-handlers/rollback-handlers.ts` —
  `handleRewindAtGap` calls `forkSession` with 11 positional args today.
  After this refactor, `forkSession`'s signature grows by **five new
  positional args** (all new — none of these are on `forkSession` today):
  `runnerRegistry`, `prStatusPoller`, `repoStore`, `createGitManager`, and
  `sseBroadcast`. Forward all five from `ctx`. Also **delete the duplicate
  `ctx.sseBroadcast("session_list", ...)` at `:339`** (the
  `handleRewindAtGap` post-fork broadcast — superseded by
  `graduateSession`'s broadcast). **Do NOT touch `:421`** in
  `handleRewindRestoreRequest`; that broadcast fires after
  `archiveSession(snapshot.childSessionId)` — it's the archive half of
  the rewind-restore flow, not a creation event. Verify
  `rewind-fork.test.ts` still passes after the signature change and the
  `:339` deletion.
- **Modify**: `src/server/orchestrator/services/index.ts` — re-export the
  new module; drop the deleted re-exports.
- **Modify**: `src/server/orchestrator/services/headless-sessions.test.ts` —
  port the "defers `branchRenamed` when no explicit branch/title" structural
  assertion from the previous fix against the new injection shape. **Delete**
  the sibling "marks `branchRenamed` immediately when graduation deps are
  not wired" test — it covers a code path that no longer exists once the
  deps are mandatory.
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

- `headless-sessions.test.ts` — keep the "defers `branchRenamed` when no
  explicit branch/title" assertion from the previous fix, retargeted at the
  new injection shape. **Delete** the sibling "marks `branchRenamed`
  immediately when graduation deps are not wired (test/local mode)" test
  (lines 303-317 of the current file): once the deps become mandatory, that
  code path no longer exists, so the test would be asserting against
  unreachable behavior.
- `child-sessions.test.ts` — add an assertion that AI naming runs when no
  `opts.title` is supplied (the new behavior) AND that the branch row stays
  at its claim-time `shipit/<random>` shape (regression test for the
  `skipBranchRename: true` flag). Verify the agent-supplied-title path
  still skips AI naming.
- `session-fork-merge.test.ts` (if it exists; otherwise add coverage in
  rollback tests) — verify fork still synchronously gets `branchRenamed: true`.

Integration:

**Critical pre-merge step: integration tests do not currently mock
`session-namer.ts`** — a grep for `generateSessionName` and `session-namer`
under `integration_tests/` returns zero hits. The function shells out to the
real provider CLI with a 15s timeout via `execFile`. Today this is fine
because no integration test exercises the warm-graduation path with a real
prompt-without-title (warm flow runs through a fake agent). After this
refactor:

- Every `POST /api/sessions/headless` call without a `title` (e.g. the new
  `repoStore.touch` assertion below) will fork a real `claude`/`codex`
  child process.
- Every `POST /api/sessions/:parent/spawn` call without `--title` (e.g.
  `agent-spawned-session.test.ts` lines 286-293, 317, and the 4-children
  per-turn-quota test at 260-274) will fork a real CLI process each — 4
  forks per run in the quota test alone.
- The branch-shape assertion at `agent-spawned-session.test.ts:307` would
  race against the AI rename.

So this refactor MUST add a vitest module mock to each affected integration
test file:

```ts
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue(null),
}));
```

(Returning `null` makes the naming a no-op — the placeholder title sticks,
the branch is unchanged, `setBranchRenamed(true)` still runs via the
finalizer.) The mock goes in: `agent-spawned-session.test.ts`,
`quick-capture-headless.test.ts`, `warm-sessions.test.ts`, and any other
file that drives a session-creation path without supplying both an
explicit title and an explicit branch.

End-to-end assertions:

- **`quick-capture-headless.test.ts`** — add `repoStore.touch` assertion
  (proves the bug is fixed end-to-end).
- **`warm-sessions.test.ts`** — existing assertions should pass unchanged
  with the mock in place.
- **`agent-spawned-session.test.ts`** — existing title/branch assertions
  should pass unchanged with the mock in place. Without the mock, the
  quota test would race against four real CLI invocations.

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
