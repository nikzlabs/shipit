---
status: done
priority: medium
description: Declarative x-shipit-depends-on-install gate that holds compose preview services until agent.install finishes, then starts them exactly once.
---

# `x-shipit-depends-on-install` — declarative install gate for compose services

Replace the implicit "start in parallel, retry on crash, do one explicit
post-install pass" choreography for install-dependent preview services with a
declarative gate: hold a compose service until `agent.install` is finished,
then start it exactly once.

## Problem

Compose preview services that need `node_modules` (or any other
`agent.install` output) currently race the agent container on cold boot.
ShipIt today bridges that race with three independent mechanisms in
`src/server/orchestrator/service-retry-manager.ts`:

1. **Parallelism** — `service-manager-setup.ts` brackets
   `setInstallRunning(true|false)` around the install promise but does not
   block service start on it. The dev server comes up while `npm install` is
   still extracting.
2. **Install-window backoff** —
   `ServiceRetryManager.scheduleRetryWhileInstalling` exponentially backs off
   non-zero exits while `_installRunning` is true, holding the UI on
   `starting` rather than `error`.
3. **Post-install retry pass** — `flushPostInstallRetries` →
   `collectPostInstallRetryTargets` does one explicit restart of every
   service still in `error` the moment install finishes.

The result is observable as a flood of `vite: not found` / exit 127 lines
during cold boot, followed by a best-effort recovery. The post-install pass
is timing-based and best-effort: it sometimes fires before `node_modules/.bin/`
symlinks are visible to the dev container (FS cache, bind-mount sync), at
which point the service crashes one more time and there is no second pass —
it sits in `error` until the user clicks restart.

Concrete repro (observed 2026-05-19): Vite preview exited `127` four times
during install, backoff exhausted, post-install pass either didn't fire or
fired too early, service stuck in `error`. Manual `POST /services/restart`
brought it up in 194ms.

The contract documented in `src/server/shipit-docs/preview.md` is honest
about this:

> Once install finishes, ShipIt does one explicit restart pass on any
> service still in `error` so a service that crashed just before install
> completed still recovers without manual intervention.

It works most of the time. It does not work all of the time. The right fix
is not "tighten the heuristic" — it's "name the dependency."

## Design

### The field

A single compose extension on individual services:

```yaml
services:
  preview:
    image: node:24-slim
    command: npm run dev -- --host 0.0.0.0 --port 3000
    x-shipit-preview: auto
    x-shipit-depends-on-install: true   # default — gate on install
```

**Default: opt-out (`true`).** Every `preview: auto` service waits for
install unless explicitly set to `false`. Rationale: preview services that
exist *because* a project declared `agent.install` almost always depend on
the install output. The escape hatch is for the narrow case of a preview
service that is genuinely install-independent and wants fail-fast feedback.
Databases, caches, and message queues don't need the field either way —
they have no install dependency to wait for, and the gate is vacuously
satisfied for them (see "Gate signal" below).

The field's behavior is:

- **`true`** (default) — do not `docker compose up <name>` until the install
  gate is open. Once it opens, start the service exactly once.
- **`false`** — start immediately, same as today. The existing install-window
  backoff in `ServiceRetryManager` still applies as a safety net.

The field is a compose extension (the `x-` prefix), so unknown to Docker — the
generator strips it before passing the file to `docker compose`.

### Gate signal

The gate opens when **all** of the following are true:

1. `ServiceManager._installRunning === false` (in-memory flag in the
   orchestrator), AND
2. The last install attempt did not fail. If `installPromise` rejected or
   the worker reported `install_status { status: "error" }`, the gate
   stays closed and gated services latch to `error` (see "Install failure"
   below).

The disk marker `.shipit/.install-done` is **not** the gate signal. The
marker exists for resume detection across container restarts and warm-pool
claims (see `docs/039-install-command`). It can lag the in-memory flag —
the orchestrator's `setInstallRunning(false)` is the authoritative
"install finished now" event for *this* boot.

The marker still matters as a vacuous-open signal: on session resume,
when no install runs at all because the marker is present, the
`installRunning` window never opens; the gate is open from the start.
The rule reduces to:

> Open the gate whenever there is no install in flight and the last
> install attempt (if any) succeeded.

### What this replaces — and what it doesn't

For services that opt in (which is the default), the gate replaces the
install-window backoff and the post-install restart pass for that
service. `ServiceRetryManager` is not deleted — services that explicitly
set `x-shipit-depends-on-install: false`, and any legacy project that
hasn't been touched yet, still get today's three-mechanism safety net.
This is "add a fourth, cleaner mechanism that supersedes the three for
opted-in services," not "remove the three."

### Edge cases

**No `agent.install` declared.** The gate is vacuously open from boot.
Services start immediately, exactly as today. The field is a no-op for
projects without an install step.

**Install fails.** Gated services latch to `error` with a message that
names the cause: "agent.install failed — dependent service not started."
This surfaces the real failure to the user instead of a downstream
symptom (`vite: not found` etc.). Once the user fixes install and it
re-runs successfully, the gate opens and gated services start.

**`agent.install` re-runs mid-session** (shipit.yaml or lockfile edit
clears the marker, triggers re-install). Gated services are torn down at
the moment install begins, held in `starting` (gated), and restarted
exactly once when install completes. Rationale: the dependent service
runs against the *previous* install output; if install is re-running,
the deps it depended on may have changed, so a restart against the fresh
tree is the safe default. Yes, this causes a visible preview blink on
every `npm install`-triggering edit — but those edits are themselves
intentional changes to the dependency tree.

