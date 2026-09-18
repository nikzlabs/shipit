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
| **H2** — poisoned pnpm store *content* (bytes changed in place) installed by a normal `pnpm install` | `/workspace/.pnpm-store` | **Conditional on mtime, and subsumed by H4.** pnpm skips re-hashing a store file whose mtime matches what `index.db` recorded (second granularity). Measured 2026-09-17: an in-place poison that **preserves mtime** (`touch -r`, trivial) installs offline with `verify-store-integrity=true`; the same poison that **bumps mtime ≥1s** fails closed. So the check is a size-and-mtime fast path, not a content re-hash, and `verify-store-integrity=true` is necessary but not sufficient. |
| **H3** — store file mutated in place under a live `node_modules` | `/workspace/.pnpm-store` | **Open, and unreachable by verification.** Store files are hardlinked into `node_modules` (`links=2`), so a store write changes already-installed files with no install event. Req 4 exists for this. |
| **H4** — pnpm store *manifest* (`v11/index.db`) rewritten to point a package's file at attacker content placed at its own valid hash | `/workspace/.pnpm-store` | **Open, and `verify-store-integrity` does not close it.** The per-package manifest is trusted layout data, the pnpm analogue of npm's `index-v5`. Verification checks each file against the digest the manifest names, not the manifest against the package's integrity. Measured 2026-09-17: offline, `verify-store-integrity=true`, a rewritten manifest installed attacker bytes (rc=0), and a second repo sharing the store got them too. pnpm's own security policy confirms it: store integrity does not defend an attacker who rewrites both files and their recorded hashes. |

Facts that shape the design:

- npm's `content-v2` is self-verifying (the path is the hash); a poisoned tarball
  is detected and an offline install fails closed. Only `index-v5` is forgeable.
