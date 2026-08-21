---
issue: planning#400
title: The agent.install gate, and why it was removed
description: What the docs/271 trust gate was, why its founding requirement was withdrawn, and what the code does instead.
---

# Plan — the `agent.install` gate, removed

Implements [requirements.md](./requirements.md). **The feature this document
designed no longer exists**; only requirements 1, 6, 9 and 10 survive, and none
of them asks ShipIt to withhold anything.

## What the code does now

`agent.install` runs exactly as it did before this feature: `runInstall` posts
the declared command list to the worker, with no gate, no acceptance record, and
no transcript notice. A plugin may write `shipit.yaml` and ShipIt will run what
it says — that is requirement 1, deliberately.

## What was built, and why it went

The gate refused to run an `agent.install` list that differed from the one a
session had already accepted, when that session had a plugin. It existed because
a plugin container writes the workspace at *less* authority than the agent
container that executes `agent.install` with the credential store mounted.

It was removed because that reasoning had a hole its own requirements had
already written down. Requirement 4 excused an ordinary `npm postinstall` on the
grounds that "the writer and the executor are the same uid in the same
container". True of the *project's* postinstall — **not** of one a plugin wrote.
A plugin may write any project file (req 6), `package.json` is a project file,
and the already-accepted `npm ci` executes what it says. So a plugin reached
unattended execution in the agent container **without changing `agent.install` at
all**, and the gate never fired on the case that mattered. Closing that would
mean treating the project's own files as a containment boundary, which req 6
forbids in the requester's own words.

The requester resolved it by placing plugin code at the `package.json` dependency
trust level (req 1, 2026-08-21), then retired req 3 — the only requirement asking
ShipIt to withhold anything — along with 7, 8 and 11. Full history is in
[requirements.md](./requirements.md).

## What the removal took with it

- `agent-install-gate.ts` and its two test files.
- The gate call, acceptance record (`.install-accepted`), auto-replay, withheld
  reporting and failed-write refusal in `container-session-runner.ts`.
- The gate + record in `warm-pool-manager.ts`'s `runPreInstall`.
- `copyAcceptedInstall` at the fork call site and `clearAcceptedInstall` at the
  claim call site.
- The `withheld` outcome flag and the overlay-publish skip that read it.
- The `dependency-reset` gap phrase, which only the auto-replay produced.

The suite shrank by two files and 50 tests.

## Two things it deliberately did NOT take

Both were written on this branch, both fix bugs that predate the gate, and both
stand on their own once the gate is gone:

1. **`InstallCompletion.unverified`, and the overlay publish that honours it.**
   Three paths resolve an install `ok: true` having observed nothing — `dispose`,
   dispose-before-worker-ready, and the reconnect resync that cannot tell success
   from failure. The publisher takes `installOk` at face value, so without this a
   dropped SSE stream could snapshot a missing or half-installed dependency tree,
   publish it as the SHARED base for the whole scope, and hand every later
   session at that commit a pre-stamped marker asserting those commands
   installed. It also stops `clearDependencyGap` answering a real gap from no
   evidence — which `clearDependencyGap`'s own docstring had claimed since #2429
   while the code did the opposite.

2. **`_installInFlight` in `agentBusy`.** Disposing mid-install tears the
   container down while the worker is part-way through `npm ci`. The answer to
   "is this runner busy?" and the answer to "may it be disposed?" must not be
   able to disagree.

## The ops incident this branch opened with

A session was left serving `sh: 1: vite: not found` after a shared dependency
base rotated under it: the rotation deleted its install marker, and the gate then
refused the reinstall, so nothing rebuilt `node_modules` and no automatic repair
path existed.

**Removing the gate dissolves that incident rather than fixing it.** With no
withhold, the rotation's deleted marker simply causes the install to re-run. The
durable acceptance record and the auto-replay built to repair the stranded state
are gone with it, because the state they repaired can no longer arise.

What remains true, and is worth keeping in view for whoever next touches this
area: **a marker deletion is not a guarantee that `agent.install` will re-run
successfully.** It was the gate that broke that assumption here, but a failed
install breaks it too, and `dependency-staleness.ts` (#2429) is what reports the
resulting state.
