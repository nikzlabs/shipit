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
  see [The acceptance record](#the-acceptance-record-2026-08-20) below). "A marker already
  exists" is not a one-way door: five paths delete an *established* session's
  marker on purpose (tabulated below), and each re-opens the pre-stamp window on
  a session a plugin container has already run in. Observed on the production host: the gate withheld a changed list at
  17:11:13 and a new marker recorded that same list as accepted at 17:11:19.

  The mitigation named at the time — a base pointer's `installCommands` can only
  come from an install that genuinely ran (`service-manager-setup.ts` skips the
  publish when the install was withheld) — holds, and it does mean a plugin
  cannot inject an *arbitrary* command by this route. It is not sufficient. A
  fresh plugin-bearing session allows its `agent.install` by design, publishes a
  base from it, and the pointer then carries that list; the pre-stamp would
  promote it into an *established* session's accepted list, which is the one
  thing this gate exists to prevent.

  **It is closed by the acceptance record, not by a check on the pre-stamp.** An
  intermediate revision did gate `preStampInstallMarker` on the trust verdict;
  that was removed once the record existed, because the record outranks any
  marker and a pre-stamped one therefore cannot move what a session has accepted.
  Redundant security-shaped code is a liability, not depth — it reads as the
  thing holding the boundary, and the next person to touch it has to re-derive
  that it is not.

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

## The acceptance record (2026-08-20)

Found live in an ops session, on the production commit `a19702c5`. Session
`fba1ee31`'s dev service died on `sh: 1: vite: not found`, exit 127, with nothing
anywhere connecting that to ShipIt. Two subsystems, each correct on its own,
disagreed and nothing reconciled them:

- `prepareOverlayDirs` (`container-lifecycle.ts`) reaps a session's superseded
  copy-on-write upper layer when the shared dependency base rotates, and drops
  the install marker **because `agent.install` must run again** — its own
  docstring names the failure it is preventing, "leaving the session with the
  base's deps and none of its own".
- This gate refuses to run it.

The result is a session with unverified dependencies, a dev service failing with
an unrelated-looking error, and — because the marker delete re-opened the
pre-stamp window — a fresh marker asserting the base satisfied the checkout,
which suppressed every later attempt to repair it.

### The marker was carrying two facts

"These dependencies are installed" and "the user accepted this command list" are
not the same claim. The first is a property of a `node_modules` tree, and it is
*correctly* discarded whenever that tree stops being trustworthy. The second is a
property of the **session**, and must survive everything short of the session
changing hands. Storing both in `.install-done` meant every dependency-driven
delete silently erased an acceptance.

**The first attempt at this fix preserved acceptance by writing a tombstone at
each place that deletes the marker. That was the wrong shape, and the second
independent review is what showed it.** The enumeration cannot be completed:

| Deleter | Where |
|---|---|
| base-generation rotation | `container-lifecycle.ts` |
| blocked-session cache reclaim | `disk-utils.ts` |
| disk-tier eviction of `state/` | `disk-utils.ts` |
| claim handing the clone on | `services/claim-session.ts` |
| **whiteout before every real reinstall** | `session/install-controller.ts` — **another process** |

The last one is decisive. The worker removes the marker before running the
commands and deliberately writes none back if they fail, and nothing
orchestrator-side observes it. So a stale-marker reinstall that failed left an
established, plugin-bearing session with no marker and no tombstone — where
`null` reads as "first install" and **allows**. Enumerating deleters is a race
against the next one somebody adds.

### So acceptance is recorded where acceptance happens

`INSTALL_ACCEPTED_FILE` (`.install-accepted`) is written by exactly one caller:
`runInstall`, **at the moment the gate ALLOWS a command list** — before the POST,
not after the completion. One writer, no enumeration, and no amount of
dependency-state deletion by either process can move it. `null` now means what it
always claimed to: nothing has ever been authorized in this session, which is the
first-time case the docs/178 repo-trust decision covers.

**Acceptance means AUTHORIZED, not RAN, and the distinction is load-bearing.**
The first draft recorded on completion-with-positive-evidence, reasoning that an
install running to completion *is* the user's session accepting a list. The
security review of 2026-08-20 found what that leaves open: a completion can be
*synthesized* rather than observed (`unverified` — a dispose, a reconnect resync
with no last result), and a session whose FIRST install resolved that way wrote
no record at all. The marker was then its only anchor, and five paths delete the
marker. Lose it and an established, plugin-bearing session reads as a first
install. Recording at the ALLOW grants nothing new — the gate has just permitted
that exact list — and it cannot be skipped by any outcome downstream of the
decision. Remainder 5 has the cost.

Three properties follow:

- **It is not under `state/`.** That subtree is in `REGENERABLE_SESSION_SUBDIRS`,
  so disk-tier eviction deletes all of it — correctly, since everything in it can
  be rebuilt. An acceptance record cannot. And `plugin-data/` is a deliberately
  **durable** sibling, so a restored session is still plugin-bearing: an anchor
  stored beside the marker would mean eviction alone handed the credential-bearing
  container a command list nobody accepted. It goes where the other durable,
  non-git session data goes — a sibling of `workspace/`, the `uploads/` convention
  (docs/217) the reclaim allowlist leaves alone.
- **The write is atomic and a failure is safe.** Temp + rename, so a reader sees
  one whole record or the other. A failed write leaves the *previous* accepted
  list standing, which withholds the new one until an install succeeds again —
  the safe direction. (The tombstone design had the opposite failure mode: a
  failed write under disk pressure, where one of its callers ran *by definition*,
  lost the anchor and allowed.)
- **A record that exists but cannot be read fails closed.** It resolves to an
  empty accepted list, which matches no request and so withholds — not to
  "absent", which allows. The file's existence is itself the evidence that
  something was accepted and we have lost track of what. A record that *parses*
  but has lost its `pluginBearing` fails closed the same way (`!== false`), so
  the two halves of the reader cannot disagree — see remainder 6.

`claim-session.ts` clears it when a clone changes hands, alongside the marker
unlink it already did — a new occupant inherits no acceptance.

**Migration, and its honest limit.** A session that accepted a list *before* this
record existed answers from its marker once, and `evaluateInstallGate` backfills
a record from that answer. That covers a session whose marker is still intact
when it next reaches the gate — the overwhelming majority, since the gate runs at
every session setup. It does **not** cover the other ordering: a pre-record
session whose marker is destroyed *before* its first post-upgrade gate evaluation
has neither source, reads as a first install, and allows. That is exactly the
behaviour that shipped before this record existed, so it is a window that fails
to close rather than a regression — but it is a window, it is not closed by the
backfill, and an earlier draft of this section claimed otherwise.

### Repairing it, rather than narrating it

A withhold that lands on a session whose install marker is gone is the incident:
the install that would rebuild the dependency tree is exactly the one being
refused, so the service dies on `sh: 1: vite: not found` and its log blames the
user's project.

**ShipIt re-runs the list it already accepted.** That is not the withheld command
and it is not new authority — `verdict.accepted` is the list that last completed
in this session, the one ShipIt re-runs unattended on every ordinary container
recreate. Requirement 4 forbids running the CHANGED list on ShipIt's own
initiative, and this does not; requirement 8's remedy for *getting* the new
command — the user asking the agent — is untouched. The user is still told once,
per distinct list, that the changed list was not run.

`afterDependencyReset` is **derived, not stored**: whether the install marker is
absent. That covers every route into the state without enumerating them —
including the worker's whiteout, which no orchestrator-side tombstone could see.

`withheld: true` still rides on the return even when the replay succeeded, and
that is load-bearing: `setupServiceManager` hands the overlay publish the
CONFIG's command list, so publishing here would stamp the shared base pointer
with commands that did not run.

**An earlier revision of this fix did not repair; it reported.** It added a third
`DependencyGap` reason with three surfaces — a persisted transcript notice, a
service-list line, and a per-turn agent prompt prefix telling the agent to run
the install before trusting a missing-module error. A review pass asked the
opposite question of every element, and that machinery did not survive it:

- It narrated a dead service instead of fixing one, while the fix was a command
  ShipIt was already permitted to run.
- The per-turn prefix repeated indefinitely, including after the user had
  repaired the tree by hand, because a shell install writes no marker.
- Worst, it **reproduced the incident**. The notice was de-duplicated per
  command list, and the ordinary withhold had already recorded that list while
  the marker was intact and the packages were fine — so on the recreate that
  actually discarded them, `alreadyReported` was true and the user was told
  nothing at all. Repair does not depend on having something to say, so it
  happens either way.

A replay that FAILS is a genuine install failure and reaches the existing
machinery: the compose gate latches dependent services to `error`, and the gap is
recorded with the existing `install-failed` reason and a `dependency-reset`
label, so the notice names what moved rather than inventing a fourth surface.

### Why the compose install gate still starts the services

The obvious move is to close the gate as a failure when the reinstall was
withheld, holding `dependsOnInstall` services instead of starting them into an
exit 127. That is wrong, and the deciding evidence came from the ops sweep: a
**control session** took the same rotation and the same withhold and came up
serving, because the shared base already satisfied its checkout. The signal is
"unverified", never "broken". Latching on an unverified means definite outages for
healthy sessions, at the scale of every session pinned to a superseded generation
(34 on that host), and it takes the diagnosis down with them: a service latched
before it ever starts produces no failure for anyone to read. Starting it costs a
crash loop in the genuinely-broken case, by which point the reason is already in
the three places the reader reaches first.

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
- `src/server/orchestrator/warm-pool-manager.ts` — gates the pre-install **and
  records the acceptance**. This is the one install path that does not go
  through `ContainerSessionRunner.runInstall`, and it gated without recording, so
  the invariant "a durable acceptance exists before every permitted POST" held
  everywhere except here — while this path also stamps the marker the gate falls
  back to. Found by the third review; the pre-existing comment already knew the
  path was special and concluded, wrongly, that gating it was enough.
- `src/server/orchestrator/services/claim-session.ts` — drops the acceptance
  record when a clone changes hands, beside the marker unlink it already did.
- `src/server/orchestrator/services/session-fork-merge.ts` — carries the record
  into a fork, which inherits the parent's mutated workspace and would otherwise
  read as a first install and run what the parent refused. The copy resolves the
  parent's acceptance the same way the gate does (record, then marker) and
  **throws** if the child's write fails, aborting the fork before
  `sessionManager.track()`: a failed record write is survivable in-session
  because the previous one is still on disk, and on a fork there is no previous
  one, so the same failure would hand the child a clean-looking first install.
- `src/server/orchestrator/overlay-session.ts` — nothing. `preStampInstallMarker`
  used to consult the gate; that call was **removed** once the record outranked
  the marker, because a pre-stamped marker can no longer move what the session
  has accepted. Listed to say so: the earlier revision of this doc claimed the
  check was still there.
- `src/server/orchestrator/dependency-staleness.ts` — the gap surfaces. There is
  no `install-withheld` reason: an earlier revision had one, and it was removed
  when the design changed from *narrating* the withhold to *repairing* it. The
  reasons are `not-content-keyed` and `install-failed`, and `dependency-reset` is
  a rewrite phrase rather than a reason.
- `src/server/orchestrator/install-acceptance-gate.test.ts` — **new**. The seam
  itself, written against the STATES the gate can find a session in rather than
  the operations that produce them: the marker-destroyer table is data, so a
  sixth way to lose the marker needs no sixth test. Each half had thorough
  per-function coverage and each half was correct, which is why the seam shipped.

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

   **The 2026-08-20 acceptance record inherits this, one notch louder.** The agent
   repairing the tree in a shell writes no marker, so the gap keeps prefixing the
   agent's turns until an install reaches
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
5. **CLOSED (2026-08-20).** *A first install that completed UNVERIFIED left no
   record, so a later marker loss re-opened the first-install allow.* Found by
   the 2026-08-20
   security review of the acceptance record. When a completion is synthesized
   rather than observed (dispose before the worker was ready, `dispose()`, a
   resync with no last result) ShipIt deliberately records no acceptance — it has
   no evidence anything ran. The worker may nonetheless have written the marker.
   If the *next* gate call happens while that marker exists, the migration
   backfills a record and the window shuts; if disk eviction takes `state/`
   first, the session reaches the gate plugin-bearing with neither source and
   reads as a first install, so a list a plugin has since written to
   `shipit.yaml` runs unattended.

   Narrower than it first looks: the gate backfills on *every* call that
   resolves an accepted list, so this needs the session's **first** install to be
   the unverified one — any earlier verified install leaves a record that no
   marker deletion can move. It is nonetheless the incident's own class, and the
   eviction half is the exact path that caused it.

   **Fixed by moving where acceptance is recorded** — from the completion to the
   gate's ALLOW in `runInstall`, which is one event earlier and unconditional.
   The record's meaning changes with it, from *what ran* to **what was
   authorized**, and that is the substance of the fix rather than a side effect:
   acceptance is a property of the decision, and by that line the decision has
   been made. It grants nothing new, because the gate has just allowed that exact
   list.

   Raised as a trust-model change rather than self-promoted, and approved on
   2026-08-20. **The cost, stated plainly:** a plugin-bearing session that
   changes its own `agent.install` between an *allowed* attempt and a
   *successful* one is now withheld, where before it was allowed until the first
   install completed. That is the gate's ordinary behaviour arriving one event
   earlier, with the req 8 remedy unchanged.

   Two things fell out. `clearDependencyGap` no longer records acceptance, so it
   is back to what its name says and lost its `commands` parameter. And the
   `result.joined` guard at its call site went with it: it existed only because
   coalescing onto a *different* list made the completion no evidence about ours,
   which stops mattering once the record means "authorized". Guard:
   `container-session-runner.test.ts` → "records acceptance on a first install
   that completes with no evidence", written as the incident's own sequence.

   **Recording earlier is not enough on its own, because the recording can
   fail.** `recordAcceptedInstall` is best-effort — it logs and returns `false` —
   so a first install whose write failed proceeded with no durable
   authorization, and if it then resolved unverified (or failed after the worker
   whiteouted the marker) the session was left with neither source and the next
   plugin-written list read as a first install. Found by the review of the fix
   itself. The invariant is therefore **no unattended install runs in a session
   that needs a gate unless its authorization is durably recorded**: on a failed
   write `runInstall` re-reads the anchor, and if there is none AND the session
   is plugin-bearing it returns `{ ok: false, withheld: true }` so
   `dependsOnInstall` services latch with a cause. Both halves of that condition
   are load-bearing and both are guarded — a plugin-free session's failed write
   must NOT cost it its install, since the gate's first line allows it
   regardless.

   **The re-read is `readAcceptedInstall`, NOT `acceptedInstallCommands`, and a
   second review of this fix is what found the difference.** The convenient
   helper resolves record-then-**marker**, and the marker is exactly what the
   permitted install is about to destroy: the worker whiteouts it before every
   reinstall (`install-controller.ts:183`) so a partial run cannot leave a stamp
   claiming success. Accepting it asks *"does an acceptance source exist right
   now"* when the question is *"will a durable one survive this install"* — so a
   pre-record session whose migration backfill had also failed passed the guard,
   lost its marker to the reinstall, and on a failed reinstall ended with neither
   source. That is the original fail-open, reached through the migration path.
   An `UNREADABLE` record is non-null and therefore counts as durable, which is
   right: it fails closed at every later gate.

   `withheld: true` rides on the refusal for the same reason it rides on the
   unrepairable branch — without it `reinstallForDepChange` falls past its
   `res.withheld` return and records an `install-failed` gap, telling the user in
   the transcript and the agent's turn prefix that ShipIt ran these commands and
   they failed. Nothing was posted.

   The refusal returns directly, without `signalInstallComplete`, for the same
   reason the withheld branches above it do: the completion promise is not armed
   until the concurrency guard, so signalling there would either do nothing or
   resolve a *concurrent* caller's promise with a failure that is not theirs.
6. **CLOSED (2026-08-20).** *A well-formed record that merely lacked
   `pluginBearing` was not fail-closed.* Same review. `readAcceptedInstall` fails
   closed on every *unparseable* record — bad JSON, a directory, `EACCES`, a
   `commands` that is not a string array all resolve to `UNREADABLE`, which gates
   — but valid JSON whose `pluginBearing` was absent read as `false`, and if the
   session's live plugin evidence is also gone (the fork case) nothing gated it.

   Now parsed as `!== false`: only an EXPLICIT `false` leaves a record ungated,
   so the two halves of the reader agree instead of contradicting each other.

   **The migration cost this was originally deferred for is nil for every
   released session, and non-zero for pre-merge ones.** The record has never
   reached `main` (`git show
   origin/main:src/server/orchestrator/agent-install-gate.ts` matches none of
   `install-accepted`, `INSTALL_ACCEPTED`, `pluginBearing`; the record-adding
   commits are ancestors of no tag and of neither `main` nor `origin/main`), so
   no released session can hold a record at all and the schema-version
   alternative was not needed.

   **The stronger claim — "no on-disk record anywhere predates the field" — was
   wrong, and an earlier revision of this paragraph asserted it.** Commit
   `94d199c0`, already pushed on this branch, wrote `{ commands, at }` with no
   `pluginBearing`. A dogfood or preview instance that ran that revision against
   a persistent session root, and is then upgraded, holds a flagless record — and
   under `!== false` that session starts gating where it did not before. Fails
   closed, costs a pre-merge environment one "ask the agent", and is named here
   rather than smoothed over: the verification supported the narrow claim and the
   broad one was assumed on top of it.

   Guarded in both directions, and across every non-`false` shape rather than
   just the absent one — `install-acceptance-gate.test.ts` gates a record whose
   flag is absent, `null`, `"false"`, `0` or an object, AND keeps allowing an
   explicitly plugin-free one, AND gates that same session once live plugin
   evidence appears. So "fail closed" cannot be satisfied by gating everything,
   and "default the missing one" cannot be satisfied by special-casing
   `undefined`.
7. **A plugin-free session whose record is damaged now gates, where before it
   had no record to damage.** Found by the review of the remainder-5 fix, and it
   is the cost of writing the record for *every* session rather than only for
   ones that completed an install. Sequence: a session that never had a plugin
   writes `{ commands: A, pluginBearing: false }` at its first ALLOW; the record
   then becomes unreadable through a permission or ownership fault; it resolves
   to `UNREADABLE`, whose flag is `true` and whose command list is empty; so
   retrying A is withheld, and with no marker it comes back `{ ok: false,
   withheld: true }`. A plugin-free session is then stuck behind a gate it has no
   plugin to justify.

   Needs a **second** storage fault to reach, and the alternative is worse: the
   only way to avoid it is to make `UNREADABLE` allow, which reopens the
   fail-open that a record's mere existence is evidence against. Accepted, and
   named so it is not rediscovered as a surprise. **Owner: planning#400.**
8. **OPEN — a refusal is not durable, so it delays the first-install ALLOW
   rather than closing it.** Found by the third review, and it is the root the
   two blockers before it were downstream of. Sequence: a fresh plugin-bearing
   session allows list A; persisting A fails, so `runInstall` refuses without
   posting. Plugin activation ran independently — a plugin service does not
   depend on the project install (`plugin-compose.ts:1351`, `dependsOnInstall:
   svc.self`) — so a plugin container is live and writes list B. Storage
   recovers. The gate still sees no record and no marker, classifies B as a first
   install, records it and runs it. **The plugin's list becomes its own
   authorization.**

   Refusing is not what opens this; *not being able to write* is. The same end
   state is reached without any refusal at all, by an install that simply fails
   after the worker has whiteouted the marker. And note the refusal is not
   strictly safer than proceeding: had A been allowed to run and SUCCEEDED, the
   worker's marker would have anchored the session and B would have been
   withheld.

   So the real defect is that **`evaluateInstallGate` treats "no acceptance
   source" as "fresh session"**, when durable on-disk plugin evidence
   (`plugin-data/<alias>/state`, written when a plugin container actually ran)
   proves the session is not fresh and its `shipit.yaml` may already be
   plugin-authored. Closing it means the first-install ALLOW no longer applies to
   such a session — which narrows the docs/178 repo-trust grant that req 6
   reaffirmed on 2026-08-17, and can leave a session with no anchor, no marker
   and no replayable list latching its `dependsOnInstall` services to `error`.
   That is a requester decision and a blast radius, not a bug fix, so it is
   raised rather than taken. **Owner: planning#400.**
9. **The route is closed for `agent.install` only.** The other two routes are
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
