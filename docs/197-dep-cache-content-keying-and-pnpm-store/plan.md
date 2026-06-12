---
issue: https://linear.app/shipit-ai/issue/SHI-122
description: Content-keyed install skip (GH-Actions-style lockfile hashing) and a shared pnpm store volume, replacing overlay for pnpm repos.
---

# Dep-cache evolution: content-keyed install skip + pnpm shared store

Two follow-ups from the docs/183 production canary (FINDINGS, 2026-06-11/12 sections),
designed together because they share one observation: **the overlay dep store keys on a
proxy (git commit ancestry) when the install's true input is the dependency manifest.**
GitHub Actions' cache got this right years ago: `key:
node-modules-node24-${{ hashFiles('package-lock.json') }}` — runtime fingerprint +
content hash of the files that actually determine the install's output.

Measured motivation (canary, `shipit-16gb`, shipit-scale dep set):

- A session at any commit other than the base pointer's re-runs the install probe even
  when the lockfile is byte-identical — i.e. **every feature-branch session pays
  ~5–20 s** (npm probe / pip "already satisfied" / pnpm verify) that a content key
  would skip outright.
- pnpm repos pay a **464 MB per-session upper copy** on every installing session:
  pnpm's store→`node_modules` hardlinks cannot cross the overlayfs boundary (EXDEV),
  so it silently degrades to full copies. Base hits are fine (9× faster than cold),
  but installing sessions get the worst of both worlds.

## Part 1 — Content-keyed install skip

### Design

Extend the install-marker stamp (`InstallMarkerStamp`, docs/183 Phase 3) with a
`depsHash` — a hash of the dependency input files — and let a **content match** skip
the install exactly like a `sourceCommit` match does today:

```
skip if marker.runtimeKey == runtimeKey
      && marker.installCommands == commands
      && (marker.sourceCommit == HEAD            // existing exact-commit path
          || marker.depsHash == hash(dep inputs)) // NEW: content path
