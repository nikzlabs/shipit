---
status: planned
description: Share dependency trees across sessions by overlay-mounting an immutable, lockfile-keyed canonical layer instead of copying node_modules per session.
---

# Overlay-mounted canonical dependency layer

> **TL;DR — the proposal.** Replace the per-session **full copy** of `node_modules`
> (today's `nm-store` `tar`/`cp -a`) with an **overlay mount**: one immutable,
> lockfile-keyed canonical layer mounted read-only under every session, with a
> per-session upper layer for copy-on-write. On a cache hit, *no installer runs for any
> ecosystem* — npm, Yarn, pnpm, pip, uv all collapse to "mount the canonical layer."
> The orchestrator owns the mount; the worker keeps owning the install. A hardlink ladder
> is kept only as an unprivileged fallback.
>
> The reasoning and ecosystem-by-ecosystem analysis behind this choice is in
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

**The populate path is unchanged.** `populateStore()` already runs the install in the
**worker** and publishes to host-backed `/dep-cache/nm-store/<key>` via temp-dir + atomic
rename ([nm-store.ts:272-309](../../src/server/session/nm-store.ts#L272-L309)) — a
directory the orchestrator can already see. Division of labor:

- **Worker** keeps owning *running the install* and publishing to `/dep-cache/nm-store/<key>`.
- **Orchestrator** owns *the mount* — on a future hit it points a `lowerdir` at that
  already-published directory instead of `cp`-ing it. Only consumption flips
  (`cp`/`tar` → mount); keying, atomic publish, and warm-pool pre-warm are identical.

**Triggers:** (1) session start → `key = hash(lockfile + runtimeKey + installCmd)`;
(2) hit → mount, miss → install + publish, next session hits; (3) warm pool pre-populates
the key before the first real session; (4) lockfile/runtime change → new key → repopulate.

**Mid-session dependency changes** land in the per-session `upperdir` (copy-up) — correct
for that session, but a live/dirty `upperdir` is **never promoted** into the shared layer.
Promotion is lazy and lockfile-driven: the next session from the *committed* new lockfile
keys differently, misses, and repopulates from a clean install.

### 4. Scope per ecosystem

- **npm, Yarn (classic / `node-modules` linker)** — primary beneficiaries (dumb-copy
  managers, no native dedup).
- **pnpm, uv, conda, Yarn PnP** — overlay still helps (cache hit = mount, zero install),
  but until overlay lands the no-new-machinery floor is to share their own store **on the
  same filesystem** as the workspace so their built-in dedup isn't silently defeated.
- **Python venvs** — overlay covers them with one pin: build the canonical venv at the
  **same absolute path it will be mounted** (`/workspace/.venv`), since venvs hardcode
  absolute paths. ShipIt's constant `/workspace` makes this stable. The built-wheel cache
  (`PIP_CACHE_DIR`) already removes the slow native-compile step regardless.
- **Hardlink ladder** — fallback only, for hosts/kernels without the host-mount layer (or
  a first unprivileged prototype). Dumb-copy managers only, same-fs required, must guard
  in-place mutation; do **not** apply to pnpm/uv.

## Next steps

1. Spike the orchestrator host-mount subsystem (mount/unmount lifecycle +
   janitor/archive awareness) to size the real cost — this is the gating unknown.
2. In parallel, prototype the hardlink fallback and benchmark cache-hit time (mount vs.
   hardlink vs. today's `cp`/`tar`) on a large repo (ShipIt itself: ~588 packages, ~24s
   cold install).

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

## Related docs

- [075-shared-dependency-cache](../075-shared-dependency-cache/plan.md) — the download cache
- [148-fast-npm-install](../148-fast-npm-install/plan.md) — the materialized `nm-store`
- [162-fast-install-gate-race](../162-fast-install-gate-race/plan.md) — synchronous fast-path gate
