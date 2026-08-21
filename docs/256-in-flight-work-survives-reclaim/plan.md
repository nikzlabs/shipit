---
title: In-flight work survives reclamation — design
description: An agent-declared, heartbeat-renewed keep-alive that folds into agentBusy, so both container reapers stop destroying work that is still running.
---

# 256 — Design

Implements [`requirements.md`](requirements.md). Current behavior it is built
on is verified in [`investigation.md`](investigation.md).

## The problem in one line

Between turns, a job the agent left running is invisible: `agentBusy` sees a
running turn, a reported background-task list that decays after 10 minutes, and
in-flight sub-agent consults — but nothing about a process the agent detached
into the container (req 2). So the session reads as idle and both reapers are
free to destroy it (req 1).

## Shape: a wrapper, not a take/release pair

The agent declares the work (req 6) and the declaration lapses unless
re-asserted (req 7). The load-bearing constraint is that **there is no agent
between turns.** The model is not resident; it exists only while a turn
streams. So the thing renewing the heartbeat cannot be the agent's own loop,
and a bare `take` / `release` pair would need a daemon whose liveness nothing
verifies — exactly the failure mode requirement 7 exists to prevent.

Make the renewer the work's own supervisor:

```bash
nohup shipit session keepalive run --reason "docs/247 pass B" \
  -- python3 pass-b.py > pass-b.log 2>&1 &
```

`keepalive run` spawns the command as a child, renews while it lives, releases
when it exits, and exits with the child's exit code. That collapses three
things into process liveness:

- **The declaration** is the agent wrapping the command — explicit, one
  decision, at the moment it starts the work (req 6).
- **The heartbeat** is automatic. Nothing to remember, no turn to be alive for
  (req 3, req 7).
- **The release** is the child exiting. A leaked hold requires a leaked
  process, and a leaked process is a problem the container's own lifetime
  already bounds.

Second subcommand, `shipit session keepalive status [--json]`, lists this
session's live holds (reason, taken-at, expires-at). It is how the agent, on a
later turn, learns whether its job is *still* protected — and, more usefully,
learns that it is not.

Deliberately **not** offered: a bare `keepalive take` with a caller-supplied
TTL. It reintroduces the unverifiable holder, and the only honest way to use it
is to build the wrapper by hand.

## Orchestrator state: fold into `agentBusy`

A hold is runner state, held in a Map on `ContainerSessionRunner`:

```ts
interface KeepaliveHold { id: string; reason: string; takenAt: number; expiresAt: number }
get keepaliveHoldCount(): number   // non-expired holds, computed on read
get agentBusy(): boolean {
  return this._isRunning
    || this.backgroundTaskCount > 0
    || this.subAgentSpawnsInFlight > 0
    || this.keepaliveHoldCount > 0;   // <- new
}
```

Folding into `agentBusy` rather than adding a fifth guard to each reaper is the
whole design, and it discharges three requirements without new code in either
reaper:

- **req 5 (one coherent answer).** Both `idle-enforcer.ts` and
  `canAutoDescend` already consult `agentBusy`, so a hold cannot protect a
  session from one reaper and not the other. This is the failure the landed
  `keepPreviewRunning` fix was: a new per-reaper guard is how that asymmetry
  got created in the first place.
- **req 8 (pressure does not override).** `idle-enforcer.ts:128` checks
  `agentBusy` and `continue`s *before* anything pressure-dependent — pressure
  only lowers `maxIdle` and bypasses the disconnect grace. So a hold survives
  memory pressure with zero pressure-specific code, matching docs/235's
  explicit refusal to let pressure override `agentBusy`.
- **req 3 (no viewer needed).** `agentBusy` is orthogonal to `viewerCount`.

Expiry is **computed on read**, the way `BackgroundTaskTracker` decays — no
timer to leak, and the only consumer that matters is a 30-second tick.

`runner.dispose()` gets the same non-forced refusal it already has for
`_subAgentAborts` (`container-session-runner.ts:2531`). Since planning#298 the idle
enforcer destroys the container only after the runner *accepts* disposal, so
the runner-level guard and the enforcer can never disagree.

### Renewal is create-or-refresh, and that matters

A renewal POST that names an unknown hold id **creates** it rather than
failing. That makes holds self-healing across an orchestrator restart, which
the reported-hint signal next door explicitly is not: `backgroundTaskCount` is
emitted only on change with no re-statement and no pull API, so a restart loses
it permanently (`investigation.md`). Here the next heartbeat rebuilds the
truth.

