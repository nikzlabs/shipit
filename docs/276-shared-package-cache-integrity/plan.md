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
and describe it in shipit-docs as pnpm's check, not ShipIt's. It is a **local**
check on a session's own store: pnpm skips re-hashing an entry `index.db`
already vouches for, so against a shared writable `index.db` it protects
nothing (H2/H4). With the store private per session (section 5) it is
belt-and-braces, never a cross-session guarantee. Pin it; it is not the fix.

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

**The lifecycle, revised through two review rounds (2026-09-18) — the
orchestrator builds the base from verified inputs; the session's tree is never
read.** The first draft audited the session's snapshot; the first review showed
that audit would have to re-implement pnpm's layout and that a base hit never
runs pnpm again to catch what it missed (a base hit **pre-stamps the install
marker**, `overlay-session.ts:preStampInstallMarker`, and the worker **skips the
install**, `install-controller.ts:96`, measured in FINDINGS.md). The second
review then broke the "rebuild, then pre-stamp" shape on two counts, both
verified: pre-stamping over an **unbuilt** base means a repo that approves a
native build gets a base with no binary and a matching-lockfile session skips
its own install and never builds it; and a **no-lockfile** session does not
resolve online — pnpm reconstructs the graph from the base's carried
`.pnpm/lock.yaml` (measured: an offline install knew the transitive versions
without resolving), so it inherits the publisher's version selection. The
resolution: the base is a **verified warm tree**, and **every session still runs
its own install over it** (no pnpm pre-stamp). That install is a near-no-op for
a matching lockfile (8 KB, FINDINGS.md) and it is where builds run and the
session's own graph reconciles, so nothing carried decides for the session.

*Inputs and verification (req 1, 3, 6).* The base is rebuilt from the repo's
**committed manifests plus lockfile** at the default-branch commit — package
manager needs the `package.json`(s), not the lockfile alone
(`pnpm install --frozen-lockfile` checks the lockfile against the manifests;
with no manifest pnpm uses an empty one and a populated importer will not
match). All build inputs are captured from **one immutable staged snapshot** of
that commit: the manifests, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the
applicable `.npmrc`, and `package.json#pnpm` (`overrides`,
`patchedDependencies`, `onlyBuiltDependencies`). For every registry package the
orchestrator resolves `<name>@<version>` against **its own** configured registry
(never a URL taken from the lockfile) and requires that packument's
`dist.integrity` to equal the lockfile's `resolution.integrity`; a mismatch is
the H1 shape and fails. Inputs that cannot be verified this way **reject the
whole candidate** (no base): `git`, `file:`, `link:`, `workspace:` entries;
`patchedDependencies` (registry integrity authenticates the original tarball,
not the patched output); and a pnpmfile (`.pnpmfile.cjs`) — a hook is executable
input, so a base is built only when there is none. This is a larger reject set
than the first draft named, and it is the honest boundary of what a
content-verified base can cover.

*Build — canonical by construction.* The orchestrator runs pnpm in a
**dedicated builder container** with a **pinned pnpm** (12.4.2 baked, not merely
corepack-enabled — availability is not implied by the worker image), no
workspace and no network, from an orchestrator-private store built **inside the
sandbox** by unpacking the staged, integrity-checked tarballs (never the
session's store index or side-effects cache), with the staged manifests +
config, `pnpm install --offline --frozen-lockfile --ignore-scripts`.
`--ignore-scripts` is required, not incidental: pnpm 12 defaults
`strictDepBuilds` true, so an *unapproved* build **exits non-zero** (measured,
FINDINGS.md), which would fail the rebuild on any script-bearing repo; ignoring
scripts also covers the root `prepare`/`preinstall` a bare "no `allowBuilds`"
would still run. pnpm then generates the tree, every symlink, every `.bin` shim
and the state files from verified inputs, so the graph, directory ids (pnpm's
own encoding), links, shims and state need no second implementation and carry
nothing from the session. Packages with build scripts land **unbuilt**; each
session builds the ones it approves in its own upper (`pnpm-workspace.yaml`
`allowBuilds`, keyed by package id — FINDINGS.md cells C2/C3). `storeDir` is the
fixed container path, so a session's private store at `/workspace/.pnpm-store`
matches (FINDINGS.md). The finished tree is materialized as `g<N+1>` through
`copySnapshotToBase` (whose hardlink dedup against `g<N>` is a **disk**
optimization only — it is not a verification step) and published through
`publishBase`. **The session-snapshot pull is dropped for pnpm**: the
orchestrator never reads the session's `node_modules`, so `overlay-snapshot.ts`'s
host `tar -x` is off this path entirely. This is the "trusted install" docs/183
only asserted (`preUserInstall: true`), done for real; the session's own install
still runs (req 9).

*Scope and store.* pnpm's dep dir is `node_modules`; the pnpm early-returns
(`container-overlay-provisioner.ts:79`, `overlay-publish.ts:102`) go. The
store becomes **private per session**: `preparePnpmStore` /
`pnpmStoreDirForRuntime` resolve to a host directory under the session's own
overlay scope dir, still mounted at `/workspace/.pnpm-store`, dropped with the
session's volumes; the shared per-runtime store and its sweep are retired.
`package-import-method=copy` is set beside `npm_config_store_dir`
(`container-lifecycle.ts`). Nothing is migrated from today's store.

*Provenance — a verified namespace.* The base pointer records `admission:
{verifier, lockfileHash}`, and verified generations live in their **own scope
namespace** (the scope hash salted with the verifier identity) that only the
verifying publisher writes; `prepareOverlaySpecs` mounts a pnpm session only
from it. Package-manager detection reads the writable checkout (`isPnpmRepo`:
`package.json` `packageManager`, else the install commands), so it is a
routing hint, never the boundary: the npm/yarn publisher, unverified until
planning#599 lands, cannot write into the verified namespace, and a checkout
that flips its package manager gets no verified base rather than another
publisher's. The same namespace serves npm/yarn once planning#599 gives them a
verifying publisher.

*Per-session install — no pnpm pre-stamp (req 9, 10, 11).* Every pnpm session
runs its own `pnpm install` over the base; pnpm pre-stamping is **cut for pnpm**
(it stays for npm/yarn). This is the fix for both second-review blockers: the
session's own install runs its approved builds into its upper (so an unbuilt
base is completed per session, not skipped), and it reconciles against the
session's own lockfile, so no session inherits another's resolution or version
selection. A matching-lockfile install is a near-no-op (8 KB, FINDINGS.md) plus
the cost of any builds; a changed or absent lockfile reinstalls the delta into
the upper. The base saves the download and store-import cost, which is its
point; it never decides the session's graph. (A **no-lockfile** repo is the one
case where the base could still bias resolution through its carried
`.pnpm/lock.yaml`; such a repo gets a base only from the orchestrator's own
resolution of its manifests, identical for every session, or no base — a
checklist item, not a session-influenced path.)

