---
status: planned
description: Evaluate copy-on-write / canonical-volume strategies for sharing dependency trees across sessions, per package-manager ecosystem (npm, Yarn, pnpm, pip, uv, poetry, conda).
---

# Canonical dependency volume vs. copy-based `nm-store`

## Context

Today ShipIt speeds up dependency setup with two shared, per-repo layers
(see [075-shared-dependency-cache](../075-shared-dependency-cache/plan.md) and
[148-fast-npm-install](../148-fast-npm-install/plan.md)):

1. **Download cache** — `/dep-cache` is mounted into every session container and the
   package managers point at it (`npm_config_cache`, `YARN_CACHE_FOLDER`,
   `PNPM_STORE_DIR`). Tarballs download once per repo.
   ([container-lifecycle.ts:209-211](../../src/server/orchestrator/container-lifecycle.ts#L209-L211))
2. **Materialized `node_modules` store** (`nm-store`) — whole `node_modules` trees,
   keyed by `sha256(lockfile + runtimeKey + installCommand)`, are cached and laid down
   on a new session via a **full copy** (`tar | tar` → `cp -a`).
   ([nm-store.ts:218-259](../../src/server/session/nm-store.ts#L218-L259))

The open question: instead of *copying* the cached tree into each session, mount a
**canonical, read-only dependency volume** as a lower layer and **overlay** per-session
writes on top (copy-on-write). This doc evaluates that idea, and — critically — how far
it generalizes beyond npm to the other Node and Python ecosystems.

`nm-store` explicitly **rejected hardlinking** today
([nm-store.ts:203-208](../../src/server/session/nm-store.ts#L203-L208)) because a
mid-session `npm rebuild` / `patch-package` / added dep would corrupt the shared store
through shared inodes. Copy-on-write is the precise tool that solves that "share the
tree but isolate mutations" problem the current code pays a full copy to avoid.

## The one axis that decides everything

A package manager either **dumb-copies** files into the project (no native dedup) or
maintains a **content-addressable store + hardlinks/reflinks** into the project. That
single property decides whether a ShipIt-side overlay/canonical-volume adds anything:

- **Dumb-copy managers** (npm, Yarn classic, Yarn `node-modules` linker, pip→venv):
  no native dedup → a ShipIt overlay/canonical-volume is a **real win**.
- **Store-based managers** (pnpm, uv, conda, Yarn PnP): they **already** do exactly
  this → adding our own layer on top is redundant or *slower*. The only lever is
  configuration: share their store and keep it on the **same filesystem** as the
  workspace so their native hardlinking actually fires.

## Node ecosystem

| Manager | On-disk model | ShipIt overlay / canonical-volume value | Notes |
|---|---|---|---|
| **npm** | Real copied `node_modules`, no dedup | **High** — primary `nm-store` target | Materialize copy is the remaining cost |
| **Yarn classic (v1)** | Real copied `node_modules` | **High** — same as npm | Already cacheable in `nm-store` fast path |
| **Yarn Berry, `node-modules` linker** | Real copied `node_modules` | **High** — same as npm | `nodeLinker: node-modules` |
| **Yarn Berry, PnP** | No `node_modules`; `.pnp.cjs` + zip cache | **N/A** — nothing to materialize | Share the zip cache (already cheap) |
| **pnpm** | Global content-addressable store + **hardlinks** into `node_modules/.pnpm` | **Redundant** — already approach B natively | Don't stack `nm-store` on top; just share store on same fs |

## Python ecosystem

| Tool | On-disk model | ShipIt overlay / canonical-volume value | Notes |
|---|---|---|---|
| **pip + venv** | Copies into `site-packages`; HTTP + **built-wheel** cache (`~/.cache/pip`) | **Medium** — wheel cache already kills the expensive part | Venv relocatability wrinkle (below) |
| **poetry** | pip/venv under the hood | **Medium** — same as pip+venv | Inherits wheel cache + venv wrinkle |
| **uv** (Astral) | Global content-addressable cache + **hardlink/reflink** into venv | **Redundant** — already approach B (the pnpm of Python) | Share `UV_CACHE_DIR` on same fs |
| **conda** | pkgs cache + hardlinks into envs | **Redundant** — already does it | Share pkgs cache |

### Python's extra wrinkle: venvs aren't relocatable

A `node_modules` is **location-independent** (relative `require`), which is *why*
`nm-store` can drop a cached tree into any session at any path. A virtualenv hardcodes
absolute paths in `pyvenv.cfg`, activation scripts, and console-script shebangs, so a
"canonical venv" laid down by **copy or hardlink** at a *different* path breaks without
`--copies` + path rewriting (or a relocation-aware tool).

**Overlay sidesteps this**, which is a further argument for it over hardlink here: build
the canonical venv at the path it will be presented (`/workspace/.venv`), capture it as a
read-only lowerdir, and overlay-mount it back at `/workspace/.venv`. The files' baked-in
paths match the mount point, so nothing needs rewriting — and ShipIt's constant
`/workspace` makes that path stable across every session. Copy/hardlink can only match
the path by physically living at it, which collides with the live workspace; overlay can
store the layer elsewhere yet present it at the canonical path. Meanwhile pip's
built-wheel cache (`PIP_CACHE_DIR`) already removes the slow native-compile step, so even
without overlay the expensive part of Python installs is shareable today.

## Strategy comparison (the materialize step)

For the dumb-copy managers, three ways to get the cached tree into a session:

| Strategy | Materialize speed | Disk usage | Cross-filesystem | Privileges | Mutation safety |
|---|---|---|---|---|---|
| **Full copy** (today) | Slow (tens of k tiny files) | 1 physical copy per session | Works anywhere | None | Trivially isolated |
| **Hardlink from store** (pnpm-style) | Near-instant | Shared inodes | **No** — needs same fs | None | Safe *iff* tools write-by-rename; in-place edits corrupt store |
| **OverlayFS (CoW)** | Near-instant (a mount) | Shared until write | Lower layer can differ; **upper + workdir must share fs** | `CAP_SYS_ADMIN` in-container, or host-side mount | Isolated by design (copy-up + whiteouts) |

### The same-filesystem caveat

Hardlinks and reflinks **cannot cross mount boundaries**. `dep-cache` is mounted as a
separate volume/subpath from the workspace
([container-lifecycle.ts:147-154](../../src/server/orchestrator/container-lifecycle.ts#L147-L154)).
If workspace and store land on different filesystems, **pnpm and uv silently fall back
to full copies** — defeating their native dedup invisibly. OverlayFS is more forgiving:
only its upper + work dir must share a filesystem; the read-only lower layer can live
elsewhere — which fits ShipIt's separate-volume layout better than hardlinks do.

### Overlay operational cost

- Container rootfs is already overlayfs; a **nested** overlay inside an unprivileged
  container needs `CAP_SYS_ADMIN`-ish config — friction ShipIt avoids (HTTP-only to
  containers, no `docker exec`, unprivileged containers). Cleaner route: orchestrator
  sets up the overlay **on the host** and bind-mounts the merged dir in — but that puts
  mount privileges + lifecycle on the orchestrator.
- Lower layer must be **immutable** (already true: `nm-store` only publishes via atomic
  rename, never overwrites — [nm-store.ts:272-309](../../src/server/session/nm-store.ts#L272-L309)).
- **ext4 on the prod VPS**: reflink (`cp --reflink`) is out (ext4 has no reflink), but
  overlayfs works fine on ext4.
- `runtimeKey` discipline matters even more across ecosystems: native addons / compiled
  wheels are arch + libc + interpreter-version specific and must stay in the cache key.

## Why overlay is the primary target, not hardlink

Hardlink and overlay are **not co-equal options** — the choice between them is purely
deployability vs. correctness:

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

Overlay wins on every axis **except** the one-time cost of building the mount layer.
Its decisive advantage: on a cache hit, **no installer runs at all** — npm, pnpm, pip,
and uv all collapse to "mount the canonical lower layer." That uniformity is exactly
what the hardlink path can't give, because hardlinking only helps managers that don't
already dedup, while *defeating* the ones that do (you'd cache pnpm's linked result as a
flat tree and re-link it). One read-only lowerdir is shared by unlimited concurrent
sessions — that's what overlayfs lowerdirs are for.

**The single blocker that decides feasibility:** who performs the mount under ShipIt's
containment model (`docs/172-agent-containment`). Unprivileged containers + HTTP-only +
no `docker exec` rule out mounting inside the session container. The viable route is the
**orchestrator mounts on the host and bind-mounts the merged dir in**, owning a new
privileged, per-session mount subsystem (mount on activate, unmount + workdir cleanup on
dispose; `disk-janitor` and archive flows must learn about live mounts). If that subsystem
is acceptable, overlay-for-all is the design and hardlink is unnecessary.

## Recommendation

1. **Overlay as the unified mechanism for all ecosystems** — one keyed, read-only
   canonical layer per `(lockfile + runtimeKey + installCommand)` (the existing
   `nm-store` key), mounted read-only under every session; per-session upper layer for
   CoW writes. Cache hit = a mount, install-free, identical for npm / Yarn / pnpm / pip /
   uv. Gated on building the orchestrator-side host-mount subsystem above.
2. **Hardlink ladder = fallback only** — for hosts/kernels where the host-mount layer
   isn't available (or as a first, unprivileged prototype). Limited to dumb-copy managers
   (npm, copy-mode Yarn), requires store + workspace on the same fs, and must guard
   in-place mutation. Do **not** apply it to pnpm/uv (redundant with their native store).
3. **Until overlay lands, keep sharing the caches** — the download cache (075) and, for
   store-based managers, their own store on the **same filesystem** as the workspace so
   their built-in dedup isn't silently defeated. This is the no-new-machinery floor.
4. **Python** — overlay covers venvs too, with one pin: build the canonical venv at the
   **same absolute path it will be mounted** (`/workspace/.venv`), since venvs hardcode
   absolute paths (`pyvenv.cfg`, shebangs). ShipIt's constant `/workspace` makes this
   workable. Meanwhile the built-wheel cache (`PIP_CACHE_DIR`) already removes the slow
   native-compile step and needs no overlay.

Next step: spike the orchestrator host-mount subsystem (mount/unmount lifecycle +
janitor/archive awareness) to size the real cost, and in parallel prototype the
hardlink fallback to benchmark cache-hit time on a large repo (ShipIt itself: ~588
packages, ~24s cold install) against today's `cp`/`tar` ladder.

## Key files

| Concern | File |
|---|---|
| dep-cache dir + mount + env | [container-lifecycle.ts](../../src/server/orchestrator/container-lifecycle.ts#L83-L211), [session-dir-factory.ts](../../src/server/orchestrator/session-dir-factory.ts#L56-L66) |
| Materialize / populate store | [nm-store.ts](../../src/server/session/nm-store.ts#L218-L309) |
| Fast-install gate + cacheable-command detection | [session-worker.ts](../../src/server/session/session-worker.ts#L649-L707) |
| Warm-pool pre-install | [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L173-L242) |
| Cache cleanup | [disk-janitor.ts](../../src/server/orchestrator/disk-janitor.ts#L568-L676) |

## Related docs

- [075-shared-dependency-cache](../075-shared-dependency-cache/plan.md) — the download cache
- [148-fast-npm-install](../148-fast-npm-install/plan.md) — the materialized `nm-store`
- [162-fast-install-gate-race](../162-fast-install-gate-race/plan.md) — synchronous fast-path gate