**Residual, accepted:** between an orchestrator restart and the first renewal
the hold is unknown. Renew every **30 s** with a **5-minute** TTL, so that
window is under one renewal interval, and reclamation additionally requires the
session to be in the excess-idle set. The 10× ratio is deliberate: the reaper
ticks every 30 s, so a tight TTL would flap on a busy host, while five minutes
is short enough that a genuinely dead job's container is not held long.

## Requirement 4 — when it dies anyway

Holds do not stop a forced teardown: Restart container, Restart agent, archive,
full reset, shutdown, and the OOM breaker all pass `{ force: true }`. Today
that work vanishes with no record anywhere, which is the "silently dies" half
of the complaint.

When `dispose({ force: true })` runs with live holds, emit a **persisted**
transcript card naming them ("Stopped this session's container while 1 declared
background job was still running: docs/247 pass B"). Persisted, not emitted:
per CLAUDE.md this is transcript content the user expects to still be there
tomorrow, and it is a side-channel card arriving outside the agent-event stream
— so it goes through `emitChatCard` (`chat-card-persistence.ts`), never a bare
`emitMessage`, and never a hand-rolled `recordChatCard` + `persistTurnInProgress`
at a call site that can run post-turn (docs/236). Adding it means the full card
recipe: a typed `PersistedMessage` field, column + migration, rehydration,
`CARD_MESSAGE_FIELDS`, and the two guard tests that make the checklist
self-enforcing (`docs/188`, `docs/191`).

A hold **expiring** — the heartbeat stopped because the job crashed or was
killed — is logged, not carded. ShipIt did not do that, and the job's own
output is where that story belongs.

## Requirement 5 — what each protection means, stated

After this there are three protections with three deliberately different
scopes, and the design is that each one says so:

| | Sidebar / disk | Container vs. idle enforcer | Container vs. disk ladder |
|---|---|---|---|
| `pinnedAt` | yes | no (req 9) | yes |
| `keepPreviewRunning` | — | yes | yes *(fixed in this branch)* |
| keep-alive hold | — | yes | yes |

The pin's UI copy was checked and needs no change: the menu item reads "Pin to
top", which claims exactly what it does. The misreading came from the concept,
not the wording, so the fix is in the docs and type comments rather than the
component.

## Touchpoints

- `src/server/session/agent-shim/shipit-session.ts` — `keepalive run` /
  `keepalive status`; `shipit.ts` for dispatch, HELP, and the rejected-subcommand
  gate.
- `src/server/session/agent-ops-routes.ts` — `/agent-ops/keepalive/*`, a thin
  pass-through; the worker injects the trusted session id, so the shim can
  never hold a lease against another session.
- `src/server/orchestrator/api-routes-agent.ts` (or a sibling) — the
  session-scoped orchestrator route the broker relays to.
- `src/server/orchestrator/container-session-runner.ts` — the hold Map,
  `keepaliveHoldCount`, the `agentBusy` union, the `dispose` refusal, and the
  forced-teardown card.
- `src/server/orchestrator/session-runner.ts` — `SessionRunnerInterface`.
- `src/server/orchestrator/chat-card-persistence.ts` + the card recipe files.
- `src/server/shipit-docs/environment.md` — **required.** It currently tells
  the agent, correctly, that runtime background work has no durability
  guarantee and belongs in Compose. That promise changes here and the
  agent-facing copy has to change with it, including the fact that a hold
  protects against *reclamation* and not against a user restart.
- `src/server/shipit-docs/sessions.md` — the `shipit session` surface.

## Bounds — what this does not do

- **It does not resurrect anything.** A hold prevents destroying a container
  that is working; it cannot bring back one already destroyed. docs/235's
  bound stands.
- **A wedged-but-alive process holds its container indefinitely.** That is the
  direct consequence of choosing a heartbeat over a maximum duration (req 7's
  receipt) and of pressure not overriding (req 8). The escape hatch is the
  existing explicit user teardown, which now says what it killed.
- **An unwrapped `Bash(run_in_background)` job longer than 10 minutes is still
  unprotected**, because the reported task list decays and nothing refreshes it
  (`investigation.md`). Adding a refresh path was the rejected option in the
  first resolved question; declaring the work is the supported path.
- **`nohup` remains the agent's own business.** `keepalive run` protects the
  container; keeping the process alive across the agent CLI's exit is still
  what `nohup … &` is for.
