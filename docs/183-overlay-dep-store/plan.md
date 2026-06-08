---
status: planned
description: Share a warm workspace baseline across sessions via one rolling overlay base per repo; each session runs its real install on top, so it's ecosystem-agnostic with no keys and no lockfile detection.
---

# Overlay-mounted rolling workspace base

> **TL;DR — the proposal.** Instead of copying `node_modules` into each session (today's
> `nm-store` `tar`/`cp -a`), keep **one rolling overlay base per repo**: the whole-workspace
> filesystem state right after a successful install. A new session mounts that base read-only
> as the overlay `lowerdir`, gets a per-session upper layer for copy-on-write, fast-forwards
> its source with git, and runs its **real install command on top** — doing only incremental
> work. Because we overlay the **entire workspace** (not a dependency subdirectory) and just
> run the install command, the design is **environment-agnostic**: no keys, no lockfile
> detection, no need to know where deps live (`node_modules`, `.venv`, `vendor/`, …). The
> chain stays naturally linear because the chain-feeding install always runs on the default
> branch at session creation. Concurrency is handled by an **optimistic compare-and-swap** on
> the base; the orchestrator owns the host-side mount; the worker keeps owning the install.
>
> A content-addressed *keyed* variant (skip install on an exact match) is kept as an optional
> [alternative](#alternative-the-keyed-immutable-layer). Reasoning and ecosystem detail are
> in [Research & analysis](#research--analysis) at the bottom.

## Problem

Every session that needs dependencies pays to get them into its workspace. Downloads are
already shared (`/dep-cache`, [075](../075-shared-dependency-cache/plan.md)), and whole
`node_modules` trees are cached and keyed by `sha256(lockfile + runtimeKey + installCommand)`
([148](../148-fast-npm-install/plan.md)). But the cached tree is laid down by a **full
copy** — `tar | tar` → `cp -a` ([nm-store.ts:218-259](../../src/server/session/nm-store.ts#L218-L259))
— which is the remaining per-session cost (tens of thousands of tiny file writes) and burns
disk (one physical copy per session). It also forced an explicit rejection of hardlinking
([nm-store.ts:203-208](../../src/server/session/nm-store.ts#L203-L208)) and only works for a
narrow allowlist of single-lockfile npm/Yarn/pnpm commands — monorepos, Python, and
arbitrary install commands get no speedup at all.

## Proposed design

### 1. Overlay the whole workspace, not a dependency directory

The base is the **entire workspace filesystem state** captured right after a successful
install, mounted read-only as the overlay `lowerdir`; each session writes to its own
`upperdir` (copy-on-write). The install command runs and writes wherever it likes —
`node_modules`, `.venv`, `vendor/`, `target/`, a `.pnp.cjs`, a pnpm store inside the tree —
and the overlay captures the whole diff generically.

This is the key simplification: **we never need to know which ecosystem or where deps live.**
There is no `findLockfile`, no command allowlist, no per-manager "mount target path." The
only per-repo input is the `agent.install` command that already exists in `shipit.yaml`. A
monorepo, a polyglot repo, or a custom install script are all just "run the command, capture
the resulting tree." This supersedes the node_modules-specific `nm-store` copy store entirely.

### 2. Keyless rolling base per repo

Route **every** session for a repo to the **one current base** for that repo and always run
the install on top of it:

- **Nothing changed** → the package manager's up-to-date check makes the install a near
  no-op; the `upperdir` delta is ~empty.
- **Something changed** → the install writes only the delta into the `upperdir`; the merged
  result becomes the next base.

The base is scoped per **`(repo, runtime fingerprint)`** — not per lockfile. The runtime
fingerprint (image digest + arch + libc + interpreter major) is still required so a base
with compiled native addons/wheels is never reused across an incompatible runtime; it is
*not* lockfile detection, so it doesn't reintroduce the thing we're avoiding.

### 3. Lifecycle of a session

1. **Mount** the repo's current base as `lowerdir` + a fresh per-session `upperdir`/workdir.
2. **Fast-forward source** with git to the new default-branch commit (writes the source diff
   into the upper layer via copy-up).
3. **Run `agent.install`** on top of the warm base (writes only the dep delta).
4. **Advance the base** by an optimistic **compare-and-swap**: publish the merged result as
   the next base *iff* the base hasn't moved since you started; otherwise keep your tree
   locally and skip the publish. Installs stay parallel; the published chain stays linear —
   no multi-second lock on the first-turn critical path, no fight with the warm pool.

Two properties keep the single chain clean (verified against the code):

- **The chain is naturally linear.** The chain-feeding install is the creation-time
  `agent.install`, and sessions are **always cut from the default branch** (`origin/HEAD`) —
  never an arbitrary branch or PR ([warm-pool-manager.ts:147-164](../../src/server/orchestrator/warm-pool-manager.ts#L147-L164),
  [claim-session.ts:361-374](../../src/server/orchestrator/services/claim-session.ts#L361-L374),
  [session.ts:202-216](../../src/server/orchestrator/services/session.ts#L202-L216)). So
  every base advance runs on `main`'s state and moves monotonically forward (`main@t1 →
  main@t2 → …`), with no cross-branch reconciliation.
- **Mid-session `npm install foo` never feeds the chain.** That's the agent's own shell
  command, landing in the session's `upperdir` — not `agent.install`. A session's divergent
  dependency work can't pollute the shared base.

The existing **`.shipit/.install-done` marker** — deleted when HEAD changed
([claim-session.ts:204-206](../../src/server/orchestrator/services/claim-session.ts#L204-L206),
checked at [session-worker.ts:659-663](../../src/server/session/session-worker.ts#L659-L663))
— already gives a commit-granularity skip: when `main` hasn't advanced, the install is
skipped entirely, at ~0 cost and **without any lockfile detection**. We keep it.

### 4. Orchestrator owns the host-side mount

The mount can't happen inside the session container — ShipIt's containment model is
unprivileged containers, HTTP-only, no `docker exec` (`docs/172-agent-containment`). So the
**orchestrator mounts on the host and bind-mounts the merged dir into the session**: mount
(lower + upper + workdir) on activate, unmount + clean workdir on disposal, and teach
`disk-janitor` / archive flows about live mounts before they tear down dirs. This is the one
genuinely new subsystem and the gating unknown for the whole proposal.

### 5. Bounding drift and overlay depth

Re-running install over generations can leave extraneous packages or stale links, and
stacked `lowerdir`s are limited (mount-options must fit in a page; Docker overlay2
historically capped at 128). **Decision: depth-cap flatten only** — when the overlay stack
hits its depth limit, flatten the merged result into a fresh single base (an amortized copy,
ideally in the warm pool), and rely on that flatten to also shed drift. No separate periodic
clean-rebuild schedule unless drift measurements later prove it necessary.

## Decisions (this iteration)

- **Sequencing:** prototype the **keyless rolling-base logic first** (on the current copy
  substrate), then build the host-mount subsystem. *Caveat:* the host-side mount remains the
  true gating risk — validating the chain logic first does not de-risk it, so keep it next in
  line.
- **Environment-agnostic:** overlay the **whole workspace**; no ecosystem/target-path
  knowledge. Settled by §1.
- **Skip policy:** keyless + keep the existing marker/`headChanged` skip (unchanged `main` →
  ~0). No manifest fingerprint for now.
- **Drift:** depth-cap flatten only (§5).
- **Sharing scope:** single-user deployment today, so a base is effectively per-repo for the
  one user. Cross-user sharing (and its secret-leak surface) is **deferred** until ShipIt has
  a multi-user model.
- **Capture filter:** capture the workspace **as-is**, with **one exclusion: `.git`** (see
  below). No secret-filtering — env-var secrets are never written to the tree (so not
  captured); the only on-disk vector is an injected credential file (e.g. private-registry
  `.npmrc`) or a committed `.env`, both of which stay within the single user / are already in
  git.

  *Why exclude `.git`:* the base is captured on **some session's branch** (post-install,
  pre-agent), so its `.git` holds that session's branch ref, `HEAD`, and reflog. If the base
  carried `.git` forward, the next session would inherit a stale branch/`HEAD` instead of its
  own. Each session must bring its **own** `.git` — via the normal repo-cache clone + the
  per-session branch cut from `origin/HEAD` — which lands in the session's upper layer. So
  `.git` is excluded from the shared base for **correctness** (not security); the base
  contributes only the install output + checked-out source *contents*. (Worktree gitdir
  pointer files use absolute paths — confirm they resolve under the overlay; tracked in
  Open Questions.)
- **Archive/restore:** **re-derive on unarchive** — persist only source/metadata; on
  unarchive re-clone and reinstall from the current base. We never persist the per-session
  `upperdir`, which removes the upper-layer ↔ base-generation coupling: base generations need
  only respect **live** mounts, not archived sessions.
- **Bad-base gate:** advance the base **only when the install exits 0**. A non-zero install
  still serves the current session's tree but is never published as the base.

## Open questions

1. **Host-mount feasibility (the gate).** Can the orchestrator own a per-session
   whole-workspace overlay (mount on activate, unmount + workdir cleanup on dispose) within
   the containment model (`docs/172`), on the prod VPS's ext4? overlayfs works on ext4, but
   the privileged host-side mount + teardown ordering with `disk-janitor` is unproven.
2. **Source + `.git` on the overlay.** The base includes the source tree at `main@t`; each
   session git-fast-forwards on top. Confirm git (and worktree gitdir pointers with absolute
   paths) behave on the overlay, that `.git` is excluded/normalized cleanly, and the source
   diff in the upper layer stays small (`t → t'`).
3. **CAS loser semantics.** When a session's base-advance loses the compare-and-swap, it
   keeps its merged tree locally and skips the publish — confirm correctness and the transient
   disk cost of divergent upper layers.
4. **Warm-pool integration.** The warm pool already pre-installs on standbys; how does that
   seed / advance the rolling base rather than duplicating work?
5. **Flatten threshold & reproducibility.** What depth cap triggers the flatten, and does
   flatten-only keep drift acceptably bounded — or is an occasional clean rebuild still a
   warranted correctness backstop (a path-dependent base can drift from a clean install)?
6. **Cold start.** Who builds base *v0* when none exists — first session installs from empty
   and publishes v0? (Trust-gating mirrors the existing warm-pool pre-install gate.)
7. **Compose + file watcher over the merged dir.** Compose services bind-mount the workspace
   and the recursive watcher runs on it. Do bind-mounts using the overlay **merged** dir as
   source, and `inotify` over overlay (copy-up event quirks), behave correctly?

*Resolved this iteration (see Decisions): sharing scope (single-user), secret capture
(as-is, no filter), archive/restore (re-derive on unarchive), bad-base (exit-0 gate).*

## Key files

| Concern | File |
|---|---|
| dep-cache dir + mount + env | [container-lifecycle.ts](../../src/server/orchestrator/container-lifecycle.ts#L83-L211), [session-dir-factory.ts](../../src/server/orchestrator/session-dir-factory.ts#L56-L66) |
| Today's node_modules copy store (superseded) | [nm-store.ts](../../src/server/session/nm-store.ts#L218-L309) |
| Install gate + marker / `headChanged` skip | [session-worker.ts](../../src/server/session/session-worker.ts#L649-L707), [claim-session.ts](../../src/server/orchestrator/services/claim-session.ts#L204-L206) |
| Session base = default branch | [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L147-L164), [claim-session.ts](../../src/server/orchestrator/services/claim-session.ts#L361-L374), [session.ts](../../src/server/orchestrator/services/session.ts#L202-L216) |
| Cache cleanup | [disk-janitor.ts](../../src/server/orchestrator/disk-janitor.ts#L568-L676) |

---

# Research & analysis

*This section is the investigation that led to the proposal above. With the **whole-workspace**
overlay (§1) the per-ecosystem and target-path detail below is **background, not a
requirement** — we run the install and capture the tree regardless. It's kept to explain why
overlay beats copy/hardlink and where each manager's costs come from.*

## The one axis that decides everything

A package manager either **dumb-copies** files into the project (no native dedup) or
maintains a **content-addressable store + hardlinks/reflinks** into the project. That
single property decides whether a ShipIt-side overlay/canonical-volume adds anything:

- **Dumb-copy managers** (npm, Yarn classic, Yarn `node-modules` linker, pip→venv):
  no native dedup → a ShipIt overlay/canonical-volume is a **real win**.
- **Store-based managers** (pnpm, uv, conda, Yarn PnP): they **already** do this →
  adding our own *hardlink* layer on top is redundant or slower. (Overlay still helps,
  because a warm base makes even their install a near no-op and shares disk.)

## Node ecosystem

| Manager | On-disk model | Overlay value | Notes |
|---|---|---|---|
| **npm** | Real copied `node_modules`, no dedup | **High** | Copy is the remaining cost |
| **Yarn classic (v1)** | Real copied `node_modules` | **High** | Same as npm |
| **Yarn Berry, `node-modules` linker** | Real copied `node_modules` | **High** | `nodeLinker: node-modules` |
| **Yarn Berry, PnP** | No `node_modules`; `.pnp.cjs` + zip cache | Captured by whole-workspace overlay | Nothing special to do |
| **pnpm** | Global store + **hardlinks** into `node_modules/.pnpm` | Warm base = near no-op install | Don't stack a hardlink store |

## Python ecosystem

| Tool | On-disk model | Overlay value | Notes |
|---|---|---|---|
| **pip + venv** | Copies into `site-packages`; built-wheel cache | **Medium** | Wheel cache already kills the slow part |
| **poetry** | pip/venv under the hood | **Medium** | Same as pip+venv |
| **uv** (Astral) | Global cache + **hardlink/reflink** into venv | Warm base = near no-op | The pnpm of Python |
| **conda** | pkgs cache + hardlinks into envs | Warm base = near no-op | — |

### Python's venv wrinkle — dissolved by whole-workspace overlay

A virtualenv hardcodes absolute paths in `pyvenv.cfg`, activation scripts, and console-script
shebangs, so a venv laid down by **copy or hardlink** at a *different* path breaks. With the
**whole-workspace** overlay this is a non-issue: the venv lives inside the workspace, is
captured in the base, and is presented back at the **same** workspace-relative path. Since
ShipIt's workspace root is constant (`/workspace`), the venv's baked-in absolute paths stay
valid with no rewriting and no special handling.

## Strategy comparison (getting the cached tree into a session)

| Strategy | Speed | Disk usage | Cross-filesystem | Privileges | Mutation safety |
|---|---|---|---|---|---|
| **Full copy** (today) | Slow (tens of k tiny files) | 1 physical copy per session | Works anywhere | None | Trivially isolated |
| **Hardlink from store** (pnpm-style) | Near-instant | Shared inodes | **No** — needs same fs | None | Safe *iff* tools write-by-rename; in-place edits corrupt store |
| **OverlayFS (CoW)** | Near-instant (a mount) | Shared until write | Lower layer can differ; **upper + workdir must share fs** | `CAP_SYS_ADMIN` in-container, or host-side mount | Isolated by design (copy-up + whiteouts) |

### The same-filesystem caveat

Hardlinks and reflinks **cannot cross mount boundaries**. OverlayFS is more forgiving: only
its upper + work dir must share a filesystem; the read-only lower layer can live elsewhere —
fitting ShipIt's volume layout better than hardlinks do, and avoiding the silent pnpm/uv
fall-back-to-copy that a separate-mount store would cause.

### Overlay operational cost

- Container rootfs is already overlayfs; a **nested** overlay inside an unprivileged
  container needs `CAP_SYS_ADMIN`-ish config — friction ShipIt avoids. Hence the
  host-side-mount route in the proposal.
- Lower layer must be **immutable** (the base is published, never edited in place).
- **ext4 on the prod VPS**: reflink (`cp --reflink`) is out (ext4 has no reflink), but
  overlayfs works fine on ext4.
- Runtime-fingerprint discipline matters: native addons / compiled wheels are arch + libc +
  interpreter-version specific and must scope the base.

## Why overlay, not hardlink

Hardlink and overlay are **not co-equal** — the choice is deployability vs. correctness:

| | Hardlink ladder | OverlayFS |
|---|---|---|
| New architecture | None — swap the materialize ladder | Privileged mount layer + per-session mount lifecycle |
| Privileges | Unprivileged | `mount(2)` needs `CAP_SYS_ADMIN` |
| Works on prod today | Yes | Needs the host-mount plumbing first |
| Teardown | `rm` the workspace | Unmount + clean workdir on disposal |
| Cross-filesystem canonical | **No** — same fs required | **Yes** — only upper + workdir share an fs |
| In-place mutation (`patch-package`, hand-edit) | **Corrupts the shared store** unless guarded | Copy-up isolates it — base is immune |
| Whole-workspace (ecosystem-agnostic) | Awkward — hardlinks a tree you must enumerate | Natural — mount one tree |
| Cache cost | Create N links (large for big trees) | One mount, O(1) regardless of tree size |

Overlay wins on every axis **except** the one-time cost of building the mount layer. Its
decisive advantage is uniformity: one read-only lowerdir is shared by unlimited concurrent
sessions and captures the whole workspace regardless of ecosystem — that's what overlayfs
lowerdirs are for.

## Alternative: the keyed immutable layer

An earlier iteration routed by a **content-addressed key** —
`sha256(lockfileName + lockfileContent + runtimeKey + tunedInstallCommand)` — and on an
**exact match skipped the install entirely**, mounting an immutable per-key dependency layer.
Why the keyless rolling base is preferred instead, and what the keyed variant still buys:

- **Keyed pros:** the hit path is **~0** (a mount, no installer process) and fully
  **reproducible** and **concurrency-safe** by construction. Per-key routing would also avoid
  cross-branch thrash — but that isn't a real scenario today (sessions only branch from the
  default), so this pro is mostly theoretical.
- **Keyed cons (why it's not primary):** it depends on **detecting the lockfile** and
  isolating the dependency directory — exactly what we're avoiding. Today's `findLockfile`
  only handles a *single top-level* lockfile and deliberately punts **monorepos**, and
  `isCacheableInstall` only fast-paths a narrow command allowlist. The whole-workspace keyless
  base sidesteps all of it.
- **Reconciliation:** a keyed *skip* can be re-added later **without** fragile detection, via
  a **detection-free manifest fingerprint** (hash *all* manifest files by a fixed glob, not
  "the one lockfile"). So the keyed fast path is an optional optimization on top of the
  keyless base, not a competing design.

## Related docs

- [075-shared-dependency-cache](../075-shared-dependency-cache/plan.md) — the download cache
- [148-fast-npm-install](../148-fast-npm-install/plan.md) — the materialized `nm-store`
- [162-fast-install-gate-race](../162-fast-install-gate-race/plan.md) — synchronous fast-path gate
