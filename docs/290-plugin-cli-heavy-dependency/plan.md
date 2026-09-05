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
- **One Blender workload runs there today.** `pip install bpy` yields Blender
  5.0.1 (943 MB installed) from PyPI, which is already in the default egress
  allowlist, so no host grant is needed. A Cycles CPU render took 1.3 s at
  480×360/24 samples, from a **read-only** tree — the state `/plugin` is in
  during a CLI call.
- **That workload has essentially no memory headroom.** Peak RSS at
  1920×1080/128 samples over ~200k triangles was **2.00 GiB** against the CLI
  container's 2 GiB ceiling (`plugin-cli-run.ts:146`), and forcing 4 threads
  instead of 16 did not lower it (2.01 GiB). No OOM was observed and no
  higher-limit comparison was run, so this establishes *absence of headroom*,
  not that the ceiling is the binding constraint on Blender generally. The other
  bounds are 512 pids, a 15-minute timeout (`:143`) and a 512 MB `/tmp` tmpfs
  (`:868`).

**Scope of that evidence.** It shows that one `bpy` wheel and one CPU render
work in the current worker environment. It does not establish broad Blender
support, and it says nothing about a dependency that needs system packages —
which req 1 also covers.

Separately, the near-zero property req 2 asks for **partly exists already**. The
plugin dependency store keys an install by the content of its declared inputs,
promotes the resulting tree into a store under the orchestrator's own state
directory — `depStoreDir` is `stateDir` (`bootstrap-managers.ts:621`), not a
per-session path — and later consumers mount it as an overlay **lowerdir**,
which the kernel makes read-only. On a hit the install container does not run at
all (`plugin-dep-store.ts`, module docstring).

Two limits on that, both verified, because the guarantee is weaker than the
docstring's summary reads:

- **It converges to one stored copy, not to one cold install.** Two sessions can
  both miss and both run the install; serialisation begins at `publishBase`, and
  the loser adopts the winner's tree and deletes its own
  (`plugin-dep-store.ts:391`). So concurrent first-time sessions each pay the
  install time, even though the disk cost converges.
- **Promotion can fail after a perfectly valid plan.** A missing or
  non-directory output, or a lost publish, yields a null pin
  (`plugin-dep-store.ts:316`, `:386`); the tree stays in that generation's
  private layer and is shared with nobody.

## Where it falls short of the requirements

1. **It cannot host a dependency that needs system packages (req 1).** An
   install container runs as an unprivileged per-session uid with `CapDrop:
   ALL` (`plugin-install.ts:674`, `:720`), so `apt-get` is impossible, and only
   `/plugin` survives into the CLI run. Blender escapes this because `bpy` is a
   wheel. Req 1 is not limited to dependencies that happen to be.
2. **Self-containment (req 3) therefore holds only for those escapees.**
   Anything needing system packages must reach the CLI as a container image, and
   a plugin cannot supply one: a fragment must name a pre-published `image:`,
   and `build:` is refused (`plugin-compose.ts:662`, `:685`). The CLI has no
   image field at all — it always borrows the worker image
   (`plugin-cli-run.ts:151`, wired at `bootstrap-managers.ts:808`).
3. **Whether req 2 is in effect is invisible.** `planPluginDepStore` returns
   `null` at **six** distinct branches — the overlay kill switch (`:184`), no
   selected installer (`:193`), an npm lifecycle script with no explicit inputs
   (`:208`), inputs that cannot be content-hashed (`:217`), an empty `dep-dirs`
   (`:227`), and a dep dir already present in the checkout (`:248`) — and the
   caller then writes the stamp, records **`succeeded`**, and returns
   (`plugin-install.ts:462`). Promotion failure above is a seventh way to end up
   sharing nothing, on a path where a plan existed. This is a **separate bug**,
   tracked as planning#511 — recorded here because it shaped the measurements
   above, not because this feature fixes it.

## Candidate mechanisms

### M1 — make the store's applicability observable — *out of scope*

Returning a typed reason from `planPluginDepStore` and surfacing it would have
made the store's silence visible. The user ruled on 2026-09-05 that this is a
**separate bug**, not part of this feature: it is a defect in something that
already exists, and it addresses no numbered requirement here — in particular
not req 1, whose `apt` class it cannot reach.

Tracked as **planning#511**. Nothing in this design depends on it, and it should
not be sequenced against this feature's work.

### M2 — the plugin names a published image for its CLI

Satisfies reqs 1 and 2. **Fails req 3**, which a human has already decided
(see the resolved question). Recorded as a rejected alternative, not as a
staged step: reviving it means changing req 3 and its receipt first.

### M3 — the plugin ships a Dockerfile and ShipIt builds it

The only candidate that satisfies reqs 1, 2 and 3 together, and therefore the
target.

**What it must include to be a CLI mechanism at all.** Lifting the fragment
`build:` refusal is a *service* change and does not reach a companion CLI. M3
must additionally define (a) a manifest field by which a plugin names the
Dockerfile its CLI runs on, (b) the build-and-adopt flow that selects the
resulting image at invocation time, replacing `PluginCliDeps.image`, and (c) an
image identity keyed to the plugin commit, so req 2's identity is the one req 15
already guarantees. Without those, a built image serves services only.

**Two things make it smaller than the record suggests.** The refusal's stated
reason — a build context cannot be a Docker volume, and pointing it at the
pristine checkout "would give one service two different views of the same
plugin" (`plugin-compose.ts:48`, `docs/262-plugins/plan.md:349`) — assumes the
build sits *beside* `install:`. If a Dockerfile **replaces** `install:`, there
is no install output and so no second view. And the pristine checkout is a plain
host directory the orchestrator creates at
`<stateDir>/plugins/<repo>/generations/<id>` (`plugin-generations.ts:873`) —
usable as a build context by the process that runs `docker compose`, though note
it is handed to the session-worker identity immediately afterwards
(`plugin-generations.ts:1363`), so ownership is not the orchestrator's.
Separately, ShipIt **already** builds repo-authored Dockerfiles for a project's
own compose file, on every service start (`compose-cli.ts:176`).

