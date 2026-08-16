---
issue: planning#397
title: Auto-merge must not merge while a session is working — design
description: The busy gate on the managed merge loop, and why a live session is never handed to GitHub native auto-merge.
---

# 266 — Auto-merge while the agent is working: design

Implements [`requirements.md`](./requirements.md). Requirements are cited as
`(req N)`.

## The hole

The guard already existed — on one path out of four.

| Path | Who merges | Guard before this change |
|---|---|---|
| `POST /api/sessions/:id/pr/merge` (UI merge button) | ShipIt, on user click | `runner?.running` → 409 |
| `AutoMergeManager.handleManaged` (managed loop) | ShipIt, on a poll tick | **none** — no reference to the runner registry at all |
| GitHub native auto-merge (`enableAutoMerge`) | GitHub, inside GitHub | **none possible** — GitHub cannot see a ShipIt turn |
| `mergePullRequest`'s pending-checks fallback (same UI button) | GitHub, later | **none** — it arms native and returns |

The UI route's comment names the failure verbatim ("merging now could ship a PR
whose later commits land on a branch with a closed PR — orphaned work"). PR
#2327 took the third row, so nothing consulted the runner.

## The shape

Two changes, one at merge time and one at arm time.

**1. The managed loop waits (req 1, req 2, req 3).** `handleManaged` takes an
optional `getRunner` callback and, after every existing precondition and
immediately before the REST merge, bails while `runner.agentBusy` — no sticky
error, re-evaluated next tick. That placement is deliberate: the gate is only
consulted for a PR that is otherwise ready, so the log line means "ready and
waiting", not "not ready yet".

`agentBusy`, never bare `running` (req 2). `container-session-runner.ts` defines
it as `_isRunning || backgroundTaskCount > 0 || subAgentSpawnsInFlight > 0 ||
_postTurnHold.active`, and both extra terms are the incident: the turn spent
8 minutes inside a backgrounded reviewer consult (`subAgentSpawnsInFlight`), and
the commit's debounced auto-push is held under the post-turn lease from the
moment it is armed (`services/auto-push-scheduler.ts`, verified at
`beginPostTurnWork`/`endPostTurnWork`). A `running` check would merge in either
window — the same bug with a smaller mouth.

The same widening is applied to the UI merge route, which had the older, narrower
predicate for exactly the same job.

**2. A live session is never handed to native (req 4).** `activatePendingAutoMergeForPr`
and `toggleAutoMerge` consult `prStatusPoller.hasLiveRunner(sessionId)` and, when
true, skip `enableAutoMerge` entirely and record the arming as ShipIt-managed.
For an agent-opened PR this is the ordinary case: activation runs inside the
post-turn flow, whose runner is very much alive.

The UI merge button's own fallback is the same case wearing different clothes:
clicking Merge while checks are still running does not merge, it *arms*. That
route now passes `preferManaged` when the session has a live runner, and
`mergePullRequest` returns `managed: true` instead of calling `enableAutoMerge`;
the route records the managed arming, since the service has no poller. The
session is necessarily quiet at that moment (the route 409s otherwise) — and one
message away from a turn, which is the whole point.

The agent-driven `gh pr merge --auto` path is deliberately untouched: it is
sandbox-only (`mergeDisposition` returns `not-sandbox` for a repo-bound session
and the route replies 403), and sandbox PRs are not poller-tracked.

The predicate is runner **existence**, not `agentBusy` — the packet says "a live
runner" in its decision, and the arming outlives the moment it is made. An
idle-but-live session is one user message away from a turn, and there is no
hand-back to native (below), so arming on "busy right this second" would leave
exactly the incident's shape: armed native while quiet, merging mid-turn once
review feedback started a turn.

## Managed for two different reasons

`managed` used to mean one thing — "GitHub refused" — and it carries the
`settingsUrl` + `reason` the card renders as a repo-misconfiguration tooltip.
Reusing it for "deliberately managed because the session is live" would tell the
user to go fix a repository that is configured perfectly well (req 6).

So `AutoMergeState` gains `managedReason: "native-unavailable" | "session-live"`,
defaulted to the former for every pre-existing call site, broadcast on the PR
summary, and returned from the toggle route so the tooltip is right immediately
rather than after the next poll. `ManagedMergeInfo` branches on it: the live case
gets its own wording and **no settings link**.

## Who owns the merge for the rest of the PR's life (req 5)

