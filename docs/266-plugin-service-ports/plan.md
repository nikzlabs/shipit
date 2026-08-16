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

`ports` leaves `ALLOWED_SERVICE_KEYS` (`plugin-compose.ts`). The existing
unknown-key check then refuses the fragment and names the service and the key,
which is the report req 6 asks for, on the plugin repository's own card. There
is no migration window: a fragment written under the old rule is invalid, and
that refusal is also how a consuming project learns one of its imports was
written under the old rule.

`readPorts` and `PluginFragmentService.port` go with it.

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
if (port === undefined) return "manual";
return source.preview ?? "auto";
```

Keeping those two questions apart matters: a portless worker the consumer wrote
`autostart: true` for still starts, and simply has nothing to preview. Making
"no port" force `manual` would have broken that — it was caught by the existing
req 16 test, not by reasoning.

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

`warnOnAmbiguousPreviewPorts` is the site: it already finds this pair and
already reports into the losing service's own log channel. It becomes a refusal
for the plugin/project pair and stays a warning for the case req 7 does not
cover — two of the **project's own** services sharing a container port, which
stays out of scope because both definitions are the consumer's and ShipIt moves
neither.

### req 3, 8 — the container is told, and a mismatch is reported

`SHIPIT_PLUGIN_PORT` joins `SHIPIT_PLUGIN_STATE` / `SHIPIT_PROJECT_DIR` /
`SHIPIT_PLUGIN_COMMIT` in `shared/plugin-contract.ts`, and is injected into the
service's environment in `plugin-compose.ts`. A plugin server that hardcodes a
port is broken under this rule (req 3), so the break has to be legible: a
plugin service that is `running` but not accepting connections on its declared
port is reported on its own log channel, rather than leaving the consumer with
an empty pane and nothing to read.

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
| `shipit-docs/plugins.md` | the author contract, and the collision note retired |
| `docs/262-plugins/plan.md` | records what this deleted |

## Not doing

- Two of the project's own services sharing a container port (out of scope in
  `requirements.md`, unchanged behaviour: warn, serve the first).
- Retained preview iframes surviving a port changing owner (planning#394).
