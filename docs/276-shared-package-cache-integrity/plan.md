---
issue: planning#414
title: Shared package cache integrity — design
description: Closes the two real cross-session holes in the shared package caches, per-session npm resolution cache and copy-on-write pnpm imports, without giving up the storage sharing.
---

# Shared package cache integrity — design

Implements [requirements.md](./requirements.md). Read it first.

All figures below were measured on npm 11.12.1 and pnpm 11.22.0 / 12.4.2. The
harnesses beside this doc reproduce the pnpm results: [`verify-h4.sh`](./verify-h4.sh)
(the store-index trust, H2/H4), [`verify-h2.sh`](./verify-h2.sh) (content-hash
behaviour) and [`verify-reflink.sh`](./verify-reflink.sh) (import methods). Note
`verify-h2.sh` forces re-verification in its setup, so its cells fail closed;
`verify-h4.sh` shows the warm-store case where pnpm skips the re-check.

## The holes

| Hole | Surface | Status |
|---|---|---|
| **H1** — cached npm *resolution data* (packument) rewritten to point at attacker content | `/dep-cache` `_cacache/index-v5` | **Open.** Install-time RCE: rewrite `dist.integrity` to attacker content placed at its own hash, set `hasInstallScript: true`, and `npm install` runs the attacker's `postinstall`. Works with the network available, because npm serves its local cache without asking the registry. |
| **H2** — poisoned pnpm store *content* (bytes changed in place) installed by a normal `pnpm install` | `/workspace/.pnpm-store` | **Conditional, and subsumed by H4.** pnpm re-hashes an entry on import only when `index.db` does not already vouch for it. Measured 2026-09-17: a *warm* store (one pnpm already has a manifest for), poisoned in place, installs the bytes offline with `verify-store-integrity=true` (rc=0); the negative control — same store with `index.db` deleted — fails closed. So `verify-store-integrity=true` is necessary but not sufficient. |
| **H3** — store file mutated in place under a live `node_modules` | `/workspace/.pnpm-store` | **Open, and unreachable by verification.** Store files are hardlinked into `node_modules` (`links=2`), so a store write changes already-installed files with no install event. Req 4 exists for this. |
| **H4** — pnpm store *manifest* (`v11/index.db`) rewritten to point a package's file at attacker content placed at its own valid hash | `/workspace/.pnpm-store` | **Open, and `verify-store-integrity` does not close it.** The per-package manifest is trusted layout data, the pnpm analogue of npm's `index-v5`. Verification checks each file against the digest the manifest names, not the manifest against the package's integrity. Measured 2026-09-17: offline, `verify-store-integrity=true`, a rewritten manifest installed attacker bytes (rc=0), and a second repo sharing the store got them too. pnpm's own security policy confirms it: store integrity does not defend an attacker who rewrites both files and their recorded hashes. |

Facts that shape the design:

- npm's `content-v2` is self-verifying (the path is the hash); a poisoned tarball
  is detected and an offline install fails closed. Only `index-v5` is forgeable.
- pnpm's content blobs are also self-verifying by path, **but pnpm does not
  re-hash them on every import**: it trusts `v11/index.db`, which records each
  file's expected hash and a `checkedAt`. That trusted index is the pnpm
  equivalent of npm's `index-v5`, and it lives in the same shared writable store
  (H2/H4). Reproduced by [`verify-h4.sh`](./verify-h4.sh).
- npm does not hardlink `_cacache` into `node_modules` (`links=1`), so H3 is
  pnpm-only.
- The overlay dependency base (docs/183) is not a hole: it is never mounted into
  a session container (`src/server/orchestrator/overlay-volume.ts`), and is
  reached only through the publish path's compare-and-swap.
- A lockfile is a partial mitigation for H1 only. Measured with a valid lockfile
  present: `npm ci` and an in-sync `npm install` are protected; `npm install
  <new-package>` and an out-of-sync lockfile are not. And after a poisoned add,
  `package-lock.json` records the attacker's hash, which the post-turn
  auto-commit then pushes to the user's repository.
- ShipIt sets neither `package-import-method` nor `verify-store-integrity`
  anywhere in `src/`; both run on pnpm defaults.

## Design

### 1. H1 — per-session npm resolution cache (reqs 1, 3, 5, 6)

Give each session its own `_cacache/index-v5` and keep sharing `content-v2`.
The poisoned packument then does not exist in the session that reads it, so
every install form is protected, including `npm install <new-package>` and a
repo with no lockfile. The download saving stays: tarballs are found in
`content-v2` by digest without an index entry.

Spiked: a private `index-v5` beside a symlinked shared `content-v2` installs
offline, the symlink survives the install, and the split is 64 KB private /
688 KB shared. An attacker's write to the shared `index-v5` had no effect on
the victim. Still to measure: warm-install time (req 7) and whether the
symlinked `content-v2` survives `npm cache verify`.

### 2. H3 — `package-import-method=copy` (reqs 1, 4, 10)

Copies give each session its own inode, so a store write no longer reaches an
installed file. Set **`copy`**, not `clone`:

