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
| **H1** — cached npm *resolution data* (packument) rewritten to point at attacker content | `/dep-cache` `_cacache/index-v5` | **Closed** by section 1. Was install-time RCE: rewrite `dist.integrity` to attacker content placed at its own hash, set `hasInstallScript: true`, and `npm install` runs the attacker's `postinstall` — with the network available, because npm serves a fresh local cache entry without asking the registry. Both halves are asserted in CI by `integration_tests/npm-cache-poisoning.test.ts`. |
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

**Shipped.** `npm_config_cache` is `/session-state/npm-cache` — inside the
session-state mount, so it needs no new mount and no other session can name it —
and the worker links its `_cacache/content-v2` to `/dep-cache/npm/_cacache/content-v2`
before it opens its listener (`shared/npm-cache.ts`, called from `session-worker.ts`).
The same call retires the shared `index-v5`: after the split nothing reads it, and it
was the whole exploitable surface. It runs in the worker rather than the orchestrator
because the shared tree is group-owned by the session gid, and orchestrator root has
no `DAC_OVERRIDE` to fall back on. yarn and pnpm keep `/dep-cache` unchanged.

**The split is a symlink, not a mount, and that is the load-bearing choice.**
`npm cache clean --force` is `fs.rm(<cache>/_cacache, {recursive, force})`
(`npm/lib/commands/cache.js`): through a bind mount that deletes the repo's shared
content store and then fails `EBUSY`, while on a symlink it unlinks the link and
leaves the store intact — measured. A mount is also the unsafe failure direction:
a mount that does not apply leaves npm reading the shared index, whereas an
unlinked private root is merely private.

**Sharing `content-v2` does not reopen the hole — npm has no verification-skip
marker, the exact thing pnpm's `index.db` provides (H2/H4).** `cacache/lib/content/read.js`
re-hashes on *every* read (`ssri.checkData` under 64 MB, an `integrityStream` above
it); `hasContent` only stats, and nothing records a `checkedAt`. Measured: a blob
poisoned in place with its **mtime preserved** — the poison pnpm installs — fails
closed offline and is re-downloaded and repaired when the network is up (req 3).

**Measured** (`verify-h1.mjs`, 8 deps / 7 480 files / 53.5 MB `node_modules` /
22.7 MB shared cache, npm 11.12.1, ext4, best-of-5, PASS=17). Two full runs, both
reported, because the spread between them is what the result rests on:

