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
"canonical venv" can't be laid down at a different path without `--copies` + path
rewriting (or a relocation-aware tool). This makes a venv-equivalent of `nm-store`
materially harder than the Node one — and largely unnecessary, since pip's built-wheel
cache already removes the slow native-compile step. Recommended Python move: share
`PIP_CACHE_DIR` / `UV_CACHE_DIR` rather than build a canonical venv.

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

## Recommendation

1. **npm + copy-mode Yarn** — the high-ROI target. Two candidate upgrades to the
   `nm-store` materialize step:
   - **B (hardlink ladder), behind a flag** — smallest change, near-instant, disk-shared;
     guard in-place mutation (copy-up-on-write, or accept the well-tested pnpm model).
     Requires store + workspace on the same fs.
   - **A (overlay)** — the "right" long-term design (instant + disk-sharing + clean
     mutation isolation), accepting the host-mount complexity.
2. **pnpm + uv + conda + Yarn PnP** — do **not** add our own layer. Instead ensure their
   store/cache volume is shared **and on the same filesystem as the workspace** so their
   built-in dedup fires. This is a config/layout change, not new machinery.
3. **Python pip/poetry** — share the built-wheel cache (high impact, cheap); skip a
   canonical venv (relocatability cost > benefit).

Next step: prototype B behind a flag and benchmark materialize time on a large repo
(ShipIt itself: ~588 packages, ~24s cold install) against today's `cp`/`tar` ladder.

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