- pnpm's content blobs are also self-verifying by path, **but pnpm does not
  re-hash them on every import**: it trusts `v11/index.db`, which records each
  file's expected hash, size and mtime, and skips re-hashing a file whose size
  and mtime still match (pnpm's documented mtime fast path). That trusted index
  is the pnpm equivalent of npm's `index-v5`, and it lives in the same shared
  writable store (H2/H4). Reproduced by [`verify-h4.sh`](./verify-h4.sh).
- npm does not hardlink `_cacache` into `node_modules` (`links=1`), so H3 is
  pnpm-only.
- The overlay dependency base (docs/183) is not *directly* writable from a
  session: it is the read-only lowerdir of a Docker overlay volume, and no mount
  exposes its path. A session reaches it only through the publish path, whose
  compare-and-swap orders publications by commit ancestry and **verifies nothing
  about content** — see section 5's out-of-scope finding.
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
  extent share. Measured on a **loopback XFS (`reflink=1`)** image, fresh
  filesystem per run, `df` from empty, 3 353 files / 86 MB of `node_modules`.
  These XFS figures are **not reproducible on this ext4 container**; the
  committed `verify-reflink.sh` reproduces only the ext4 direction (copy isolates,
  clone fails, hardlink propagates). Treat the numbers as measured-once, not
  independently re-run here:

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

**The store-poisoning row is now backed by a committed harness**
([`store-overlay-spike.sh`](./store-overlay-spike.sh), Docker host 2026-09-18,
[FINDINGS.md](./FINDINGS.md), PASS=14): attacker A poisons through its upper (H4
and H2, each with its own no-overlay control that poisons the victim), and
victim B installs clean over the shared base — clean asserted by the installed
file's digest equalling the original, not merely "no marker".

**Req 7 and req 10 are now measured against a genuine hardlink baseline** (scale
set, 8 deps / 2 168 files / 58 MB, on ext4; install timed inside the container,
link counts asserted). Both regress on ext4, and both because of the copy:

| | today (hardlink) | design (overlay copy) |
|---|---|---|
| warm install (best of 5) | 0.060 s | 0.088 s (**1.47×**) |
| per-session marginal disk | **0 B** | **58.6 MB** (the copied `node_modules`) |

So on ext4 the design trades the hardlink's zero per-session cost for a full
`node_modules` copy, and is ~1.5× slower on a warm install — the req-10 ext4
gate below, quantified, and a measurable (if small-absolute) req-7 cost. A
reflink filesystem would remove both, but **req 12 rules that out of scope:
ext4 must be supported**, so the store-in-overlay shape does not meet req 10
(section 5, "not viable on ext4"). The store-upper copy-up itself (`index.db`,
~0.7 MB at scale / ~48 KB tiny) is bounded and not the cost. The other rows above (reading a base, a dependency
edit staying private, the 63 MB add) are not reproduced by the harness.

Two constraints for implementation:

- **The pnpm store is outside the overlay as deployed.** It is a separate
  read-write bind at `/workspace/.pnpm-store`, so overlayfs does not cover it and
  H2/H3/H4 survive there. Section 2 (`copy`) alone does **not** make the store
  safe — it copies whatever the poisoned manifest names. Making the store safe
  means moving it inside an overlay over a content-verified base (section 5),
  which is new machinery, not a config flag.
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
once the store is inside an overlay (section 5), which is unsolved machinery.
Pin this value anyway; it is not the fix.

### 5. H4 — the pnpm store index is trusted metadata (reqs 1, 3, 6)

`v11/index.db` maps each package to a per-file manifest of expected hashes, and
pnpm trusts it: it re-hashes content only when the manifest does not already
vouch for the entry. Two consequences, both measured
([`verify-h4.sh`](./verify-h4.sh)) and both defeating `verify-store-integrity`:

- **H4** — rewrite the manifest to point a file at attacker content placed at
  its own valid hash. Installs the attacker's bytes, offline, rc=0,
  unconditionally.
- **H2 (mtime)** — poison the bytes in place and preserve the file's mtime.
  Same result, because pnpm's fast path skips re-hashing a file whose size and
  mtime are unchanged. Bumping mtime ≥1s fails closed.

This is the pnpm analogue of H1, and worse-scoped: the store is shared
per-runtime across **repos**, so an untrusted repo poisons a private repo's
install. `verify-store-integrity` (section 4) does not close it, and the copy
fix (section 2) does not help — it copies whatever the manifest names.

The fix is to not share the trusted store index across trust boundaries. The
store goes inside an overlay: sessions read a shared base and every write —
`index.db` (H4) or a blob (H2) — copies up into that session's private upper, by
the kernel's copy-up contract. Two things had to be worked out for that to be a
design and not a slogan.

**Why it is not a reuse of section 3.** docs/183's overlay *deliberately
excludes pnpm* — `container-overlay-provisioner.ts:79` and
`overlay-publish.ts:102` both `return []` for a pnpm repo, because a hardlink
import cannot cross the overlay boundary (EXDEV). With the store inside an
overlay and `node_modules` outside it the same crossing happens in the other
direction, so **`package-import-method=copy` (section 2) is a prerequisite**,
not an optimisation. A per-session *cold* `index.db` over shared blobs was
tried and does not work: an offline install fails (`snapshot not present in
local store`), because the manifest lives only in `index.db`, is derived from
the tarball, and cannot be rebuilt from the loose blobs. So the base must carry
the manifest, and the base must be trusted.

**The trusted-base lifecycle — content-based, not positional.** Verified
2026-09-18: the `index.db` key for a package **is** the registry `dist.integrity`
(the tarball sha512), and a manifest is exactly re-derivable — hash the tarball
against the key, unpack it, sha512 each file, and every recorded digest is
reproduced with nothing left over. That makes a store entry *checkable against
the registry*, which the docs/183 base never was (its compare-and-swap orders
publications and verifies nothing about content). The lifecycle:

- **The base is written only by the orchestrator, and only with verified
  entries.** A package enters the base when the orchestrator has fetched its
  tarball by the key, confirmed the hash, re-derived the manifest and matched
  it, and confirmed each blob hashes to its name. Nothing a session wrote is
  ever copied into the base unverified.
- **Sessions install into their private upper (req 9), and read the base.** A
  base-hit install copies no package *content* into the store (only the
  `index.db` copy-up, ~48 KB measured); a new package's blobs land in the upper,
  real for that session and invisible to others. Note the `node_modules` tree is
  copied per session regardless (`package-import-method=copy`), separate from the
  store.
- **Publish = verify-and-admit, automatic.** After a session's install, the
  orchestrator reads the new entries from that session's upper, verifies each as
  above, and admits the verified ones to the base as a new generation. That
  restores sharing for the next session (req 2, req 10) without ever trusting
  the session. The cost is one tarball fetch per *new package per instance*,
  not per session.
- **Cross-repo sharing stays, and is now safe.** Trust is in the content, so a
  verified `lodash@4.17.21` is the same entry whichever repo asked for it. The
  store keeps its per-runtime key; the cross-repo blast radius disappears
  because there is no unverified path into the base, not because the key
  narrowed.
- **Migration: start empty.** Today's store is attacker-writable and may already
  hold poison, and re-deriving every existing manifest costs a tarball fetch
  each. So the new base starts at generation 0 empty; the first sessions pay a
  cold install into their uppers, publish admits the verified entries, and later
  sessions hit the base. The old store is not promoted.
- **Base is immutable per generation, as docs/183 already does.** A generation
  is never modified while it can be a live lowerdir; a new generation is minted
  per publish and the janitor reaps unreferenced ones.

**Measured 2026-09-18 ([FINDINGS.md](./FINDINGS.md),
[`store-overlay-spike.sh`](./store-overlay-spike.sh), PASS=13).** With a warmed
store as the overlay lowerdir — a **fixture** standing in for the verified base,
not the proposed verification — the H4 manifest rewrite and the H2 mtime-kept
byte poison run through attacker session A stayed in A's private upper: the base
`index.db` was byte-unchanged and victim session B installed clean (asserted by
the installed digest matching the original), while the same attack with **no
overlay** (shared bind) poisoned B. H4 and H2 each have their own control, so
the copy-up isolation is measured, not asserted. `index.db` is **1.3% of the
store for this workload** (659 KB on a 51 MB, 2 168-file store); a per-runtime
index grows across repos, so measure its absolute copy-up at ShipIt's scale
rather than treating 1.3% as a bound. **Req 7 and req 10 are measured against a
hardlink baseline** (scale set, ext4): the design is ~1.47× on a warm install
(0.060 → 0.088 s) and costs a full per-session `node_modules` copy (58.6 MB vs
0 B hardlink). Both are the copy, both regress on ext4, and **both are removed
by a reflink filesystem** — so the store-in-overlay fix depends on reflink
storage (btrfs / XFS) to satisfy req 7 and req 10; on ext4 it regresses both.
The concurrency cell shows two installs into **separate** uppers do not error;
with per-session uppers there is no shared writable index, so it is not a
shared-lock-correctness test. It ran on the services host; it cannot run in a
session container (no Docker socket).

**Not viable on ext4 (2026-09-18).** The requester ruled that ext4 must be
supported and reflink-only optimisations are out of scope (req 12). On ext4
this design costs a full per-session `node_modules` copy (58.6 MB vs 0 B,
measured), which req 10 forbids — and the cost cannot be engineered away while
the store stays shared. Verified on the services host: (a)
`fs.protected_hardlinks=1`, the distro default, refuses a hardlink to a file the
caller cannot write, so a session can link a shared store blob only if it can
also poison it — linkable and writable are the same inode, which is H3; and (b)
hardlinking a lower file inside an overlay copies the data up (a 5 MB link grew
the upper by 5 MB), so overlay plus hardlink shares nothing. A store writable by
sessions is the hole; a store read-only to sessions cannot be hardlinked by a
session, only by the orchestrator, which req 9 rules out. So on ext4 the shared
pnpm **store** cannot be both safe and free.

**Candidate redesign — share the tree, not the store.** Apply docs/183's
overlay-dep-dir model to pnpm. The shared unit becomes a content-verified,
orchestrator-written `node_modules` **base** per (repo, runtime), mounted as
each session's lowerdir; the pnpm store becomes **private per session**,
holding only packages that session adds. A base-hit session imports nothing
(pnpm sees an up-to-date tree) and pays the overlay's 4 KB; a new package is
copied into the upper once; an edit inside a package copies up that one file
(req 11). No shared writable store exists, so H2, H3 and H4 have no
cross-session path. The base is protected by the same verify-and-admit
lifecycle, applied to the tree's files rather than store entries — every file
under `node_modules/.pnpm/<pkg>/` must hash to the package's manifest digest
before admission, the planning#599 shape. This meets req 10 on ext4 with no
reflink. docs/183 excluded pnpm because a store hardlink cannot cross the
overlay; with a private store and copy import for new packages only, that
exclusion no longer applies. The trade — the pnpm store's cross-**repo** dedup
is lost, so sharing becomes per-repo as npm's is — was accepted by the requester
on 2026-09-18 (req 13). **Spiked 2026-09-18, and it works**
([`tree-overlay-spike.sh`](./tree-overlay-spike.sh), [FINDINGS.md](./FINDINGS.md),
PASS=12, ext4): pnpm accepts the lowerdir tree as up to date with an empty
private store ("resolution step is skipped", store untouched, upper **8 KB**);
`pnpm add` works against the private store with copy import and lands only that
package (+229 KB) in the upper; an edit inside a base package copies up only
that file; a second session over the same base sees neither; the base is
byte-unchanged throughout. So on ext4 a base-hit session pays 8 KB instead of a
58.6 MB copy, and no shared writable store exists. Two wiring details it found:
the private store must sit at the same container path the base was built with
(pnpm records `storeDir` in `node_modules/.modules.yaml` and refuses another;
ShipIt already fixes `/workspace/.pnpm-store`, so each session's container maps
that path to its own host directory); and pnpm 12 exits 1 on an "Ignored build
scripts" notice even for a no-op install — pnpm's default and the project's
`approve-builds` concern, independent of the overlay. What remains is the
orchestrator side: verify-and-admit applied to the tree (shared with
planning#599), and publishing a session's verified additions as a new base
generation.

**The lifecycle, designed 2026-09-18 — content-verified admission of the
tree.** Trust is in the content: the base holds only packages the orchestrator
has verified against the registry, the orchestrator alone writes it, and
nothing a session wrote enters it unverified. It reuses docs/183's machinery
end to end — the same scope `(repo, runtime key, dep dir)` and
`overlay-base/<scope-hash>/g<N>` layout, the same pointer, `withScopeLock`,
compare-and-swap, depth cap, flatten, and the janitor's live-mount sweep — and
inserts one step: **verification between the snapshot pull and `publishBase`**.
The snapshot stays the worker's tar of the merged dep dir
(`src/server/session/dep-snapshot.ts`, pulled by `overlay-snapshot.ts`): it is
untrusted, and that no longer matters, because admission is decided by content.
The same insertion point is planning#599's fix for npm/yarn, with an npm
verifier.

*Scope and store.* pnpm's dep dir is `node_modules` (the `agent.dep-dirs`
default), so `prepareOverlaySpecs` and `publishDepDirOverlayBases` treat a pnpm
repo like any other; their pnpm early-returns
(`container-overlay-provisioner.ts:79`, `overlay-publish.ts:102`) go. The store
becomes **private per session**: `preparePnpmStore` and
`pnpmStoreDirForRuntime` (`overlay-session.ts`) resolve to a host directory
under the session's own overlay scope dir instead of the shared per-runtime
one, still mounted at `/workspace/.pnpm-store` so `.modules.yaml`'s `storeDir`
matches (FINDINGS.md), and dropped with the session's volumes. The shared
per-runtime store and its sweep are retired. `package-import-method=copy` and
`verify-store-integrity=true` are set beside `npm_config_store_dir`
(`container-lifecycle.ts`).

*Cold start and migration.* No base → the session cold-installs into its
upper (the docs/183 rule); publish verifies that whole tree and mints `g1`.
Nothing is migrated from today's shared store; it is simply no longer mounted.
`/dep-cache` (docs/075) keeps speeding downloads and serves the verifier as a
self-verifying tarball source.

*What a session's tree contains, and what is verified.* In pnpm's isolated
layout each package is a directory of regular files at
`node_modules/.pnpm/<id>/node_modules/<name>/`; its dependencies are relative
symlinks beside it (`.pnpm/<id>/node_modules/<dep> ->
../../<depid>/node_modules/<dep>`); the top level and `.pnpm/node_modules/`
are symlinks into `.pnpm/`; `.bin/` directories hold pnpm-generated shims; and
pnpm's state is `.modules.yaml`, `.pnpm/lock.yaml` and
`.pnpm-workspace-state-v1.json`. The verifier walks `.pnpm/` and, per package
directory, does for the tree what was established for store entries:

1. **Resolution (req 6).** Map the directory id to `<name>@<version>` (pnpm's
   dep-path encoding, peer suffix stripped) and resolve it at the registry: the
   packument's `dist.integrity` is the authority. The session lockfile's
   `packages.<name>@<version>.resolution.integrity` must equal it; a lockfile
   that points a name at another tarball is the H1 shape and rejects the
   package.
2. **Tarball.** Bytes whose sha512 equals that integrity — from `/dep-cache`
   when present (untrusted, but a hash cannot be forged), else `dist.tarball`.
   A mismatch rejects.
3. **Manifest.** Unpack in a temp dir, as the orchestrator, no scripts: the
   exact file list with sha512 and mode (measured 2026-09-18 to be the manifest
   pnpm itself derives).
4. **Tree.** The package directory must hold exactly those files, each equal by
   sha512, executable bit as in the tarball, no symlinks, nothing extra,
   nothing missing. A package whose install script ran in the session has
   extra or changed files and is rejected here: built output is code the
   session produced and never enters the base; `ignoredBuilds` records such
   packages and every session builds them in its own upper.
5. **Links.** Every symlink pnpm created for the package must be relative and
   resolve inside `node_modules/.pnpm/` to a package that is itself verified.
6. **State files.** `.modules.yaml` is carried with `allowBuilds` reset to `{}`
   and `pendingBuilds` to `[]`, so a session cannot pre-approve a script for
   the next session (`storeDir` must already be the fixed path);
   `.pnpm/lock.yaml` and the workspace-state file are carried as pnpm
   metadata that the next session's install cross-checks against its own
   `pnpm-lock.yaml`. `.bin/` shims are not admitted from a session — either
   pnpm regenerates them over a base that omits them, or the verifier checks
   each against pnpm's shim template (checklist).

Packages byte-identical to the current generation's are already verified —
`copySnapshotToBase`'s link-dedup compares content, not size or mtime
(`overlay-base.ts`: `canHardlink` → `filesContentEqual`) — so a publish
fetches one tarball per package **new to the base**, not per session. Git,
`file:` and `link:` dependencies, and packages from a registry the orchestrator
cannot read, cannot be verified.

*Admission is all-or-nothing per publish.* If every package verifies, the
candidate is the whole snapshot and `publishBase` runs unchanged —
`preUserInstall` is no longer asserted; for pnpm it is the verifier's verdict.
If any package fails, the publish is skipped with a new outcome,
`skipped-unverified`, naming the first failing package and why, surfaced
through `formatOverlayMeasurement` and the log; the session keeps its private
tree and its own install is never failed (req 9). All-or-nothing keeps
`.pnpm/lock.yaml` consistent with the tree by construction; admitting a
verified subset is a later refinement.

*Trigger, ordering, cleanup.* Publish runs where docs/183 runs it: after a
successful declared install (`service-manager-setup.ts`, fire-and-forget,
aborted with the runner). A package the agent adds mid-session with `pnpm add`
stays private until a later session's install, from the updated lockfile,
publishes it; a post-turn publish when the session's upper gains `.pnpm/`
entries is a follow-up. The compare-and-swap, the `depsHash` lineage-only
advance, depth cap and flatten, generation immutability, and the janitor's
live-mount reaping are unchanged. Sessions never write the base: copy-up is the
kernel's contract, measured with controls in FINDINGS.md.

*Resolution metadata.* No shared metadata cache. pnpm keeps resolution
metadata in `XDG_CACHE_HOME/pnpm`, separate from the store, and with a lockfile
it skips resolution (FINDINGS.md: "resolution step is skipped"); `pnpm add`,
and a repo with no lockfile, resolve online. The container's own cache is
private and ephemeral, so no shared resolution surface remains (req 5, req 6).

**A finding outside this issue's scope.** The docs/183 overlay base for
npm/yarn dep dirs has the same positional-trust gap: it is seeded from a tar of
an untrusted session's merged tree, `preUserInstall` is asserted by the
publisher rather than checked, the only content gate is `sourceIsDefaultBranch`,
and the finished base is group-writable to the shared session gid. The
verify-and-admit lifecycle above is the same fix for it. Filed as
**planning#599**, separate from this issue.

### Sequencing

1. Section 1 (H1). It is a working RCE and the cheapest fix.
2. Sections 2 and 4 (pnpm settings). Ship on the storage ShipIt already has.
   **On ext4, section 2 alone regresses disk ~1.8× (req 10) until section 3
   lands**, so on ext4 ship 2 and 3 together, or accept the interim cost
   deliberately.
3. **The H2/H4 fix, redesigned for ext4 (section 5).** The store-in-overlay
   shape is measured as not viable on ext4, and req 12 rules reflink out of
   scope, so the candidate is to share a verified `node_modules` base per
   (repo, runtime) via overlay and keep the pnpm store private per session
   (cross-repo dedup given up, req 13). The spike passed (PASS=12,
   FINDINGS.md) and the admission lifecycle is designed (section 5). Gating
   the build: the `.bin`-shim and state-file spikes in the checklist, and an
   independent review of the lifecycle asking what could be removed.
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
| `src/server/orchestrator/overlay-publish.ts:102`, `:163-191` | The pnpm early-return to drop, and the pull → `publishBase` sequence the tree verifier is inserted into (section 5, lifecycle). |
| `src/server/orchestrator/container-overlay-provisioner.ts:79`, `:157` | The pnpm early-return to drop; `preparePnpmStore`, which becomes the per-session private store. |
| `src/server/orchestrator/overlay-base.ts` | `publishBase` (CAS, depth cap, flatten) reused unchanged; `copySnapshotToBase` link-dedup compares content, which is the "already verified" test. |
| `src/server/orchestrator/overlay-session.ts:316` | `pnpmStoreDirForRuntime` — today the shared per-runtime store; becomes a per-session host dir at the same container path. |
| `src/server/orchestrator/container-lifecycle.ts:143` | `PNPM_STORE_CONTAINER_PATH` — `/workspace/.pnpm-store`; where `package-import-method=copy` and `verify-store-integrity=true` are set. |
| `src/server/session/dep-snapshot.ts`, `src/server/orchestrator/overlay-snapshot.ts` | The merged-tree tar and its pull — unchanged; untrusted, and admission no longer depends on it. |
| `src/server/orchestrator/overlay-volume.ts:196` | The Docker `overlay` volume, now also for pnpm's `node_modules`. |
| `src/server/orchestrator/session-worker-uid.ts:124` | `shareOne` — group write on the shared surfaces (docs/270 req 9). |
| `src/server/orchestrator/session-dir-factory.ts:58` | `createDepCacheDirHelper` — `/dep-cache` keyed per repo; the verifier's self-verifying tarball source. |
| `src/server/session/install-controller.ts` | The install path; also serves `GET /workspace/dep-snapshot`. |

## Related

- `docs/075-shared-dependency-cache` — why `/dep-cache` exists and is per-repo.
- `docs/183-overlay-dep-store` — the overlay dependency base.
- `docs/198-dep-cache-content-keying-and-pnpm-store` — the pnpm store; its
  "integrity-checked on link" caveat is corrected in this PR.
- `docs/270-per-session-worker-uids` — req 9 (sharing must survive).
- `docs/266-orchestrator-git-trust-boundary` — E4, held by req 8.
