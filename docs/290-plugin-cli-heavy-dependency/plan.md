---
title: A plugin CLI can carry a heavy dependency — design
description: Weighs four mechanisms for giving a companion CLI a large toolchain at near-zero per-session cost, against measured evidence from the session-worker image.
---

# A plugin CLI can carry a heavy dependency — design

Implements [requirements.md](requirements.md). Requirements are cited as
`(req N)`.

## What is already true — measured, not inferred

Measured on 2026-09-05 inside a live session-worker container (Debian 12, uid
2000886 — the same per-session identity a plugin CLI container runs as):

- **The worker image already carries the X and GL closure.** `libGL.so.1`,
  `libX11`, `libXi`, `libXxf86vm`, `libXrender`, `libXfixes`, `libSM`,
  `libICE`, `libxkbcommon`, `libgbm` and `xz` are all present, because
  `playwright install-deps chromium` (`docker/Dockerfile.session-worker.prod:171`)
  installs them. An earlier reading of the Dockerfile's own `apt-get` line
  concluded the opposite; the running image is the authority.
- **Blender runs there today.** `pip install bpy` yields Blender 5.0.1 (943 MB
  installed) from PyPI, which is already in the default egress allowlist, so no
  host grant is needed. A Cycles CPU render took 1.3 s at 480×360/24 samples.
  It runs from a **read-only** tree, which is the state `/plugin` is in during a
  CLI call.
- **Memory is the binding limit, not the libraries.** Peak RSS at
  1920×1080/128 samples over ~200k triangles was **2.00 GiB** — exactly the CLI
  container's ceiling (`plugin-cli-run.ts:146`). Forcing 4 threads instead of 16
  did not reduce it (2.01 GiB). The other bounds are 512 pids, a 15-minute
  timeout (`:143`) and a 512 MB `/tmp` tmpfs (`:868`).

And the near-zero property req 2 asks for **already exists** for a dependency of
this shape. The plugin dependency store keys an install by the content of its
declared inputs, promotes the resulting tree into a store under the
orchestrator's own state directory — `depStoreDir` is `stateDir`
(`bootstrap-managers.ts:621`), not a per-session path — and later consumers
mount it as an overlay **lowerdir**, which the kernel makes read-only. On a hit
the install container does not run at all
(`plugin-dep-store.ts`, module docstring). One copy on the host; one cold
install per dep state.

## Where it falls short of the requirements

1. **It is silent when it does not apply (req 4).** `planPluginDepStore`
   returns `null` under four conditions — an install command whose inputs
   cannot be content-hashed, an empty `dep-dirs`, a dep dir already present in
   the checkout, or a named input file that does not exist
   (`plugin-dep-store.ts:174`–`:248`). The caller then writes the stamp,
   records **`succeeded`**, and returns (`plugin-install.ts:462`). No warning,
   no log line, no row on the Plugins card. A plugin that misses a condition
   pays a full cold install in every session, for ever, and its author is never
   told. `pip install --target vendor/py -r requirements.txt` is such a case:
   the *value* of `--target` reads as a bare package positional, so pip's input
   extraction returns `null` (`deps-hash.ts:152`).
2. **It cannot host a dependency that needs system packages (req 1).** An
   install container runs as an unprivileged per-session uid with `CapDrop:
   ALL` (`plugin-install.ts:674`, `:720`), so `apt-get` is impossible, and only
   `/plugin` survives into the CLI run. Blender happens to escape this because
   `bpy` is a wheel; a dependency that needs `apt` does not.
3. **Self-containment (req 3) holds only for case 2's escapees.** Anything
   needing system packages must reach the CLI as a container image, and a
   plugin cannot supply one: a fragment must name a pre-published `image:` and
   `build:` is refused (`plugin-compose.ts:662`, `:685`).

## Candidate mechanisms

### M1 — keep the store, make it observable