- `clone` is the strict reflink spelling and fails the install where reflink is
  unavailable: `os error 95` (ENOTSUP) on ext4, `os error 18` (EXDEV) across a
  filesystem boundary.
- `copy` goes through `copy_file_range`, which XFS and btrfs turn into an
  extent share. Measured on XFS (`reflink=1`), fresh filesystem per run, `df`
  from empty, 3 353 files / 86 MB of `node_modules`:

  | import method | filesystem used (store + `node_modules`) | inode shared | store poisoning reaches installed files |
  |---|---|---|---|
  | `hardlink` (today) | 91 MB | yes | yes |
  | `copy` | 92 MB | no | no |
  | `clone` | 92 MB | no | no |

  `filefrag` showed 1 054 of 1 057 files with the `shared` flag at the same
  physical blocks as the store entry. btrfs behaves the same. On ext4 `copy` is
  a real copy: about 1.8× the combined disk of hardlinks for the same tree.
- Install time is unaffected: hardlink 170 ms, copy 180 ms, mean of five runs.

Reflink needs the store and the workspaces on one filesystem. ShipIt's state
directory already holds both (`pnpmStoreDirForRuntime` puts the store under
`stateDir`). The filesystem is the operator's: ShipIt installs on laptops and
in Docker Desktop VMs, most of which are ext4. So **detect reflink support on
the state directory at startup and report it; never require it.** A loopback
XFS image is not a ShipIt feature: it needs `CAP_SYS_ADMIN`, which the
orchestrator does not take, and is Linux-only.

### 3. ext4 — overlayfs gives copy-on-write without reflink (reqs 10, 11)

overlayfs implements copy-on-write in the VFS, so it works on any filesystem.
ShipIt already builds this: the docs/183 overlay dep store, mounted by Docker
as an `overlay` volume (`src/server/orchestrator/overlay-volume.ts:196`), so no
privileges are needed and it works under Docker Desktop.

Measured on ext4, two sessions over one shared 59 MB / 1 547-file base:

| | session A upper | session B upper | base |
|---|---|---|---|
| after mount, and after reading the whole tree | 4 KB | 4 KB | unchanged |
| A overwrites a shared file | 64 KB | 4 KB | unchanged |
| A poisons a shared store entry (store inside the overlay) | — | unchanged | unchanged |
| A adds a dependency | 63 MB | 4 KB | unchanged |

The 64 KB row is req 11: a session's edit inside its installed packages is real
for it and invisible to everyone else. docs/198's 464 MB-per-session objection
applies only to sessions that change their dependencies; sessions that use the
base's tree pay 4 KB.

Two constraints for implementation:

- **The pnpm store is outside the overlay as deployed.** It is a separate
  read-write bind at `/workspace/.pnpm-store`, so overlayfs does not cover it
  and H3 survives there. Either move the store inside the overlay, or rely on
  section 2 alone for the store. Decide before building.
- **Never `chown -R` through an overlay mount.** It copies up every file and
  destroys the sharing (a 4 KB upper became 110 MB). Act on the base or the
  upper directly, as docs/272 already requires for shared git trees.

Sections 2 and 3 compose: overlayfs shares the base tree between sessions and
isolates writes to it on any filesystem; `copy` governs how the store
materialises into `node_modules` within a session and is near-free on a reflink
filesystem.

### 4. H2 — pin `verify-store-integrity=true` (necessary, not sufficient)

Set the value explicitly so the protection is asserted rather than inherited,
and describe it in shipit-docs as pnpm's check, not ShipIt's. But it does **not**
make the shared store safe on its own: pnpm skips re-hashing an entry `index.db`
already vouches for, and `index.db` is attacker-writable. The store is safe only
once the store is inside the overlay (section 5 → section 3). Ship this
alongside that, not instead.

### 5. H4 — the pnpm store index is trusted metadata (reqs 1, 3, 6)

`v11/index.db` maps each package to a per-file manifest of expected hashes, and
pnpm trusts it: it re-hashes content only when the manifest does not already
vouch for the entry. Two consequences, both measured
([`verify-h4.sh`](./verify-h4.sh)) and both defeating `verify-store-integrity`:

- **H4** — rewrite the manifest to point a file at attacker content placed at
  its own valid hash. Installs the attacker's bytes, offline, rc=0.
- **H2 (warm)** — poison the bytes in place of an entry the manifest already
  vouches for. Same result, because pnpm does not re-hash it.

This is the pnpm analogue of H1, and worse-scoped: the store is shared
per-runtime across **repos**, so an untrusted repo poisons a private repo's
install. `verify-store-integrity` (section 4) does not close it, and the copy
fix (section 2) does not help — it copies whatever the manifest names.

The fix is to not share the trusted store index across trust boundaries.
**Spiked 2026-09-17, and it resolves to section 3, not to a new mechanism:**

- **A per-session *cold* `index.db` over shared content blobs does not work.**
  Measured: with `files/` symlinked to a shared store and an empty private
  `index.db`, an offline install fails (`snapshot not present in local store`).
  The manifest lives only in `index.db` (no manifest blob exists under `files/`),
  it is derived from the tarball, and pnpm cannot reconstruct it from the bare
  content-addressed blobs. So the index cannot simply be split off cold.
