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

**And the 2 GiB ceiling is a property of the plugin CLI container, not of a
session.** The same measurement host gives an ordinary session 42.4 GiB and 16
CPUs (`/sys/fs/cgroup/memory.max`), because session memory is sized from host
capacity — half the usable budget, 4 GiB floor, 48 GiB cap
(`shipit-docs/shipit-yaml.md` → "Container sizing is automatic"). So the render
that had no headroom under a companion CLI has ample room when the agent runs it
directly.

### The motivating use case does not need this feature

Recorded because it decides whether the feature is worth building, and because
the design would otherwise read as necessary. The need behind it — *use Blender
without installing it in every session* (user, 2026-09-09) — is already met, in
an ordinary session, with no plugin and no ShipIt change:

```yaml
agent:
  install: pip install --no-cache-dir --target vendor/py -r requirements.txt
  install-inputs: [requirements.txt]
  dep-dirs: [vendor/py]
```

`agent.dep-dirs` feeds the same overlay store this document already describes —
docs/183-overlay-dep-store shares "a rolling overlay base per (repo, runtime),
scoped to the dirs declared in shipit.yaml `agent.dep-dirs`" — so the tree is
installed once and every later session on that repository **mounts** it. Combined
with the measurement above, that is Blender in every session at no per-session
install cost.

What this feature adds over that is **packaging and cross-repository reuse**: a
dep-dirs base is keyed per repository, so every project repeats the declaration
and pays its own first install, and none of it is available to a plugin's
companion CLI. Those are real, and they are conveniences — not the capability.

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
  (`plugin-dep-store.ts:581`, post-planning#511 line numbering). So concurrent
  first-time sessions each pay the
  install time, even though the disk cost converges.
- **Promotion can fail after a perfectly valid plan.** A missing or
  non-directory output, or a lost publish, pins nothing; the tree stays in that
  generation's private layer and is shared with nobody. Still true after
  planning#511 — that fix made the outcome *visible* (`nothing-installed`,
  `not-a-directory`, `publish-failed`), it did not remove it.

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
3. ~~Whether req 2 is in effect is invisible.~~ **Fixed, and no longer a gap.**
   An install could decline the store at six branches, or plan successfully and
   then pin nothing, and every one of those was recorded as a plain success.
   That was filed as a separate bug — planning#511 — and is now **merged**:
   `planPluginDepStore` returns a `PluginDepStoreDecision` carrying a typed
   `PluginDepStoreReasonKind`, promotion attaches one per directory that pinned
   nothing, and the reason reaches the Plugins card and `shipit plugin status`.
   Recorded here because it shaped the measurements above, and because a design
   that leaned on the store's silence would now be wrong.

## Candidate mechanisms

### M1 — make the store's applicability observable — *out of scope*

Returning a typed reason from `planPluginDepStore` and surfacing it would have
made the store's silence visible. The user ruled on 2026-09-05 that this is a
**separate bug**, not part of this feature: it is a defect in something that
already exists, and it addresses no numbered requirement here — in particular
not req 1, whose `apt` class it cannot reach.

Tracked as **planning#511**, and now **merged** — the store reports a typed
reason at every decline branch and at a promotion that pins nothing. Nothing in
this design depended on it, and the outcome confirms the scoping was right: it
shipped on its own while this design was still settling its requirements.

### M2 — the plugin names an image for its CLI

An earlier draft treated this as one mechanism and rejected it. That collapsed
two cases with different answers, and the distinction is the user's
(2026-09-09): *"could we allow invoking existing docker images instead?"*

#### M2a — the plugin author publishes their own image

Satisfies reqs 1, 2 and 4. **Fails req 3**, which a human decided on 2026-09-05:
the plugin repository no longer carries what its CLI needs, and a *private*
image additionally requires the operator to log the orchestrator's daemon in —
there is no per-project registry credential (`compose-cli.ts:492`). Rejected;
reviving it means changing req 3 and its receipt first.

#### M2b — the plugin names an **existing** public image

`image: <some published blender image>` in the manifest, pulled by the host
daemon and shared by every session. The author publishes nothing.

**Whether this satisfies req 3 is an open question** (see `requirements.md`) —
it turns on whether "no separately published artifact" means *no artifact the
author must publish* or *no artifact outside the repository at all*. Under the
first reading M2b satisfies **all four** requirements, and note that the second
reading would also disqualify the `bpy` wheel the measurements above used, since
that is equally an artifact published elsewhere.

If it is permitted, M2b is markedly cheaper than M3 and **needs no contained
builds at all** — there is no build, so the prerequisite in
`docs/291-contained-builds` simply does not apply to it. Against the
requirements: req 1 is satisfied including the `apt` class, since the image
carries its own system packages; req 2 is satisfied better than the dependency
store manages, because there is no install step to share and the host pulls the
image once; req 4 is satisfied trivially, since an ordinary commit that does not
change the declared tag pulls nothing.

**What it would need, and what it would face.** Verified against the code:

- **A pull path, which does not exist.** No plugin container module pulls
  anything — they run the worker image, which is always present locally. A first
  call would otherwise fail on a missing image rather than fetch it, and a
  multi-gigabyte pull needs its own progress and timeout story rather than
  riding the 15-minute call budget.
- **The toolchain env repairs must not be applied.** `pluginContainerEnv` sets
  `HOME=/tmp` unconditionally — which is what a foreign image needs, since the
  call runs as a per-session uid that cannot write the image's own home — but
  its `PLAYWRIGHT_BROWSERS_PATH` / `NPM_CONFIG_PREFIX` / `PATH` overrides are
  repairs for *borrowing the worker image* and would point a foreign image away
  from what it ships. That line is already drawn for services
  (`plugin-container-env.ts:40`); M2b applies the same rule to a CLI.