Return a typed reason from `planPluginDepStore` instead of a bare `null`, and
surface it where the author looks: a log line at minimum, a row on the
repository's Plugins card by preference (the card already carries
withheld-surface reasons — `services/plugin-services.ts`). Advisory only: a
missing store is not an error and must not fail the install.

Satisfies reqs 2 and 4, and req 1 for any dependency a language package manager
can install unprivileged. Satisfies req 3. **No prerequisite.** Does not satisfy
req 1 for the `apt` class.

### M2 — the plugin names a published image for its CLI

Add an image to the `cli:` grammar; run the invocation container on it instead
of borrowing the worker image (`plugin-cli-run.ts:151`, wired from
`bootstrap-managers.ts:808`).

Satisfies reqs 1, 2 and 4. **Fails req 3**: the plugin repository no longer
carries what its CLI needs, and a private image additionally requires the
operator to log the orchestrator's daemon in — there is no per-project registry
credential (`compose-cli.ts:492`).

### M3 — the plugin ships a Dockerfile and ShipIt builds it

Satisfies reqs 1, 2, 3 and 4. Two things make it smaller than the record
suggests, and one makes it larger.

**Smaller.** The refusal's stated reason — a build context cannot be a Docker
volume, and pointing it at the pristine checkout "would give one service two
different views of the same plugin" (`plugin-compose.ts:48`,
`docs/262-plugins/plan.md:349`) — assumes the build sits *beside* `install:`.
If a Dockerfile **replaces** `install:`, there is no install output and so no
second view. And the pristine checkout is an ordinary orchestrator-owned host
directory at `<stateDir>/plugins/<repo>/generations/<id>`
(`plugin-generations.ts:873`), directly usable as a context by the process that
runs `docker compose`. Separately, ShipIt **already** builds repo-authored
Dockerfiles for a project's own compose file, on every service start
(`compose-cli.ts:176`).

**Larger.** A `RUN` step has **no session egress containment**: it runs on the
daemon's default bridge, as root by default, before any Tier A/B/C control
exists. ShipIt documents this for its own builds
(`src/server/shipit-docs/compose.md:623`), and
`docs/263-compose-service-egress` req 1 scopes it out in as many words,
its *Scope boundary* section adding that build-network containment "needs a
separate daemon/BuildKit design". For a project's own repository that gap is
gated on the user's trust in their own code. A plugin is a different repository
whose new commits execute without review (`docs/262-plugins` req 19), and the
plugin subsystem elsewhere goes to the length of a pre-contained holder
container so plugin code never has one uncontained instant
(`plugin-egress.ts:72`). **Contained builds are therefore the prerequisite, not
a follow-up.**

Three further pieces this needs: an image tag keyed to the plugin commit (so
req 2's identity is the same identity req 15 already guarantees), a prune tied
to generation pruning (nothing prunes images in-session —
`startup-janitor.ts:78`), and a validated `build:` subtree narrower than
Compose's (`context` and `dockerfile` only; `secrets`, `ssh`, `args`,
`cache_from` and `network` each open a separate question).

### M4 — the CLI runs inside the plugin's own service container

Not a delivery mechanism: a service still needs an `image:`, so M4 composes
with M2 or M3 rather than replacing them. What it changes is *where* a call
executes.