**Compose's native `depends_on`.** The ShipIt install gate is applied
first; once it opens, compose's normal `depends_on` ordering is honored
by `docker compose up`. The two compose; they don't fight.

**Multiple gated services.** When the gate opens, all gated services
start on the same `docker compose up <s1> <s2> ...` invocation so they
share startup time rather than serializing.

## Key files (as implemented)

| File | Change |
|---|---|
| `src/server/orchestrator/compose-generator.ts` | `ComposeService.dependsOnInstall` added (the per-service parsed model — there was no separate type in `domain-types.ts`). `parseComposeFile` resolves `x-shipit-depends-on-install`: explicit boolean wins, else `true` for effective `auto` preview / `false` for `manual`. No stripping needed — `x-` keys are valid compose extensions Docker ignores (same as `x-shipit-preview`). |
| `src/server/orchestrator/compose-generator.test.ts` | Covers default-auto, implicit-auto (ports), default-manual, implicit-manual (portless), explicit `false` on auto, explicit `true` on manual. |
| `src/server/orchestrator/service-manager.ts` | `ManagedService.dependsOnInstall` + `INSTALL_FAILED_GATE_MESSAGE`. Gate state: `_installFailed`, `gatedServices`. `start()` partitions auto services — non-gated start now, gated held in `starting` (or latched to `error` if a prior install failed). `setInstallRunning(running, { failed })`: `true→false` success → `startGatedServices` (one batched `up`); `true→false` fail → `latchGatedServicesToError`; `false→true` → `holdGatedServicesForReinstall` (stop + re-hold). `handleNonZeroExit` ignores gated services. `flushPostInstallRetries` (legacy net) excludes gated services. |
| `src/server/orchestrator/service-poller.ts` | New `isGated` callback — the poller skips gated services so a transient `ps` reading can't clobber the gate-owned status. |
| `src/server/orchestrator/container-session-runner.ts` | `runInstall` now returns `Promise<{ ok: boolean }>`; `signalInstallComplete(ok)` carries success/failure (from `install_done`/`install_error` and the reconnect resync). |
| `src/server/orchestrator/service-manager-setup.ts` | Plumbs the install outcome: `installPromise` is `Promise<{ ok: boolean }>`, and both the create and adopt paths call `setInstallRunning(false, { failed: !ok })`. |
| `src/server/orchestrator/service-manager.test.ts` | New "install gate" describe block: not-started-during-install, started-after-success, latched-on-failure, vacuous open, opted-out starts immediately, mixed gated/non-gated, mid-session re-install teardown+restart, batched multi-service up. Three legacy backoff-net tests updated to use `x-shipit-depends-on-install: false` (the net no longer applies to gated defaults). |
| `src/server/orchestrator/integration_tests/service-manager-adoption.test.ts` | Stub captures `setInstallRunning` opts; asserts `{ failed: false }` on success and `{ failed: true }` on failure through the adopt path. |
| `src/server/shipit-docs/preview.md`, `compose.md` | Document the field, the new default, the failure message, and the mid-session re-install blink. The "exit 127 is expected" note is now scoped to opted-out services only. |

### Implementation note: log streaming

Gated services are NOT re-streamed in the gated-start batch. `start()` already
streams logs for every service in the map (`docker compose logs -f <service>`
follows the service across its first `up`), so re-spawning a log follower in
`startGatedBatch` was both redundant and — in test environments without a real
`docker` binary — a source of duplicate spawns. The single stream from
`start()` covers gated services for their whole lifecycle.

## Out of scope

- **Removing `ServiceRetryManager`.** It remains the safety net for
  opted-out services and for OOM auto-retry, which is unrelated to install
  state.
- **Generalizing the gate to other signals.** No
  `x-shipit-depends-on: [install, build, ...]` list. If a second gate
  signal is ever needed (e.g. a build step), revisit the field's shape
  then. YAGNI now.
- **Gating non-`preview: auto` services.** The field is honored on any
  service it appears on, but the *default* (`true`) only applies to
  `x-shipit-preview: auto`. A `manual` service that the user starts
  explicitly does not get the implicit gate — explicit start means "I
  want it now."
- **Compose `depends_on` integration beyond ordering.** No attempt to
  synthesize `depends_on: { install: { condition: ... } }` because
  install isn't a compose service.

## Migration

For projects that already have `agent.install` and a preview service:
the default flip from "start in parallel" to "wait for install" is the
desired behavior — the cold-boot exit-127 noise disappears. No project
config change required.

For projects whose preview service genuinely doesn't depend on install:
set `x-shipit-depends-on-install: false` to restore today's behavior.

The `src/server/shipit-docs/preview.md` "vite: not found is expected"
section becomes a footnote that only applies to opted-out projects.

## Risks

1. **Behavioral change on cold boot for every existing project.** Today,
   a healthy preview service shows up in `starting`/`running` immediately;
   with the gate, it shows up in `starting` (gated) and only transitions
   once install completes. UX-wise this is slightly slower to first signal
   but much cleaner — no fake `error` blink, no log noise. We should
   make sure the `starting` state surfaces "waiting for install" so the
   user understands what's happening.
2. **Install that hangs forever silently breaks every preview.** Today,
   parallelism means the user sees the dev server come up (or crash-loop
   visibly) even if install is hung. With the gate, a hung install means
   nothing visible. Mitigation: the install panel already surfaces install
   progress; we should make sure a hung install (no output for N minutes)
   surfaces a warning. This is largely an existing problem the gate makes
   slightly more visible.
3. **Mid-session re-install causes a preview blink.** Acceptable per the
   "shipit.yaml or lockfile edit means the dependency tree changed" rationale,
   but worth documenting in the user-facing preview.md so users aren't
   surprised.
