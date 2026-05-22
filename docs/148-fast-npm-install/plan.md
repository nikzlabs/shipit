---
status: planned
priority: high
description: Make per-session `npm install` near-instant by sharing a materialized, lockfile-keyed node_modules across sessions for the same repo — not just the download cache.
---

# Fast `npm install` in session containers

## Problem

Every session that needs dependencies pays for `agent.install` (typically `npm install`).
For the ShipIt repo itself this is ~24s:

```
[agent-install] running npm install
added 588 packages, and audited 589 packages in 24s
```

ShipIt spins up many sessions per repo (warm pool, worktrees, branches, rewinds,
dogfooding). Each new session gets a **fresh workspace**, so it re-runs the full
install even though the dependency tree is byte-identical to a sibling session that
installed minutes ago. 24s of dead time on the critical path to the user's first turn,
repeated per session, is the cost we want to remove.

## Root cause: we cache downloads, not materialization

There is already a per-repo dependency cache, but it only covers the **download** step:

- `createDepCacheDirHelper()` in [session-dir-factory.ts](../../src/server/orchestrator/session-dir-factory.ts#L56-L66) maps a repo URL to `{stateDir}/dep-cache/{hash}` (hash = first 16 chars of `sha256(repoUrl)`, via [git-utils.ts](../../src/server/orchestrator/git-utils.ts#L18-L20)).
- [container-lifecycle.ts](../../src/server/orchestrator/container-lifecycle.ts#L133-L147) mounts that dir at `/dep-cache` in every container for the repo, and [buildEnv()](../../src/server/orchestrator/container-lifecycle.ts#L175-L179) points the package managers at it:
  ```
  npm_config_cache=/dep-cache/npm
  YARN_CACHE_FOLDER=/dep-cache/yarn
  PNPM_STORE_DIR=/dep-cache/pnpm
  ```

So tarballs are already local on the second session onward. The remaining ~24s is
**not network** — it is the cost of *materializing* `node_modules` from a warm cache:

1. Resolve the lockfile into an ideal tree.
2. Extract ~588 package tarballs into the workspace — tens of thousands of small file
   writes onto a Docker volume / overlay filesystem (the dominant cost).
3. Run install scripts and native rebuilds — the `prebuild-install@7.1.3` deprecation
   warning in the log shows at least one native addon going through node-gyp/prebuild.

`node_modules` itself lives in the per-session workspace and is **never shared or
reused** across sessions. That is the gap.

## Where install runs today

- Triggered at **session activation** (not warm-pool creation) by [service-manager-setup.ts](../../src/server/orchestrator/service-manager-setup.ts#L300-L307) → `runner.runInstall(shipitConfig.agent.install)`.
- [container-session-runner.ts](../../src/server/orchestrator/container-session-runner.ts#L834-L891) forwards the commands over HTTP to the worker's `POST /install`.
- The worker ([session-worker.ts](../../src/server/session/session-worker.ts#L761-L848)) shells out to each command in the workspace with `NODE_ENV=development`, streams stdout/stderr as `install_log` SSE events, and on success writes a `.shipit/.install-done` marker so a **re-activation of the same workspace** skips. A *new* workspace has no marker → full re-install.
- Note: [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L194) has a comment "Pre-run install so the user doesn't wait for it on activation" but the block is **empty** — warm containers do not currently pre-install. (See Option C.)

## Goal

Bring the common case — "new session for a repo whose lockfile we've already installed
once" — from ~24s down to low single-digit seconds (ideally sub-second), without:

- forcing users onto a particular package manager,
- corrupting `node_modules` shared between concurrent sessions,
- depending on a host filesystem feature we can't guarantee on the prod VPS.

## Measurement first (do this before building)

Instrument `runSingleInstallCommand` to record wall-clock for the install step, and
break the 24s into resolve / extract / scripts using `npm install --timing` (writes
`_timing.json`). This tells us how much is extraction (addressed by the Option A copy) vs
native builds (addressed only by caching the *built* tree). Without this split we risk
optimizing the wrong phase. Capture numbers for: cold (empty dep-cache), warm-download
(dep-cache populated, current state), and each candidate strategy.

---

## Options

Ordered roughly by leverage. A and C are complementary and likely the recommended
combination; the rest are alternatives or fallbacks.

### Materialization runs in the worker — not an overlay mount (topology constraint)

The first instinct — have the orchestrator overlay-mount a shared `node_modules` onto
the workspace — **does not work in this architecture**, for two structural reasons:

- The workspace is a **Docker named volume**, not a host directory the orchestrator owns
  ([container-lifecycle.ts:86-93](../../src/server/orchestrator/container-lifecycle.ts#L86-L93)
  — `Type: "volume"`, `VolumeOptions.Subpath`). The orchestrator only knows the volume
  name + subpath, never a host path it can mount onto.
- The orchestrator is **itself a container**, talking to Docker over a socket. A mount it
  performs in its own mount namespace does not appear inside a *sibling* session
  container — `CAP_SYS_ADMIN` does not change that.

Meanwhile the install command runs **inside the session container**: the worker shells
out in `/workspace` ([session-worker.ts:823-825](../../src/server/session/session-worker.ts#L823-L825)).
So whatever fills `node_modules` must be visible there, and the only actor in the right
namespace is the **worker** — which has no `CAP_SYS_ADMIN`, so it cannot `mount -t overlay`.

**Conclusion:** materialize is a **worker-side file operation** (reflink / tar / copy),
and the cached store is **mounted into the container** the way `/dep-cache` already is, so
the worker reads/writes it via a container path. Overlay is therefore *not* a runtime
strategy — it's a possible future container-*creation*-time mechanism with its own
mount/unmount lifecycle (see Option D). The Tier-2 spike proved overlayfs mechanics on a
bare host, but that validated the wrong boundary for this architecture.

### Option A — Lockfile-keyed materialized `node_modules` store (recommended core)

Cache the **fully built** `node_modules` and have the worker materialize it into a fresh
workspace instead of installing.

- **Store key** = `sha256(lockfile-content ‖ runtimeKey ‖ installCommand)`. Hashing
  lockfile *content* (not repo URL) shares a store across repos with identical deps and
  auto-invalidates on any dependency change. `runtimeKey` (image digest + arch + libc)
  prevents restoring a tree whose compiled native addons (`.node`) were built for a
  different arch/libc/image — which would **load-fail at runtime, after install was
  skipped** (a silent late failure); self-hosted image rebuilds get a fresh key for free.
  `installCommand` keys on the exact command, so `npm install` and `npm install
  --production`/`--omit=dev` (which build *different* trees from the same lockfile) can
  never share a store — over-keying errs safe (a spurious miss is one re-install). This is
  deliberate: it lets `isCacheableInstall` stay a *side-effects* gate without also having
  to police every dependency-set-altering flag.
- **Store location**: `{stateDir}/dep-cache/{repoHash}/nm-store/{storeKey}/`, kept as a
  plain directory and mounted into the container next to `/dep-cache`.
- **Engage only for a recognized pure installer.** `agent.install` is arbitrary shell
  ([session-worker.ts:821-828](../../src/server/session/session-worker.ts#L821-L828)) — a
  user's install may produce `.venv/`, `vendor/`, or generated files, not just
  `node_modules`. Snapshotting only `node_modules` and writing the marker would skip side
  effects that were never restored — a correctness regression worse than the latency it
  fixes. So the optimization engages **only** for a single bare `npm ci|install`,
  `yarn [install]`, or `pnpm install` with no chaining/redirection (call this gate
  `isCacheableInstall`); anything else runs unchanged.
- **No lockfile / monorepos / Yarn PnP.** No lockfile → nothing to key on (npm would
  *generate* one, so there's nothing to skip) → run the real command. Workspaces/monorepos
  hoist `node_modules` at multiple levels; v1 engages only for a single root lockfile +
  single root `node_modules` and falls through otherwise. Yarn Berry/PnP repos don't
  produce a hoisted `node_modules` at all (they use `.pnp.cjs`), so engage only when a
  `node_modules` actually materializes — detect post-install and skip populate otherwise.
  Correctness over coverage throughout.
- **Flow**, in the worker, replacing the install step:
  1. Not a cacheable installer, or no/multiple lockfiles → run the real command as today.
  2. Compute `storeKey` from the lockfile + runtime.
  3. `nm-store/{storeKey}` exists → `materialize()` it into `node_modules`, then write
     `.shipit/.install-done`.
  4. Else → real install, then **populate** `nm-store/{storeKey}` (single-flight,
     temp-dir + atomic rename).
- **Single source of truth.** Materialize-then-marker keeps the existing
  `.shipit/.install-done` check ([session-worker.ts:574-578](../../src/server/session/session-worker.ts#L574-L578))
  as the *one* skip signal; the store is only *how* the install step is satisfied, not a
  second skip mechanism. The worker's existing in-flight join (concurrent `/install`
  callers share one promise) serializes same-workspace installs, so warm pre-install
  (Option C) and on-activation install can't double-materialize one workspace.
- **Cross-session concurrency.** Two sessions for the same new `storeKey` may install at
  once. Populate is single-flight per `(repoHash, storeKey)` and publishes via atomic
  rename, so a reader never sees a partial store. The self-heal repopulate (when a fast
  path fails against an existing store) runs under the **same** lock, so it cannot
  overwrite a store another session is mid-read on.
- Reuses the per-repo `dep-cache` dir, hash helpers, and disk-janitor cleanup (extend the
  janitor to prune `nm-store/{storeKey}` by mtime and by "storeKey no longer referenced").

#### Materialization mechanisms (worker-side, copy-shaped)

The agent may mutate `node_modules` mid-session (`npm rebuild`, patch-package, adding a
dep), so the materialized tree must be an **independent copy** — never share mutable
inodes with the store.

- **reflink (`cp --reflink=always -r`)** — block-level CoW: instant, writes diverge
  safely. Needs xfs(reflink)/btrfs. **Unavailable on prod** (ext4); kept in the probe for
  hosts that have it.
- **tar stream (`tar -C store -cf - . | tar -C dest -xf -`)** — sequential copy from the
  directory store; fewer per-file syscalls than `cp -a` for tiny-file trees. The realistic
  **prod fast path** (no FS feature required).
- **plain copy (`cp -a`)** — always correct, always available, slowest. The floor below tar.
- **(rejected) `cp -al` hardlink** — shares inodes; an in-place edit corrupts the store.

`materialize()` tries these in capability order and falls through to a **real install** if
all fail (which also self-heals a corrupt store). All operate on the one directory store,
so there's a single store format.

### Option B — Adopt pnpm's content-addressable store

pnpm's `PNPM_STORE_DIR` is already wired to `/dep-cache/pnpm`. A pnpm install with a warm
store **hardlinks** packages into `node_modules` instead of extracting them — typically
several times faster, and it's the industry-standard answer to exactly this problem.

- Downside: changes the user's package manager and the `node_modules` layout (symlinked /
  isolated), which breaks tools that assume a flat hoisted tree. We **cannot force this**
  on user repos (violates "the agent serves the repo as-is").
- Where it fits: as the package manager for **ShipIt's own dogfooding** and as a
  *recommended* (not mandatory) option we document. Not a general solution.

### Option C — Pre-run install during warm-pool creation (latency hiding)

Make good on the existing-but-empty intent in [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L194): kick off `runInstall` in the
background right after the standby container is ready, against the default branch's
lockfile. By the time the user activates the warm session, `node_modules` is already
materialized.

- Hides latency rather than reducing work — but for the warm-pool path that's exactly
  what the user experiences (instant first turn).
- Composes with A: the warm install also **populates** `nm-store/{storeKey}`, so the
  *next* non-warm session for the same lockfile materializes instantly. C warms A's cache.
- Caveat: warm install runs on the default branch's lockfile; a session that immediately
  changes deps still re-installs. Acceptable — that's the genuinely-different case.

### Option D — Overlay-backed `node_modules` set up at container creation (future)

The only coherent way to get true CoW (zero-copy materialize) given the topology
constraint above is to establish the overlay **when the container is created**, not at
install time from the worker: the orchestrator composes an overlayfs (lower = the store,
per-session upper/work) and hands the *merged* directory to Docker as the `node_modules`
mount, so the session container sees a ready CoW tree with no worker-side mount and no
copy at all. This is the genuinely-fast endgame, but it carries real lifecycle cost —
the mount must be torn down before the volume is removed (the Tier-2 teardown caveat),
needs the orchestrator to own a host path for the layers, and interacts with the existing
`compose-generator` volume rewriting and `shipit-managed=true` labels. Deferred until the
worker-side copy path (Option A) is shipped and measured; pursue only if tar-copy latency
turns out to be the bottleneck. Note this is a *mount with a lifecycle*, deliberately kept
out of the copy-shaped `materialize()` ladder.

### Option E — Tune the install command (cheap, marginal)

Default-inject flags into the npm path: `--prefer-offline --no-audit --no-fund`
(audit + fund metadata round-trips are pure overhead in our setting). Worth doing
regardless — it's a one-line change in how we compose the install command — but it shaves
seconds, not the 20s. Must not override a user's explicit `agent.install`.

---

## Recommendation

A layered rollout:

1. **Now (cheap):** Option E flag tuning + a measurement pass to split the 24s.
2. **Core:** Option A — worker-side, lockfile+runtime-keyed materialized `node_modules`
   store under the existing `dep-cache`, gated on a recognized pure installer, via the
   capability-probing `materialize()` ladder. On prod (ext4) the path is
   **tar-stream → copy → real install**; reflink stays in the probe for xfs/btrfs hosts.
   Package-manager-agnostic, strictly additive.
3. **Latency hiding:** Option C — pre-run install on warm-pool creation, which also warms
   the Option A store for subsequent cold sessions.
4. pnpm (Option B) only for ShipIt's own dogfooding and as documented guidance, never
   forced on user repos.
5. **Endgame (only if needed):** Option D — overlay-backed `node_modules` at container
   creation for zero-copy materialize, pursued only if tar-copy latency proves to be the
   bottleneck after Option A ships.

## Portability & graceful degradation (hard requirement)

The prod VPS (ext4 / overlay2) is **one** deployment. ShipIt is also self-hosted by other
users, run on dev laptops, and run in `RUNTIME_MODE=local` (dogfooding, no Docker at all).
The host filesystem, kernel, storage driver, and even whether containers exist all vary.
So the optimization must be **strictly additive**: it can only ever make install faster,
never make it fail. The fallback floor is today's behavior — a plain `npm install`.

Concretely, the worker-side `materialize()` helper is a probe-and-degrade ladder, and
**every rung falls through to the next on any error**, ending at the real install:

```
reflink copy   (needs xfs(reflink)/btrfs; NOT prod ext4)
  ↓ `cp --reflink=always` returns "not supported"
tar stream     (portable; any FS — the prod fast path)
  ↓ store missing/corrupt or extract errors
plain copy     (always correct, slowest)
  ↓ copy errors
REAL install   (always works — current behavior; also self-heals/populates the store)
```

Rules that make this safe across deployments:

- **Probe once, cache the verdict per host**, but treat every individual `materialize`
  call as fallible — a mid-operation failure (corrupt/partial store, permission denied,
  ENOSPC) aborts to the real install and leaves a clean workspace, never a half-populated
  `node_modules`. Populate via temp-dir + atomic rename so a crashed populate never
  publishes a broken store.
- **`RUNTIME_MODE=local` has no Docker volumes and no session containers**, but materialize
  is plain file ops, so it still works against a local store dir — or set `disabled` to
  run the real install. Don't assume a container context.
- **Self-hosted hosts vary** (rootless Docker, odd filesystems). Every fast path is a
  capability probe that falls through on failure; no configuration flag is *required* to
  get a working (if slower) install.
- **A feature flag to disable the whole optimization** (`disabled`, wired to an env var)
  so any deployment hitting an unforeseen edge forces plain installs without a code change.

## Open questions / action items

- [x] **Confirm the prod VPS backing filesystem** for workspace volumes. **Resolved
  2026-05-22:** Docker root `/var/lib/docker` is **ext4**, storage driver **overlay2**,
  kernel 6.8.0 / Ubuntu 24.04.4. `cp --reflink=always` probe → UNSUPPORTED. So reflink is
  out on prod; the worker-side fast path is **tar-stream → copy** (Option A). Re-probe if
  prod ever moves to xfs(reflink)/btrfs, which would re-enable the reflink rung for free.
- [x] **Overlay CoW mechanics validated — but on the wrong boundary (throwaway spike,
  2026-05-22).** A `lower=store` + per-session `upper`/`work` overlayfs mount in a
  user+mount namespace (`unshare -Urm`) on ext4/overlay2 worked: writes landed in `upper`,
  the `lower` store stayed byte-for-byte untouched, deletes became whiteouts. **But this
  proved overlay *mechanics on a bare host*, not the production topology** — see
  "Materialization runs in the worker". In prod the workspace is a Docker named volume and
  the orchestrator is a sibling container, so an orchestrator-side mount never reaches the
  session container's `node_modules`. Net: overlay is **demoted out of the runtime ladder**
  to Option D (container-creation-time, future). The spike's value is that *if* we ever do
  Option D, the CoW + teardown caveats are now known (workdir needs root to clean up).
- [ ] Instrument and split the 24s (resolve / extract / native scripts) — `npm install --timing`.
- [x] **Where the hash is computed:** the **worker** (it holds the workspace), as part of
  the worker-side materialize. `storeKey` covers npm/yarn/pnpm by hashing lockfile content
  + runtime, so no per-manager branching is needed for the key itself.
- [x] **Cross-session concurrency:** single-flight per `(repoHash, storeKey)`, temp-dir +
  atomic rename, with the self-heal repopulate under the same lock (Option A). Same-
  workspace concurrency is already covered by the worker's in-flight `/install` join.
- [x] **Mid-session dep mutation:** materialize produces an independent copy (reflink/tar/
  copy), never shared inodes — `cp -al` hardlinking is explicitly rejected. Solved by the
  worker-side copy model.
- [x] **Native-addon portability:** `storeKey` includes a `runtimeKey` (image digest +
  arch + libc), so a tree built for one runtime is a cache miss (→ real install) on
  another, including self-hosted image rebuilds. No silent late load-failure.
- [ ] **Define `runtimeKey` precisely** and where the worker reads it (image digest via a
  baked-in env/label? `process.arch` + libc detection?). The shape is decided; the exact
  inputs are not.
- [ ] **Monorepo/workspace coverage** beyond the single-root-lockfile v1 (multi-lockfile,
  nested/hoisted `node_modules`). v1 falls through to plain install; revisit after ship.
- [ ] Cache invalidation + disk-janitor: extend [disk-janitor.ts](../../src/server/orchestrator/disk-janitor.ts) to prune `nm-store/{storeKey}` by mtime and unreferenced storeKey.
- [ ] **Implement + test the single-flight populate** (per-`storeKey` lock, temp-dir +
  atomic rename) — the M4 safety core. Single-flight must span read-and-repopulate, not
  just the initial populate, so a self-heal can't overwrite a store another session is
  mid-read on. This is the highest-risk piece; it needs dedicated concurrency tests.
- [ ] Build the worker-side `materialize()` ladder and its strategy impls (reflink / tar /
  copy / real install), the `storeKey`/`isCacheableInstall` helpers, mount the `nm-store`
  dir into the container, and call it from `runInstallCommands`. Option E flag tuning
  composes cleanly — the tuned command is part of `storeKey`, so it can't collide with an
  untuned one. Log the disable *reason* (operator kill-switch vs non-cacheable install)
  distinctly for observability.

## Implementation status

Design only — no code yet. A throwaway spike validated the overlay CoW mechanics on a
bare host (recorded in Open questions; it also surfaced the topology constraint that moved
materialize into the worker) and confirmed the prod filesystem facts. The spike was not
kept; this doc is the source of truth and integration starts from the open items above.

## Key files

| Concern | File |
|---|---|
| Install trigger at activation | [service-manager-setup.ts](../../src/server/orchestrator/service-manager-setup.ts#L300-L307) |
| Install orchestration (HTTP) | [container-session-runner.ts](../../src/server/orchestrator/container-session-runner.ts#L834-L891) |
| Install execution + marker | [session-worker.ts](../../src/server/session/session-worker.ts#L761-L848) |
| Per-repo dep cache dir | [session-dir-factory.ts](../../src/server/orchestrator/session-dir-factory.ts#L56-L66) |
| Repo-URL hashing | [git-utils.ts](../../src/server/orchestrator/git-utils.ts#L18-L20) |
| Cache mount + env wiring | [container-lifecycle.ts](../../src/server/orchestrator/container-lifecycle.ts#L133-L179) |
| Warm-pool (pre-install hook point) | [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts#L184-L199) |
| Cache cleanup | [disk-janitor.ts](../../src/server/orchestrator/disk-janitor.ts) |
| Session-worker image | [Dockerfile.session-worker.prod](../../docker/Dockerfile.session-worker.prod) |
