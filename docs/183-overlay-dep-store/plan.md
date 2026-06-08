---
status: planned
description: Share dependency trees across sessions by overlay-mounting an immutable, lockfile-keyed canonical layer instead of copying them in per session.
---

# Overlay-mounted canonical dependency layer

> **TL;DR — the proposal.** Replace the per-session **full copy** of `node_modules`
> (today's `nm-store` `tar`/`cp -a`) with an **overlay**: a **single rolling base per repo**
> mounted read-only as the `lowerdir`, with a per-session upper layer for copy-on-write.
> Each session always runs its **real install command on top of that warm base**, so it
> does only incremental work — which needs **no keys and no lockfile detection**, making it
> work for arbitrary commands, monorepos, and Python alike. Concurrency stays clean by
> advancing the shared base through an **optimistic compare-and-swap** (parallel installs,
> serialized publish). The orchestrator owns the mount; the worker keeps owning the install.
>
> A content-addressed *keyed* variant (skip install on an exact match) is kept as an
> optional optimization / [alternative](#alternative-the-keyed-immutable-layer). The
> reasoning and ecosystem-by-ecosystem analysis are in
> [Research & analysis](#research--analysis) at the bottom.

## Problem

Every session that needs dependencies pays to get `node_modules` into its workspace.
Downloads are already shared (`/dep-cache`, [075](../075-shared-dependency-cache/plan.md)),
and whole `node_modules` trees are already cached and keyed by
`sha256(lockfile + runtimeKey + installCommand)` ([148](../148-fast-npm-install/plan.md)).
But the cached tree is laid down by a **full copy** — `tar | tar` → `cp -a`
([nm-store.ts:218-259](../../src/server/session/nm-store.ts#L218-L259)) — which is the
remaining per-session cost (tens of thousands of tiny file writes) and burns disk (one
physical copy per session). It also forced an explicit rejection of hardlinking
([nm-store.ts:203-208](../../src/server/session/nm-store.ts#L203-L208)), because a
mid-session `npm rebuild` / `patch-package` would corrupt a shared store through shared
inodes.

## Proposed design

> **Rename first — the store is no longer node_modules-specific.** Today's module is
> `nm-store.ts` and the on-disk store is `/dep-cache/nm-store/<key>` — both named for
> `node_modules`. This design also caches Python venvs (and any future ecosystem's tree),
> so as part of the work rename the module to **`dep-store.ts`** and the store path to
> **`/dep-cache/dep-store/<key>`**. The rest of this doc uses `dep-store` for the proposed
> system and keeps `nm-store` only when citing today's code.

### 1. Overlay instead of copy

Mount the canonical tree as a read-only `lowerdir` with a fresh per-session `upperdir`
for writes (copy-on-write). Materialize becomes an **O(1) mount** instead of an O(files)
copy, disk is shared until a session writes, and in-place mutations are isolated by
copy-up — structurally solving the very problem `nm-store` pays a full copy to avoid.
This is ecosystem-agnostic: on a cache hit the install step disappears entirely,
including for store-based managers like pnpm/uv that would otherwise re-link thousands of
files.

### 2. Orchestrator owns the mount

The mount can't happen inside the session container — ShipIt's containment model is
unprivileged containers, HTTP-only, no `docker exec` (`docs/172-agent-containment`). So
the **orchestrator mounts on the host and bind-mounts the merged dir into the session**.
This is the one genuinely new subsystem and the gate on the whole proposal:

- Mount (lower + upper + workdir) on session activate.
- Unmount + clean workdir on disposal.
- `disk-janitor` and archive flows must learn about live mounts before tearing down dirs.

If this subsystem is acceptable, overlay-for-all is the design and hardlink is
unnecessary.

### 3. Lifecycle: populate vs. consume

**Consumption** (mount the layer) and **population** (run the install) are different
paths; only consumption changes from today.

> **Routing direction (read this first).** There are two ways to route a session to a
> base: a **content-addressed key** (skip install on an exact match) or a **keyless rolling
> chain** (always warm-install on one base per repo). To avoid keys and lockfile detection,
> the **keyless chain in §4 is the chosen primary design**; the keyed mechanics described in
> the rest of this section are an *optional optimization* layered on top (and stand alone as
> the [keyed alternative](#alternative-the-keyed-immutable-layer)). Read §3 for the
> immutable-layer/CoW mechanics that both modes share, then §4 for how routing actually
> works.

The canonical layer is **content-addressed and immutable — never updated in place**
(mutating a layer that live sessions mount read-only would corrupt all of them). A
lockfile/runtime change produces a **new key → new layer**; the old one is GC'd once
unreferenced (existing stale-`nm-store` sweep). The install therefore runs **only on a
cache miss, into a writable tree — never against the mount**:

- **Hit:** orchestrator mounts the existing immutable layer read-only + a fresh
  `upperdir`. No installer runs.
- **Miss:** the session (or a warm standby) runs the real install into a writable tree,
  exactly as today. On success the result is frozen into the keyed store via atomic
  rename, and *that frozen directory becomes the `lowerdir`* for future sessions.

**The populate path is unchanged** (apart from the rename). `populateStore()` already runs
the install in the **worker** and publishes to a host-backed store dir via temp-dir +
atomic rename ([nm-store.ts:272-309](../../src/server/session/nm-store.ts#L272-L309)) — a
directory the orchestrator can already see. Division of labor:

- **Worker** keeps owning *running the install* and publishing to `/dep-cache/dep-store/<key>`.
- **Orchestrator** owns *the mount* — on a future hit it points a `lowerdir` at that
  already-published directory instead of `cp`-ing it. Only consumption flips
  (`cp`/`tar` → mount); keying, atomic publish, and warm-pool pre-warm are identical.

**Who handles detection, and what about arbitrary / nested / monorepo installs?** The
**session worker** does, via the existing fast-path gate — `computeFastPath()`
([session-worker.ts:1163](../../src/server/session/session-worker.ts#L1163)) plus helpers
in `nm-store`. The crucial point: **there is no framework auto-detection, and there
doesn't need to be.** The gate is deliberately narrow and bails to a plain install on
anything ambiguous, so the cache only ever engages where the answer is unambiguous:

- **Command allowlist, not framework sniffing.** `isCacheableInstall()`
  ([nm-store.ts:123](../../src/server/session/nm-store.ts#L123)) accepts *only* a single
  bare `npm install|i|ci`, `yarn [install]`, or `pnpm install|i`. Any shell metacharacter,
  env prefix, extra flag, `cd`, or command chaining disqualifies it. An **arbitrary
  install command** (a script, `make deps`, `cd packages/api && npm ci`, `pip install -e
  .`) therefore never matches → it just runs as a normal install, uncached. The command
  string also goes *into* the key, so two commands that build different trees can't
  collide.
- **Single top-level lockfile only.** `findLockfile()`
  ([nm-store.ts:63](../../src/server/session/nm-store.ts#L63)) looks **only at the
  workspace root** for exactly **one** of `package-lock.json` / `yarn.lock` /
  `pnpm-lock.yaml`. A **nested** `package.json`, or a **monorepo with several lockfiles**,
  yields zero-or-many → returns null → plain install. The code comment is explicit that
  this monorepo case is intentionally punted, because one hoisted cache wouldn't be
  correct.

So "which framework?" is never guessed — it's read off *which single recognized lockfile
is present* and *which exact command was typed*. Everything outside that narrow window
falls through to today's behavior (a real install), losing the speedup but never risking a
wrong cache.

**Detection of a "change" is then implicit — the key is the detector.** For a case that
*does* qualify, the worker computes
`key = sha256(lockfileName + lockfileContent + runtimeKey + tunedInstallCommand)`
([computeStoreKey, nm-store.ts:173](../../src/server/session/nm-store.ts#L173)):

- **lockfileContent** — the bytes of that one root lockfile; any dependency change *is* a
  change to these bytes.
- **runtimeKey** — image digest + arch + libc + interpreter major
  ([nm-store.ts:92](../../src/server/session/nm-store.ts#L92)), so a tree with compiled
  native addons/wheels is never reused across an incompatible runtime.

A changed lockfile or rebuilt image simply hashes to a **different key** with no published
layer → miss → repopulate. No diffing, no invalidation, no mtime check — "did it change?"
reduces to "does a layer for this key exist?" (the janitor prunes keys no session uses).

**Triggers:** (1) session start → recompute key; (2) hit → mount, miss → install +
publish, next session hits; (3) warm pool pre-populates the key before the first real
session; (4) different lockfile/runtime → different key → repopulate.

**Mid-session dependency changes** land in the per-session `upperdir` (copy-up) — correct
for that session, but a live/dirty `upperdir` is **never promoted** into the shared layer.
Promotion is lazy and lockfile-driven: the next session from the *committed* new lockfile
keys differently, misses, and repopulates from a clean install.

### 4. Making misses cheap *and* detection-free: populate from a warm base

The miss path above ("run the real install into an empty tree") still pays a full cold
install, and the cache only engages for the narrow allowlisted shape. A better miss path —
the **restore-nearest** pattern from CI caching (GitHub Actions `restore-keys`, BuildKit
`RUN --mount=type=cache`): instead of installing into an *empty* tree, mount the **nearest
prior layer for the same repo** as the `lowerdir` and **run the install command on top of
it**, then publish the merged result as the new keyed layer.

The package managers do the rest: `npm/yarn/pnpm install`, `pip install -r`, `poetry
install`, `uv sync` all do up-to-date checks against an existing tree, so:

- **Nothing changed** → the install is a near no-op (a few seconds of resolution), the
  `upperdir` delta is ~empty.
- **Something changed** → the install writes only the delta into the `upperdir`; the merged
  view becomes the next baseline.

**Why this is a big deal: it dissolves the detection problem for population.** Because we
*actually run the real install command*, the populate path no longer needs the command
allowlist or the single-lockfile rule — an **arbitrary command, a monorepo, a nested
package, or Python** all just work, because the package manager itself decides what to
change. Detection (the key) is then only needed for the *consume/hit* path, where it earns
its keep (see caveats). Capture the baseline **immediately after install, before the agent
or services start**, so session-specific mutations never pollute the shared lineage — which
is already how the install gate is ordered today.

**Avoiding keys entirely: a single serialized chain per repo (the chosen direction).** To
have *no keys and no lockfile detection*, route **every** session to **one rolling base per
repo** and always run the real install on top of it. No `findLockfile`, no allowlist, no
`computeStoreKey` — monorepos, nested packages, Python, and arbitrary commands all work,
because the package manager itself reconciles the tree. Concurrency is kept clean by
**serializing the base advance** — but *how* you serialize matters:

- **Don't serialize the whole install.** A multi-second lock on the first-turn critical
  path would queue new sessions and fight the warm pool. Instead use **optimistic
  concurrency**: every session mounts the *current* base and runs install in **parallel**;
  publishing the merged result as the next base is a cheap **compare-and-swap** (succeeds if
  the base hasn't advanced since you started; otherwise keep your tree locally and skip the
  publish). The published chain stays strictly linear while installs stay parallel.

**The honest limit of a single chain — branch divergence, not concurrency.**
Serialization fixes *concurrent* forks, but one chain is one-dimensional while branches are
many. When consecutive installs come from **divergent dependency states** (`main` vs a
`feature` branch that changed deps, or a package-manager switch), each install fully
*reconciles* the base (remove + add) instead of no-op'ing — slower, and it accumulates
drift. This happens even with purely *sequential* sessions alternating branches, so
serialization can't fix it. In practice branches of one repo usually share ~all deps, so
the warm delta is tiny and the download cache covers additions — but a repo with wildly
divergent branches will thrash on a single chain.

**If thrashing (or the always-pay-install floor) bites, the fix is *not* lockfile
detection.** You can route per-branch and skip a no-op install with a **detection-free
content fingerprint**: hash the bytes of *every* dependency-manifest file found by a fixed
glob across the tree (`package.json`, `*.lock`, `pnpm-lock.yaml`, `requirements*.txt`,
`poetry.lock`, `uv.lock`, `pyproject.toml`, …) together with the runtime. This is **not**
"pick the one lockfile" — it's a coarse fingerprint of *all* manifests, so monorepos and
polyglot repos are included by construction, and a divergent branch simply fingerprints
differently and gets its own lineage. It is optional and additive: ship the keyless single
chain first; add the fingerprint only if measurements show thrashing or the warm-install
seconds matter.

**Shared caveats either way:**

- **Overlay depth is bounded.** Stacked `lowerdir`s are limited (mount-options must fit in
  a page; Docker's overlay2 historically capped at 128), so **periodically flatten** the
  merged result into a fresh single base (an amortized copy, ideally in the warm pool).
- **Incremental installs drift.** Re-running `install` over generations can leave
  extraneous packages or stale `.bin` links; schedule an occasional **clean rebuild** from
  empty. `npm ci` *deletes* `node_modules` first → no warm-base gain (only the download
  cache); `install` / `pnpm install` / `pip install` / `uv sync` all benefit.
- **Always-run-install has a floor.** Even a warm no-op install is a few seconds of
  resolution; the keyless chain never reaches the keyed mode's ~0 skip. That is the price
  of no keys — accept it, or add the optional fingerprint to skip on an exact match.

### 5. Scope per ecosystem

The keyless chain **drops today's narrow gate** — there's no allowlist or single-lockfile
rule, because the real install command runs verbatim on the warm base regardless of
ecosystem or monorepo shape. The one genuinely new per-ecosystem requirement is a
**deterministic mount-target path** — the directory the base is mounted at — since overlay
mounts in place rather than copying into a fixed `node_modules`.

- **npm, Yarn (classic / `node-modules` linker)** — primary beneficiaries (dumb-copy, no
  native dedup). Target path is trivially deterministic: `<workspace>/node_modules`, the
  same place `materialize`/`populateStore` hardcode today.
- **pnpm, uv, conda, Yarn PnP** — overlay still helps (cache hit = mount, zero install),
  but until overlay lands the no-new-machinery floor is to share their own store **on the
  same filesystem** as the workspace so their built-in dedup isn't silently defeated.
- **Python (pip/poetry/uv venvs)** — the keyless chain runs the real install, so there's
  no detection to do; the only hard part is the **target path**. Unlike `node_modules`, a
  venv's location varies and venvs hardcode absolute paths, so standardize on a fixed venv
  path (`/workspace/.venv`), build the base there, and overlay-mount it back at that same
  path — ShipIt's constant `/workspace` keeps it stable. The built-wheel cache
  (`PIP_CACHE_DIR`) already removes the slow native-compile step regardless.

Hardlinking is **not** part of this design — it was considered and rejected as a separate
mechanism; see [Why overlay, not hardlink](#why-overlay-not-hardlink) for why.

## Next steps

1. Spike the orchestrator host-mount subsystem (mount/unmount lifecycle +
   janitor/archive awareness) to size the real cost — this is the gating unknown.
2. Prototype the keyless rolling base: mount the repo's current base, run the real install
   on top, advance the base via optimistic compare-and-swap. Measure warm-install time for
   "nothing changed", "one dep added", and "alternating divergent branches" (the thrash
   case) vs. a cold install.
3. Rename `nm-store` → `dep-store` (module + store path) as a self-contained precursor,
   since it's purely a rename and unblocks the generalized naming.
4. From the measurements, set the **flatten cadence** (overlay-depth cap) and the periodic
   **clean-rebuild** policy that bounds drift; decide whether the optional detection-free
   manifest fingerprint is worth adding to skip no-op installs / avoid branch thrash.

## Key files

| Concern | File |
|---|---|
| dep-cache dir + mount + env | [container-lifecycle.ts](../../src/server/orchestrator/container-lifecycle.ts#L83-L211), [session-dir-factory.ts](../../src/server/orchestrator/session-dir-factory.ts#L56-L66) |
| Materialize / populate store | [nm-store.ts](../../src/server/session/nm-store.ts#L218-L309) |
| Fast-install gate + cacheable-command detection | [session-worker.ts](../../src/server/session/session-worker.ts#L649-L707) |
| Warm-pool pre-install | [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L173-L242) |
| Cache cleanup | [disk-janitor.ts](../../src/server/orchestrator/disk-janitor.ts#L568-L676) |

---

# Research & analysis

*This section is the investigation that led to the proposal above — kept for the
reasoning, the rejected alternatives, and the per-ecosystem detail.*

## The one axis that decides everything

A package manager either **dumb-copies** files into the project (no native dedup) or
maintains a **content-addressable store + hardlinks/reflinks** into the project. That
single property decides whether a ShipIt-side overlay/canonical-volume adds anything:

- **Dumb-copy managers** (npm, Yarn classic, Yarn `node-modules` linker, pip→venv):
  no native dedup → a ShipIt overlay/canonical-volume is a **real win**.
- **Store-based managers** (pnpm, uv, conda, Yarn PnP): they **already** do this →
  adding our own *hardlink* layer on top is redundant or slower. (Overlay still helps,
  because a cache hit becomes a mount with no install at all.)

## Node ecosystem

| Manager | On-disk model | ShipIt overlay / canonical-volume value | Notes |
|---|---|---|---|
| **npm** | Real copied `node_modules`, no dedup | **High** — primary `nm-store` target | Materialize copy is the remaining cost |
| **Yarn classic (v1)** | Real copied `node_modules` | **High** — same as npm | Already cacheable in `nm-store` fast path |
| **Yarn Berry, `node-modules` linker** | Real copied `node_modules` | **High** — same as npm | `nodeLinker: node-modules` |
| **Yarn Berry, PnP** | No `node_modules`; `.pnp.cjs` + zip cache | **N/A** — nothing to materialize | Share the zip cache (already cheap) |
| **pnpm** | Global content-addressable store + **hardlinks** into `node_modules/.pnpm` | Hardlink redundant; overlay = mount, zero install | Don't stack a hardlink store; share store on same fs |

## Python ecosystem

| Tool | On-disk model | ShipIt overlay / canonical-volume value | Notes |
|---|---|---|---|
| **pip + venv** | Copies into `site-packages`; HTTP + **built-wheel** cache (`~/.cache/pip`) | **Medium** — wheel cache already kills the expensive part | Venv relocatability wrinkle (below) |
| **poetry** | pip/venv under the hood | **Medium** — same as pip+venv | Inherits wheel cache + venv wrinkle |
| **uv** (Astral) | Global content-addressable cache + **hardlink/reflink** into venv | Hardlink redundant (the pnpm of Python); overlay = mount | Share `UV_CACHE_DIR` on same fs |
| **conda** | pkgs cache + hardlinks into envs | Hardlink redundant; overlay = mount | Share pkgs cache |

### Python's extra wrinkle: venvs aren't relocatable

A `node_modules` is **location-independent** (relative `require`), which is *why*
`nm-store` can drop a cached tree into any session at any path. A virtualenv hardcodes
absolute paths in `pyvenv.cfg`, activation scripts, and console-script shebangs, so a
"canonical venv" laid down by **copy or hardlink** at a *different* path breaks without
`--copies` + path rewriting.

**Overlay sidesteps this** — a further argument for it over hardlink: build the canonical
venv at the path it will be presented (`/workspace/.venv`), capture it as a read-only
lowerdir, and overlay-mount it back at `/workspace/.venv`. The baked-in paths match the
mount point, so nothing needs rewriting, and ShipIt's constant `/workspace` keeps the path
stable across sessions. Copy/hardlink can only match the path by physically living at it,
which collides with the live workspace; overlay stores the layer elsewhere yet presents it
at the canonical path.

## Strategy comparison (getting the cached tree into a session)

| Strategy | Speed | Disk usage | Cross-filesystem | Privileges | Mutation safety |
|---|---|---|---|---|---|
| **Full copy** (today) | Slow (tens of k tiny files) | 1 physical copy per session | Works anywhere | None | Trivially isolated |
| **Hardlink from store** (pnpm-style) | Near-instant | Shared inodes | **No** — needs same fs | None | Safe *iff* tools write-by-rename; in-place edits corrupt store |
| **OverlayFS (CoW)** | Near-instant (a mount) | Shared until write | Lower layer can differ; **upper + workdir must share fs** | `CAP_SYS_ADMIN` in-container, or host-side mount | Isolated by design (copy-up + whiteouts) |

### The same-filesystem caveat

Hardlinks and reflinks **cannot cross mount boundaries**. `dep-cache` is mounted as a
separate volume/subpath from the workspace
([container-lifecycle.ts:147-154](../../src/server/orchestrator/container-lifecycle.ts#L147-L154)).
If workspace and store land on different filesystems, **pnpm and uv silently fall back to
full copies** — defeating their native dedup invisibly. OverlayFS is more forgiving: only
its upper + work dir must share a filesystem; the read-only lower layer can live elsewhere
— fitting ShipIt's separate-volume layout better than hardlinks do.

### Overlay operational cost

- Container rootfs is already overlayfs; a **nested** overlay inside an unprivileged
  container needs `CAP_SYS_ADMIN`-ish config — friction ShipIt avoids. Hence the
  host-side-mount route in the proposal.
- Lower layer must be **immutable** (already true: `nm-store` only publishes via atomic
  rename — [nm-store.ts:272-309](../../src/server/session/nm-store.ts#L272-L309)).
- **ext4 on the prod VPS**: reflink (`cp --reflink`) is out (ext4 has no reflink), but
  overlayfs works fine on ext4.
- `runtimeKey` discipline matters across ecosystems: native addons / compiled wheels are
  arch + libc + interpreter-version specific and must stay in the cache key.

## Why overlay, not hardlink

Hardlink and overlay are **not co-equal** — the choice is deployability vs. correctness:

| | Hardlink ladder | OverlayFS |
|---|---|---|
| New architecture | None — swap the `nm-store` materialize ladder | Privileged mount layer + per-session mount lifecycle |
| Privileges | Unprivileged | `mount(2)` needs `CAP_SYS_ADMIN` |
| Works on prod today | Yes | Needs the host-mount plumbing first |
| Teardown | `rm` the workspace | Unmount + clean workdir on disposal |
| Cross-filesystem canonical | **No** — same fs required | **Yes** — only upper + workdir share an fs |
| In-place mutation (`patch-package`, hand-edit) | **Corrupts the shared store** unless guarded | Copy-up isolates it — store is immune |
| Helps store-based managers (pnpm/uv) | **No** — they already hardlink | **Yes** — cache hit becomes a mount, zero install |
| Cache-hit cost | Create N links (large for big trees) | One mount, O(1) regardless of tree size |

Overlay wins on every axis **except** the one-time cost of building the mount layer. Its
decisive advantage is uniformity: on a cache hit no installer runs for *any* manager,
whereas hardlinking only helps the non-dedup managers while *defeating* the ones that do
(you'd cache pnpm's linked result as a flat tree and re-link it). One read-only lowerdir
is shared by unlimited concurrent sessions — that's what overlayfs lowerdirs are for.

## Alternative: the keyed immutable layer

The earlier iteration of this design routed by a **content-addressed key** —
`sha256(lockfileName + lockfileContent + runtimeKey + tunedInstallCommand)` — and on an
**exact match skipped the install entirely**, mounting an immutable per-key layer. Why the
keyless rolling chain (§4) is preferred instead, and what the keyed variant still buys:

- **Keyed pros:** the hit path is **~0** (a mount, no installer process) and fully
  **reproducible** and **concurrency-safe** by construction (identical inputs → identical
  immutable layer; the atomic-rename publish dedupes). Different branches route to
  different layers with **no thrashing**.
- **Keyed cons (why it's not primary):** it depends on **detecting the lockfile**, which is
  exactly what we're trying to avoid — today's `findLockfile` only handles a *single
  top-level* lockfile and deliberately punts **monorepos** and nested packages, and
  `isCacheableInstall` only fast-paths a narrow command allowlist. Generalizing that
  detection to every ecosystem/monorepo is the fragile part.
- **Reconciliation:** the keyed *skip* can be re-added later **without** reintroducing
  fragile detection, via the **detection-free manifest fingerprint** in §4 (hash *all*
  manifest files by a fixed glob, not "the one lockfile"). So the keyed fast path is an
  optional optimization on top of the keyless chain, not a competing design.

## Related docs

- [075-shared-dependency-cache](../075-shared-dependency-cache/plan.md) — the download cache
- [148-fast-npm-install](../148-fast-npm-install/plan.md) — the materialized `nm-store`
- [162-fast-install-gate-race](../162-fast-install-gate-race/plan.md) — synchronous fast-path gate