| `npm install --prefer-offline` (ShipIt's line, `install-runtime.ts:29`) | today (shared index) | design (private index) |
|---|---|---|
| warm, lockfile in sync | 1 955 / 1 839 ms | 1 896 / 1 967 ms (**0.97× / 1.07×**) |
| warm, lockfile in sync, private index cold | — | 1 935 / 1 897 ms (**0.99× / 1.03×**) |
| **no lockfile — the case that does use the index** | 3 400 / 3 403 ms | 3 566 / 3 375 ms (**1.05× / 0.99×**) |

Every cell lands inside the ±5 % that the same cell moves between runs on this
host, in both directions, so **the honest reading is no measurable cost, not a
measured speed-up**. req 7 is met. Per-session disk is **0 B** with an in-sync
lockfile and **0.9 MB** when resolution runs; a newly downloaded package's bytes
still land in the shared store (+4 blobs), so req 10 and req 2 hold.

The reason the cost is this small is that **an in-sync lockfile install writes no
resolution index at all**: the lockfile carries the resolution and tarballs are
found in `content-v2` by digest, so the private half stays empty. Only resolution
— `npm install <new-package>`, an out-of-sync or absent lockfile — touches it,
which is exactly what H1 attacked. A fresh session pays packument fetches (JSON),
never tarballs.

**What the split costs, stated plainly.** Three behaviours change, all documented
in `src/server/shipit-docs/environment.md`:

- **Resolution is no longer shared between sessions, only content.** So
  `npm install --offline <pkg>` for a package *this* session has never resolved now
  fails `ENOTCACHED`, where before it could reuse another session's cached
  packument. Measured. This is a genuine reduction in what is shared, and it is
  the point: shared resolution data *is* H1. It does not breach req 2, whose
  clause is that no install may fail *because another session wrote the cache
  first* — and ShipIt's own install line is `--prefer-offline`
  (`install-runtime.ts:29`), which falls back to the registry, so no ShipIt-driven
  install is affected. An agent that types `--offline` by hand is.
- **`npm cache verify` and `npm doctor` fail** with `Cannot read properties of null
  (reading 'toString')`. `cacache/lib/verify.js:132` globs the content directory
  with `follow: false`, so the symlink itself comes back as a match and
  `ssri.fromHex` on those path segments returns null. `cache verify` aborts before
  its first delete — the shared store is byte-identical afterwards, asserted per
  blob. `doctor` likewise loses and rewrites nothing, though its own registry probe
  *adds* a blob. A *real directory* there would not crash — but then the
  mark-and-sweep would reclaim every blob this session's private index does not
  reference, i.e. one session's `cache verify` would strip the repo's shared store.
  Failing loudly and changing nothing is the better of the two, and npm's own
  `cache clean` text says what replaces it: the cache treats a bad entry as a miss
  and re-downloads.
- **`npm cache clean --force` removes the link** with the rest of the cache; the
  shared store is byte-identical afterwards. That session installs privately until
  the container next starts, when the worker discards the unshared content it
  accumulated and relinks.

Not in scope, and newly noted: the **plugin install container** still gets
`npm_config_cache=/dep-cache/npm` over a cache keyed per plugin *source*
(`plugin-install.ts:385`, `plugin-dep-store.ts:382`). No session can write it, so
this is not a session-to-session hole; but a plugin's own install scripts can
poison the resolution data for the next install of *that plugin*, which is H1 at
plugin scope. Filed as **planning#603**.

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

The filesystem is the operator's: ShipIt installs on laptops and in Docker
Desktop VMs, most of which are ext4, and req 12 makes ext4 the target. Nothing
in the design selects behaviour from a reflink probe, so there is none. A
loopback XFS image is not a ShipIt feature: it needs `CAP_SYS_ADMIN`, which the
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

### 4. H2 — `verify-store-integrity` is not part of the fix

It is a **local** check on a session's own store: pnpm skips re-hashing an
entry `index.db` already vouches for, so against a shared writable `index.db`
it protects nothing (H2/H4). With the store private per session (section 5)
there is no cross-session writer for it to guard against, so it stays at pnpm's
default and shipit-docs must not present it as cross-session protection. The
boundary is the private store plus the verified base.

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

**The lifecycle, revised through four review rounds (2026-09-18 to 2026-09-20)
— the orchestrator builds the base from verified inputs; the session's tree is
never read.** The fourth round asked the opposite question of the first three
(for each element, would anyone notice if it were removed?) and cut or narrowed
what is noted below. The first draft audited the session's snapshot; the first review showed
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
its own install over it** (no pnpm pre-stamp). That install is where builds run
and the session's own graph reconciles, so nothing carried decides for the
session. It is a near-no-op for a matching *scriptless* lockfile (8 KB measured);
a build-bearing repo adds its build-output disk and time to each session's upper,
which the spikes did not measure — an open measurement, not a settled 8 KB.

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
the H1 shape and fails. **Eligibility is one decision over that staged input
set**, taken before any fetch; an ineligible repo gets no base and a plain
private install. Not eligible in the first cut: `git` entries (the builder has
no source handling); `file:`, `link:`, `workspace:` entries and
`patchedDependencies` — verifiable in principle, since the linked content and
the patch bytes are in the immutable snapshot, but their reconciliation under
the frozen builder is unmeasured; `.pnpmfile.mjs` and `configDependencies`,
whose suppression by `--ignore-pnpmfile` is unmeasured (only `.cjs` was
measured); a scoped registry with no orchestrator-authorized scope→registry
mapping; and an output layout that escapes one self-contained `node_modules`
(`modulesDir`, `virtualStoreDir`, a non-isolated `nodeLinker`). Admitted: an
`npm:` alias (the resolved target's digest is what is verified); a `.pnpmfile.cjs`
(its hook is suppressed, measured — if the frozen install then fails to
reconcile, the build yields no base, decided by the build rather than by a
presence rule); a relocated global store (overridden to the fixed builder
path); `optionalDependencies`, verified like the rest; `bundledDependencies`,
trusted as part of their authenticated outer tarball; a deprecated-but-present
version; and `overrides`/`catalog:`/peer selections, which are graph choices
captured in the config, not unverifiable content. Genuinely unverifiable under
this contract: bytes with no independent expected content, mutable
out-of-snapshot paths, an unauthorized source, and hook output.

*Build — canonical by construction.* The orchestrator runs pnpm in a
**dedicated builder container** with a **pinned pnpm** (12.4.2 baked, not merely
corepack-enabled — availability is not implied by the worker image), no
workspace and no network, from an orchestrator-private store built **inside the
sandbox** by unpacking the staged, integrity-checked tarballs (never the
session's store index or side-effects cache), with the staged manifests +
config, `pnpm install --offline --frozen-lockfile --ignore-scripts
--ignore-pnpmfile`. Both flags are required. `--ignore-scripts`: pnpm 12 defaults
`strictDepBuilds` true, so an *unapproved* build **exits non-zero** (measured),
which would fail the rebuild on any script-bearing repo, and it covers the root
`prepare`/`preinstall`. `--ignore-pnpmfile`: a pnpm **hook is not a script** and
`--ignore-scripts` does **not** stop it — measured, a `.pnpmfile.cjs` hook ran
under `--ignore-scripts` and only `--ignore-pnpmfile` suppressed it (FINDINGS.md).
A hook (or a `configDependencies` plugin) that runs in the builder can rewrite
the "canonical" output the orchestrator then publishes, so the builder runs
with an **explicit, known configuration**: no inherited global
`.npmrc`/`pnpm-workspace.yaml` settings, no credentials, and `packageManager`
version-switching disabled (baking pnpm is not enough — a repo pin can request
another version). pnpm then
generates the tree, every symlink, every `.bin` shim
and the state files from verified inputs, so the graph, directory ids (pnpm's
own encoding), links, shims and state need no second implementation and carry
nothing from the session. Packages with build scripts land **unbuilt**; each
session builds the ones it approves in its own upper (`pnpm-workspace.yaml`
`allowBuilds`, keyed by package id — FINDINGS.md cells C2/C3). `storeDir` is the
fixed container path, so a session's private store at `/workspace/.pnpm-store`
matches (FINDINGS.md). The finished tree is materialized as `g<N+1>` through
`copySnapshotToBase` (whose hardlink dedup against `g<N>` is a **disk**
optimization only — it is not a verification step) and published through
`publishBase` — its per-scope serialization (`withScopeLock`,
`overlay-base.ts:101`), immutable generations and pointer-last `finalize`
(`:351`) are reused unchanged, not reimplemented. **The session-snapshot pull is dropped for pnpm**: the
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
(`container-lifecycle.ts`) because a hardlink cannot cross the overlay boundary
— an import-compatibility setting; with the store private it is no longer a
cross-session security boundary. Nothing is migrated from today's store.

*Provenance — a verified namespace.* Verified generations live in their **own
scope namespace**: one fixed discriminator (`pnpm-verified-v1`) added to
`overlayScopeHash` (`overlay-volume.ts:23`, which today hashes repo, runtime
and dep dir and carries no publisher identity). Only the verifying publisher
writes there, and `prepareOverlaySpecs` mounts a pnpm session only from it,
never falling back to an unverified base. The namespace is load-bearing and
stays: a per-session install does not authenticate an arbitrary existing tree
(a no-op leaves a poisoned base's missing shims unrepaired), so provenance is
needed for correctness as well as security. The pointer carries **no**
`admission` fields — the discriminator and the source commit already name the
verifier and the committed inputs. Package-manager detection reads the writable
checkout (`isPnpmRepo`, `overlay-session.ts:343`: `package.json`
`packageManager`, else the install commands, else the presence of
`pnpm-lock.yaml`), so it is a routing hint, never the boundary: the npm/yarn
publisher, unverified until planning#599 lands, cannot write into the verified
namespace, and a checkout that flips its package manager gets no verified base
rather than another publisher's.

*Per-session install — no pnpm pre-stamp (req 9, 10, 11).* Every pnpm session
runs its own `pnpm install` over the base; pnpm pre-stamping is **cut for pnpm**
(it stays for npm/yarn). The session's install runs its approved builds into its
upper (an unbuilt base is completed per session) and reconciles against the
session's own lockfile. What req 1 asks of the base is narrow and exact:
**mounting the base must not introduce a graph choice absent from the consuming
session's own inputs.** Authentic `overrides`/`catalog:`/peer selections in a
session's *own* committed lockfile are that session's choice, not a cache
attack; the danger is only a session that adopts the *base's* graph. That is the
**no-lockfile consumer** — enforced at the consumer, not the base: a session
whose checkout has no `pnpm-lock.yaml` at mount time (committed or not — a
lockfile the session's own pnpm wrote is its own resolution) gets **no base
lowerdir** and installs plain, because pnpm would otherwise synthesize the
wanted graph from the base's carried `.pnpm/lock.yaml` (measured). This is a
one-shot gate where `prepareOverlaySpecs` selects specs
(`container-overlay-provisioner.ts:65`); it does not watch the mount. A session
that deletes its lockfile afterwards inherits the default-branch commit's graph,
which the orchestrator built from committed inputs — the repo's own trust
boundary, not another session's choice, so no live watcher is needed. Two limits
stated plainly: this is only as strong as who may commit to the default branch
(the same trust boundary docs/183 already draws, and rebuilding from immutable
committed blobs is stronger than its HEAD compare); and cutting the overlay
pre-stamp does not by itself guarantee the install runs, because the **worker's
own install marker** skips on `sourceCommit` match alone
(`install-marker.ts:52`, `commit || depsHash`), so a same-commit approval change
is skipped. For pnpm the marker must require the content hash, and that hash
must always include `pnpm-workspace.yaml`: the default input list does
(`deps-hash.ts:21`) but a custom `installInputs` replaces it wholesale (`:89`),
so the approval file can be absent from the hash today.

*Ineligible and unverified.* An ineligible input set yields no base — the repo
takes an ordinary private install. A candidate that is eligible but fails
verification (a tarball whose hash does not match, a lockfile edge with no
registry record) skips the publish all-or-nothing, reported as a publish outcome
naming the first failing package; the session keeps its private tree and its
own install is never failed (req 9). Either way such a repo gets **no base and a
cold install per session**, which does **not** meet req 2 / req 10 / req 13 for
it. Sharing for those repos is **required work, not an optional follow-up** —
reuse the unbuilt-base / private-build shape above rather than a second build
path.

*Ordering and cleanup — what the reused machinery does and does not give.*
Publish runs after a successful declared install (`service-manager-setup.ts`).
The compare-and-swap and `sourceIsDefaultBranch` order publications and
authenticate nothing; `depsHash` lineage-advance is reuse policy; the depth-cap
"flatten" only resets a counter (`shouldFlattenNext` has no production caller)
and every generation is a whole tree, so nothing depends on it — dropped from
this lifecycle. **No runner-bound cancellation**: the build's inputs are staged
and its registry is the orchestrator's, so a build that outlives its triggering
session simply finishes and publishes (the abort signal
`bootstrap-managers.ts:522` binds to runner disposal guards the session-snapshot
pull, which pnpm no longer uses). Concurrency and reclamation, verified at the
source: pointer-last is necessary but **not sufficient** — the sweeps sample
claims and the pointer *separately* and await before deleting
(`steady-state-reclaim.ts:sweepOrphaned…`, `sweepStale…`), and
`claimOverlayBaseGeneration` (`overlay-base-claims.ts`) is a 10-minute expiry,
not an operation-lifetime lease. Reading "current" claims just before an
asynchronous delete is no better, so the rule is **one per-scope lock**:
claim-taking, publish and sweep all serialize through `withScopeLock`
(`overlay-base.ts:101`, today publisher-only), and a claim lives for the whole
select→mount, so a reader that claimed `g1` is safe after a publish advances the
pointer to `g2`. A **missing published generation selects generation 0** — the
existing empty cold base (`overlay-session.ts:119`) — and the session installs;
it is never recreated by `mkdirSync` of the pointer's lowerdir
(`container-lifecycle.ts:459`). And liveness must be
computed by the **same scope function** creation uses:
`resolveOverlayScope` keys on `overlayRuntimeKey + overlayPinSegment(workspaceDir)`
(`overlay-session.ts:61`) while `liveOverlayScopeHashes` uses `overlayRuntimeKey`
alone (`:189`) — a pre-existing mismatch the verified namespace must not inherit, or a
stopped session's pinned scope is swept despite a current pointer.

*What this still depends on.* `/dep-cache` stays shared-writable, but the npm
resolution index no longer lives there (section 1, shipped), so a pnpm repo whose
agent also runs npm is no longer exposed to H1. The base is group-writable to the session gid by
design (`shareOne`): overlay copy-up preserves the lower's ownership and modes,
and a session must be able to edit a copied-up file (req 11). So the base's
safety is **mount confinement**, and the Docker-proxy path check
(`docker-proxy-auth.ts:66`, called from `docker-proxy-sanitize.ts:112`) is
TOCTOU — it `realpath`-checks the requested bind but Docker mounts the original
string, so a Docker-enabled hostile session can swap a symlink between check and
mount to bind the base directory read-write. Filed as **planning#601**; a
dependency inherited from docs/183, to be closed on its own.
`verify-store-integrity` (section 4) is a local check on a store that is now
private; it is not part of this fix.

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

1. Section 1 (H1) — **shipped**. It was a working RCE and the cheapest fix.
2. Sections 2 and 4 (pnpm settings). Ship on the storage ShipIt already has.
   **On ext4, section 2 alone regresses disk ~1.8× (req 10) until section 3
   lands**, so on ext4 ship 2 and 3 together, or accept the interim cost
   deliberately.
3. **The H2/H4 fix, redesigned for ext4 (section 5).** The store-in-overlay
   shape is measured as not viable on ext4, and req 12 rules reflink out of
   scope, so the candidate is to share a verified `node_modules` base per
   (repo, runtime) via overlay and keep the pnpm store private per session
   (cross-repo dedup given up, req 13). The spike passed (PASS=12,
   FINDINGS.md) and the admission lifecycle is designed (section 5), through
   three adversarial reviews and one subtractive one.
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
  `index.db`, which the attacker can write (H2/H4). Once the store is private
  it is a local check with no part in the fix.
- **A gate over the existing session-snapshot publisher instead of a rebuild.**
  Considered in the fourth review. That path reads worker HEAD, compares it with
  the default branch, pulls the mutable tree and asserts `preUserInstall`
  (`overlay-publish.ts:123`, `:149`, `:163`, `:183`); none of it authenticates
  the tree, and auditing package files misses links, shims, state and
  omissions. A complete audit would re-implement pnpm's output; the builder is
  smaller.

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
| `src/server/orchestrator/overlay-base.ts` | `publishBase` reused for ordering (CAS authenticates nothing); `withScopeLock` (`:101`) becomes the one per-scope lock for claim, publish and sweep; `copySnapshotToBase` hardlink-dedup is a **disk** optimization, not a verification step. |
| `src/server/orchestrator/overlay-volume.ts:23` | `overlayScopeHash` — repo + runtime + dep dir, no publisher identity; the verified namespace is one fixed discriminator added here. |
| `src/server/shared/deps-hash.ts:21`, `:89` | pnpm's default hash inputs include `pnpm-workspace.yaml`; a custom `installInputs` replaces the list, so the pnpm marker must add it back. |
| `src/server/orchestrator/overlay-session.ts:316` | `pnpmStoreDirForRuntime` — today the shared per-runtime store; becomes a per-session host dir at the same container path. |
| `src/server/orchestrator/container-lifecycle.ts:143` | `PNPM_STORE_CONTAINER_PATH` — `/workspace/.pnpm-store`; where `package-import-method=copy` is set. |
| `src/server/session/dep-snapshot.ts`, `src/server/orchestrator/overlay-snapshot.ts` | The merged-tree tar and its pull — unchanged; untrusted, and admission no longer depends on it. |
| `src/server/orchestrator/overlay-volume.ts:196` | The Docker `overlay` volume, now also for pnpm's `node_modules`. |
| `src/server/orchestrator/session-worker-uid.ts:124` | `shareOne` — group write on the shared surfaces (docs/270 req 9). |
| `src/server/orchestrator/session-dir-factory.ts:58` | `createDepCacheDirHelper` — `/dep-cache` keyed per repo; the verifier's self-verifying tarball source. |
| `src/server/shared/npm-cache.ts` | Section 1's whole mechanism: the per-session cache path, the `content-v2` link, and the retirement of the shared index. |
| `src/server/orchestrator/container-lifecycle.ts` | `buildEnv` points `npm_config_cache` at the session's own cache; `createContainer` retires the shared index. |
| `src/server/session/session-worker.ts` | Calls `linkSessionNpmCache` before the listener opens, so no install, terminal or service can reach npm through an unlinked cache. |
| `src/server/orchestrator/integration_tests/npm-cache-poisoning.test.ts` | The H1 attack and its control, against real npm and a local registry. |
| `src/server/session/install-controller.ts` | The install path; also serves `GET /workspace/dep-snapshot`. |

## Related

- `docs/075-shared-dependency-cache` — why `/dep-cache` exists and is per-repo.
- `docs/183-overlay-dep-store` — the overlay dependency base.
- `docs/198-dep-cache-content-keying-and-pnpm-store` — the pnpm store; its
  "integrity-checked on link" caveat is corrected in this PR.
- `docs/270-per-session-worker-uids` — req 9 (sharing must survive).
- `docs/266-orchestrator-git-trust-boundary` — E4, held by req 8.
