---
issue: planning#400
title: Re-gate agent.install so a plugin cannot run code in the agent container
description: One gate at the single orchestrator-side chokepoint where agent.install commands are handed to the session worker, anchored on the install marker and scoped to plugin-bearing sessions.
---

# Plan — `agent.install` trust boundary

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

## What changes, in one sentence

In a session that has a plugin (req 11), `agent.install` commands that differ
from the ones that last actually ran are **not executed**; a system notice in
the chat transcript says so, and the user gets them by asking the agent (reqs 3,
7, 8).

## Where the gate goes, and why there is only one

`ContainerSessionRunner.runInstall(commands)`
(`container-session-runner.ts:1782`) carries **all but one** of the paths by
which a session's own `agent.install` reaches the worker. Enumerated:

| Caller | Path | Gated |
|---|---|---|
| `service-manager-setup.ts:472` | session setup / container (re)create — the **restart path** (req 5) | via `runInstall` |
| `container-session-runner.ts:2020` (`maybeReinstallForDepChange`) | the live `shipit.yaml` delta the issue names, and the dep-file reinstall | via `runInstall` |
| `warm-pool-manager.ts:358` (`runPreInstall`, called at `:298`) | the warm-pool **pre-install**, which POSTs `/install` on the standby's worker **directly** | separately, at `runPreInstall` |
| `plugin-generations.ts:835` | a **different** `deps.runInstall` — the plugin's *own* generation install, object-shaped signature, not this method | n/a |

The two paths requirement 5 names converge on `runInstall`, so the gate is one
`if` rather than a rule duplicated at each site. This is why it is *not* placed
in `applyShipitConfigChange` where the issue found the bug: that closes the
watcher delta and leaves the restart path open.

The warm-pool pre-install is the exception and is gated at its own call site. A
standby's clone is fresh and no plugin container has ever run against it, so the
gate allows in practice — but "in practice" is not what requirement 5 asks for,
and an ungated run there would also stamp the marker, which is the anchor the
gate reads. **An earlier revision of this table said those lines were "comments
only, no call"; that was wrong** — the call sits three lines below the comment
block, and the independent review caught it.

The restart path is the one the issue does not mention and requirement 5 exists
for: a plugin's write to `shipit.yaml` is auto-committed by the post-turn flow
like any other workspace change, so the next container create reads the plugin's
command list out of a repo whose remote the user trusted once, and the docs/178
gate — which asks only whether the *remote* is trusted
(`service-manager-setup.ts:397-401`) — passes it.

## The three questions the gate asks

### 1. Does this session have a plugin? (reqs 11, 12)

```
config.plugins.use.length > 0  ||  fs.existsSync(pluginDataRoot(sessionDir))
```

The first half is requirement 11's plain reading. The second half is
requirement 12: `<sessionDir>/plugin-data/` is created when a plugin container
is prepared (`plugin-cli-run.ts:433-437` for a CLI run, `plugin-state.ts:407`
for a service), it lives **outside** every mount a plugin container gets —
verified against the mount list at `plugin-cli-run.ts:444-453`, which is
`workspaceDir`, the plugin's own state dir, and its settings file — so a plugin
cannot delete the evidence that it exists. Without the second half, a plugin
removing its own `plugins.use` entry in the same write that changes
`agent.install` makes the session look plugin-free at exactly the moment the
check runs.

Falling back to "not plugin-bearing" when `shipit.yaml` cannot be read is safe
here: an unreadable config also means `agent.install` resolves to nothing, so
there is no command list to withhold.

### 2. Which commands count as accepted? (req 3)

The install marker's `installCommands`
(`install-marker.ts`, `<sessionDir>/state/shared/.install-done`). It is the
record of the exact list that **last ran to completion** in this session, it
survives a container recreate, and no plugin container mounts the directory it
sits in (docs/246 moved it out of the clone precisely so `git add -A` could not
reach it).

Three properties were checked rather than assumed:

- **A missing marker allows the install.** A session installing for the first
  time has no prior list to contradict, and its `agent.install` is the one the
  docs/178 repo-trust decision covered. Withholding there would break every new
  plugin-bearing session.