- **What the index needs is a per-session *trusted copy* that is writable
  privately while the content blobs stay shared and read-until-written. That is
  exactly overlayfs (section 3).** Put the whole store — `files/` and `index.db`
  — inside the overlay, and by overlayfs's copy-on-write guarantee a session's
  write to `index.db` (H4) or to a blob in place (H2 warm) copies up to that
  session's private upper and leaves the shared base byte-identical. Section 3's
  table already measured the store-poisoning row staying private; the guarantee
  is the kernel's, not pnpm's, so it holds for `index.db` the same as for a blob.

So H4 is **not** a separate unsolved mechanism: it is closed by the same "move
the store inside the overlay" decision section 3 already carries, and that one
move closes H2, H3 and H4 together. Two residuals still to measure before
building: that pnpm operates correctly with its `index.db` on an overlay (the
whole SQLite file copies up on first store write, and pnpm's store lock must
still work), and the fallback for a host where the store cannot be
overlay-mounted (`--frozen-store` opens the store read-only, but a session must
still install its own new packages — req 9 — so the writable path needs an
answer there).

### Sequencing

1. Section 1 (H1). It is a working RCE and the cheapest fix.
2. Sections 2 and 4 (pnpm settings). Ship on the storage ShipIt already has.
   **On ext4, section 2 alone regresses disk ~1.8× (req 10) until section 3
   lands**, so on ext4 ship 2 and 3 together, or accept the interim cost
   deliberately.
3. Section 3 (overlay), **with the pnpm store moved inside the overlay** — that
   is what closes H2, H3 and H4 together (section 5). This is the load-bearing
   step for the pnpm store, not section 2.
4. `docs/266-orchestrator-git-trust-boundary` E4 stays unshipped until 1 and the
   pnpm store is safe against H3 and H4 (req 8).

## Rejected

- **A ShipIt-owned writer with the store read-only to sessions.** Ruled out by
  req 9. Also, permission bits alone do nothing: the session owns the inode and
  can `chmod` it back through its own `node_modules` path.
- **Registry mediation.** Closes none of the holes: every attack is a
  local write to a shared path, and the package manager serves its local cache
  without asking the registry. `--prefer-online` makes crafted bytes fail
  closed, but repointing a name at a genuinely published package's real tarball
  and integrity installed `is-even` under the name `is-odd` with the flag set.
  It would also concentrate registry tokens in the orchestrator and add a
  single point of failure for all installs.
- **Per-repo pnpm store key.** Narrows cross-repo reach and closes nothing:
  `/dep-cache` is already per-repo and H1 was demonstrated against it. Optional,
  at the cost of cross-repo dedup.
- **Lockfile pinning as the fix.** Covers only `npm ci` and in-sync installs;
  section 1 covers everything it covers and the adding case too.
- **Relying on `verify-store-integrity` alone for the pnpm store.** It trusts
  `index.db`, which the attacker can write (H2/H4). Pin it, but do not treat it
  as the fix.

## Measurement notes

For anyone re-running or extending the harnesses:

- `du` is blind to reflinks (separate inodes, shared extents); it does see
  through hardlinks. Measure disk as a `df` used-space delta.
- Plain `cp` on XFS defaults to `--reflink=auto`; a copy control must pass
  `--reflink=never`.
- btrfs inlines files under ~2 KB into metadata, so a small probe file shows no
  extent sharing. Probe with a multi-megabyte file.
- Locate a store entry by inode, never by grepping content.
- Run every cell with a clean negative control, and rebuild the store per trial.
  Both harnesses once produced confident wrong answers without these.

## Key files

| File | Why it matters |
|---|---|
| `src/server/orchestrator/overlay-session.ts:316` | `pnpmStoreDirForRuntime` — the store lives under `stateDir`, keyed by runtime only. |
| `src/server/orchestrator/container-lifecycle.ts:143` | `PNPM_STORE_CONTAINER_PATH` — `/workspace/.pnpm-store`, the bind outside the overlay. |
| `src/server/orchestrator/overlay-volume.ts:196` | The Docker `overlay` volume that section 3 reuses. |
| `src/server/orchestrator/session-worker-uid.ts:124` | `shareOne` — group write on the shared surfaces (docs/270 req 9). |
| `src/server/orchestrator/session-dir-factory.ts:58` | `createDepCacheDirHelper` — `/dep-cache` keyed per repo. |
| `src/server/session/install-controller.ts` | The install path where the pnpm settings are applied. |

## Related

- `docs/075-shared-dependency-cache` — why `/dep-cache` exists and is per-repo.
- `docs/183-overlay-dep-store` — the overlay dependency base.
- `docs/198-dep-cache-content-keying-and-pnpm-store` — the pnpm store; its
  "integrity-checked on link" caveat is corrected in this PR.
- `docs/270-per-session-worker-uids` — req 9 (sharing must survive).
- `docs/266-orchestrator-git-trust-boundary` — E4, held by req 8.
