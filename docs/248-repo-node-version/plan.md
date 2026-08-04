---
issue: nikzlabs/shipit#1728
title: Honor the repo's Node version pin in the agent container
description: Read .nvmrc / engines.node at worker boot, provision the matching Node onto PATH, and report the mismatch in diagnostics when it can't be honored.
---

# Repo Node version pin

Implements [requirements.md](./requirements.md). Filed as
[nikzlabs/shipit#1728](https://github.com/nikzlabs/shipit/issues/1728).

## The problem

The session-worker image bakes one Node major (`node:24-slim`). A repo pinning
Node 22 in `.nvmrc` got Node 24 with no indication anything was off (req 1, 2).
Nothing crashed, which is what made it bad: native addons compiled against the
wrong ABI (req 4), version-sensitive tooling diverged from CI, and the Node that
installed `node_modules` disagreed with the `node:22` a Compose preview service
pinned for the same mounted workspace (req 5).

## Shape

One mechanism does the work: **resolve the pin at worker boot and prepend the
matching toolchain's `bin/` to the worker's own `process.env.PATH`.** The
terminal, the agent CLI, and `agent.install` are all spawned by that worker and
inherit its environment, so a single assignment covers every place req 4 cares
about. There is no per-process env plumbing, no shim layer, and no `shipit.yaml`
key (req 1: automatic for every repo).

```
worker boot ──> startNodeRuntimeProvisioning()   (not awaited)
                  │
                  ├─ readNodePin(/workspace)          .nvmrc → engines.node
                  ├─ already satisfied? ──────────────> done, PATH untouched
                  ├─ resolve: cached versions first, then nodejs.org/dist
                  ├─ below Node 20? ──────────────────> report, PATH untouched
                  ├─ download + SHA256-verify + extract into /dep-cache
                  └─ PATH = <toolchain>/bin : PATH ; SHIPIT_PINNED_NODE=<ver>

/install, /terminal/start, /agent/start ──> await whenNodeRuntimeReady()
GET /node-runtime ────> orchestrator diagnostics ────> panel "Node runtime"
```

## Decisions

**Provisioning does not block `listen()`.** The orchestrator gives a worker 30s
to report healthy (`waitForWorkerHealth`) before failing container creation. A
cold download is ~50 MB from `nodejs.org`; blocking boot on it would turn a slow
network into a failed session. Instead the three paths that must not run on the
wrong Node await the shared promise individually. `/node-runtime` deliberately
does *not* await — it reports `pending` — so a diagnostics panel can't hang on a
download.

**`.tar.gz`, not `.tar.xz`.** ~20 MB larger, once per version per host, in
exchange for depending only on `gzip` rather than `xz-utils` being present in
whatever base image the worker is on.

**The tarball is SHA256-verified against the release's `SHASUMS256.txt`.** This
fetches an executable toolchain over the network and puts it first on the PATH of
every process in the session; an unverified download would be a code-execution
path. Extraction goes to a unique temp dir and lands with one `rename`, because
`/dep-cache` is shared across every session of the repo on the host and two
containers can provision the same version at once.

**Cache before network.** Already-extracted versions under `/dep-cache/node-versions`
are consulted first, so a warm host provisions offline — which is also what makes
a network-off sandbox work from its second session onward. Measured against the
real registry from a session container: `.nvmrc: 22` resolves, downloads,
verifies and extracts Node 22.23.2 in **~1.7s** cold and **~1ms** warm, for
**~204 MB** on disk per version. That footprint lives in the repo's dep cache and
is reclaimed with it, and only a repo that actually pins an off-image version
pays it.

**A floor at Node 20 (`MIN_ACTIVATABLE_MAJOR`).** The pinned Node leads PATH for
everything the worker spawns, including the `claude` and `codex` CLIs, whose
shebangs resolve `node` the same way; both need 20+. Honoring a Node 14 pin would
trade a wrong-ABI warning for a session with no working agent. Below the floor the
pin takes req 6's reporting path instead. Node 20 went EOL in April 2026, so this
excludes essentially nothing a live repo pins.

**Range support is a deliberate subset, and unparseable is a reported outcome.**
`>=`, `>`, `<=`, `<`, `=`, `^`, `~`, x-ranges, `*`, intersections and `||` unions
cover what `engines.node` actually contains. Adding the `semver` package for this
would be a new runtime dependency under the 7-day-cooldown policy; instead
`parseRange` returns `null` for anything it doesn't implement (`lts/jod`, `node`,
hyphen ranges) and the caller reports `unsupported`. A silently-wrong match would
activate the wrong Node, which is worse than saying we couldn't read the pin.

