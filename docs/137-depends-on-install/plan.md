---
status: planned
priority: medium
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

## Key files

| File | Change |
|---|---|
| `src/server/shared/types/domain-types.ts` | Add `dependsOnInstall: boolean` to the per-service config type (default `true`). |
| `src/server/orchestrator/compose-generator.ts` | Parse and strip `x-shipit-depends-on-install` from each service. Default to `true` when `x-shipit-preview` is `auto`; `false` for `manual`. Capture per-service flag in the parsed model. |
| `src/server/orchestrator/compose-generator.test.ts` | Cover default, explicit `true`, explicit `false`, and the `manual`-preview default. |
| `src/server/orchestrator/service-manager.ts` | In the auto-start path, partition services by `dependsOnInstall`. Start non-gated ones immediately (today's path). For gated ones: register them with the manager but defer `docker compose up`. Hook into `setInstallRunning(false)`: when the install succeeded, start every gated service in one batched `up`; when it failed, latch each gated service to `error` with the cause message. Mid-session re-install: when `setInstallRunning(true)` flips, `docker compose stop` gated services and re-enter the gated state. |
| `src/server/orchestrator/service-manager.test.ts` | Add cases: gated service not started during install, started after install success, latched to error after install failure, restarted after mid-session re-install, no-install vacuous open, mixed gated + non-gated services. |
| `src/server/shipit-docs/preview.md` | Document the new field and the new default. Remove the "exit 127 is expected" footnote — it now only applies to projects that explicitly opt out. |
| `src/server/shipit-docs/compose.md` | Add the field to the `x-shipit-*` reference. |
| `src/server/orchestrator/integration_tests/service-manager-*.test.ts` | One end-to-end integration test: fake install promise + fake compose, assert the gate ordering. |

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
