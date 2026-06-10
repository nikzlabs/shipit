---
status: planned
issue: https://linear.app/shipit-ai/issue/SHI-93
description: Share installed dependency directories across sessions via a rolling overlay base per (repo, runtime), scoped to the dirs declared in shipit.yaml agent.dep-dirs (default node_modules); each session installs its delta on top. (Whole-workspace overlay superseded.)
---

# Overlay-mounted rolling dependency base

> **⚠️ Design status (updated 2026-06-10) — the design changed.** This feature originally
> proposed overlaying the **whole workspace**. That is now **superseded**. The current design
> overlays only the **dependency directories a repo declares in `shipit.yaml`** (`agent.dep-dirs`,
> default `[node_modules]`). It keeps the same proven, unprivileged daemon-overlay volume
> **primitives** and the rolling-base publish logic (the `overlay-base.ts` CAS, marker, and runtime
> fingerprint are reused as-is), but it **eliminates the two host-gated subsystems** that blocked the
> whole-workspace variant — whole-workspace **source re-sequencing** and the worker
> **workspace-view resolver**.
>
> **Read [Current design](#current-design-overlay-declared-dependency-directories) and
> [Rejected approaches](#rejected-approaches) first.** The sections below them describe the
> **superseded** whole-workspace design; they are retained because the **publish CAS, marker, and
> runtime fingerprint** they specify are reused unchanged. The **volume shape** (name, count, mount
> target, scope key) and the **GC** are NOT unchanged — they go from one-base-per-`(repo,runtime)` to
> one-base-per-`(repo,runtime,dep-dir)`; see the "Changed" bucket below.

## Current design: overlay declared dependency directories

**What we overlay.** Not the whole workspace — only the **dependency/artifact directories** a repo
declares in `shipit.yaml` `agent.dep-dirs` (default `[node_modules]`). Source and `.git` stay on the
normal per-session workspace mount exactly as today; each declared dep dir is **additionally** mounted
as a per-session `local` `type=overlay` volume whose read-only `lowerdir` is the shared rolling base
for that `(repo, runtime, dep-dir)` and whose `upperdir` captures this session's install delta.

**Why this shape.** It keeps the rolling-base value — a warm shared baseline makes each install a
near-no-op, shared on disk — and the proven unprivileged daemon-overlay mechanism, while **deleting
the two pieces that made the whole-workspace variant a large, host-gated re-architecture**:

- The orchestrator's view of the workspace (`session.workspaceDir`) is **unchanged** — source +
  `.git` are still the normal host-visible mount — so there is **no workspace-view resolver** (no
  rerouting file/doc/git/diff/post-turn flows through the worker).
- The clone still happens host-side at the normal path, so there is **no source-sync re-sequencing**
  (no clone-into-the-merged-mount, no whiteout pass for base-deleted source).

The dep dirs are gitignored build artifacts the orchestrator never needs to read host-side (the file
tree hides them, diffs ignore them), so overlaying **only** them is invisible to every existing
workspace operation.

### `agent.dep-dirs` config

```yaml
agent:
  install: npm ci
  dep-dirs:            # default: [node_modules]
    - node_modules
    - packages/web/node_modules   # monorepo: list each explicitly
    - services/worker/.venv        # polyglot: just more literals
```

- **Literal relative paths only — no globs, no detection.** Each entry is a relative directory path
  inside the workspace. Globs are deliberately **not** supported (see Rejected approaches): a glob
  would force special-casing the artifact suffix (`packages/*/node_modules` = "expand the source
  parent `packages/*`, treat `node_modules` as a literal the mount creates"), a confusing wart for
  **zero** expressiveness gain — package dirs have fixed names in committed source, so any glob match
  can be listed literally.
- **Default `[node_modules]`** so the common single-package npm/Yarn/pnpm repo is **zero-config**
  (pnpm's `.pnpm` store lives inside `node_modules`; the global download store is already shared via
  `/dep-cache`, [075](../075-shared-dependency-cache/plan.md)).
- **Agent-maintainable.** A monorepo or polyglot repo declares its dep dirs once; in a chat-driven IDE
  the agent writes/updates the list on request ("cache the new package's deps"), so the user doesn't
  hand-curate it. The scope is fixed at container-create, so a freshly-added dir takes effect on the
  **next** session — first session plain, then fast.

### Per-dir base + mount model

- **Scope:** one rolling base per `(repo, runtime fingerprint, dep-dir relpath)`. The runtime
  fingerprint is the orchestrator-side `overlayRuntimeKey` (worker image digest + arch — pins libc +
  Node ABI). The publish compare-and-swap, depth-cap flatten, force-push lineage reset, and the
  `.shipit/.install-done` stamped marker all carry over unchanged, scoped per dep dir.
- **Mount targets at create time.** Because this design keeps the **pre-container host clone**, the
  orchestrator resolves the declared dep dirs against the real checked-out source before creating
  mounts. Cold start → empty `lowerdir` → install populates the `upperdir`.

  > **✅ Proven — 3 of 3 hosts green; the mount-topology gate is CLEARED** (see
  > [`prototype/nested-overlay-spike.sh`](./prototype/nested-overlay-spike.sh) verdicts in
  > [`FINDINGS.md`](./FINDINGS.md): Docker Desktop/Windows-WSL2 amd64 PASS=13/0, Docker Desktop/Mac
  > arm64 PASS=13/0, **prod VPS `shipit-16gb`/ext4 PASS=14/0 with rung 7 — the real host-bind parent —
  > executed**). This
  > nests a `type=overlay` volume mount at `/workspace/<dep-dir>` **underneath** the existing
  > `/workspace` bind/Subpath mount — a topology **none of the *earlier* spikes exercised** (they all
  > mounted the overlay AT the `/workspace` root, never as a child of an existing mount). The two
  > unknowns this design assumed are now **confirmed on all three targets, including under a real host
  > bind on ext4:**
  > **(a)** the dep dir's leaf mountpoint **is** created cleanly inside the already-mounted parent when
  > it doesn't pre-exist (the daemon `mkdir -p`'d the leaf — and, as a data point, even an absent
  > *parent* chain); and **(b)** **mount ordering** holds — the daemon applies the nested
  > `/workspace/<dep-dir>` overlay after the parent mount. **Carry-forward:** the data point in (a)
  > means **prod must still resolve dep dirs against the host clone** so the parent dir is real, rather
  > than leaning on the daemon to invent it.
- **Publish snapshot = the dep dirs only**, not the whole tree — so export/import is much smaller and
  faster than the whole-workspace snapshot.
- **Compose services** that need a dep dir (a dev server reading `node_modules`) mount the *same*
  per-session overlay volume(s) at the matching subpath(s) — the shared-overlay-volume-across-containers
  substrate proven by `shared-volume-spike.sh`. **But this needs a new compose-generator construct, not
  the existing rewrite.** The superseded design pointed `opts.workspaceVolume` at the overlay volume
  with `workspaceSubpath = ""`, and `rewriteVolumes`
  ([compose-generator.ts:479-526](../../src/server/orchestrator/compose-generator.ts#L479-L526))
  reroutes **every** relative workspace mount onto a **single** `shipit-workspace` alias at the merged
  root — it hard-codes one `source` for all relative-path mounts and has **no per-path volume
  selection**. That cannot express what dep-dir overlay requires: a service that bind-mounts `.`
  (the whole workspace) must keep its **normal** `shipit-workspace` workspace mount for source/`.git`
  **and additionally** mount each per-dep-dir overlay volume nested at `<service-target>/<dep-dir>`.
  So the wiring is: leave the service's workspace mount on the state volume (as today), then **append
  one extra `type: volume` mount per dep dir** pointing at that dep dir's overlay volume, targeted at
  the nested subpath. `rewriteVolumes` must be extended to emit those appended nested mounts (it is a
  generator change to design — the "scoped to the subdir" shorthand above understates it). The
  read-only-lower / never-mount-an-`overlay-base/`-subpath guardrails from the superseded §4 still
  apply, asserted by a generator test.

### Validation (degrade safely, never break)

**Precondition — the config field must be added first.** `agent.dep-dirs` is **not** parsed today:
`shipit-config.ts` `KNOWN_AGENT_KEYS` is `{memory, cpu, pids, install}`, so an unrecognized `dep-dirs`
currently only emits an "Unknown key" warning. The field, its known-key entry, the `[node_modules]`
default, and the validation below are all net-new parser work — see `checklist.md`.

An entry is **skipped** (that dir runs plain install; the session is unaffected) when it:

- isn't a relative path inside the workspace (no `..`, no absolute, not the workspace root — overlaying
  the root **is** the rejected whole-workspace mode);
- the entry, or any path component, **is a symlink** — overlaying onto a symlinked target (or through a
  symlinked parent) has undefined resolution and must be skipped; this is covered by neither the
  relative-path nor the tracked-files check, so it needs its own guard;
- **contains tracked source files** — dep dirs must be gitignored build artifacts; a base over tracked
  source would shadow real files. Warn + skip.
- doesn't exist after install (nothing to capture).

An empty / missing / all-invalid list → no overlay → plain install everywhere. Misconfiguration only
forfeits speedup; it never corrupts a session or the shared base.

### Reused vs dropped vs changed (relative to the whole-workspace implementation already on the branch)

- **Reused as-is:** the rolling-base publish CAS + depth-cap flatten + force-push lineage reset
  (`overlay-base.ts`); the stamped install marker (`install-marker.ts`); the runtime fingerprint; the
  `RepoGit` ancestry oracle; and the low-level daemon `type=overlay` volume **primitives**
  (`createOverlayVolume` / `resolveVolumeMountpoint` / `removeOverlayVolume` in `overlay-volume.ts`).
- **Dropped (no longer needed):** the whole-workspace **source-sync re-sequencing** and the worker
  **workspace-view resolver** — the two host-gated pieces. `session.workspaceDir` stays authoritative.
- **Changed (these are NOT "reused as-is" despite the superseded sections implying it):**
  - **Volume shape — one per session → one per session × dep-dir.** `overlayVolumeName(sessionId)`
    returns a single name today; the dep-dir model needs a **distinct overlay volume per dep dir**
    (one `type=overlay` volume = exactly one merged root, so a single volume cannot back N subpaths).
    The name must gain a per-dep-dir component while still matching the GC regex
    `^shipit-([a-f0-9-]{12})_` (e.g. `shipit-<id[:12]>_overlayN`).
  - **Spec count — one → N.** `ContainerConfig.overlaySpec` (a single `OverlaySpec`) and
    `createContainer` (creates one volume) become an `OverlaySpec[]` / N volumes.
  - **Mount target.** `buildMounts` mounts the overlay at the `/workspace` **root** today
    ([container-lifecycle.ts:107-111](../../src/server/orchestrator/container-lifecycle.ts#L107-L111)).
    The dep-dir design keeps the **normal `/workspace` mount** and adds an overlay mount at each
    `/workspace/<dep-dir>` subpath.
  - **Scope key.** `overlayScopeHash(repoUrl, runtimeKey)` has **no dep-dir component** today; it must
    gain the dep-dir relpath, or two dep dirs in one `(repo, runtime)` collide on the same
    `overlay-base/<hash>`.
  - **GC.** `liveOverlayScopeHashes` emits **one scope-hash per session** today
    ([overlay-session.ts:370-384](../../src/server/orchestrator/overlay-session.ts#L370-L384)); it must
    emit **one per (session, dep-dir)**, or the janitor under-counts live bases and can reap one out
    from under a live mount.
  - **Snapshot.** the worker export shrinks from the whole merged tree to a **per-dep-dir** export.
  - **Config.** `agent.dep-dirs` is read from `shipit.yaml` — **this field does not exist yet**
    (`shipit-config.ts` `KNOWN_AGENT_KEYS` is `{memory, cpu, pids, install}`), so it is a real add, not
    a wiring tweak.

### Disk cleanup under the dep-dir design

Overlay removes the per-session full `node_modules` copy (`nm-store`), so the dominant steady-state
disk cost is gone — but cleanup doesn't disappear, it **splits into three surfaces**, each reclaimed
where it accrues:

1. **Shared bases — `overlay-base/<scope-hash>/`** (now one per `(repo, runtime, dep-dir)`). Bounded
   by **scope count, not session count**; each holds one dep dir's tree (≈ "a few `node_modules` per
   repo" in aggregate). Reclaimed by the disk-janitor `sweepOrphanedOverlayBases`: keep if the
   scope-hash is live, else mtime-guard + reap. **Hard constraint:** a base is a live overlay
   **lowerdir** — deleting it under a live mount is undefined behavior — so the live-set
   (`liveOverlayScopeHashes`) must enumerate **per `(session, dep-dir)`** (see the "Changed → GC" item)
   and be complete across all *resumable* sessions, not just running ones.
2. **Per-session overlay volumes — `shipit-<id>_overlayN`** (N per session). Removed on container
   teardown (`destroyContainer` → `removeOverlayVolume` for each); crash-orphans swept by the
   `^shipit-([a-f0-9-]{12})_` prefix regex (`sweepOrphanSessionVolumes`), which already matches every
   per-dep-dir name sharing the session prefix. Each is small — the delta, not a copy.
3. **`/dep-cache` download cache** ([075](../075-shared-dependency-cache/plan.md)) — unchanged,
   separate subtree, swept independently.

**The disposable-upper property + the disk-tier-escalation retarget.** Unlike the whole-workspace
variant — where the upper held `.git` + source + uncommitted work and was **undeletable** — the dep-dir
upper holds **only the dependency delta**; source/`.git` stay on the normal host-side workspace mount.
So a session's overlay volume is a **pure disposable cache**: dropping it loses nothing (the next mount
re-installs the delta over the base). Two consequences:

- Reclaiming a session's overlay volume is **safe by construction** — no "unsaved work?" check.
- The existing **disk-tier escalation** (docs/161) reclaims deps at the `hot → light` rung
  (`reclaimToLight` in `disk-janitor.ts`) by **dropping the per-session compose named volumes** —
  it sets `removeVolumesOnDispose`, disposes the runner, and calls `containerManager.destroy()`
  (with a `ServiceManager.stop({ removeVolumes: true })` + `pruneVolumes` fallback when no runner
  is alive); the host-side checkout is kept. There is **no host-path `rm` of `node_modules`** to skip —
  the only `fs.rm` of host state is the full-`workspaceDir` wipe at the `light → evicted` rung.
  `destroyContainer` already calls `removeOverlayVolume(sc.overlayVolumeName)` for the single Phase-2
  overlay volume, so on `hot → light` one overlay volume is already reclaimed today. The dep-dir
  retarget is therefore to **extend `removeOverlayVolume` in `destroyContainer` to drop all N
  per-dep-dir volumes** — not to skip a host-path `rm`. (The `pruneVolumes`/`pruneSessionVolumes`
  fallback can't reach overlay volumes: it filters `label=shipit-session=<sessionId>`, but overlay
  volumes are labeled `shipit-session=true` + `shipit-managed=true`. The backstop for crash-orphaned
  overlay volumes is the `sweepOrphanSessionVolumes` `^shipit-([a-f0-9-]{12})_` sweep, not the label
  prune.) This is the change most likely to be missed, because the escalation lives outside the
  overlay code path.

Net: aggregate disk drops sharply (shared base vs. per-session copies), resource **count** rises
(N small volumes + per-dep-dir bases), per-session uppers become **safe to drop**, and the only surface
needing careful GC is "don't reap a base that's a live lowerdir."

## Rejected approaches

### Whole-workspace overlay (the original design) — **superseded**

Overlay the entire `/workspace` and run the install on top, capturing the whole diff generically.
**Pro:** truly ecosystem-agnostic — no need to know where deps live. **Why rejected:** the merged
tree exists only inside the session container, which forces two large, **host-gated** subsystems
before it can even function:

- **(A) Source-sync re-sequencing** — the clone/checkout/reset/clean must run *inside* the merged
  mount after the container starts (the existing host clone lands outside the merged view → an empty
  `/workspace`). This includes an explicit whiteout pass for source files deleted since the base that
  **cannot** be a plain `git clean -ffdx` — `-x` would also delete the base's `node_modules`, the very
  thing the base exists to preserve.
- **(B) Workspace-view resolver** — every orchestrator file/doc/git/diff/post-turn operation must
  route through the worker because `session.workspaceDir` is only the upperdir for an overlay session.

Both touch the most critical path in the product (session creation + every workspace read/write) and
can only be verified on real Docker overlay across the host matrix. The ecosystem-agnosticism they buy
is **not worth** that cost: explicit `dep-dirs` (defaulted, agent-maintainable) covers the real cases,
and the dep-dir overlay keeps **all four targets + the unprivileged mechanism** while deleting A and B
entirely. (The implementation spine for this variant — `overlay-session.ts`, the publish wiring — was
built and tested behind a flag; the reusable parts above survive the pivot, A and B were never built.)

### Host-visible overlay (privileged sidecar + mount propagation) — **rejected**

Make the *orchestrator* see the merged whole-workspace tree at `session.workspaceDir` (so existing
fs/git code "just works" and A/B mostly vanish) via a long-lived `--privileged` mounter sidecar whose
overlay propagates (`rshared`) into the daemon's namespace. **Why rejected:** it reintroduces exactly
the infrastructure the daemon-overlay mechanism was chosen to delete — a privileged container
(containment regression vs `docs/172`), a startup propagation probe, re-arm-on-boot, and the
disk-janitor unmount-ordering hazard — **and it fails on Docker Desktop/Windows-WSL2** (managed
`docker-desktop` distro, no user-applicable `MountFlags=shared`; `propagation-spike.sh`), so Windows
dev falls back to plain install anyway. It trades portability + containment for the same goal the
dep-dir overlay reaches **unprivileged on all four targets**. Strictly dominated except on
ecosystem-agnosticism, which it buys at far higher cost.

### Globs in `dep-dirs` — **rejected**

Support `packages/*/node_modules`. **Why rejected:** `node_modules` doesn't exist pre-install, so a
glob can't match the artifact dir directly; supporting it means **special-casing the suffix** (expand
the source-parent wildcard against the checkout, treat the artifact name as a literal the mount
creates) — confusing semantics + edge cases (matches containing tracked files, transitive nesting) for
**zero** expressiveness gain, since package directories have fixed names in committed source. The cost
of literal-only (a longer, drift-prone list for big monorepos) is **benign**: a missing entry just
runs that dir plain, and the agent regenerates the list on request. Globs can be added later as pure
sugar if real demand appears — no architectural commitment now.

> **TL;DR — the SUPERSEDED whole-workspace proposal (retained for the reused mechanism; see the
> design-status banner above).** Instead of copying `node_modules` into each session (today's
> `nm-store` `tar`/`cp -a`), keep **one rolling overlay base per repo runtime**: the
> whole-workspace filesystem state right after a successful install for a compatible runtime.
> A new session mounts that base read-only
> as the overlay `lowerdir`, gets a per-session upper layer for copy-on-write, fast-forwards
> its source with git, and runs its **real install command on top** — doing only incremental
> work. Because we overlay the **entire workspace** (not a dependency subdirectory) and just
> run the install command, the design is **environment-agnostic**: no keys, no lockfile
> detection, no need to know where deps live (`node_modules`, `.venv`, `vendor/`, …). The
> chain stays linear because **only a default-branch install may advance the base, and base
> publishes are serialized per repo runtime** (single-writer). Any session still runs its install
> freely into its *own* upper layer — that never races — but publishing a new base is
> restricted and sequential, so the shared chain can't fork. The orchestrator owns the
> host-side mount; the worker keeps owning the install.
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

### 2. Keyless rolling base per repo runtime

Route every session for a **`(repo, runtime fingerprint)`** pair to that pair's one current
base and always run the install on top of it:

- **Nothing changed** → the package manager's up-to-date check makes the install a near
  no-op; the `upperdir` delta is ~empty.
- **Something changed** → the install writes only the delta into the `upperdir`; the merged
  result becomes the next base.

The base is scoped per **`(repo, runtime fingerprint)`** — not per lockfile. The runtime
fingerprint must describe ABI compatibility, not just broad language families: image digest,
arch, libc, and each relevant runtime ABI/version (for example Node's native module ABI,
Python implementation + major.minor / ABI tag, and equivalent compiled-extension boundaries
for other runtimes). That prevents a base with compiled native addons/wheels from being reused
across incompatible runtimes; it is *not* lockfile detection, so it doesn't reintroduce the
thing we're avoiding. That tuple is the unit for the current-base pointer, publish lock/CAS,
depth counter, and janitor cleanup. After that scope is established, "per repo" in this doc is
shorthand for "per repo runtime" unless explicitly stated otherwise.

### 3. Lifecycle of a session

Ideally prep happens **on a warm-pool standby** before activation, so install latency is off
the first-turn critical path — but it is **not** the only install path (see the warning
below), so the base-advance rule must hold regardless of where the install runs:

1. **Mount** the repo's current base as `lowerdir` + a fresh per-session `upperdir`/workdir.
2. **Sync source inside the merged `/workspace`, not by pre-populating the host upperdir.** The
   checkout/reset that moves source to the session commit must run against the overlay mount with
   a git index that knows the base commit, then clean lower-only paths (`git clean -ffdx`, or an
   equivalent explicit whiteout pass). This is what creates overlay whiteouts for files deleted
   since the base; a host-side clone into the upperdir alone would let deleted files leak through
   from the lowerdir into builds, installs, file views, and commits. Record the remote
   default-branch commit used for that sync — it stamps any base this session publishes.

   > **This re-sequences the existing creation flow — call it out as real work, not a given.**
   > Today the claim path does the *opposite*: `cloneFromCache(workspaceDir)` →
   > `fetchAndResolveDefaultBranch` → `git checkout -b <branch>` all run on the host
   > `workspaceDir` **before any container or overlay volume exists**
   > ([claim-session.ts:353-374](../../src/server/orchestrator/services/claim-session.ts#L353-L374)),
   > and the warm/manual/unarchive paths share that pre-container clone. For an overlay session
   > that host path is the **upperdir**, so the current sequence is precisely the
   > "host-side clone into the upperdir alone" warned against here. The overlay path must move the
   > clone + fetch + branch + reset (and the lower-only clean/whiteout pass) to run **against the
   > merged mount after the container starts** — i.e. through the session worker against
   > `/workspace`, per §4's worker-backed git operations. This is a non-trivial change to the
   > creation flow and shifts where the clone latency lands (the warm pool currently relies on
   > that work being done pre-container, off the activation critical path); Phase 4 must restructure
   > it explicitly rather than assume the existing pre-container clone still applies.
3. **Run `agent.install`** on top of the base (writes only the dep delta into *this session's*
   upper layer — this never races another session).
4. **Maybe advance the base** — publish the merged result as the next base **only if** the
   install exited 0, the install ran before any user/agent dependency edits, the session's
   recorded source base is the remote default-branch commit (normal ShipIt sessions are
   per-session branches cut from `origin/HEAD`, not literally named `main`), **and the
   ordering rule below allows the publish** (normal strict-descendant advance, or a current
   remote-default lineage reset after a force-push). Otherwise the install result is used by the
   session but never published. Activation hands the user the already-prepped tree.

> **Separate "runs an install" from "advances the base."** There is more than one install
> path: the warm pool pre-installs on standbys ([warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L214-L243)),
> **but that is skipped for untrusted remotes**, and `setupServiceManager` runs
> `runner.runInstall(...)` again **on every activation**, guarded only by the worker marker
> ([service-manager-setup.ts:322-329](../../src/server/orchestrator/service-manager-setup.ts#L322-L329),
> [session-worker.ts:659-663](../../src/server/session/session-worker.ts#L659-L663)).
>
> *Why the on-activation install exists* (so it isn't mistaken for redundant): it's the
> **guaranteed, idempotent backstop**, distinct from the best-effort warm pre-install. It is
> the path that installs (a) **trust-deferred** repos — the untrusted-remote early-return
> ([service-manager-setup.ts:278-289](../../src/server/orchestrator/service-manager-setup.ts#L278-L289))
> skips both warm and on-activation install until the user accepts trust, which **re-invokes
> this same setup** via `runner.rerunServiceSetup` ([container-session-runner.ts:136-141](../../src/server/orchestrator/container-session-runner.ts#L136-L141));
> (b) sessions with **no completed pre-install** (pool miss, unfinished standby); and (c)
> **re-created runners** (idle eviction, restart-agent `docs/127`, reconnect). A validated
> `.shipit/.install-done` marker makes the repeat a no-op only when the checked-out source
> commit, runtime fingerprint, and install command still match, so "every activation" is cheap.
> So the warm pool is *not* the single installer. The
> invariant we actually rely on is narrower and
> must be enforced explicitly: **(a)** any session may run install into its own `upperdir`
> (safe — no shared state); **(b)** only an **exit-0**, pre-user install whose recorded source
> base is the remote default-branch commit may *publish* a new base; **(c)** the publish either
> moves the base **forward in `main`'s history** or performs the explicit remote-default lineage
> reset described in the ordering rule below. That, not "one installer," is what keeps the chain
> linear.

> **Ordering rule — compare by `main` commit, never by publish time.** Each base is stamped
> with the `main` commit it was built from (step 2). On publish, advance the base when the
> candidate's commit strictly descends the current base's commit —
> `git merge-base --is-ancestor <base.commit> <candidate.commit>` true **and** the two differ.
> Equal commit → deps already current, no-op. Behind → skip the publish; the session keeps its
> own tree. Diverged while the candidate is the current remote default commit (for example a
> force-push rewrote `main`) → treat it as a **lineage reset**, not a permanent skip: under the
> same per-scope lock, rebuild/publish a clean base from empty for the rewritten default commit
> (or rotate to an equivalent new base generation keyed by that rewritten default HEAD). That
> prevents stale pre-rewrite source/dependency content from remaining every future session's
> lowerdir. A short **per-`(repo, runtime fingerprint)` lock** makes the read-compare-swap atomic;
> the *decision* is git ancestry, **not** wall-clock or lock-acquisition order — so an
> older-commit install that grabs the lock late can never clobber a newer base. (This is a
> compare-and-swap keyed on commit ancestry; behind "losers" simply decline to publish, while a
> current-default divergence is the explicit clean-reset case.)

Two properties keep the published chain clean:

- **It advances monotonically.** Normal creation paths branch from the default branch
  (`origin/HEAD`) — manual/warm-pool/unarchive and generic agent-spawned sessions
  ([warm-pool-manager.ts:147-164](../../src/server/orchestrator/warm-pool-manager.ts#L147-L164),
  [claim-session.ts:361-374](../../src/server/orchestrator/services/claim-session.ts#L361-L374),
  [session.ts:202-216](../../src/server/orchestrator/services/session.ts#L202-L216),
  [child-sessions.ts:70-81](../../src/server/orchestrator/services/child-sessions.ts#L70-L81)).
  Generic spawned sessions therefore look like any other fresh claim and are publish-eligible
  only if they satisfy the same pre-user/default-source rules as manual sessions. The only
  non-default reset path here is internal Ops `--shipit-source`, where ShipIt pins a fix
  session to a system-resolved inspected build commit. Those source-pinned sessions run their
  install on the base into their own upper layer but are **excluded from publishing** (rule
  (b)), so they never inject a historical or divergent tree into the chain — which therefore
  stays `main@t1 → main@t2 → …`. They also must not inherit a default-branch install marker:
  any internal source pin or other non-default checkout whiteouts the marker before
  `agent.install`, forcing the real install to validate that checkout's manifests against the
  shared base.
- **Mid-session `npm install foo` never feeds the chain.** That's the agent's own shell
  command, landing in the session's `upperdir` — not `agent.install`. A session's divergent
  dependency work can't pollute the shared base.

The existing **`.shipit/.install-done` marker** is kept in concept, but presence alone is no
longer enough. Today it is deleted when HEAD changes
([claim-session.ts:204-206](../../src/server/orchestrator/services/claim-session.ts#L204-L206))
and checked at [session-worker.ts:659-663](../../src/server/session/session-worker.ts#L659-L663);
the overlay design must upgrade it to a stamped marker containing the source commit it
validated, runtime fingerprint, and install command. A session may skip `agent.install` only
when those fields match its current checkout and base scope. Any non-default checkout/reset,
or any checkout whose source commit differs from the marker's stamped commit, whiteouts or
deletes the marker before `agent.install` runs. That preserves the cheap unchanged-`main` path
without letting source-pinned sessions or historical branches reuse dependencies from the
default branch base blindly.

### 4. Orchestrator owns the host-side mount

The mount can't happen inside the session container — ShipIt's containment model is
unprivileged containers, HTTP-only, no `docker exec` (`docs/172-agent-containment`). So the
**orchestrator (which holds `docker.sock`) has the daemon create the overlay and mount it into
the session** — see the mechanism decision below.

#### Host-mount design decisions (decided — see [`FINDINGS.md`](./FINDINGS.md))

- **Mount mechanism — daemon-performed overlay via the `local` volume driver.** The orchestrator
  stays **unprivileged**; using the `docker.sock` it already holds, it creates a per-session
  **`local`-driver volume with `type=overlay`** and `o=lowerdir=<base>,upperdir=<session-upper>,
  workdir=<session-work>` (absolute daemon-host paths, resolved via `docker volume inspect`).
  When the session container mounts that volume at `/workspace`, the **Docker daemon performs the
  `mount -t overlay`** as it constructs the container, so the merged view is in the container's
  mount namespace **by construction**. **No privileged sidecar, no `CAP_SYS_ADMIN` anywhere, and
  no cross-container mount propagation** — which is what makes it work uniformly across **all
  four** install targets, including Docker Desktop/Windows. **Proven** on Docker Desktop/Windows
  (the host where the propagation approach was dead): `prototype/volume-driver-overlay-spike.sh`
  PASS=7/7 — unprivileged merged visibility, copy-up to a per-session upper, immutable shared
  base, and two concurrent sessions over one read-only base with no EBUSY.

  *Rejected — privileged sidecar driving `mount -t overlay` with shared propagation.* The
  earlier design ran a long-lived `--privileged` "mounter" sidecar whose overlay mount had to
  **propagate** (`rshared`) into the daemon's namespace to reach a separate session container.
  That works on systemd VPS and Docker Desktop/Mac but is **confirmed rejected on Docker
  Desktop/Windows-WSL2** (managed `docker-desktop` distro, no user-applicable
  `MountFlags=shared` fix — `propagation-spike.sh`, see [`FINDINGS.md`](./FINDINGS.md)). The
  daemon-overlay mechanism above makes the whole propagation problem — and the sidecar, the
  startup propagation probe, the re-arm-on-boot, and the disk-janitor unmount-ordering hazard
  (Docker unmounts on container stop; we just `docker volume rm`) — disappear. *(Also rejected:
  standing `CAP_SYS_ADMIN` on the orchestrator; a custom Docker volume plugin — too heavy.)*

  **Per-session-upper rule + concurrency caveat (kernel-level, respected by the design):** the
  kernel errors `upperdir is in-use by another mount` if two overlays share an `upperdir`, so
  each session gets its **own** upper/work; a **shared read-only `lowerdir`** across sessions is
  fine (proven). `device or resource busy` is a known overlay2 hazard under **parallel** mount
  creation → **serialize** the volume create/mount. `workdir` must be empty and on the upper's fs.

  **Volume lifecycle + GC (the overlay volume is a new Docker resource — must not leak).**
  **Name it on the pattern the existing orphan sweep already matches** — `sweepOrphanSessionVolumes`
  ([disk-janitor.ts:366-421](../../src/server/orchestrator/disk-janitor.ts#L366-L421)) reclaims
  dangling volumes matching `^shipit-([a-f0-9-]{12})_` whose 12-char session prefix is not a live
  session, so name the volume **`shipit-<sessionId[:12]>_overlay`**. That makes orphan recovery
  *automatic*: a live (incl. idle-evicted) session's volume is preserved (live-prefix check; and
  it's `dangling=false` while attached), and a volume orphaned by an orchestrator crash between
  `docker volume create`↔start or stop↔`docker volume rm` is swept once no session owns the
  prefix. Also stamp the `shipit-managed=true` label for parity with compose volumes. Happy-path
  teardown stays `docker volume rm` on dispose (daemon unmounts on container stop — no manual
  unmount-ordering). **Do NOT** use a name like `shipit-overlay-<id>`: it fails the
  `<12 hex>_` regex and would leak. For the on-disk `overlay-base/<hash>/` dirs, extend the
  existing unreferenced-`dep-cache/<hash>` cache sweep (`sweepOrphanedCaches`) to cover them —
  **but not by reusing its `liveHashes` set.** That set keys liveness on `repoUrlToHash(repo.url)`
  ([disk-janitor.ts:580-587](../../src/server/orchestrator/disk-janitor.ts#L580-L587)) and removes
  any entry not in it with no age guard. An `overlay-base/<scope-hash>` is keyed on **`(repo,
  runtime fingerprint)`**, so its hash will never appear in the repo-url `liveHashes` set — a naive
  extension would delete **every live base on the first run**, defeating the rolling base. The
  sweep must instead compute the set of live overlay-base scope-hashes (repo url × the runtime
  fingerprints currently in use / recently seen), and fall back to an mtime/age guard for
  scope-hashes it can't positively confirm live, exactly as `sweepStaleNmStores` guards by mtime.

  *Confirm-before-build — done.* `volume-driver-overlay-spike.sh`, updated to seed the real
  production layout (`lowerdir` under the workspace volume's `overlay-base/<hash>/`,
  `upperdir`/`workdir` under `sessions/<uuid>/` — cross-subtree nested subpaths of the *same*
  named volume's `_data`), ran **PASS=7/7 on the prod VPS** (`shipit-16gb`, Ubuntu 24.04, docker
  29.5.2) — settling both the production path layout and a non-Docker-Desktop Linux daemon. Only
  nice-to-have left: mount-cost timing (not a gate).

  - **No copy-store fallback — `nm-store` is removed, not retained.** Where overlay is
    unavailable the fallback is simply running `agent.install` into the workspace as today,
    warmed by the **existing download cache** (`/dep-cache`, [075](../075-shared-dependency-cache/plan.md))
    — a *separate* subtree from `nm-store`, so a plain install pulls tarballs locally with **no
    network**. Note this removes network only, **not** the node_modules extract/link cost (the
    tens-of-thousands-of-tiny-writes that dominate a large-tree install — e.g. ~24s for ShipIt's
    own repo); that extract cost is precisely what the overlay warm-base path eliminates and the
    fallback still pays. So the fallback is "correct + network-free," not "fast." The `nm-store`
    materialization (`tar`/`cp -a`, lockfile detection,
    command allowlist, store keying) adds nothing the overlay base doesn't do better and is
    **deleted entirely** ([nm-store.ts](../../src/server/session/nm-store.ts)), leaving exactly
    two paths: overlay (warm, near-no-op) or plain full install (correct everywhere).
- **Storage layout — single workspace volume; base in its OWN subtree, never mounted into a
  session.** Per-session `upper`/`work` live under the session subtree (`sessions/{uuid}/` — the
  same subtree, so upper+work share a filesystem, satisfying overlay's same-fs rule). The shared
  base (lowerdir) lives under a **dedicated `overlay-base/<scope-hash>/` subtree of the workspace
  volume — NOT under the `dep-cache` subtree.** This is a correctness requirement, not a
  preference: the per-repo dep-cache is bind/Subpath-mounted **read-write** into every session at
  `/dep-cache` ([container-lifecycle.ts:146-158](../../src/server/orchestrator/container-lifecycle.ts#L146-L158)),
  so a base placed there would be **writable from inside any session** — and the agent (or even
  the install writing the npm cache) could mutate the shared **lowerdir under other sessions'
  live overlay mounts**, which is undefined behavior (overlay requires an immutable lower; see
  §Overlay operational cost). The `overlay-base/` subtree is on the same workspace volume (so the
  daemon resolves its absolute path the same way and overlay's lower-can-differ-fs rule is moot)
  but is **never bind/Subpath-mounted into a session container**, so it is unreachable-for-write
  from any session. Its absolute daemon-host path is resolvable via `docker volume inspect`.
  **How the merged
  dir reaches the session:** the orchestrator creates the per-session `local`-driver
  `type=overlay` volume from those paths and mounts it at `/workspace`; the **daemon** performs
  the overlay mount as it builds the container, so the merged view is present **by
  construction** — no nested-mount/propagation step, and no `merged` dir to pre-create on disk
  (the daemon's volume mount is the merged view). This replaces the Subpath-of-a-pre-mounted-dir
  approach (`buildMounts`, [container-lifecycle.ts:97-104](../../src/server/orchestrator/container-lifecycle.ts#L97-L104))
  for overlay-eligible sessions.

  **Authoritative workspace view — worker APIs, not the host `upperdir`.** The daemon-mounted
  `local` overlay volume makes the merged tree visible in the **session container**; it does
  **not** make the same merged tree reliably visible to the already-running orchestrator
  container at `session.workspaceDir`. That host path is only the session's upper/storage
  subtree for overlay sessions, so treating it as the authoritative workspace would hide files
  inherited from the base and make ShipIt show/commit/diff the wrong tree. Therefore overlay
  sessions must split storage metadata from the operational workspace view:

  - `session.workspaceDir` remains the durable session storage/upperdir path used for cleanup,
    janitor ownership, and non-overlay fallback.
  - All user-visible and correctness-sensitive workspace operations for overlay sessions run
    through the session worker against `/workspace`, the same merged mount the agent sees.
    This includes file tree/content/edit routes (`services/files.ts`), doc discovery, compose
    config and service-env reads/writes, file watcher state, Git reads and mutations
    (`services/git.ts`), rollback/rebase/push/pull, PR/diff stats, and post-turn
    auto-commit/auto-push (`ws-handlers/post-turn.ts`).
  - The implementation adds a small "workspace view" resolver at the orchestrator boundary:
    non-overlay sessions keep the existing host-path `GitManager`/filesystem path, while
    overlay sessions dispatch to worker HTTP endpoints that expose the needed file and git
    operations inside the container. Any remaining direct `fs` or `GitManager` use against
    `session.workspaceDir` must be audited and either proven storage-only or routed through
    that resolver before the overlay path is enabled.
  - Publish/flatten code that needs to build the next base consumes an explicit worker-exported
    snapshot of the merged workspace (excluding `.git` as already decided), not the host
    `upperdir` alone. Otherwise a base publish after an empty/no-op install would lose every
    dependency and source file that came only from the lowerdir.

#### Compose/preview wiring (Open Q #4 resolved — the mechanism, scoped)

The shared-overlay-volume mechanism is proven (PASS=8/8 across all three hosts; Open Q #4).
Wiring it in is small because the agent container and compose services already mount subpaths of
one shared `external` named volume (`shipit-workspace`) today. The **compose** side is a pure
option-value change (below); the **agent** side needs a one-argument signature change to
`buildMounts`, because that function currently feeds a *single* `workspaceVolume` parameter into
three different mounts. The concrete touchpoints:

- **Resolve the overlay volume name.** One helper returns `shipit-<sessionId[:12]>_overlay` (the
  §4 GC name) for overlay-eligible sessions, `undefined` otherwise. Everything below branches on it;
  non-overlay sessions are byte-for-byte unchanged.
- **Agent container — `buildMounts` needs a new param, not a value swap.** `buildMounts`
  ([container-lifecycle.ts:85-158](../../src/server/orchestrator/container-lifecycle.ts#L85-L158))
  takes a **single** `workspaceVolume` parameter and reuses it for **three** mounts: `/workspace`
  (subpath `sessions/<id>/workspace`, L97-104), `/uploads` (subpath `sessions/<id>/uploads`,
  L131-138), and `/dep-cache` (subpath `dep-cache/<hash>`, L146-154). So you **cannot** just pass
  the overlay volume name — that would also repoint `/uploads` and `/dep-cache` at the overlay
  volume, whose root is the merged workspace and which has no `sessions/<id>/uploads` or
  `dep-cache/<hash>` subtree (both mounts would resolve to non-existent paths, and an overlay-backed
  `/dep-cache` would also break cross-session cache sharing). The change is a **signature change**:
  add a distinct `overlayWorkspaceVolume` argument applied to the `/workspace` mount **only** —
  mounting the per-session `type=overlay` volume at `/workspace` **at the volume root** (no subpath —
  the daemon-merged tree *is* the volume root). `/uploads` and `/dep-cache` keep using the existing
  `workspaceVolume` (the `shipit-workspace` state volume), and `/credentials` keeps its separate
  `credentialsVolume` param. Only the `/workspace` source switches.
- **Compose services — option values only, no new generator code.** Pass
  `workspaceVolume = <overlay volume name>` and **`workspaceSubpath = ""`** to
  `generateComposeOverride` ([service-manager.ts:604-611](../../src/server/orchestrator/service-manager.ts#L604-L611)).
  `rewriteVolumes` then maps each `.`/`./sub` workspace mount onto the merged volume: `joinSubpath("", ".")`
  → root mount, `joinSubpath("", "backend")` → `backend`. The existing top-level alias mapping
  (`shipit-workspace` → `{ name: opts.workspaceVolume, external: true }`,
  [compose-generator.ts:651-655](../../src/server/orchestrator/compose-generator.ts#L651-L655))
  carries the rename. The empty subpath is the key difference from today: `shipit-workspace`'s root
  is the **state dir** (workspace at `sessions/<id>/workspace`), whereas the overlay volume's root
  **is** the workspace.
- **Volume must exist before `docker compose up`.** The Phase-2 daemon-overlay subsystem
  `docker volume create`s the overlay volume before the agent container starts; compose references
  it `external: true`, so it must already exist when the stack comes up. The agent-container start
  triggers the daemon's single `mount -t overlay` first; compose then refcount-shares it (the spike
  proved concurrent first-use is safe regardless of order).
- **Secrets delivery must not assume the workspace is host-readable.** The `x-shipit-secrets`
  entrypoint wrapper and per-service env file live under `.shipit/` in the workspace today
  ([compose-generator.ts:589-615](../../src/server/orchestrator/compose-generator.ts#L589-L615)).
  For overlay sessions, either write them into the **merged** tree via the worker (per the
  workspace-view resolver above) so the service container reads them at the subpath, or — cleaner —
  use the already-present **out-of-workspace `serviceEnvFiles`** mode (absolute path outside the
  workspace), which sidesteps the overlay entirely. Prefer out-of-workspace for overlay sessions;
  the entrypoint-script mount needs the same treatment.
- **Guardrail (must hold by construction + asserted by test).** No service mount may resolve to an
  `overlay-base/` lowerdir subpath (the read-only-lower rule) or a bare-upperdir subpath. Because
  the rewrite only ever targets the merged overlay volume root + a relative subpath, this holds —
  but a compose-generator test must assert an overlay-session override **never** references the
  `shipit-workspace` storage subpath (`sessions/<id>/…`) or the `overlay-base/` tree.

### 5. Bounding drift and overlay depth

Re-running install over generations can leave extraneous packages or stale links, and
stacked `lowerdir`s are limited (mount-options must fit in a page; Docker overlay2
historically capped at 128). **Decision: depth-cap-triggered clean rebuild.** When the
overlay stack reaches a **specific configured depth** (a tunable on the order of ~10–20,
deliberately well below the environment's hard limit), rebuild the base from **empty** — a
clean reinstall, not a layer collapse — so every flatten doubles as a reproducibility reset.
This single mechanism bounds both overlay depth and incremental-install drift; no separate
periodic clean-rebuild schedule is needed.

## Decisions (this iteration)

> **Prototype status (all green):** keyless rolling-base **logic** validated —
> [`prototype/run-rolling-base.ts`](./prototype/run-rolling-base.ts) (33/33 against a real git
> repo); overlay **substrate** confirmed (WSL2/ext4 19/19 + Docker Desktop/Mac 21/21); and the
> **mount mechanism** settled — **daemon-performed overlay via the `local` volume driver**,
> proven on Docker Desktop/Windows-WSL2 ([`prototype/volume-driver-overlay-spike.sh`](./prototype/volume-driver-overlay-spike.sh)
> 7/7), which makes all four install targets overlay-eligible and removes the privileged sidecar.
> The earlier [`host-overlay-spike.sh`](./prototype/host-overlay-spike.sh) /
> [`propagation-spike.sh`](./prototype/propagation-spike.sh) remain as substrate evidence and the
> record of why the sidecar approach was rejected. Results in [`FINDINGS.md`](./FINDINGS.md),
> how-to in [`prototype/README.md`](./prototype/README.md).

- **Sequencing:** prototype the **keyless rolling-base logic first** (done), then settle the
  **host-mount mechanism** (done — daemon-overlay). Both are now validated, so the gating risk
  the earlier draft worried about (the privileged host-side mount) is retired: the daemon does
  the mount, no sidecar.
- **Environment-agnostic:** overlay the **whole workspace**; no ecosystem/target-path
  knowledge. Settled by §1.
- **Skip policy:** keyless + upgrade the existing marker/`headChanged` skip into a stamped
  marker (source commit + runtime fingerprint + install command). Unchanged `main` still skips
  at ~0, but non-default checkouts and mismatched marker stamps must delete/whiteout the marker
  before `agent.install`. No manifest fingerprint for now.
- **Base advancement is restricted and ordered by `main` commit — not "one installer."** The
  code has multiple install paths (warm-pool pre-install, *skipped for untrusted remotes*; and
  an on-activation `runInstall` guarded only by the marker), so we cannot rely on the warm pool
  being the sole installer. Instead: any session runs install into its **own** `upperdir` (no
  shared state, no race — installs need not be serialized), and only an **exit-0**, pre-user
  install whose recorded source base is the remote default-branch commit may **publish** a new
  base. A publish advances the base when its `main` commit strictly descends the current
  base's commit (`git merge-base --is-ancestor`), under a short per-`(repo, runtime
  fingerprint)` lock that makes the read-compare-swap atomic. The decision is **commit ancestry,
  not publish/wall-clock time**, so a late-but-older install can't clobber a newer base; a stale
  behind publish is skipped, while a diverged candidate that is the current remote default commit
  triggers a **lineage reset** (clean rebuild from empty, or equivalent new generation keyed by
  the rewritten default HEAD). This is a compare-and-swap keyed on commit ancestry — lighter
  than the loser-reconciliation we ruled out.
  Internal Ops source-pinned sessions, any other session whose source base is not the remote
  default commit, and sessions with user/agent dependency edits before publish run on the base
  but never publish (§3), and their non-default checkout invalidates any inherited install
  marker before install so they cannot skip against default-branch dependencies. Generic
  agent-spawned children branch from the same freshly fetched `origin/HEAD` claim path as
  manual sessions and follow the same publish rule.
- **Flatten = clean reinstall.** When the depth cap is hit, rebuild the base from **empty**
  rather than collapsing layers, so every flatten is also a correctness reset (no separate
  clean-rebuild schedule needed). The **depth cap is a specific tunable value** (on the order
  of ~10–20, revisited from measurement), deliberately well below the environment's hard
  layer limit — not the max itself.
- **Cold start & trust:** the first prep for a repo builds base **v0 from empty**, under the
  **existing repo trust gate** (`docs/178`) — no new gate; base creation simply rides the
  trust decision already made when the repo was added.
- **Sharing scope:** single-user deployment today, so a base is effectively per repo runtime
  for the one user. Cross-user sharing (and its secret-leak surface) is **deferred** until
  ShipIt has a multi-user model.
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

## Implementation phases

Ordered; see [`checklist.md`](./checklist.md) for the per-phase task list. **Phase 1 deletes
nm-store first** — a clean, self-contained simplification — then the overlay subsystem is built
on top of the simplified install path.

> **Implementation status (updated 2026-06-10 — design pivot).** The phase list below was written
> for the **superseded whole-workspace** design; it is retained because Phases 0–2 (the daemon-overlay
> mechanism) and the Phase-3 *decision logic* (the publish CAS) are **reused unchanged** by the
> current dep-dir design. What's on the branch today, behind the **`OVERLAY_DEP_STORE` flag (default
> OFF)**: `overlay-volume.ts`, `overlay-base.ts` (publish CAS), `install-marker.ts`, the `RepoGit`
> ancestry oracle (`isAncestor` via an explicit git exit-code — simple-git's `raw` does NOT reject on
> `--is-ancestor` exit-1, which would have silently broken the CAS), the worker
> `GET /workspace/head-commit`, container-spec population, compose volume rooting, the publish hook,
> and the disk-janitor GC — all unit-tested.
>
> **Dep-dir retargeting progress (Phases 1–4b on the branch, flag still OFF).** Config read+validate
> (`agent.dep-dirs`), the per-dep-dir scope key + `buildOverlaySpecs` (N mounts at `/workspace/<dep-dir>`
> subpaths), the N-spec container plumbing + flag-gated populator (`prepareOverlaySpecs` +
> `validDepDirsForOverlay`), the per-dep-dir snapshot producer/transport (`dep-snapshot.ts`,
> `overlay-snapshot.ts`), and the **per-dep-dir publish-after-install orchestration**
> (`overlay-publish.ts` → `publishDepDirOverlayBases`, wired into `setupServiceManager`'s install seam
> via a `publishOverlayBases` hook constructed in `index.ts`) are all landed and unit-tested. Each dep
> dir publishes into its own `(repo, runtime, dep-dir)` base via the unchanged `overlay-base.ts` CAS.
> **Phase 5 (compose subpath mounts)** is also landed: `generateComposeOverride` gained an
> `overlayDepDirs` option that, for each service sharing the workspace, keeps the normal mount and
> appends one nested `type: volume` overlay mount per reachable dep dir at `<service-target>/<dep-dir>`
> (declared `external: true`); `ServiceManager` threads it via `setOverlayDepDirs()`, populated from
> `prepareOverlaySpecs` in `setupServiceManager`'s start path. **Phase 6 (disk-cleanup retargeting — the
> GC-correctness gate)** is also landed: the N-volume reclaim was already wired by the foundation +
> Phase 3a (teardown via `destroyContainer`'s `overlayVolumeNames` loop, disk-tier escalation via
> `containerManager.destroy()`, the `^shipit-([a-f0-9-]{12})_` crash-orphan prefix sweep, the
> per-`(session × dep-dir)` `liveOverlayScopeHashes` live-set, and `copySnapshotToBase`'s atomic
> old-generation swap), and Phase 6 locked it with N>1 tests across all surfaces + the CLAUDE.md
> "Disk cleanup" docs sync. **Phase 7 (enable-path wiring)** closed the last code gap: the warm-pool
> standby is now built with `prepareOverlaySpecs` (`warm-pool-manager.ts`), so a warm-claimed session —
> which reuses the standby container — carries the overlay mounts (it was the only creation path
> bypassing `createContainerForRunner`'s overlay wiring). **The overlay dep store is now functionally
> complete behind `OVERLAY_DEP_STORE` (still default OFF).** The only remaining items are the user's:
> (1) measure warm-install on the real containerized path and set the final depth cap, and (2) flip the
> flag on (deliberately, ideally a canary) — both deferred to the user, as the flip enables real overlay
> mounts in production.
>
> **The two pieces previously listed as "remaining" — (A) source-sync re-sequencing and
> (B) the workspace-view resolver — are now [REJECTED, not pending](#rejected-approaches)**, because
> the current design overlays only the declared **dep dirs** and leaves `session.workspaceDir`
> authoritative (so neither A nor B is needed). The **actual remaining work** under the current
> design is: read `agent.dep-dirs` from shipit.yaml (default `[node_modules]`) + validation; change
> `buildOverlaySpec` to emit **N mounts at dep-dir subpaths** (not one mount at `/workspace` root)
> with the scope key extended by the dep-dir relpath; scope the worker snapshot to the dep dirs; wire
> compose services to the same per-session overlay volume at the dep-dir subpaths; and host-matrix
> validation ([`prototype/nested-overlay-spike.sh`](./prototype/nested-overlay-spike.sh) — a
> `type=overlay` volume nested under the `/workspace` bind, run on all three targets). See
> [`checklist.md`](./checklist.md) for the reframed task list.

0. **Prototypes & decisions** *(done)* — rolling-base logic (33/33), overlay substrate
   (WSL2 + Docker Desktop/Mac), and the §4 design are settled. **Mechanism = daemon-performed
   overlay via the `local` volume driver** (no sidecar, no propagation, no `CAP_SYS_ADMIN`):
   proven in the **production layout** on both **Docker Desktop/Windows-WSL2** (`volume-driver-overlay-spike.sh`
   7/7 — the host where the rejected sidecar approach failed) and the **prod systemd VPS**
   (`shipit-16gb`, Ubuntu 24.04, 7/7). **All four documented targets are overlay-eligible** and
   the confirm-before-build gate is cleared. (The earlier propagation spike — VPS/Mac pass,
   Windows fails — is the evidence for *why the sidecar was rejected*; superseded.)
1. **Delete the nm-store fast path** — remove the copy store + its gate wiring; keep
   `runtimeKey`/`detectLibc` (overlay reuses it) and `tuneNpmInstall`; the worker install path
   becomes marker-skip-or-plain-`agent.install` (download cache stays). Mark
   [148](../148-fast-npm-install/plan.md) superseded. *Interim:* fast-path-eligible repos pay a
   full install per fresh session until Phase 3 — a conscious, temporary regression with a known
   end date now that overlay is proven across all targets.
2. **Daemon-overlay mount subsystem** — orchestrator (unprivileged, via `docker.sock`) creates a
   per-session `local` `type=overlay` volume (`lowerdir`=base, `upperdir`/`workdir`=session,
   absolute daemon-host paths from `docker volume inspect`) and mounts it at `/workspace`;
   **serialize** volume create/mount (overlay2 EBUSY hazard); teardown is `docker volume rm`
   (daemon unmounts on container stop — no manual unmount-ordering); add the workspace-view
   resolver that prevents overlay sessions from using the host `upperdir` as their authoritative
   tree; mount-cost timing (the one nice-to-have left — not a gate). *(No sidecar, no propagation
   probe, no re-arm — all removed by this mechanism.)*
3. **Rolling-base logic wired to the real install** — per-`(repo, runtime fingerprint)` scope,
   base in the `overlay-base/<hash>/` subtree (NOT dep-cache — see §4 storage layout) + per-session
   upper/work, the stamped marker, the publish
   commit-ancestry CAS, the exit-0 gate, depth-cap flatten, `.git` exclusion, cold-start v0.
4. **Session lifecycle integration** — on-activation install → publish rule, eligibility
   exclusions (Ops source-pin / non-default / user-edited), re-derive on unarchive, worker-backed
   file/doc/git/compose/watcher/post-turn operations over the merged `/workspace`, and production
   wiring.
5. **Measure & tune** — warm-vs-cold install timing on the containerized path, set the depth cap,
   optional manifest-fingerprint skip.

## Open questions

These are now mostly **empirical / feasibility** items to settle in the prototype — the
design decisions are made (see Decisions). Status of each is tracked in
[`FINDINGS.md`](./FINDINGS.md); #1/#2/#3/#4 are all resolved (#4 resolved by the shared-overlay
multi-container spike going PASS=8/8 on all three host targets — see below).

1. **Host-mount feasibility (the gate).** ✅ **Resolved.** Can the unprivileged orchestrator own
   a per-session whole-workspace overlay within the containment model (`docs/172`), across all
   install targets? *Substrate confirmed (WSL2/ext4 19/19 + Docker Desktop/Mac 21/21: mount, CoW
   with immutable base, 16-deep lowerdirs, teardown). The **mechanism** is the
   **daemon-performed overlay via the `local` volume driver** — the orchestrator (via
   `docker.sock`, no added capability) has the daemon mount the overlay as it builds the session
   container, so there's no privileged sidecar, no `CAP_SYS_ADMIN`, and no cross-container
   propagation. Proven on Docker Desktop/Windows-WSL2 (`volume-driver-overlay-spike.sh` 7/7) —
   the host where the rejected sidecar/propagation approach failed — so **all four documented
   targets are overlay-eligible**. Teardown ordering also dissolves: the daemon unmounts on
   container stop; the orchestrator just `docker volume rm`s. Proven in the production layout on
   the prod VPS too (`shipit-16gb`, Ubuntu 24.04, 7/7). Only nice-to-have left: mount-cost timing
   (not a gate) — see [`FINDINGS.md`](./FINDINGS.md).*
2. **Source + `.git` on the overlay.** ✅ **Resolved** (WSL2/ext4 + Docker Desktop/Mac): clone +
   checkout/reset work on the merged dir, a linked worktree's absolute gitdir pointer resolves,
   and a published base carries source contents with `.git` excluded cleanly. Implementation must
   include the §3 clean/whiteout step for paths deleted since the lowerdir base.
3. **Publish ordering by commit ancestry.** ✅ **Resolved** by
   [`prototype/run-rolling-base.ts`](./prototype/run-rolling-base.ts). The base advances only
   when a candidate's `main` commit strictly descends the current base's commit (§3), or when
   the current remote default has diverged and forces a lineage reset from empty. The
   `git merge-base --is-ancestor` check (~2.3 ms/call) + short per-`(repo, runtime
   fingerprint)` lock (~0.1 ms/call) are confirmed cheap and gate only the *publish*. A
   late-but-older publisher correctly declines (ancestry, not wall-clock); a force-pushed
   default branch does not wait for impossible old-lineage ancestry and instead starts a clean
   generation.
4. **Compose + file watcher over the merged dir.** ✅ **Resolved — spike PASS=8/8 on all three
   targets (Docker Desktop/Windows-WSL2 amd64, Docker Desktop/Mac arm64, prod VPS ext4; see
   [`FINDINGS.md`](./FINDINGS.md)).** The Phase-0 spike proved the *filesystem* behavior —
   bind-mounting the overlay **merged** dir reads through to the base and writes reach the upper,
   and `inotify` over the overlay sees both plain creates and copy-up modifies (Docker Desktop/Mac
   named-volume substrate, `run-in-docker.sh`, 21/21 incl. inotify; bind-mount-corroborated on
   WSL2). **But that spike mounted the merged dir within a single container's mount namespace** —
   the model §4 *rejected*. Under the adopted daemon-overlay mechanism the merged tree exists only
   as the per-session `local` `type=overlay` volume the daemon mounts into the **agent** container,
   while compose **dev-server services are separate containers** that today mount the workspace as
   a **Subpath of the shared `shipit-workspace` volume** (`entry.volume = { subpath }`,
   [compose-generator.ts:492-518](../../src/server/orchestrator/compose-generator.ts#L492-L518)).
   For an overlay session that subpath resolves to the session's **upperdir**, so a vite/next dev
   server would see a workspace with **no `node_modules` and no lowerdir source** and fail to start.

   **Decided solution — one shared overlay volume, not one per container.** Do **not** give each
   compose service its own `type=overlay` volume (that *would* trip the kernel's `upperdir is
   in-use by another mount` rule). Instead make the per-session `type=overlay` volume the agent
   already mounts (`shipit-<sessionId[:12]>_overlay`, §4 GC) *be* the `shipit-workspace`-equivalent
   the compose stack mounts too: declared `external: true` and mounted **by subpath** into every
   service, exactly as `shipit-workspace` is today (compose-generator.ts:651-655). This is not a
   new sharing pattern — ShipIt **already** shares one `external` named volume across the agent
   container and every service by subpath; the only changed variable is that the shared volume is
   now `type=overlay`. Docker's `local` driver refcounts named volumes: the daemon runs
   `mount -t overlay` **once** on first use (onto the volume's `_data`), then **bind-mounts that
   already-mounted `_data`** into every subsequent container — it does **not** issue a second
   overlay mount. One shared volume ⇒ one overlay mount ⇒ the `upperdir is in-use` error is
   structurally impossible, and all containers get a coherent merged view (the dev server sees the
   agent's edits and vice-versa — what HMR needs). The compose-generator change is small: for
   overlay-eligible sessions, point `opts.workspaceVolume` at the per-session overlay volume name
   instead of `shipit-workspace` **and set `opts.workspaceSubpath = ""`** (the overlay volume's
   root *is* the merged workspace, so there is no `sessions/<id>/workspace` storage subpath to
   prepend — passing the existing non-empty subpath would mount every service at a path that
   doesn't exist on the overlay volume and the dev server would fail to boot); `rewriteVolumes` and
   the `external: true` declaration are otherwise unchanged. See the "Compose/preview wiring"
   subsection in §4 for the full per-mount detail. Services must mount **only** that merged volume — never an
   `overlay-base/` lowerdir subpath (the §4 read-only-lower rule) and never a bare-upperdir subpath.

   **The one unproven bit + how it's proven.** The new variable is *concurrent first-use* of a
   `type=overlay` volume: the agent `docker run` and `docker compose up` can race on the volume's
   first mount, which is the overlay2 EBUSY window §4 flags. Docker's per-volume store lock should
   already serialize this (it does for every `local` volume), but it must be shown empirically for
   `type=overlay` on every target. The gating spike — [`prototype/shared-volume-spike.sh`](./prototype/shared-volume-spike.sh),
   a sibling to `volume-driver-overlay-spike.sh` (which only tests two *distinct* volumes sharing
   one lower, not one volume shared by N containers):
   **(a)** after bring-up, assert the upperdir appears **exactly once** as an `overlay` mount in
   the daemon host's `/proc/self/mountinfo` (the decisive check — one mount, not N); **(b)** loop
   ~50× from a cold `volume rm`+create each iteration, launching agent + ≥2 services with no
   inter-start delay, asserting **zero** `EBUSY`/`device or resource busy`/`upperdir is in-use`;
   **(c)** assert the **HMR polling substrate**: a file the agent writes is visible — fresh
   content + an updated mtime — to a *service* container's `stat()`/`read()`. Note previews do
   **not** use cross-container inotify today and won't under overlay: dev servers run in a separate
   container and inotify doesn't cross the mount-namespace boundary, so the templates already drive
   HMR by **polling** (`usePolling`/`WATCHPACK_POLLING`, see
   [`shipit-docs/compose.md`](../../src/server/shipit-docs/compose.md)); polling only needs the
   write/mtime coherence this check proves, so native cross-container inotify is recorded as a
   **non-gating** data point, not a pass/fail. **(d)** exercise the teardown↔startup overlap (stop
   the last container while starting a new one) and confirm the merged view survives.

   > **The two watchers don't both depend on this.** ShipIt's own file-tree watcher
   > (`file-watcher.ts`, chokidar/inotify) runs **inside the agent container** over the merged
   > mount — *same-namespace* inotify, already proven by the Phase-0 21/21 run — so it is unaffected
   > by the shared-volume question. Only the dev-server HMR watcher lives in a separate container,
   > and it polls. So the spike gates previews on **read-through + write/mtime coherence**, not on
   > inotify crossing a container boundary. Run all of it on the full matrix — prod systemd VPS (ext4), Docker
   Desktop/Mac, Docker Desktop/Windows-WSL2 — since EBUSY is kernel/storage-driver-dependent. Green
   = 1 overlay mount + 0 errors across the cold-race trials × 3 hosts + clean teardown overlap; that
   retires the blocker and the rest is ordinary wiring. **The matrix is now complete — all three
   hosts PASS=8/8 (Windows-WSL2 amd64 + Mac arm64 at 25 trials, prod VPS/ext4 at 50; single
   superblock + 0 EBUSY everywhere; see [`FINDINGS.md`](./FINDINGS.md)).** The remaining work is
   the compose-generator wiring (point overlay-session services at the per-session overlay volume
   by subpath); dev-server HMR keeps polling, which the write/mtime-coherence check confirmed works
   over the shared mount.

*Resolved this iteration (see Decisions): concurrency (installs run into each session's own
upper — no serialization needed; base publishes restricted to exit-0 pre-user installs whose
recorded source base is the remote default-branch commit, and advance only forward by
**`main`-commit ancestry**, a compare-and-swap with no reconciliation), flatten
(depth-cap-triggered clean reinstall, specific tunable cap), cold start + trust (build v0 under
the existing repo trust gate), sharing scope (single-user), secret capture (as-is, no filter),
archive/restore (re-derive on unarchive), bad-base (exit-0 gate).*

## Key files

| Concern | File |
|---|---|
| dep-cache dir + mount + env | [container-lifecycle.ts](../../src/server/orchestrator/container-lifecycle.ts#L83-L211), [session-dir-factory.ts](../../src/server/orchestrator/session-dir-factory.ts#L56-L66) |
| Today's node_modules copy store (superseded) | [nm-store.ts](../../src/server/session/nm-store.ts#L218-L309) |
| Install paths (warm-pool pre-install + on-activation) | [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L214-L243), [service-manager-setup.ts](../../src/server/orchestrator/service-manager-setup.ts#L322-L329) |
| Install gate + marker / `headChanged` skip | [session-worker.ts](../../src/server/session/session-worker.ts#L649-L707), [claim-session.ts](../../src/server/orchestrator/services/claim-session.ts#L204-L206) |
| Default-branch creation paths | [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L147-L164), [claim-session.ts](../../src/server/orchestrator/services/claim-session.ts#L361-L374), [session.ts](../../src/server/orchestrator/services/session.ts#L202-L216) |
| Generic spawned sessions + internal Ops source pin | [child-sessions.ts](../../src/server/orchestrator/services/child-sessions.ts#L70-L81) |
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