It does **not** re-open the API boundary, which is what the record claims
against it (`docs/262-plugins/plan.md:1156` — "`docker exec` into the agent or a
service container is not an acceptable shortcut"). That clause bundles two
cases. For the agent container it is right: the loopback credential broker is
there (`shared/worker-auth.ts:68`). For a service container it is not: every
generated service carries `shipit-parent-session` (`compose-generator.ts:1804`),
and the guard denies any caller resolved by that label the **whole** `/api/*`
surface (`api-container-guard.ts:27`, `:273`). A plugin service also receives
the plugin's declared credentials already (`plugin-compose.ts:826`), so an exec
grants none it did not have.

What it does trade is set out under [The M4 trade](#the-m4-trade) below.

## Recommendation

**Sequenced, smallest first.** Nothing here should be built before the open
questions in `requirements.md` are answered — in particular, whether a heavy
dependency may require system packages, which is the single fact that decides
whether M1 is sufficient.

1. **M1 now.** It has no prerequisite, it is small, and it makes an existing
   guarantee trustworthy rather than adding a second one. Measured evidence says
   it is *already* enough for the case that prompted the feature.
2. **M3 if the `apt` class is in scope**, with contained builds sequenced first
   and treated as the bulk of the work.
3. **M2 only as a deliberate, temporary exception to req 3**, taken by a human.
4. **M4 as an optimisation of whichever image mechanism lands**, never as the
   reason to choose one.

## The M4 trade

Two properties are given up, and one budget is gained.

**Given up: the stronger of two API-denial constructions.** A CLI container is
on `shipit-plugin-cli`, a subnet registered untrusted when the **network is
created** (`plugin-container.ts:61`) and re-registered at boot before the API
accepts traffic (`bootstrap-managers.ts:174`). Its first packet is already
denied; there is nothing to be stale. A service container is denied instead by
the `shipit-parent-session` **label**, resolved through an IP→session map built
from a snapshot of running containers and ordered against first packets by a
topology bracket and a fail-closed guess (`api-container-guard.ts:273`,
`session-container.ts:1703`). Both hold today. But the guard's own docstring
argues that a container running code ShipIt did not write belongs behind the
subnet construction (`api-container-guard.ts:15`), and M4 moves plugin CLI
execution the other way.

**Given up: a call that survives a restart.** `ServiceManager.start()` opens
with `killStaleContainers()`, which `docker rm -f`s **every** container labelled
`shipit-parent-session=<session>` and then deletes the session network
(`compose-cli.ts:264`, called at `service-manager.ts:1828`). It runs on stack
initialisation — session activation and orchestrator restart — not on an
individual `shipit service start`. Today a CLI call runs in an unlabelled
container and is untouched by that sweep. Inside a service container it would be
force-removed mid-call, so a long render would vanish rather than fail.

**Gained: the image and the cgroup.** The call runs the image the plugin chose,
and joins that container's cgroup — and a fragment may declare `mem_limit`,
`cpus`, `shm_size`, `pids_limit` and `ulimits`
(`plugin-compose.ts:221`). So the 2 GiB ceiling that the measurement above shows
binding a 1080p render stops binding, with no new manifest field. Per-call
container start also disappears; `docs/262-plugins/plan.md:1156` already names a
"credential-blind persistent runner" as a later optimisation, and M4 is close to
that with the service as the runner.

Two further costs, both operational rather than security: a command becomes
coupled to a service's lifecycle (a heavy plugin is `autostart: false` on
purpose), and per-call isolation disappears, so one call can leave state that
changes the next.

## Key files

| File | Why it matters here |
|---|---|
| `src/server/orchestrator/plugin-dep-store.ts` | The store, its key, and `planPluginDepStore`'s four `null` conditions |
| `src/server/orchestrator/plugin-install.ts` | Records `succeeded` with no plan (`:462`); install container limits |
| `src/server/shared/deps-hash.ts` | Which install commands can be content-keyed; `install-inputs` overrides |
| `src/server/orchestrator/plugin-cli-run.ts` | The invocation container: borrowed image, 2 GiB, 512 pids, 15 min |
| `src/server/orchestrator/plugin-compose.ts` | Fragment allowlist, the `build:` refusal, allowed resource keys |
| `src/server/orchestrator/api-container-guard.ts` | The two denial constructions M4 trades between |
| `src/server/orchestrator/compose-cli.ts` | `--build` on every `up`; `killStaleContainers` |
| `docs/263-compose-service-egress` | Why build-time containment is M3's prerequisite |
