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

The primary mechanism: **resolve the pin at worker boot and prepend the matching
toolchain's `bin/` to the worker's own `process.env.PATH`.** The terminal, the
agent CLI, `agent.install`, and the MCP package installs are all spawned by that
worker and inherit its environment, so one assignment covers everything that
reads the inherited env. There is no `shipit.yaml` key (req 1: automatic for
every repo).

That is necessary but **not sufficient**, and the gap is invisible if you only
test the terminal: Codex runs every tool command as `bash -lc`, and Debian's
`/etc/profile` *overwrites* `PATH` outright. So `node -v` in the terminal and in
the diagnostics panel reported the pinned Node while `npm test` under Codex
silently ran the image's — the same invisible mismatch the bug is about. The
second half of the mechanism is therefore a baked
`/etc/profile.d/10-shipit-node.sh` that re-prepends the pinned bin inside login
shells, reading the path the worker publishes to `/session-state/node-bin` (the
snippet needs root, so it is baked; the value depends on the repo, so it is
written at runtime). An absent file means no pin and the snippet no-ops.

```
worker boot ──> startNodeRuntimeProvisioning()   (not awaited)
                  │
                  ├─ readNodePin(/workspace)          .nvmrc → engines.node
                  ├─ retract any stale /session-state/node-bin
                  ├─ already satisfied? ──────────────> done, PATH untouched
                  ├─ resolve: cached versions first, then nodejs.org/dist
                  ├─ below Node 20? ──────────────────> report, PATH untouched
                  ├─ download + SHA256-verify + extract into /dep-cache
                  ├─ PATH = <toolchain>/bin : PATH ; SHIPIT_PINNED_NODE=<ver>
                  └─ publish <toolchain>/bin to /session-state/node-bin
                                                     (login shells, via profile.d)

/install, /terminal/start, /agent/start,
/mcp/install, /mcp/test  ────────────────> await whenNodeRuntimeReady()
GET /node-runtime ────> orchestrator diagnostics ────> panel "Node runtime"
```

## Decisions

**Provisioning does not block `listen()`.** The orchestrator gives a worker 30s
to report healthy (`waitForWorkerHealth`) before failing container creation. A
cold download is ~50 MB from `nodejs.org`; blocking boot on it would turn a slow
network into a failed session. Instead every path that must not run on the wrong
Node awaits the shared promise individually — `/install`, `/terminal/start`,
`/agent/start`, and (because session activation fires them in parallel with the
install, not after it) `/mcp/install` and `/mcp/test`. `/node-runtime` deliberately
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
everything the worker spawns, so anything on PATH with a `#!/usr/bin/env node`
shebang runs under it. Checked against the shipped artifacts rather than assumed:
the binding constraint is `playwright-mcp`, whose `playwright` / `playwright-core`
deps declare `engines.node >= 20`; `@playwright/mcp` itself wants `>= 18` and the
`codex` JS launcher `>= 16`. The `claude` bin is a *native executable*
(`bin/claude.exe`), so it is unaffected either way — an earlier draft of this doc
claimed both agent CLIs were the constraint, which the lockfile does not support.
Below the floor the pin takes req 6's reporting path instead. Node 20 went EOL in
April 2026, so this excludes essentially nothing a live repo pins.

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

The pin applies to the agent's shell, the terminal, `agent.install`, the MCP
package installs, and Codex's login shells. It does **not** apply to the
session-worker process itself — it is already running, and
its native addons are compiled for the image's ABI. `imageVersion` in the status
payload is therefore always the worker's own `process.version`.

Changing `.nvmrc` mid-session does not re-provision: the pin is resolved once at
container start. A container restart picks it up. The install marker *does*
notice, because the resolved version is in the runtime key (below), so a pin
change forces a reinstall rather than reusing addons built under the old ABI.

**Resolution is cache-first, which is a deliberate deviation from "newest
satisfying".** The resolved receipt says a range resolves to the newest available
version satisfying it; here "available" means *available to this host*, and an
already-extracted 22.9.0 wins over a downloadable 22.23.2. The trade is a warm
start that needs no network at all (~1ms, and the only thing that makes a
network-off sandbox work on its second session) against a pin that can sit a few
patch releases behind. `NODE_MODULE_VERSION` is per-major, so the ABI is
unaffected; a container restart after the cache is swept picks up the newer one.

## Runtime key

`install-runtime.ts:runtimeKey()` describes the ABI boundary the overlay dep
store and install marker are scoped to. It read `process.versions.modules` — the
*worker's* ABI — which is wrong once the install runs under a pinned Node. It now
appends `|node<version>` from `SHIPIT_PINNED_NODE`.

Appended **only when a pin is active**: an unconditional extra segment would
change every key in the fleet at once and force a global cold reinstall for a
feature almost no repo uses.

## Overlay base scope

`overlayRuntimeKey` describes the *image's* ABI, and the orchestrator picks the
overlay `lowerdir` before the container exists. Once a repo can pin a different
Node, that is no longer sufficient: a base whose native addons were built under
the image's Node must not be mounted into a session running another major. The
worker-side marker mismatch does force `agent.install` to re-run, but a plain
`npm install` over an already-complete `node_modules` does **not** rebuild an
addon that is already present — so the marker is not the backstop the docs/183
comment claims it is for this case. (Before this feature the case could not
arise: a base-image Node bump changes `BASE_IMAGE_DIGEST`, which rotates the
scope.)

`resolveOverlayScope` therefore appends a `|pin<raw>` segment. Two details make
it safe:

- **It keys on the pin text, not the resolved version.** The orchestrator has no
  network budget here and resolves nothing. Two sessions on `.nvmrc: 22` months
  apart may run different patch releases, but `NODE_MODULE_VERSION` is per-major,
  so sharing one base is correct.