*Admission is all-or-nothing per publish — a known gap, not a claim.* One
unverifiable package or a lockfile mismatch skips the whole publish
(`skipped-unverified`, first failing package named, surfaced through
`formatOverlayMeasurement`); the session keeps its private tree and its own
install is never failed (req 9). A repo with a git, `file:` or
private-registry dependency therefore gets no base and pays a cold install per
session, which does **not** meet req 2 / req 10 for it; a partial base is a
follow-up.

*Ordering and cleanup — what the reused machinery does and does not give.*
Publish runs after a successful declared install (`service-manager-setup.ts`).
The compare-and-swap and `sourceIsDefaultBranch` order publications and
authenticate nothing; `depsHash` lineage-advance is reuse policy; the depth-cap
"flatten" only resets a counter (`shouldFlattenNext` has no production caller)
and every generation is a whole tree, so nothing depends on it — dropped from
this lifecycle. Three concurrency gaps to close in implementation, all verified:
`publishBase` takes no abort signal, so the whole rebuild-and-publish needs one
bound to the runner (cancelling only the rebuild leaves materialization
running). The janitor race is **not** fixed by "write the pointer first" — a
consumer selecting a pointer whose generation is not yet materialized hits
`prepareOverlayDirs` creating the missing lower dir, and the publisher then
overwrites a mounting directory; so publication and reclamation need coordinated
exclusion (a claim taken **before** `sweepOrphanedOverlayBases` /
`sweepStaleBaseGenerations` sample, since a claim acquired after their snapshot
does not protect it — `overlay-base-claims.ts`) with the **pointer swap last**.
And the salted verified namespace must reach `liveOverlayScopeHashes`
(`overlay-session.ts`), which computes unsalted scopes today, or an unmounted
verified scope with a current pointer is swept wholesale.

*What this still depends on.* `/dep-cache` stays shared-writable and
`npm_config_cache=/dep-cache/npm` is forwarded to every session
(`container-lifecycle.ts:367`), so H1 reaches a pnpm repo whose agent runs
npm: section 1 lands first. The base is group-writable to the session gid by
design (`shareOne`): overlay copy-up preserves the lower's ownership and modes,
and a session must be able to edit a copied-up file (req 11). So the base's
safety is **mount confinement**, and the Docker-proxy path check
(`docker-proxy-auth.ts:66`, called from `docker-proxy-sanitize.ts:112`) is
TOCTOU — it `realpath`-checks the requested bind but Docker mounts the original
string, so a Docker-enabled hostile session can swap a symlink between check and
mount to bind the base directory read-write. Filed as **planning#601**; a
dependency inherited from docs/183, to be closed on its own.
`verify-store-integrity=true` (section 4) is a local check on the session's
private store, not a cross-session guarantee.

*Resolution metadata.* No shared metadata cache: with a lockfile pnpm skips
resolution (FINDINGS.md). A **no-lockfile** session does not simply resolve
online — pnpm reconstructs the graph from a carried `.pnpm/lock.yaml` if one is
present (measured), which is why such a repo's base comes from the
orchestrator's own resolution or not at all (above). The container's own cache
is private and ephemeral (req 5, req 6).

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
| `src/server/orchestrator/overlay-base.ts` | `publishBase` reused for ordering (CAS authenticates nothing); `copySnapshotToBase` hardlink-dedup is a **disk** optimization, not a verification step. |
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