```

The `sourceCommit` path stays — it is what proves a *base publish* is safe (ancestry
CAS is unchanged; this design only widens who gets to **skip**, not who gets to
**publish**).

### What gets hashed

Per package manager, the canonical input set (first match wins):

| Ecosystem | Files hashed |
|---|---|
| npm | `package.json` + `package-lock.json` |
| pnpm | `package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml` (if present) |
| yarn classic | `package.json` + `yarn.lock` |
| pip/venv | `requirements.txt` (+ `requirements-*.txt` siblings if referenced) |
| uv | `pyproject.toml` + `uv.lock` |

Hash = sha256 over (relpath, file bytes) pairs, order-fixed — same shape as
`hashFiles()`.

### The codegen hazard (why this is NOT unconditional)

`agent.install` is an arbitrary command list. `npm install`'s output depends only on
the manifest+lockfile, but a repo may declare `install: [npm install, npm run
codegen]` where codegen reads `schema.prisma` or `*.proto` — inputs the deps-hash does
not see. Skipping on a content match there would serve stale codegen.

Rule: **the content path applies only when every entry in `agent.install` is a
recognized pure dependency-install command** (`npm install`/`npm ci`/`pnpm
install`/`yarn install`/`pip install -r …`/`uv sync`, modulo flags). Anything else in
the list → content path disabled for the whole stamp, `sourceCommit` semantics only.
Escape hatch for power users: an explicit `agent.install-inputs: [file, …]` list opts
back in by declaring the full input set (hash those files instead of the per-PM
defaults). This adds no new dimension for the common case — defaults cover the four
templates and every plain npm/pnpm/pip repo.

### Touchpoints

- `src/server/shared/install-marker.ts` — stamp shape (+ version bump so legacy
  markers mismatch cleanly, which is the existing miss path).
- `src/server/session/session-worker.ts` `/install` gate — compute the deps hash
  (cheap: ≤4 small files) and apply the widened match. The empty-dep-dir
  contradiction check (docs/183 precondition (e) fix) applies to both paths
  unchanged.
- Pre-stamp path (warm pool): the orchestrator-side pre-stamp must write `depsHash`
  too, so a standby claimed by a feature branch with unchanged deps skips.
- shipit-docs: `shipit-yaml.md` (the `install-inputs` field), `install.md` if present.

## Part 2 — pnpm: shared store volume instead of overlay

### Design

For pnpm repos, **do not overlay `node_modules` at all.** Instead:

1. Mount a shared, per-runtime pnpm store at a fixed path on the **same filesystem as
   the workspace** (a subdir of the state volume, e.g.
   `pnpm-store/<runtimeKey-hash>/`, bind-mounted into the container — the workspace
   bind and the store bind share the host superblock, so hardlinks work).
2. Point pnpm at it (`npm_config_store_dir` env on the agent + install processes —
   works for every pnpm invocation without touching the repo).
3. Let pnpm do what it was built to do: `pnpm install` with a warm store is
   resolution + linking (seconds), per-session disk is hardlinks (~0), and dedup is
   content-addressed across **versions and repos** — strictly better than the
   per-scope base generations overlay provides.

With Part 1's content-keyed marker, the unchanged-deps case doesn't even run pnpm —
same ~5–7 s floor as npm.

### Why not keep the overlay for pnpm too

Measured on the canary: the overlay buys pnpm nothing on installing sessions (EXDEV →
full copy into the upper) and costs 464 MB per session; the store volume gives the
same sessions near-warm installs at ~zero marginal disk. Base-hit reuse is replaced by
store-hit + marker-skip, which is at least as fast. One mechanism per ecosystem, not
two.

### pnpm detection

Signals, in precedence order (any hit → pnpm):

1. `packageManager` field in `package.json` starting `pnpm@` — the corepack standard;
   authoritative when present.
2. `pnpm-lock.yaml` at the workspace root — the conventional signal (what
   `KNOWN_LOCKFILES` already uses in `templates.ts`).
3. A `pnpm` invocation in `agent.install` — truthful by construction (it is what we
   will actually run), covers repos with no lockfile committed yet.

Conflicts (e.g. both `package-lock.json` and `pnpm-lock.yaml` present): 1 > 3 > 2 —
the declared manager and the actual install command outrank a stray lockfile.
Detection lives next to `validDepDirsForOverlay` (orchestrator side) so the overlay
skip and the store mount derive from one decision.

### Store lifecycle

- Keyed by runtimeKey hash → an image rebuild starts a fresh store (same ABI argument
  as overlay scope rotation, docs/183 precondition (c)).
- Reclaim: disk-janitor sweeps store dirs whose runtimeKey is no longer current and
  untouched stores past the cache cutoff (same `DISK_JANITOR_CACHE_DAYS` family).
  pnpm's own `store prune` can run as part of the sweep for the live store.
- Known caveat (document in shipit-docs): in-place mutation of hardlinked store files
  (patch-package style) — pnpm's own ecosystem answer (copy-on-patch via
  `pnpm patch`) applies; the store is also integrity-checked by pnpm on link, so
  corruption is detected, not silently propagated.

## Shelf (explicitly not scheduled): content-addressed multi-base store

The end-state convergence of Part 1's idea: replace the single rolling base pointer
per scope with a map `depsHash → base generation` (immutable entries, LRU eviction) —
the full GitHub Actions cache model. It would delete the ancestry CAS, depth cap, and
flatten machinery, and give concurrent branches with different dep sets their own
bases; #1267's hardlink-dedup already makes coexisting bases cheap. Not scheduled
because the rolling-pointer model is production-proven as of the docs/183 canary and
the marginal win over Part 1 + Part 2 is small. Revisit if branch-divergent dep sets
show up as a real cost in fleet telemetry.

## Sequencing

1. Part 1 (content-keyed skip) — small, self-contained, benefits every ecosystem
   immediately. Inert risk: a wrong hash only causes a *miss* (re-install), never a
   wrong skip, except via the codegen rule above — which is why the recognized-command
   allowlist is conservative.
2. Part 2 (pnpm store) — orchestrator mount + env + detection + janitor sweep;
   removes the EXDEV caveat from the docs/183 flip story entirely.

Both land behind the existing `OVERLAY_DEP_STORE` rollout gate where applicable; no
new deployment-level configuration dimensions (see the docs/183 flag-retirement plan —
the goal is fewer knobs, not more).
