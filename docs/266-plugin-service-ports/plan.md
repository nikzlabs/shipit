---
issue: planning#395
title: Plugin service ports belong to the consuming project — design
description: How the port moves from the plugin's fragment to the consumer's plugins.use entry, and what that deletes.
---

# Plugin service ports belong to the consuming project — design

Implements [`requirements.md`](./requirements.md). Requirements are cited as
`(req N)`. All eight open questions were answered on 2026-08-16; the receipts
are in that document.

## The shape

Today a plugin repository's exported compose fragment declares `ports:`, ShipIt
reads the container port out of it, and prefers that number as the service's
preview routing key whenever it "looks free". That hands the plugin author a
decision only the consuming project can make, and
[nikzlabs/shipit#2325](https://github.com/nikzlabs/shipit/issues/2325) is what
it looks like from the outside.

After this change the number is written in exactly one place — the consuming
project's `plugins.use` entry, next to `autostart` and `as`:

```yaml
plugins:
  use:
    - plugin: requirements
      from: tools
      overrides:
        services:
          web:
            port: 4300        # req 2 — the consumer's number, always explicit
```

`port` is the service's **container port and its preview origin at once**, as a
project service's port already is (req 10). There is no second number.

## What each requirement costs

### req 1, 6 — the fragment stops declaring a port

`ports` leaves `ALLOWED_SERVICE_KEYS` (`plugin-compose.ts`), and a dedicated
check ahead of the generic allowlist loop refuses it by name. Dedicated because
this is the one refused key that used to be legal: the reader needs the rule and
the line to delete, not "not supported". That refusal lands on the plugin
repository's own card, which is the report req 6 asks for. There is no migration
window — a fragment written under the old rule is invalid, and that same refusal
is how a consuming project learns one of its imports was written under it.

`readPorts` goes with it. `PluginFragmentService.port` stays, but now carries
the CONSUMER's number rather than the fragment's.

### req 2, 9 — the consumer writes it, and that is what makes it previewable

`PluginServiceOverride` gains `port?: number`, `KNOWN_SERVICE_OVERRIDE_KEYS`
gains `"port"`, and the value is validated as an integer in 1–65535
(`shared/plugin-repos.ts`). The override is keyed by the fragment's **source**
service name, like `autostart` and `as`.

Req 9 needs **no flag at all**. A plugin service the project names no port for
carries no port, and the pane's list is built from ports
(`buildDetectedPortsFromServices`), so it cannot reach the pane — previewability
is carried entirely by the port's presence, with nothing to keep in step.

`preview: "auto" | "manual"` therefore keeps meaning what req 16 says it means —
*does this start with the stack* — and the port only replaces the fragment's own
`ports:` as its **default**:

```ts
const override = use.overrides.services[source.name]?.autostart;
if (override !== undefined) return override ? "auto" : "manual";   // req 16, unchanged
if (source.preview !== undefined) return source.preview;           // the author's answer
return port !== undefined ? "auto" : "manual";                     // the new default
```

Keeping those two questions apart matters, and it took two goes. A portless
worker the consumer wrote `autostart: true` for still starts, and simply has
nothing to preview — making "no port" force `manual` would have broken that, and
was caught by the existing req 16 test. The second layer is the same mistake one
level down: letting the port override an *explicit* `x-shipit-preview` would
silently drop a key the fragment declared, stopping a portless worker the AUTHOR
marked `auto` with nothing anywhere saying why. So the port is the default only,
below both the consumer's override and the author's explicit answer.

### req 7 — one number written twice is refused

Two checks, in the two places that can actually answer:

- **Plugin against plugin** — both numbers are in `shipit.yaml`, so this is
  settled at declaration parse (`collectPluginFragments`). The import that
  collides is refused whole, matching the existing all-or-nothing-per-import
  rule, and the message names both services.
- **Plugin against the project's own** — decided in `ServiceManager`, against
  the parse that actually runs, **not** the plugin resolver's separate
  `readProjectServices` read. That second read disagreeing with the live stack
  is what let #2325 through, so it must not be the thing that refuses. The
  plugin service is dropped and reported, naming both.

  "The parse that actually runs" is literal, and was not at first
  ([nikzlabs/shipit#2379](https://github.com/nikzlabs/shipit/issues/2379)): the
  occupant set was read from `this.services`, which only `reconcile()` clears,
  so a second `start()` in one activation offered the PREVIOUS round's rows as
  occupants — and a plugin service clashed with its own outgoing instance, on a
  port nothing was using. It is built from `parsedServices` now, which is what
  makes the refusal's "this project's own service" true by construction. Both
  port messages also route their advice through `portChangeAdvice`, because the
  two kinds of service keep their number in different files and one sentence
  naming the compose file cannot be right for both.

**A known ordering artifact, shared with the name domain.** `claimedPorts` is
filled as each import is accepted, but a repository's services are withheld as a
*unit* at the end (`services.filter(s => !issuesByRepo.has(s.repo))`). So an
import that claims a port and is later withheld — because a *different* import
from the same repository failed — leaves its number claimed, and a third import
that wanted it was already refused. `claimed`, the service-NAME domain, has had
exactly this shape since docs/262, so ports match it rather than diverging;
fixing it properly is a two-pass change to both and is not in scope here.

The refusal happens at **admission**, before the service is registered, so
`warnOnAmbiguousPreviewPorts` now only ever sees the case req 7 does not cover —
two of the **project's own** services sharing a container port, which stays out
of scope because both definitions are the consumer's and ShipIt moves neither.

Two things the refused row needs beyond not starting. It is registered `error`,
and the client puts a Start button on every `error` row — so `startService` and
`restartService` refuse it by name (`refusePluginPortStart`). Without that, one
click reaches `docker compose up` for a service that is not in the override, and
the catch replaces the actionable "change `port:`…" text with a raw "no such
service". And the refusal is reported on the **failure** path of `start()` as
well as the success path: a refused port is not a consequence of that failure
and outlives it, so the reason has to be said either way.

### req 3, 8 — the container is told, and a mismatch is reported

`SHIPIT_PLUGIN_PORT` joins `SHIPIT_PLUGIN_STATE` / `SHIPIT_PROJECT_DIR` /
`SHIPIT_PLUGIN_COMMIT` in `shared/plugin-contract.ts`, and is injected into the
service's environment in `plugin-compose.ts`. A plugin server that hardcodes a
port is broken under this rule (req 3), so the break has to be legible: a
plugin service that is `running` but not accepting connections on its declared
port is reported on its own log channel, rather than leaving the consumer with
an empty pane and nothing to read.

**The check retries before it reports, and settles either way.** The first
version checked once at a 45s deadline — and the case that delay exists for is
exactly the one it got wrong: `npm ci` routinely outruns 45s, so a plugin that
binds fine at 60s was reported, and because the verdict was recorded and never
revisited the wrong diagnosis stayed in the Logs panel for the session. It now
re-arms up to `PLUGIN_PORT_PROBE_ATTEMPTS` times, so the report means "still
nothing after ~6 minutes". A service that answers is marked settled and never
probed again, which also stops `onRunning` — which fires on *every* running
poll, not just the transition — from turning this into a connect per poll.

### req 10 — the two-number scheme collapses

`plugin-ports.ts`, `<sessionDir>/plugin-ports.json`, `PLUGIN_PORT_BAND_START`,
and `ManagedService.publishedPort` are deleted, along with the indirection in
`ServiceManager.resolvePreviewTarget` (two passes become one) and the
`publishedPort ?? port` projection at all three wire sites
(`container-session-runner.ts` ×2, `compose-attach-replay.ts`).

This does not lose docs/262 req 18. The pin existed because a tracked-branch
commit could move the fragment's port behind a consuming session's back; under
req 2 the number is the consumer's own file, so it moves only when the consumer
moves it — the same guarantee a project service has always had, by the same
means.

## Key files

| File | Change |
|---|---|
| `shared/plugin-repos.ts` | `PluginServiceOverride.port`, key set, validation |
| `shared/plugin-contract.ts` | `SHIPIT_PLUGIN_PORT` |
| `orchestrator/plugin-compose.ts` | `ports` refused; port from the consumer; `resolvePreview`; env injection; plugin-vs-plugin collision |
| `orchestrator/services/plugin-services.ts` | drops `resolvePublishedPorts` and the `reserved` read |
| `orchestrator/service-manager.ts` | one-pass `resolvePreviewTarget`; `publishedPort` gone; collision refusal |
| `orchestrator/plugin-ports.ts` | deleted |
| `orchestrator/container-session-runner.ts`, `compose-attach-replay.ts` | wire sites stop projecting |
| `shipit-docs/plugin-authoring.md` | the author contract, and the collision note retired (this content lived in `plugins.md` until the usage/authoring split) |
| `docs/262-plugins/plan.md` | records what this deleted |

## Not doing

- Two of the project's own services sharing a container port (out of scope in
  `requirements.md`, unchanged behaviour: warn, serve the first).
- Retained preview iframes surviving a port changing owner (planning#394).