**A `.nvmrc` we can't parse does not fall through to `engines.node`.** The repo
did express a preference; honoring a different source silently would be more
surprising than reporting the one we couldn't read.

**Only the shims ShipIt owns are pinned back to the image's Node.** `gh`,
`shipit`, and `shipit-git-credential` run ShipIt's own code against
`/app/node_modules`, which is built for the image's ABI, so the Dockerfiles now
invoke them via the absolute `/usr/local/bin/node` instead of the shebang's
`env node`. The MCP bridges already used `process.execPath` and needed no change.

## Scope boundary

The pin applies to the agent's shell, the terminal, and `agent.install`. It does
**not** apply to the session-worker process itself — it is already running, and
its native addons are compiled for the image's ABI. `imageVersion` in the status
payload is therefore always the worker's own `process.version`.

Changing `.nvmrc` mid-session does not re-provision: the pin is resolved once at
container start. A container restart picks it up. The install marker *does*
notice, because the resolved version is in the runtime key (below), so a pin
change forces a reinstall rather than reusing addons built under the old ABI.

## Runtime key

`install-runtime.ts:runtimeKey()` describes the ABI boundary the overlay dep
store and install marker are scoped to. It read `process.versions.modules` — the
*worker's* ABI — which is wrong once the install runs under a pinned Node. It now
appends `|node<version>` from `SHIPIT_PINNED_NODE`.

Appended **only when a pin is active**: an unconditional extra segment would
change every key in the fleet at once and force a global cold reinstall for a
feature almost no repo uses.

## Diagnostics (req 6)

`GET /node-runtime` on the worker returns the resolved `NodeRuntimeStatus`. The
orchestrator's diagnostics service probes it (2s budget, degrades to `null` on
any error — including a container that outlived the deploy that added the
endpoint) and the panel renders a "Node runtime" section. The states that mean
"your pin is not being honored" (`unsupported`, `below-floor`, `failed`) render
their `reason` in the error color. The reported bug was an *invisible* mismatch,
so this section exists to make the discrepancy legible even on the happy path.

## Key files

| File | Role |
|---|---|
| `shared/node-pin.ts` | Pure: read `.nvmrc` / `engines.node`, parse ranges, match, pick best |
| `shared/types/node-runtime-types.ts` | `NodeRuntimeStatus` / `NodeRuntimeState` — both layers read it |
| `session/node-runtime.ts` | Resolve, download, verify, extract, PATH-prepend; the boot singleton |
| `session/session-worker.ts` | Starts provisioning; serves `GET /node-runtime` |
| `session/install-controller.ts` | Awaits the pin before stamping the marker or installing |
| `session/terminal-controller.ts`, `session/agent-controller.ts` | Await the pin before spawning |
| `session/install-runtime.ts` | `runtimeKey()` appends the pinned version |
| `orchestrator/services/diagnostics.ts` | Probes the worker, adds `nodeRuntime` to the payload |
| `client/components/SessionDiagnosticsPanel.tsx` | "Node runtime" section |
| `docker/Dockerfile.session-worker.{prod,dev}` | Shims invoke the image's `node` by absolute path |
| `shared/fs-constants.ts` | `DEP_CACHE_CONTAINER_PATH` moved here (session code needs it) |

## Tests

- `shared/node-pin.test.ts` — range grammar, precedence, unsupported forms, the
  excluded ecosystem pin files.
- `session/node-runtime.test.ts` — the outcome table with network and tar
  injected: no-pin, provisioned (the reported repro), satisfied, warm cache,
  unsupported, below-floor, failed download, offline, unsatisfiable.
- `session/install-runtime.test.ts` — the key is byte-identical without a pin,
  and changes when the pin changes.
- `orchestrator/services/diagnostics.test.ts` — probe against a real stand-in
  worker; missing endpoint and malformed reply both degrade to `null`.
- `client/components/SessionDiagnosticsPanel.test.tsx` — honored, un-honored
  (reason rendered), and no-worker states.
