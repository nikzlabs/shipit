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
(`container-session-runner.ts:1782`) is the **single** orchestrator-side
chokepoint through which a session's own `agent.install` reaches the worker.
Verified by enumerating its callers:

| Caller | Path |
|---|---|
| `service-manager-setup.ts:472` | session setup / container (re)create — the **restart path** (req 5) |
| `container-session-runner.ts:2020` (`maybeReinstallForDepChange`) | the live `shipit.yaml` delta the issue names, and the dep-file reinstall |
| `plugin-generations.ts:835` | a **different** `deps.runInstall` — the plugin's *own* generation install, object-shaped signature, not this method |
| `warm-pool-manager.ts:282,293` | comments only, no call |

So the two paths requirement 5 needs covered converge on one function, and the
gate is one `if` rather than a rule duplicated at each site. This is the reason
the gate is *not* placed in `applyShipitConfigChange` where the issue found the
bug: that closes the watcher delta and leaves the restart path open.

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

## Key files

- `src/server/orchestrator/agent-install-gate.ts` — **new**. The whole decision:
  plugin-bearing predicate, accepted-list read, withheld-record read/write, and
  the notice text. Pure except for four `fs` reads and one write, so it is
  testable without a container.
- `src/server/orchestrator/container-session-runner.ts` — the gate call at the
  top of `runInstall`, beside the existing empty-commands early return, and the
  `onInstallWithheld` hook.
- `src/server/orchestrator/runner-registry-factory.ts` — wires
  `onInstallWithheld` to `emitNoticeInTurn`.

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
2. **`agent.install-inputs` is not gated.** A plugin can still change which
   files trigger a reinstall, which changes *when* the accepted commands run,
   never *what* runs. Out of scope of requirement 1, recorded so it is not
   mistaken for an oversight.
3. **Requirement 4 is a deliberate hole, not a gap.** An `npm postinstall` and
   the agent itself write the workspace at the authority they already hold, so
   nothing here tries to stop them, and a plugin-bearing session's gate is
   trivially bypassed by any of them. That is the requester's scoping, stated in
   the issue.
4. **The route is closed for `agent.install` only.** The other two routes are
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