- **It is empty whenever the pin doesn't move the runtime** — no pin, an
  unparseable pin (the worker won't switch either), or a pin the image's Node
  already satisfies. That last case needs the image's own Node version, which the
  orchestrator now reads from the worker image's `NODE_VERSION` env at startup
  (`resolveWorkerNodeVersion`, mirroring `resolveWorkerBaseDigest`). Without it,
  `>=20` on a Node-24 image would look like a scope change and split the base for
  most repos that declare `engines.node` at all. When the image's version is
  unknown, a pin splits the scope — erring toward isolation costs one cold
  install instead of risking an ABI mismatch.

## Requirement 5 — the Compose cross-check

Honoring `.nvmrc`/`engines.node` makes install and preview agree for a repo that
pins consistently. A repo that pins *only* through its Compose image (`image:
node:22`, no `.nvmrc`, no `engines.node`) is not covered — the resolved question
fixed the pin sources at those two files, and adding the Compose image as a third
source would overrule a human decision rather than implement one.

So `findComposeNodeConflicts` detects the disagreement and reports it, the same
treatment req 6 prescribes for a pin that can't be honored: the panel names the
service and its image and suggests adding a `.nvmrc`. Best-effort throughout — a
missing, unreadable, or exotic compose file yields no conflicts rather than an
error. **This is a partial satisfaction of req 5 and is called out as such**; if
the Compose image should become a real pin source, that is a new question for the
requirements doc, not an inference to make here.

## Telling the agent (req 8)

The diagnostics panel is a *human* surface. The agent cannot reach it and has no
reason to look, so an agent in a session whose pin failed would debug a broken
native build against a runtime it believed was the project's — the original bug,
one layer along.

So when the pin could not be honored, the note rides the **first turn's prompt**:

```
<system>
ShipIt could not run this session on the Node version the repository asks for.

  running:  Node 24.15.0
  repo pin: 22 (.nvmrc)
  reason:   could not provision Node for `22`: getaddrinfo EAI_AGAIN nodejs.org

Take this into account before trusting anything version-sensitive: …
</system>

why does the native module not build?
```

Four decisions:

- **The user message, not the system prompt.** `PRECOMPUTED_INSTRUCTIONS` is
  rendered once per `(agentId, isOps)` at module load and must stay byte-stable
  or the prompt cache goes cold on every turn in the fleet (`CLAUDE.md` →
  Prompts). The prompt text carries no such contract, and `assembleAgentPrompt`
  already establishes that prompt ≠ displayed text by folding in file and image
  context. The transcript keeps the user's own words; only the CLI's copy has
  the prefix, so the note never reads as something the user said.
- **Prefixed, except for slash commands.** A `/command` must stay at position 0
  or the CLI stops parsing it; the note then follows. Same rule and same reason
  as `assembleAgentPrompt`, restated in `node-runtime.ts` because session code
  may not import from `orchestrator/`.
- **Once per container, not per session.** The pin is resolved at worker boot, so
  "first turn" means first since that resolution. A session whose container is
  recreated re-resolves and tells the *new* agent process, which never saw the
  old note.
- **Keyed on `mismatch`, not the literal `failed` state.** `unsupported`
  (`lts/jod`) and `below-floor` are the same situation from the agent's point of
  view — the repo asked for a Node it isn't getting. `provisioned` and
  `satisfied` say nothing, which is almost every session.

Sub-agent spawns (`/agent/spawn`) deliberately don't carry the note: they are
scoped one-shot tasks launched *by* an agent that already received it.

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
| `session/node-runtime.ts` (`formatNodeRuntimeNotice`, `prefixPromptWithNotice`) | Req 8's system note + where it lands in the prompt |
| `session/agent-controller.ts` | Attaches the note to the first turn since boot |
| `session/node-runtime.ts` (`findComposeNodeConflicts`) | Req 5's Compose cross-check |
| `orchestrator/overlay-session.ts` | `overlayPinSegment` splits the base scope on the pin |
| `orchestrator/container-overlay-provisioner.ts`, `session-container.ts`, `app-lifecycle.ts` | Resolve + publish the worker image's own Node version |
| `docker/session-worker/profile-node-pin.sh` | Re-applies the pin inside `bash -lc` login shells |
| `docker/Dockerfile.session-worker.{prod,dev}` | Shims invoke the image's `node` by absolute path; bake the profile.d snippet |
| `shared/fs-constants.ts` | `DEP_CACHE_CONTAINER_PATH` moved here (session code needs it) |

## Tests

- `shared/node-pin.test.ts` — range grammar, precedence, unsupported forms, the
  excluded ecosystem pin files.
- `session/node-runtime.test.ts` — the outcome table with network and tar
  injected: no-pin, provisioned (the reported repro), satisfied, warm cache,
  unsupported, below-floor, failed download, offline, unsatisfiable; the
  login-shell handoff (published, retracted when the pin goes away, retracted
  when it can't be honored); the Compose cross-check; and that a plain directory
  is not mistaken for the shared cache mount.
- `orchestrator/overlay-session.test.ts` — the pin segment is empty for every
  case that doesn't move the runtime, splits when it does, and differs per pin.
- `session/agent-controller.test.ts` — req 8 through the real `/agent/start`
  route with a fake agent: silent with no pin and with an honored pin, leads the
  prompt when the pin failed, fires once per container, and keeps a slash command
  at position 0.
- `session/install-runtime.test.ts` — the key is byte-identical without a pin,
  and changes when the pin changes.
- `orchestrator/services/diagnostics.test.ts` — probe against a real stand-in
  worker; missing endpoint and malformed reply both degrade to `null`.
- `client/components/SessionDiagnosticsPanel.test.tsx` — honored, un-honored
  (reason rendered), and no-worker states.