**One thing makes it larger, and it is the prerequisite.** A `RUN` step has **no
session egress containment**: it runs on the daemon's default bridge, as root by
default, before any Tier A/B/C control exists. ShipIt documents this for its own
builds (`src/server/shipit-docs/compose.md:623`), and
`docs/263-compose-service-egress` req 1 scopes it out explicitly, its *Scope
boundary* section adding that build-network containment "needs a separate
daemon/BuildKit design". For a project's own repository that gap is gated on the
user's trust in their own code. A plugin is a different repository whose new
commits execute without review (`docs/262-plugins` req 19), and the plugin
subsystem elsewhere builds a pre-contained holder container so plugin code never
has one uncontained instant (`plugin-egress.ts:72`). **Contained builds come
first, and are the bulk of the work.**

Also needed: a prune tied to generation pruning (nothing prunes images
in-session — `startup-janitor.ts:78`), and a `build:` subtree validated far
more narrowly than Compose's — `context` and `dockerfile` only, since `secrets`,
`ssh`, `args`, `cache_from` and `network` each open a separate question.

### M4 — the CLI runs inside the plugin's own service container

Not a delivery mechanism: a service still needs an `image:`, so M4 composes with
M3 rather than replacing it. What it changes is *where* a call executes.

It does **not** re-open the API boundary, which is what the record claims
against it (`docs/262-plugins/plan.md:1156` — "`docker exec` into the agent or a
service container is not an acceptable shortcut"). That clause bundles two
cases. For the agent container it is right: the loopback credential broker is
there (`shared/worker-auth.ts:68`). For a service container it is not: every
generated service carries `shipit-parent-session` (`compose-generator.ts:1804`),
and the guard denies any caller resolved by that label the **whole** `/api/*`
surface (`api-container-guard.ts:27`, `:273`). A plugin service also already
receives the plugin's declared credentials (`plugin-compose.ts:826`), so an exec
grants none it did not have.

What it does trade is set out under [The M4 trade](#the-m4-trade).

## Recommendation

**Nothing here should be built before the open questions in `requirements.md`
are answered.** With that said, the shape follows from req 1 taken whole:

1. **M3 is the target**, because it is the only candidate that satisfies reqs 1,
   2 and 3 together. Its first piece of work is **contained builds**, not the
   plugin-facing surface.
2. **M2 is rejected** — it fails req 3, which a human has already decided.
3. **M4 is an optimisation of M3**, never a reason to choose it.

M1 is not on this list: the user scoped it out as a separate bug
(planning#511).

An earlier draft recommended M1 first, on the reading that req 1 might be
narrowed to dependencies a language package manager can install. Req 1 already
classifies the `apt` case, so that reading asked the user to shrink their own
requirement.

## The M4 trade

One property is weakened, one is narrowed, and one budget is gained.

**Weakened: the API-denial construction.** A CLI container is on
`shipit-plugin-cli`, a subnet registered untrusted when the **network is
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

**Narrowed: which sweeps can kill a call.** `ServiceManager.start()` opens with
`killStaleContainers()`, which `docker rm -f`s every container labelled
`shipit-parent-session=<session>` and deletes the session network
(`compose-cli.ts:264`, called at `service-manager.ts:1828`). Today a CLI call
runs in an unlabelled container and is untouched by it; inside a service
container it would be force-removed mid-call. The comparison is limited to a
**same-process** compose-stack reinitialisation: an orchestrator *restart* kills
a CLI call either way, since `reapOrphanPluginInstalls` removes every container
carrying the CLI label at boot (`plugin-install.ts:849`, called from
`startup-janitor.ts:287`) and the waiting request dies with the old process.

**Gained: the image and the cgroup.** The call runs the image the plugin chose,
and joins that container's cgroup — and a fragment may declare `mem_limit`,
`cpus`, `shm_size`, `pids_limit` and `ulimits` (`plugin-compose.ts:221`). Given
the measured absence of headroom at 1080p, that is the difference between a
render having room and not. Per-call container start also disappears;
`docs/262-plugins/plan.md:1156` already names a "credential-blind persistent
runner" as a later optimisation, and M4 is close to that with the service as the
runner.

Two further costs, operational rather than security: a command becomes coupled
to a service's lifecycle (a heavy plugin is `autostart: false` on purpose), and
per-call isolation disappears, so one call can leave state that changes the next.

## Key files

| File | Why it matters here |
|---|---|
| `src/server/orchestrator/plugin-dep-store.ts` | The store, its key, `planPluginDepStore`'s six `null` branches, and the promotion path that can pin nothing |
| `src/server/orchestrator/plugin-install.ts` | Records `succeeded` with no plan (`:462`); install container limits; boot-time reap of CLI containers (`:849`) |
| `src/server/shared/deps-hash.ts` | Which install commands can be content-keyed; `install-inputs` overrides |
| `src/server/orchestrator/plugin-cli-run.ts` | The invocation container: borrowed image, 2 GiB, 512 pids, 15 min |
| `src/server/orchestrator/plugin-compose.ts` | Fragment allowlist, the `build:` refusal, allowed resource keys |
| `src/server/orchestrator/api-container-guard.ts` | The two denial constructions M4 trades between |
| `src/server/orchestrator/compose-cli.ts` | `--build` on every `up`; `killStaleContainers` |
| `docs/263-compose-service-egress` | Why build-time containment is M3's prerequisite |