- **`preStampInstallMarker` cannot launder a changed list into the marker.** It
  returns `false` when a marker already exists
  (`overlay-session.ts:549-550`), so it can only ever write the *first* marker —
  at container create on a fresh session, before any plugin container has run.

  **This was wrong as written, and was corrected on 2026-08-20** (ops finding —
  see [The reset record](#the-reset-record-2026-08-20) below). "A marker already
  exists" is not a one-way door: three paths delete an *established* session's
  marker on purpose — a base rotation, a blocked-session cache reclaim, and
  disk-tier eviction of the whole `state/` subtree — and each re-opens the
  pre-stamp window on a session a plugin container has already run in. Observed on the production host: the gate withheld a changed list at
  17:11:13 and a new marker recorded that same list as accepted at 17:11:19.

  The mitigation named at the time — a base pointer's `installCommands` can only
  come from an install that genuinely ran (`service-manager-setup.ts` skips the
  publish when the install was withheld) — holds, and it does mean a plugin
  cannot inject an *arbitrary* command by this route. It is not sufficient. A
  fresh plugin-bearing session allows its `agent.install` by design, publishes a
  base from it, and the pointer then carries that list; the pre-stamp would
  promote it into an *established* session's accepted list, which is the one
  thing this gate exists to prevent. The claim is now enforced rather than
  inferred: the pre-stamp asks the gate directly and declines while it is
  withholding.

  Two things the independent review sharpened, so the bar is not overstated. The
  pointer match is not generic — it needs the same commit (or byte-identical dep
  inputs) **and** the generation the mount actually pinned, so this is not an
  arbitrary-injection primitive. And the production timeline cleared that bar
  anyway: same session, same commit, the generation it had just been moved onto.
- **An unparseable marker is a miss, not an allow.** `parseMarker` returns
  `null` for a legacy, corrupt or future-version file, and this gate treats
  `null` the same as absent — which is the same direction the existing skip gate
  errs in (one extra install, never a wrong skip).

### 3. Have we already said so? (req 7, without repeating itself)

The withheld list is recorded beside the marker as `.install-withheld`. Without
it the notice re-fires on every container recreate — an idle session resumes,
`setupServiceManager` calls `runInstall`, and the same sentence lands in the
transcript again — so a user who has not acted accumulates one per resume. The
record is compared by command list, so a *different* withheld list always
produces a fresh notice.

## The reset record (2026-08-20)

Found live in an ops session, on the production commit `a19702c5`. Session
`fba1ee31`'s dev service died on `sh: 1: vite: not found`, exit 127, with
nothing anywhere connecting that to ShipIt. Two subsystems, each correct on its
own, disagreed and nothing reconciled them:

- `prepareOverlayDirs` (`container-lifecycle.ts`) reaps a session's superseded
  copy-on-write upper layer when the shared dependency base rotates, and drops
  the install marker **because `agent.install` must run again** — its own
  docstring names the failure it is preventing, "leaving the session with the
  base's deps and none of its own".
- This gate refuses to run it.

The result is a session with known-incomplete dependencies, a dev service
failing with an unrelated-looking error, and — because the marker delete
re-opened the pre-stamp window — a fresh marker asserting the base satisfied the
checkout, which suppressed every later attempt to repair it. `reclaimBlockedSessionCaches`
(`disk-utils.ts`) is the same defect by the same mechanism under disk pressure.

**The cause is that the marker was carrying two facts.** "These dependencies are
installed" and "the user accepted this command list" are not the same claim, and
deleting the marker for the first reason destroyed the second. So the deleters
now write `.install-reset` first (`agent-install-gate.ts`), carrying the second
one on its own: `accepted`, the list that last ran to completion. The gate reads
it **in preference to** the marker while it exists, so a marker written by
anything other than a completed install cannot move what this session has
accepted — which closes the pre-stamp route above, and needs no cooperation from
the pre-stamp. Its mere presence is the other half of the signal: between a
deliberate delete and the next completed install, this session's dependencies are
whatever the shared base happens to carry, which nothing has checked.

**There are three anchor destroyers, not two**, and the third is why the record
is not stored beside the marker:

| Path | When |
|---|---|
| `prepareOverlayDirs` | the shared dep base rotated under the session |
| `reclaimBlockedSessionCaches` | disk pressure took the overlay upper |
| `reclaimRegenerableSessionDirs` | disk-tier eviction deleted the whole `state/` subtree |

The third deletes `state/` wholesale — it is in `REGENERABLE_SESSION_SUBDIRS`,
correctly, because everything in it can be rebuilt. An acceptance record cannot.
Worse, `plugin-data/` is a deliberately **durable** sibling, so an evicted and
restored session comes back still plugin-bearing with its anchor gone — and a
`null` anchor reads as "first install", which allows. Eviction alone would hand
the credential-bearing container a command list nobody accepted. The record
therefore lives where the other durable, non-git session data lives: a sibling of
`workspace/`, the `uploads/` convention (docs/217) the reclaim allowlist leaves
alone. `claim-session.ts` clears it when a clone changes hands, which is the one
case where the previous occupant's history must not carry over.

Two failure directions are handled deliberately rather than by default:

- **The write is atomic** (temp + rename) and its result is returned, not
  swallowed. Both callers log a failure naming the consequence — but neither
  stops, because the alternative to deleting the marker is keeping it, and a
  marker outliving the dependencies it describes is precisely the dep-less
  session both deleters exist to prevent. A lost anchor costs only a
  plugin-bearing session, and only back to the behaviour that shipped before this
  record existed; a kept marker costs every session its dependencies.
- **A record that is present but unreadable fails closed.** It resolves to an
  empty accepted list, which matches no request and so withholds — not to
  "absent", which allows. The file's existence is itself the evidence that
  something was accepted and we have lost track of what.

The record is cleared by the next install that completes with positive evidence
(ran and succeeded, or the worker's content-keyed marker matched) — the same two
outcomes that clear a dependency gap, and in the same place. The clear is
best-effort, so the runner's in-memory answer and the file can briefly disagree;
they are retracted together, but only one of them can fail, and a surviving
record costs a repeated notice rather than a wrong execution.

**That exclusion had to be made true first.** `clearDependencyGap`'s docstring
already said a synthesized completion is not proof, but `signalInstallComplete`
defaults to `ok = true` and three paths reported success having observed no
install: the reconnect resync's "not running and no last result" branch, whose
own comment says it cannot tell success from failure; `dispose()`; and the
disposed-before-worker-ready return. All three cleared the #2429 gap from
nothing. Harmless enough while the method only touched runner state; not harmless
once it also drops the trust anchor, where a dropped SSE stream would be enough
to let the next recreate run a withheld list. The exclusion now lives in the type
(`InstallCompletion.unverified`) instead of in prose — and it gates the **overlay
publish** too, which otherwise takes `installOk` at face value and would stamp a
missing or half-installed tree as the shared base for the whole scope.

### What ShipIt cannot tell, and does not claim

An earlier revision of this fix carried a second field, `depsDiscarded`, meant to
prove the harmless case by checking whether the reaped overlay upper layer had
held anything. **It is not a proof and it is gone.** An empty upper says the
**old** lower satisfied this checkout; it says nothing about the **new**
generation being mounted, which may have been published from a tree that dropped
the very package this branch needs. The same production symptom could recur with
that check reporting "nothing lost".

So the signal is *unverified*, full stop — and that is what the surfaces say. The
wording matters more for being unconditional: the remedy is framed as diagnostic
ordering ("before you treat a missing-module error as a fault in the code, run
these") rather than as an order to reinstall every turn. `npm ci` deletes
`node_modules` and rebuilds from scratch; that is not a free thing to instruct on
a session that is working.

### Saying so, when the dependencies are in question

An outstanding reset is what makes this a different event from the ordinary
withhold. Ordinarily the session keeps working on the dependencies it already
has (req 7) and the once-per-list notice above is proportionate. Here nothing
has checked what it has — and `.install-withheld` is *precisely* what silenced
the recreate that broke the service, because the user had already seen that
notice for the same list.

So this case records a `DependencyGap` (`dependency-staleness.ts`, reason
`install-withheld`) instead. It is the session's existing "installed tree does
not match this checkout" state, it reaches three surfaces rather than one — the
persisted transcript, the line the service list carries beside the failing
service, and the agent's own turn prompt — and it lasts until an install answers
it rather than until the reader scrolls past.

**Requirement 4 is untouched, including in the wording.** The gap names the
**in-force** list as the remedy, never the withheld one: having ShipIt instruct
its own agent to run the command it just refused would be this boundary dressed
up rather than observed. Running the in-force list restores whatever the reset
took and adopts nothing; requirement 8's remedy — the *user* asking for the new
command — is unchanged, and the agent prompt says so explicitly.

### Why the compose install gate still starts the services

The obvious move is to close the gate as a failure when the reinstall was
withheld, holding `dependsOnInstall` services instead of starting them into an
exit 127. That is wrong, and the deciding evidence came from the same ops sweep:
a **control session** took the same rotation and the same withhold and came up
serving, because the shared base already satisfied its checkout. The signal is
"unverified", never "broken" — see the section above for why no cheap check
sharpens it. Latching on an unverified means definite outages for healthy
sessions, at the scale of every session pinned to a superseded generation (34 on
that host), and it takes the diagnosis down with them: a service latched before
it ever starts produces no failure for anyone to read. Starting it costs a crash
loop in the genuinely-broken case, by which point the reason is already in the
three places the reader reaches first.

## The notice (reqs 7, 8)

`emitNoticeInTurn` (`chat-card-persistence.ts:428`) at `warn` level — the muted
full-width panel docs/138 introduced, already used for account failover and the
pre-turn-reset skip. It emits **and persists** through `emitChatCard`, which
decides on `runner.running` whether the row rides the in-progress turn or is
appended as a final one — the branch `CLAUDE.md` requires for a card that can
arrive post-turn.

This is deliberately **not** a new card type. A new `PersistedMessage` field
would mean a column, a `database.ts` migration, `toRow`/`fromRow`,
`loadSessionHistory` rehydration, `CARD_MESSAGE_FIELDS` registration and two
guard-test updates — the whole `docs/188` recipe — to render one sentence with
no interactive affordance. The notice already satisfies requirement 7's
"appears in the transcript and is still there after a reload".

The runner cannot reach `chatHistoryManager`, so the emit is wired as a
callback (`onInstallWithheld`) in `runner-registry-factory.ts`, beside the
existing `onComposeConfigChanged` and `rerunServiceSetup` wirings that solve the
same problem. A runner built without the wiring (unit tests, local mode) simply
withholds silently rather than crashing.

Requirement 8 needs no mechanism: the agent runs commands in that container
already, so the notice names the withheld commands and the user asks for them.

## Two things that would have made this a no-op

Both were found by the independent review, and both are the kind of thing a
green test suite hides.

### `runner.sessionDir` is the CLONE, not the session root

`ContainerSessionRunner` is built with `session.workspaceDir`
(`route-registry.ts:501`), and `app-lifecycle.ts:685` states it before taking
`path.dirname` of it. The first revision of the gate read
`<sessionDir>/workspace`, `<sessionDir>/state/shared` and
`<sessionDir>/plugin-data` off that value — one level too deep every time.

It did not fail loudly. `resolveShipitConfig` returns **defaults** for a missing
file rather than throwing (`shipit-config.ts:916-930`), so the config read
yielded "no plugins", the `plugin-data` probe found nothing, and the gate
returned a permanent, silent `ALLOW`. Nineteen unit tests passed, because the
fixture built a session-root-shaped directory and passed the root — a shape no
caller uses. The gate now derives everything from the clone via
`sessionRootForWorkspace` and `sessionStateDirForWorkspace`, and the runner test
constructs its runner the way production does.

### A withheld install must not publish an overlay base

`runInstall` resolving `{ ok: true }` is not enough information for its caller.
`setupServiceManager` hands the result to `publishOverlayBases`, which stamps the
rolling base pointer's `markerStamp.installCommands`
(`overlay-publish.ts:200-212`) with the list it was given. For a withheld
install that list never ran — and a later fresh session at the same commit would
get a marker pre-stamped with it, which is precisely the anchor this gate reads.
The gate would have laundered the plugin's commands into its own accepted list.
So `runInstall` returns `{ ok: true, withheld: true }` and the publish is
skipped.

## Key files

- `src/server/orchestrator/agent-install-gate.ts` — **new**. The whole decision:
  plugin-bearing predicate, accepted-list read, withheld-record read/write, and
  the notice text. Pure except for four `fs` reads and one write, so it is
  testable without a container.
- `src/server/orchestrator/container-session-runner.ts` — the gate call at the
  top of `runInstall`, beside the existing empty-commands early return, and the
  `onInstallWithheld` hook.
- `src/server/orchestrator/runner-registry-factory.ts` — wires
  `onInstallWithheld` to `emitNoticeInTurn`. The hook call is wrapped in
  `try`/`catch` at the runner: it reaches SQLite and the viewer transports, and
  `setupServiceManager` maps a throw out of `runInstall` to `{ ok: false }`,
  which latches every `dependsOnInstall` service to `error` — so a failure to
  *report* must never become a failed install (req 7).
- `src/server/orchestrator/service-manager-setup.ts` — skips the overlay publish
  for a withheld install, and carries the note on why the compose install gate
  still releases its services when the packages were discarded.
- `src/server/orchestrator/warm-pool-manager.ts` — gates the pre-install.
- `src/server/orchestrator/container-lifecycle.ts` — `removeInstallMarkerForRotation`
  writes the reset record before dropping the marker (2026-08-20).
- `src/server/orchestrator/disk-utils.ts` — `reclaimBlockedSessionCaches`, the
  same deleter under disk pressure.
- `src/server/orchestrator/overlay-session.ts` — `preStampInstallMarker` declines
  while the gate withholds.
- `src/server/orchestrator/services/claim-session.ts` — clears the record when a
  clone changes hands.
- `src/server/orchestrator/dependency-staleness.ts` — the `install-withheld`
  reason and its three surfaces.
- `src/server/orchestrator/install-reset-gate.test.ts` — **new**. The seam
  itself: rotation × gate × pre-stamp, including the ops sweep's control case
  (same rotation, same withhold, base already satisfied the checkout). Each half
  had thorough per-function coverage and each half was correct, which is why the
  seam shipped.

## What this does NOT close (req 9)

**Partly closed**, and here is the remainder:

1. **The gate stays pending after the user gets what they asked for.** When the
   user tells the agent to run the withheld command, the agent runs it in a
   shell — which does not write the install marker. So the config's list and the
   marker's list still differ, and ShipIt keeps declining to run it
   *automatically*: a later lockfile change no longer triggers the
   dependency-input reinstall (#1622) until the two agree again. The session
   works, the dependencies are installed, and the notice is not repeated. This
   is a consequence of the requester's 2026-08-17 choice of the transcript-card
   shape over an acceptance store, and is the price that choice names. **Owner:
   planning#400** — reopen if it bites.

   **The 2026-08-20 reset record inherits this, one notch louder.** The agent
   repairing the tree in a shell writes no marker, so the record is not cleared
   and the gap keeps prefixing the agent's turns until an install reaches
   `/install` (a dependency-input change, or a container recreate after the
   lists agree again). The prefix is diagnostic ordering rather than an order —
   "run this before treating a missing-module error as a code fault" — which is
   deliberately weaker than the certain case's wording, because ShipIt does not
   know the dependencies are broken and the command is not free (`npm ci`
   rebuilds `node_modules` from scratch). It resolves with the same acceptance
   store this item is waiting on.
2. **`agent.install-inputs` is not gated.** A plugin can still change which
   files trigger a reinstall, which changes *when* the accepted commands run,
   never *what* runs. Out of scope of requirement 1, recorded so it is not
   mistaken for an oversight.
3. **Requirement 4 is a deliberate hole, not a gap.** An `npm postinstall` and
   the agent itself write the workspace at the authority they already hold, so
   nothing here tries to stop them, and a plugin-bearing session's gate is
   trivially bypassed by any of them. That is the requester's scoping, stated in
   the issue.
4. **The worker's `/install` endpoint is reachable on the session subnet, and is
   closed by a token rather than by this gate.** `compose-service-egress.ts:299-304`
   allows a contained service to reach the agent, so a plugin *service* can
   route to the worker — but `shared/worker-auth.ts` requires the
   per-container token for a non-loopback caller on `/install`, and no plugin
   container holds it. This is a **load-bearing dependency of this design that
   this design does not own**: the guard's no-token fallback failed open, so a
   container created without a token would expose a direct-POST bypass of
   everything here. Verified by the independent review at the source, recorded
   because a future change to that fallback silently reopens this route.

   **Now owned and pinned (planning#421, 2026-08-17).** The fallback is gone: a
   tokenless worker refuses every non-loopback caller, and in a container it
   refuses to start at all. The dependency is a test rather than this paragraph —
   `shared/worker-auth.test.ts` and `session/worker-auth-guard.test.ts` both fail
   if the rule is relaxed, the latter by POSTing `/install` from a peer container
   IP against the real `SessionWorker` route table. See
   `docs/251-worker-trust-boundary/plan.md` §"Token resolution, and failing
   closed". The route is still not gated by *this* design — what changed is that
   the guarantee it borrows can now fail a build.
5. **The route is closed for `agent.install` only.** The other two routes are
   docs/266 (`.git`, shipped) and planning#386 (the compose file, closed). This
   design does not make `/project` safe to write in general, and docs/262 req 29
   still stands: what a plugin writes to the project is untrusted content the
   user reviews like any other change.

## Checked against the five post-turn invariants

The gate runs inside `runInstall`, which is not on the post-turn path — it is
called from session setup and from the dependency-reinstall throttle, neither of
which is reachable from `agent_result`. No commit, drain, lease, push or
branch-reset behaviour is touched, so invariants 1–5 are unaffected. The one
adjacency: the notice is emitted through `emitChatCard`, which is exactly the
helper invariant-adjacent card persistence already requires (`CLAUDE.md`, "Chat
transcript content MUST be persisted").