**The managed loop keeps it. There is no hand-back to native.** Handing the PR
back once the session went quiet would restore the exposure on the next turn —
and a PR that is armed but not yet merged is, by definition, one that is blocked
on CI or review, i.e. precisely the PR a later turn will work on. That is the
incident again. Disarming native on turn start is the option the operator already
rejected.

That the managed loop covers the whole life of the PR is verified, not assumed:

- **Container reclaimed, session row alive** — `PollingGlobalGate.anyAutonomousActionInFlight`
  returns true for `merge?.enabled && merge.managed` (`polling-global-gate.ts`),
  so the supervisor keeps polling with no viewer anywhere. `getRunner` resolves
  to `undefined`, which reads as not-busy, and the merge happens.
- **Session archived** — `untrackSession` is called by nothing in production
  (`pr-status-poller.ts` says so at its only definition), and `loadPersisted`
  re-seeds archived sessions, so tracking survives.
- **No runner registry wired at all** (degraded setups, tests) — the callback is
  absent, which reads as not-busy. The "skip wiring when `runnerRegistry` is
  absent" contract is honoured in the direction that matters: an absent registry
  must never turn into a merge that never happens.

**Known limitation, pre-existing and stated rather than fixed:** auto-merge
arming lives in the `AutoMergeManager` map and is deliberately stripped from the
persisted PR snapshot (`loadPersisted`), so it does not survive an orchestrator
restart. Native arming does, because it lives on GitHub. This change moves more
PRs onto the managed loop and therefore widens exposure to that hole without
creating it; closing it means persisting the arming, which is a separate change.

## Logging (req 7)

Three lines, no more:

- `[auto-merge] Merged PR #N (owner/repo) for <session> via managed merge (squash, reason=…)` — at the successful REST merge.
- `[auto-merge] Holding merge of PR #N (owner/repo) for <session>: agent busy` — once per wait, not once per poll tick (a `busyLogged` set, cleared when the gate opens or the arming is retired).
- `[auto-merge] PR #N for <session> reached merged with auto-merge armed: native | managed (reason)` — in the poller's terminal branch, just before the arming is dropped. This is the only place a **native** merge is attributable from ShipIt's side, since the merge itself happens inside GitHub. Gated on `!alreadyTerminal` so it fires once.

## Key files

- `src/server/orchestrator/auto-merge-manager.ts` — the busy gate, `managedReason`, merge/hold logs.
- `src/server/orchestrator/pr-status-poller.ts` — wires `getRunner`, adds `hasLiveRunner`, broadcasts `managedReason`, logs the terminal attribution.
- `src/server/orchestrator/services/github.ts` — `activatePendingAutoMergeForPr` / `toggleAutoMerge` arm managed while the session is live; `mergePullRequest` takes `preferManaged` for its pending-checks fallback.
- `src/server/orchestrator/api-routes-github.ts` — UI merge route widened to `agentBusy`, and records a managed arming for a live session.
- `src/server/shared/types/github-types.ts` — `AutoMergeManagedReason`, on the state and both broadcast shapes.
- `src/client/components/PrStatusControls.tsx` — the two managed tooltips.
- `src/client/stores/pr-store.ts` — carries `managedReason` from the toggle response.

## Tests

- `auto-merge-manager.test.ts` — busy holds the merge; `running:false, agentBusy:true` still holds it; the same PR merges once idle; no registry and no runner both still merge; `managedReason` defaults and clears.
- `pr-status-poller.test.ts` — the wiring guard: a poller with a busy runner does not merge a green PR, and does merge on a later tick once the runner is idle.
- `services/github-auto-merge-arming.test.ts` — a live session arms managed, not native, and carries no settings URL or GitHub error; a quiet session still arms native; the GitHub-refused fallback reports `native-unavailable`; the merge button's pending-checks fallback arms managed for a live session and native otherwise.
- `integration_tests/pr-merge.test.ts` — the UI route 409s during post-turn work, not just mid-turn.
- `PrStatusControls.test.tsx` — the live-session tooltip explains the wait and offers no settings link; the misconfiguration tooltip is unchanged.

The registry fake (`pr-poller-test-helpers.ts`) grew an `agentBusy` that follows
`running` unless overridden. Without that it could never report the exact state —
turn over, work not yet pushed — that this gate exists for, so every test of the
gate would have been blind by construction.