- **The image must be able to execute the plugin's entry.** The invocation sets
  `Entrypoint: [spec.entry]` (`plugin-cli-run.ts:846`), so the interpreter that
  entry names has to exist in the image — and the image's own `ENTRYPOINT` is
  bypassed, so an image that does setup there (an s6-based one, say) never runs
  it.
- **No new trust class.** A plugin *service* already names an arbitrary image
  (`plugin-compose.ts:685`), and the CLI container is the more contained of the
  two: `CapDrop: ALL`, `no-new-privileges`, and a network registered untrusted
  at creation.

**What it cannot do** is add anything to the image. A plugin needing Blender
*plus* an addon, a font, or a Python library gets whatever the published image
has. That is the case M3 exists for — and it is a narrower case than "a heavy
dependency", which is why M2b may retire M3 for this feature without retiring
the idea.

### M3 — the plugin ships a Dockerfile and ShipIt builds it

The only candidate that satisfies reqs 1–4 together, and therefore the target.

**What it must include to be a CLI mechanism at all.** Lifting the fragment
`build:` refusal is a *service* change and does not reach a companion CLI. M3
must additionally define (a) a manifest field by which a plugin names the
Dockerfile its CLI runs on, (b) the build-and-adopt flow that selects the
resulting image at invocation time, replacing `PluginCliDeps.image`, and (c) an
image identity keyed to the **content** of the Dockerfile and the inputs it
declares. Without those, a built image serves services only.

**Requirement 4 decides (c), and rules out the obvious answer.** Keying the
image to the plugin commit is the intuitive choice and it is wrong: a plugin
repository commits often, and a commit-keyed tag would rebuild a gigabyte-sized
image on every one of them — exactly the cost req 4 forbids a refresh from
paying. The identity must be content-addressed, the same way the existing
dependency store keys a base by the content of an install's declared inputs
rather than by the commit (`plugin-dep-store.ts`, module docstring).

Two consequences follow. A build context of `.` defeats it, because every commit
changes the context and invalidates the layer — so the design must let a plugin
declare what its build actually consumes, for which `install-inputs` is the
existing precedent. And one image will legitimately serve many commits, so the
tie between "the running plugin" and "one commit" (`docs/262-plugins` req 15) is
held by the checkout and the generation, not by the image. That is already true
of dependency-store bases today, so it is a precedent rather than an exception.

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

That prerequisite now has its own design — `docs/291-contained-builds`,
planning#512 — which reports containment as achievable but **not** by the
obvious route: the tier program's Tier B/C exemptions are keyed by uid
(`session-worker-uid.ts:37` — "they are not identity checks, so ANY process with
that uid inherits them"), and a `RUN` step starts as root and can assume a
reserved uid in one line, which no declaration-time check on `user:` can reach.
Read that doc rather than assuming the shape; it is a design with open
questions, not a decision.

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

**This ordering is contingent on the open question about req 3** (does naming an
*existing* third-party image satisfy self-containment?), and the two answers give
different targets:

- **If yes — M2b is the target**, and M3 is not needed for this feature. M2b
  satisfies all four requirements, needs no build, and therefore needs no
  build-time egress containment; the remaining work is a pull path, not applying
  the worker-image env repairs to a foreign image, and the manifest surface.
  M3's idea survives for the narrower case M2b cannot serve — a plugin that
  needs an image *plus* something the published one lacks — but that is not this
  feature.
- **If no — M3 is the target**, because it is then the only candidate satisfying
  reqs 1–4 together, and its first piece of work is **contained builds**, not
  the plugin-facing surface.

Either way: **M2a is rejected** (it fails req 3, which a human decided), and
**M4 is an optimisation of whichever image mechanism lands**, never a reason to
choose one.

M1 is not on this list: the user scoped it out as a separate bug
(planning#511).

Two earlier drafts got the ordering wrong in the same way — by narrowing a
requirement rather than reading it whole. The first recommended M1, on the
reading that req 1 might exclude dependencies needing system packages; req 1
already classifies that case. The second rejected M2 outright, by collapsing
"the author publishes an image" and "the plugin names an image that already
exists" into one mechanism when only the first is what req 3's receipt ruled
on.

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
| `src/server/orchestrator/plugin-dep-store.ts` | The store and its key; since planning#511, `planPluginDepStore` returns a `PluginDepStoreDecision` with a typed reason at each decline branch, and promotion reports a directory that pinned nothing |
| `src/server/orchestrator/plugin-install.ts` | Install container limits; boot-time reap of CLI containers. Its silent `succeeded`-with-no-plan path was fixed by planning#511 |
| `src/server/shared/deps-hash.ts` | Which install commands can be content-keyed; `install-inputs` overrides |
| `src/server/orchestrator/plugin-cli-run.ts` | The invocation container: borrowed image, 2 GiB, 512 pids, 15 min |
| `src/server/orchestrator/plugin-compose.ts` | Fragment allowlist, the `build:` refusal, allowed resource keys |
| `src/server/orchestrator/api-container-guard.ts` | The two denial constructions M4 trades between |
| `src/server/orchestrator/compose-cli.ts` | `--build` on every `up`; `killStaleContainers` |
| `docs/263-compose-service-egress` | Why build-time containment is M3's prerequisite |
