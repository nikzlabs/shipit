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
| **H2** — poisoned pnpm store *content* (bytes changed in place) installed by a normal `pnpm install` | `/workspace/.pnpm-store` | **Conditional on mtime, subsumed by H4, and reachable only on pnpm ≤ 10.** pnpm skips re-hashing a store file whose mtime matches what `index.db` recorded (second granularity). Measured 2026-09-17: an in-place poison that **preserves mtime** (`touch -r`, trivial) installs offline with `verify-store-integrity=true`; the same poison that **bumps mtime ≥1s** fails closed. So the check is a size-and-mtime fast path, not a content re-hash, and `verify-store-integrity=true` is necessary but not sufficient. |
| **H3** — store file mutated in place under a live `node_modules` | `/workspace/.pnpm-store` | **Reachable only on pnpm ≤ 10, and unreachable by verification.** Store files are hardlinked into `node_modules` (`links=2`), so a store write changes already-installed files with no install event. Req 4 exists for this. Closed there by section 2's copy import. |
| **H4** — pnpm store *manifest* (`v11/index.db`) rewritten to point a package's file at attacker content placed at its own valid hash | `/workspace/.pnpm-store` | **Reachable only on pnpm ≤ 10, and `verify-store-integrity` does not close it.** The per-package manifest is trusted layout data, the pnpm analogue of npm's `index-v5`. Verification checks each file against the digest the manifest names, not the manifest against the package's integrity. Measured 2026-09-17: offline, `verify-store-integrity=true`, a rewritten manifest installed attacker bytes (rc=0), and a second repo sharing the store got them too. pnpm's own security policy confirms it: store integrity does not defend an attacker who rewrites both files and their recorded hashes. |

**H2, H3 and H4 are open only for pnpm ≤ 10 repos**, because only those ever shared a store.
Verified 2026-09-20 on pnpm 12.5.1 with `pnpm store path`, which reports the resolved value:
`PNPM_CONFIG_STORE_DIR` relocates the store; **`npm_config_store_dir`** (the shared-store wiring)
and **`PNPM_STORE_DIR`** (the `/dep-cache/pnpm` line docs/075 and docs/148 describe) both move
nothing — neither is a pnpm config env for that version. So a
pnpm ≥ 11 session ran a **private in-container store**, shared nothing, re-downloaded on every
cold container, and left the `/workspace/.pnpm-store` mount unused. Two consequences for section 5:
for those repos it **adds** sharing to a private store rather than fixing a shared one — req 2's
baseline for them is "no sharing" and req 10's is "a private store with hardlinks" — and there is
no shared store to migrate off. `PNPM_STORE_DIR` is not merely inert but latently wrong: its target
`/dep-cache/pnpm` is writable by every session of the repo, so a release that started honouring it
would arm H2/H4 at repo scope. It is removed rather than left set.

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
- ShipIt set neither `package-import-method` nor `verify-store-integrity`
  anywhere in `src/`; both ran on pnpm defaults. Section 2 shipped the import
  method on 2026-09-20; `verify-store-integrity` is still the default (section 4).

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

**The same split now covers the plugin install container (planning#603).** Its
download cache is keyed per plugin *source* (`plugin-dep-store.ts`), so no session
can write it and this was never a session-to-session hole; but a plugin's own
install scripts run in that container with write access to the cache, so they could
poison the resolution data for the next install of *that plugin* — H1 at plugin
scope. `npm_config_cache` is now `/plugin-npm-cache`, a directory of this
generation's work dir mounted into the install container, with its `content-v2`
symlinked to the shared store and the shared `index-v5` removed
(`plugin-install.ts`, `pluginInstallCommand`). Both halves name the shared paths
through `shared/npm-cache.ts`, so the two splits cannot drift.

**What bounds the forgery is that the private cache is reset, not merely that it is
not the shared one.** The work dir is keyed by session, plugin and generation, so a
different install job already lands somewhere else; `resetPluginNpmCache` covers the
one path that returns to the same directory, a forced re-install of the same
generation. It runs beside `prepareLayer`, which already discards the previous
attempt's writable layer.

**A tmpfs was tried first and is wrong**, which is worth recording because it looks
like the tidier answer — nothing to reset, private by construction. npm puts far
more than the index under its cache root: `_npx` keeps whole extracted trees there,
and a git dependency is cloned and *prepared* there. Measured: one `npx cowsay`
leaves **2.7 MB** under the cache root, against an index of a few KB. RAM-backing
that caps a dependency tree at the tmpfs size and charges it to the container's
2 GiB limit — and Docker mounts a tmpfs `noexec` unless told otherwise (which is why
every other tmpfs in this repo spells out `exec`, guarded by
`container-hardening.test.ts`), so anything `npx` installed would fail to run.

**Measured** against real npm 11.12.1 with both halves on ext4, the layout the
container actually gets. Content lands in the shared store at mode **0664**, which
is what the shared-gid model needs, and the shared `index-v5` is never re-created.
A **reset** private cache — exactly what every install job starts from — then
installs `npm ci --offline` **entirely from the shared store: 0 new blobs**. That is
the number that matters here, because the private index is cold on *every* plugin
install job and the lockfile install shape plugins use does not need it. It is a
single-package measurement: it establishes that no download is needed, not a
throughput claim.

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

**Shipped 2026-09-20, before the overlay, with the ext4 disk cost accepted.** The
requester chose to land H3 on its own rather than hold it for section 5, so until
that lands a pnpm ≤ 10 session pays roughly 1.8× the disk of the hardlink import for
the same tree on ext4 (the row above). The req 10 gate is therefore **not** met by
this change and stays open in the checklist; it closes when the tree overlay makes
the copy free again. Paying that cost where it buys nothing is what scopes the
setting to pnpm ≤ 10, below.

**Scoped to pnpm ≤ 10, deliberately — pnpm moved its config env prefix at 11**
(measured 2026-09-20 with `pnpm store path`, which reports the resolved value): pnpm
10.28.2 reads `npm_config_*` and ignores `PNPM_CONFIG_*`; 11.22.0 and 12.5.1 do the
reverse. The first cut set both spellings; on review 2026-09-20 the requester cut the pnpm ≥ 11
one, because pnpm ≥ 11 had a private in-container store where a copy would buy no cross-session
isolation and still cost ~1.8× the disk on ext4. **Section 5 restores it on 2026-09-21, and the
disk half of that reasoning turns out not to apply in a container at all** — see below. The pre-11
spelling costs one `npm warn Unknown env config "package-import-method"` per npm command in a pnpm
session, next to the one `npm_config_store_dir` already emits.

**Correction, measured 2026-09-21 in a session container: in the standard layout there is no
hardlink baseline to regress from, so `copy` is not a disk trade there** (FINDINGS.md). `link(2)`
compares **mounts**, not superblocks, and a session's store (`/workspace/.pnpm-store`) is its own
mount under both bind and volume layouts — so a hardlink into any dep dir is EXDEV even though
both sit on one ext4 device, measured as a raw `link()` (EXDEV) and as a real pnpm 12.5.1 install
with the default `auto` import (`nlink=1`, copied). The 1.8× row below is copy-vs-hardlink **on
one mount**; an ordinary session has been paying the copy already, through pnpm's own fallback.
So the interim ext4 cost accepted on 2026-09-20 was largely not charged, and **H3's reach inside a
ShipIt container was already nil** — an installed file could not be a hardlink into a shared
store. The hole is real in pnpm, which is what the guard tests measure.

**Two layouts escape that, and they are why the pnpm ≥ 11 setting is gated** (both named by an
independent review, both then measured — FINDINGS.md): a `virtualStoreDir` pointed at the store's
own mount (`nlink=2` under `auto`, `nlink=1` under `copy` — a real cost), and a dropped store
mount, where pnpm 10 resolves its default to `/workspace/.pnpm-store/v10`, on the workspace mount.
Both keep the store session-private, so neither is a cross-session exposure; both are unreachable
for a repo that has a base. Forcing a copy there would spend ext4 disk to protect nothing.

**The setting governs an import, so it does not detach links that already exist**
(measured 2026-09-20 on pnpm 12.5.1, and the cell
`integration_tests/pnpm-store-import-method.test.ts` "GAP" holds it): a tree
installed under the hardlink import keeps `nlink` 2 across a plain reinstall **and
across `pnpm install --force`**; only removing `node_modules` and installing again
re-imports it as copies. So reqs 4 and 11 hold for a session from its next cold
install, not from the moment the setting arrives. Scope: a repo on pnpm ≤ 10 with a
tree installed before this change, since pnpm ≥ 11 is not given copy at all. A
migration (detecting store-hardlinked trees and rebuilding them) is a
deliberate destructive step and is left to the requester; section 5 replaces the
shape entirely, since its base tree is orchestrator-built and its store is private.

**Finding: the store relocation used the pre-11 spelling too, so pnpm ≥ 11 shared no
store** (the holes table above records the measurement). `npm_config_store_dir` moved
nothing for pnpm ≥ 11, which fell back to its default store in the container's home —
private to that container, with the `/workspace/.pnpm-store` mount unused. That is what
made H3 unreachable there, and copy pointless there. Adding `PNPM_CONFIG_STORE_DIR`
while the store was still **shared** would have started sharing a store H2 and H4 were
open against, so **the requester ruled on 2026-09-20 not to add it**. Section 5 adds it
once the store is **private per session**, where relocating every version is the fix
rather than the hole: a store no other session can name has nothing for H2/H4 to
rewrite. Never point either spelling at a shared directory.

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
its own install over it** (no pnpm pre-stamp). That install is where the session's
own graph reconciles, so nothing carried decides for the session. It is a
near-no-op for a matching *scriptless* lockfile (8 KB measured).

**Measured 2026-09-21, and the "builds run there" half of that claim does NOT
hold** ([`build-cost-spike.sh`](./build-cost-spike.sh), FINDINGS.md). A session
that mounts the base and approves a pending build does **not** get it built: its
install prints "Lockfile is up to date, resolution step is skipped", exits 0 and
leaves `pendingBuilds` unprocessed — 8 KB upper, 286 ms, silently unbuilt. The
control is the same project and the same approval file with **no** base, which
does build. The two repairs also fail as the session's own uid, because copy-up
preserves the lower's owner and a session may rewrite a base file's contents but
not `chmod` it: `pnpm rebuild` and `pnpm install --force` both exit 1 with
`Operation not permitted`. So a repo with an approved native build gets a working
tree from its first private install — the one that triggers the publish — and a
silently unbuilt one from every container start after the base exists. The C2/C3
cells this design leaned on used a base from an **ordinary** install, not the
builder's `--ignore-scripts` output; FINDINGS.md's own limits section had flagged
that gap. **Open, and a design decision**: exclude a repo with pending builds from
eligibility, or have the base carry built output, or give the session a repair
that works under its own uid.

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

**Shipped 2026-09-21** (the builder, the immutable input snapshot and the one eligibility
decision — `pnpm-base-inputs.ts`, `pnpm-lockfile.ts`, `pnpm-base-registry.ts`,
`pnpm-base-builder.ts`), with four recorded deviations from the two paragraphs above.

- **The sandbox store is populated by `pnpm fetch` through a loopback registry over the
  staged tarballs, not by unpacking them into a store ShipIt writes.** Measured
  2026-09-21 (FINDINGS.md): `v11/index.db` is a **SQLite** database, so hand-writing the
  store is a second implementation of pnpm's store, pinned to a store version — the thing
  "canonical by construction" exists to avoid. The loopback server is a static file server
  over tarballs three digests already agreed on; it authenticates nothing and needs to,
  because it serves only verified bytes. It is up for the **fetch phase only**: the phase that
  produces the published tree runs `--offline` with `--registry` pointed at a dead port, so an
  accidental network dependency fails loudly. The container still has `NetworkMode: none`.
- **The archive-to-manifest derivation is off the path.** It existed to admit *store entries*,
  which the ext4 redesign replaced with a tree pnpm builds. What is still leaned on — tarball
  sha512 == lockfile `resolution.integrity` == packument `dist.integrity` — is scripted and
  asserted (`pnpm-base-registry.test.ts`, `integration_tests/pnpm-verified-base-build.test.ts`).
- **Pinned pnpm 12.4.1, not 12.4.2.** 12.4.2 was 6 days old on 2026-09-21, inside the
  dependency policy's 7-day minimum; 12.4.1 is the newest 12.x outside it, and re-measured
  identical on both build phases.
- **A pinned binary is not enough to stop a repo choosing the builder's pnpm.** Measured: the
  repo's `packageManager` field reaches the builder by three routes, and the pinned binary
  invoked directly **self-switches** unless pnpm's own version management is off. `builderEnv`
  sets all three switches (`PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS`,
  `COREPACK_ENABLE_PROJECT_SPEC`, `COREPACK_ENABLE_AUTO_PIN`).

Three things the implementation makes stronger than the paragraphs describe, all worth stating
because they change what a later reader has to check.

- **`--ignore-pnpmfile` on BOTH phases, and hook-config keys refused outright.** The first cut
  had it on the offline phase only, which an independent review broke: not staging a
  `.pnpmfile` is not enough, because `globalPnpmfile: ./hooks.cjs` names a path the snapshot
  stages for another reason — every `package.json` in the tree is staged, so
  `hooks.cjs/package.json` with `main: "../.npmrc"` has Node resolve the hook to the staged
  `.npmrc` and execute it in the fetch phase, before the phase that publishes. So
  `pnpmfile`/`globalPnpmfile`/`global-pnpmfile` are refused in `.npmrc` and
  `pnpm-workspace.yaml`, and the flag is on both phases.
- **The builder builds at the SESSION's container paths**, `/workspace` and
  `/workspace/.pnpm-store`, not paths of its own. pnpm records `storeDir` in `.modules.yaml`
  and the publish preserves it, so any other path is a store mismatch at every consumer.
- **`--store-dir`/`--registry` are passed on the command line**, which outranks any `.npmrc`
  the snapshot carries — that is what makes "override a relocated global store" a real
  override rather than a hope.

*Scope and store.* pnpm's dep dir is `node_modules`; the pnpm early-returns
(`container-overlay-provisioner.ts`, `overlay-publish.ts`) go. The store becomes
**private per session** — `preparePnpmStore` resolves `sessionPnpmStoreDir`,
`<stateDir>/sessions/<id>/overlay/pnpm-store`, still mounted at
`/workspace/.pnpm-store` and dropped with the session's directory — and the
shared per-runtime store is retired. `package-import-method=copy` is set beside
the store path (`container-lifecycle.ts`) because a hardlink cannot cross the
overlay boundary — an import-compatibility setting; with the store private it is
no longer a cross-session security boundary. Nothing is migrated from today's store.

**Shipped 2026-09-20** (the private store and the verified namespace), with three
recorded deviations from the sentence above:

- **Both env spellings set the store path**, not just the pre-11 one: `PNPM_CONFIG_STORE_DIR`
  and `npm_config_store_dir`. One spelling reaches half the pnpm versions, and the half it
  misses keeps a store the verified base was not built against — which
  `ERR_PNPM_UNEXPECTED_STORE` then refuses. The reason it was a hole before (a *shared*
  target) is gone.
- **The janitor's pnpm-store sweep is kept, not dropped.** It is what reclaims the retired
  shared trees: deleting the sweep would leak them forever. It now exempts no hash, so every
  tree under `<stateDir>/pnpm-store` ages out at the cold-artifact threshold — an age-out
  rather than an immediate delete, because a container created before the upgrade still mounts
  one. The per-session store is under the session dir and is not swept.
- **The store is sealed 0700 to the session's own uid**, replacing `shareTreeOnce`'s group
  share. Carrying the group share over would have left every session able to write every other
  session's index — H2/H4 with extra steps.

Also removed with it: `PNPM_STORE_DIR` (see the holes table). The per-session store survives a
container restart, where pnpm ≥ 11's in-container default did not.

**Shipped 2026-09-21** (the pnpm ≥ 11 copy import), with one recorded deviation from the sentence
above: **`PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy` is set only where a spec in the verified
namespace is mounted**, not beside the store path. `buildEnv` reads `config.overlaySpecs` and keys
on `scope.namespace === PNPM_VERIFIED_NAMESPACE`, so an npm/yarn base cannot turn it on.

The design's reason for the setting is that the import must cross the overlay boundary, which is
true exactly when a base is mounted. Everywhere else it is either a no-op (the standard layout
already copies, EXDEV) or a cost (the two escaping layouts in section 2 hardlink into a
session-private store, and a forced copy there buys no isolation for ~1.8× the ext4 disk). Gating
is what keeps the requester's 2026-09-20 reasoning true in the only cases it still describes —
and neither escaping layout can have a base, so the gate never withholds the setting from a
session that needs it.

Three facts this rests on, all measured 2026-09-21 (FINDINGS.md).

- **The setting is honoured**: `PNPM_CONFIG_PACKAGE_IMPORT_METHOD` produces `nlink` 1 on pnpm
  11.22.0 and 12.5.1, and `npm_config_*` is ignored there — the 2026-09-20 split, re-measured.
- **It is free where it is set.** A base implies the standard mount layout, where `auto` was
  already copying; and a base hit imports nothing at all, so only an added package is copied.
- **It cannot whiteout a base.** pnpm does not record `packageImportMethod` in `.modules.yaml` or
  re-validate it, so a session whose base appears or disappears between container starts sees
  "Already up to date" rather than the `Recreating node_modules` a store-version mismatch causes.

Placing it under `sessions/<id>/overlay/` is what makes it reclaimable rather than a new leak:
that directory is already in `REGENERABLE_SESSION_SUBDIRS` (`disk-utils.ts`), so both disk-tier
paths — the full reclaim and `reclaimBlockedSessionCaches`, which archive and a blocked evict
call — drop the store with the overlay upper it filled, and drop the install marker in the same
act so the next start reinstalls. A store is a cache; it is reclaimed with the tree it built.

*Provenance in code.* The verified namespace is a fourth field of `overlayScopeHash`
and an optional `namespace` on `OverlayScope`, so the pointer, the publish and the
mount all address the same scope. `prepareOverlaySpecs` mounts a pnpm session only
when a **published pointer exists in the verified namespace for every ELIGIBLE dep dir**
— the gate reads the pointer of the scope each spec actually names, so it cannot drift
from what would be mounted, and an ineligible declaration is already dropped before it;
with nothing publishing there yet, a pnpm session installs privately exactly as
it did before, and an unverified pointer in the un-namespaced scope opens nothing.
All-or-nothing across dep dirs: a partly-mounted set has no single answer to what the
session is running. `liveOverlayScopeHashes` claims **both** addresses for every
session, because package-manager detection reads the mutable checkout and must not be
what decides whether a base is reapable.

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
(it stays for npm/yarn). The session's install reconciles against the session's
own lockfile. It was also supposed to run its approved builds into its upper, so
that an unbuilt base is completed per session; **measured 2026-09-21, it does
not** — see the paragraph above and FINDINGS.md. What req 1 asks of the base is
narrow and exact:
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
while `liveOverlayScopeHashes` used `overlayRuntimeKey`
alone — a pre-existing mismatch the verified namespace must not inherit, or a
stopped session's pinned scope is swept despite a current pointer.

**Shipped 2026-09-21** (the consumer-side gates: no pnpm pre-stamp, the no-lockfile
gate, the per-scope lock and the operation-lifetime claim), landed BEFORE the trigger
rather than with it. The sequencing is the checklist's own reasoning applied in order: a
published pointer opens the mount gate at once, so the gates that make mounting safe must
already be in place when the first pointer appears. Each of them is a no-op for today's
behaviour — no pointer exists in the verified namespace yet — except the install marker,
which for pnpm repos re-validates on content instead of on the commit. Two things the
implementation adds to the paragraph above:

- **The sweep re-checks Docker per scope, after that scope's claim read.** The design said the
  sweeps "sample claims and the pointer separately". The sharper problem, found by the
  independent review and reproduced: with an operation-lifetime claim, a claim's WHOLE
  lifetime — claim, mount, release — can fall between a pass-wide Docker sample and a
  per-scope claim read, so neither reading holds it and a running container's lowerdir is
  deleted. The cover is an ordering *inside the scope lock*: read claims, then sample Docker.
  Under the lock nothing more can be claimed, and a claim is released only once its container
  exists, so a generation not claimed at the first reading had a visible container before
  that release and the sample taken next sees it. The pass-wide sample is kept as the cheap
  "is anything deletable here" filter — protective, never sufficient — so the Docker re-check
  costs three CLI calls only for a scope that would actually delete something.
- **The scope lock itself admitted concurrent holders**, which the design took as given. It
  read its queue link back off the map *after* awaiting, so two callers enqueuing in one tick
  both held the second one's link; the first deleted it on exit and a third caller found an
  empty map and entered while the second still ran (reproduced 2026-09-21). Each invocation
  captures its own link now. Pre-existing, and load-bearing the moment reclamation depends on
  the lock.
- **A claim is keyed by the select→mount OPERATION, not by the session.** Two creation attempts
  for one session overlap in production — a standby create the runner stopped waiting for, plus
  the cold-create fallback (`app-lifecycle.ts`) — and a session key let the second attempt's
  release drop the first attempt's protection while it was still mounting. `prepareOverlaySpecs`
  takes an opaque `claimToken`; passing none is how a read-back path says it claims nothing.
- **`liveOverlayScopeHashes` claims the pinned AND the unpinned address**, not just the
  pinned one the mismatch was about. `overlayPinSegment` reads the mutable checkout, so it
  is the same argument the verified namespace already makes: a sweep must never be what
  decides a base is reapable, and naming a hash with no directory costs nothing.

Two consequences worth stating because nothing engineers them away. Requiring the content
hash for pnpm means a pnpm repo whose `agent.install` is **not content-keyable** re-installs
on every container start; that is the safe direction — the alternative is skipping an install
whose approved builds never ran — and declaring `install-inputs` restores the skip. And
`install-inputs: []`, the explicit opt-out, stays an opt-out: `pnpm-workspace.yaml` is added
to a *non-empty* custom list only, because adding it to an empty one would key on the approval
file ALONE and then skip an install a lockfile change genuinely needed.

**Shipped 2026-09-21** (the trigger — the last piece, so a verified base now exists in production
for the first time). `overlay-publish.ts`'s pnpm early-return is replaced by
`publishVerifiedPnpmBase`, which runs on docs/183's own trigger — a successful declared install
whose session sits on the default-branch commit — and calls `buildVerifiedPnpmBase` for the
verified scope. The session-snapshot pull is off this path entirely: nothing on it reads the
session's `node_modules`, and every way this can fail — an ineligible input set, a failed
verification, a build that does not finish, and a throw out of Docker, the filesystem or the
publish — becomes a publish outcome on the measurement line, so a session's own install is never
affected (req 9). That line's `install_ms` is read the moment the install settles, not after the
publish, or for pnpm it would charge a builder's minutes to an install that took seconds — the one
number req 7 is judged from. Seven things the paragraphs above left to the implementation.

- **A pointer already naming the default-branch commit skips the build.** Every session's install
  triggers, so without the pre-check the common case is a multi-minute builder container per
  container start, for a base `publishBase` would then answer `skipped-equal` about. The read is an
  optimization only — the compare-and-swap inside the publish is still what decides.
- **Admission for the build is decided in `buildVerifiedPnpmBase`, not at the call site**: one build
  per scope, claimed synchronously before the first await, plus a ceiling across scopes
  (`MAX_CONCURRENT_PNPM_BASE_BUILDS`) because each builder container is capped at 4 GiB and several
  at once is what the host feels. Over either bound the trigger **skips** rather than queues — the
  next session's install triggers again, while a queue would hold work for a commit that has since
  moved on.
- **The BUILD carries no abort signal** (the trigger's preliminary HEAD request still does, and a
  disposal there simply skips). The design said no runner-bound cancellation; the npm/yarn loop in
  the same function turns an aborted signal into an `error` outcome per dep dir, so the pnpm branch
  had to be written not to inherit that, and a cell holds it.
- **`node_modules` is the only dep dir the builder can fill**, so a pnpm repo declaring another one
  gets no base at all rather than a base its all-or-nothing mount gate could never accept.
- **A repo that DECLARES pnpm ≤ 10 gets no base, at the publisher AND at the consumer.** Measured
  2026-09-21 (FINDINGS.md): pnpm resolves its store as `<storeDir>/v<N>` and records the resolved
  path in `.modules.yaml`, so a pnpm 10 consumer (store `v10`) of a tree the pinned pnpm 12 builder
  wrote (store `v11`) prints `Recreating node_modules` and reinstalls — rc=0, so not a req 9
  failure, but over an overlay it whiteouts every base file into the session's upper and installs
  privately on top, which is reqs 7 and 10 inverted. pnpm 11 and 12 (both `v11`) hit the base with
  no recreate and no download. Nothing else would have caught it: pnpm 12 accepts a pnpm-10
  `lockfileVersion: '9.0'` under `--frozen-lockfile`. So `MIN_VERIFIED_BASE_PNPM_MAJOR` gates both
  ends — the publisher on the committed manifest (no container spent on a base every session would
  discard) and `prepareOverlaySpecs` on the checkout's (a branch that downgrades pnpm under a repo
  whose default branch did not). **"Declares" is two fields, not one**: `packageManager`, else
  `devEngines.packageManager`, which corepack honours on its own (measured on corepack 0.34.6, and
  the gap an independent review found). The limit is stated rather than engineered away: a manifest
  declaring neither is taken as the image's corepack default, so an `agent.install` command naming a
  version (`npx pnpm@10 install`) still recreates the tree — a command string is not a declaration,
  and parsing one is not worth what it would cost.
- **The boot reaper never touches a build this process has already started.** It is launched
  un-awaited (`startup-monitors.ts`) and sweeps pnpm work dirs after paced plugin cleanup, so a
  restored session can finish its install and be building by the time it runs; it would then have
  killed the live container and deleted its staged inputs. Every run nests under a per-process id
  that is also a container label, so "a previous process's leftovers" is a fact rather than a timing
  assumption — and no start barrier is needed. Found by the independent review of this slice.
- **A publish whose generation the sweep reclaimed is repaired, not skipped.** The whole-scope sweep
  removes a scope's base directory and leaves its pointer, which lives outside the swept tree
  (`steady-state-reclaim.ts`, `wholeScopeCandidate`); `publishBase` answered `skipped-equal` about it
  and `selectGeneration` fell back to the empty generation 0, so the scope got no base again until
  the default branch moved. It now materializes a new generation (`repaired`) when the pointer's
  `baseDir` is gone. Pre-existing and shared with the npm/yarn publisher; found by the independent
  review of this slice.

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

**Verified at the source 2026-09-21.** pnpm keeps its resolution metadata under
`XDG_CACHE_HOME/pnpm`, and nothing in `src/` sets `XDG_CACHE_HOME` for a session container
(`buildEnv`, `container-lifecycle.ts`; the only other setter is `session-namer.ts:219`, an
orchestrator-side opencode run, and `pnpm-base-builder.ts:251`, inside the builder sandbox).
So it falls back to `$HOME/.cache/pnpm` with `HOME=/home/shipit` (`buildEnv`,
`shared/agent-home.ts:4`) — a path **no** bind or volume targets: `buildMounts` mounts the
workspace, `/credentials`, `/uploads`, `/persist`, `/session-state`, the plugin store,
`/dep-cache`, `/workspace/.pnpm-store` and the overlay dep dirs, and nothing under
`/home/shipit`. Under `readonlyRootfs` the home is a per-container **tmpfs**
(`container-hardening.ts:readonlyRootfsTmpfs`), which is if anything more private; the
entrypoint's only home links point into `/credentials`, itself per-session
(`docker/session-worker/entrypoint.sh:174-182`), and `.cache` is not among them. So the
metadata cache is private per session container and ephemeral in both modes, and no shared or
seeded metadata cache exists.

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
| `src/server/orchestrator/overlay-publish.ts` | `publishVerifiedPnpmBase` — the trigger: docs/183's condition (declared install ok, session on the default-branch commit), the already-published pre-check, and the call into the builder with no abort signal. The snapshot publisher beside it (npm/yarn, the pull → `publishBase` sequence) never writes the verified namespace. |
| `src/server/orchestrator/bootstrap-managers.ts` | `buildPnpmBase` — the one place the builder's Docker deps are bound; absent without a container manager, which is how a pnpm repo keeps installing privately where there is no Docker. |
| `src/server/orchestrator/overlay-base.ts` | `publishBase` reused for ordering (CAS authenticates nothing); `withScopeLock` (`:109`, exported) is the one per-scope lock for claim, publish and sweep; `copySnapshotToBase` hardlink-dedup is a **disk** optimization, not a verification step. `OverlayScope.namespace` runs through `scopeHashOf`, so pointer reads and publishes address the same namespaced scope. An equal-commit publish whose generation directory is gone materializes again (`repaired`) rather than skipping — the sweep takes the directory and leaves the pointer. |
| `src/server/orchestrator/overlay-base-claims.ts` | The select→mount lease. Keyed by an opaque per-OPERATION token (two creation attempts for one session overlap), held until `releaseOverlayBaseClaims`, no expiry — and the reason the sweep must read claims BEFORE it samples Docker. |
| `src/server/shared/pnpm-repo.ts` | `isPnpmRepo` (moved out of `overlay-session.ts`, re-exported there) and `hasPnpmLockfile` — the no-lockfile consumer gate's narrower question. In `shared/` because the worker needs the same answer and may not import from `orchestrator/`. |
| `src/server/shared/install-marker.ts:60` | `markerMatches(marker, stamp, { requireDepsHash })` — pnpm skips on the content hash alone, never on the commit, so a same-commit approval change still runs the install that performs the build. |
| `src/server/orchestrator/overlay-volume.ts` | `overlayScopeHash` — repo + runtime + dep dir + an optional **namespace**, the verified-base discriminator; omitting it reproduces the pre-namespace hash, so existing npm/yarn bases stay addressable. Also the Docker `overlay` volume (`:196`), now also for pnpm's `node_modules`. |
| `src/server/orchestrator/container-overlay-provisioner.ts` | `prepareOverlaySpecs` (`:67`) — the pnpm mount gate, the no-lockfile gate (`:98`) and the claim, all under the scope lock; `selectGeneration` (`:159`) — a published generation whose directory is gone selects 0; `preparePnpmStore` — the per-session private store. |
| `src/server/orchestrator/pnpm-lockfile.ts` | What the builder reads out of `pnpm-lock.yaml`: which packages it pins, the digest it pins them to, and the entries that are not plain registry downloads. Classifies on the `resolution` SHAPE, so an unfamiliar future form stays ineligible rather than being silently admitted. |
| `src/server/orchestrator/pnpm-base-inputs.ts` | `stagePnpmInputs` — the immutable snapshot, read out of one commit through git and never out of the session's checkout; `decidePnpmBaseEligibility` — the ONE eligibility decision, taken before any fetch, including the committed `packageManager` store-version gate. |
| `src/server/shared/pnpm-repo.ts` | `MIN_VERIFIED_BASE_PNPM_MAJOR` and the measurement behind it — pnpm records its resolved `<storeDir>/v<N>` in `.modules.yaml`, and a consumer on another `N` recreates the tree instead of reading it. Asked at both ends: the publisher's eligibility and `prepareOverlaySpecs`. |
| `src/server/orchestrator/pnpm-base-registry.ts` | `stageVerifiedRegistry` — resolves `<name>@<version>` against the orchestrator's own registry, admits only when the lockfile digest, the packument's `dist.integrity` and the downloaded bytes' sha512 all agree, and names the first failing package. |
| `src/server/orchestrator/pnpm-base-builder.ts` | `builderScript` (the two phases), `builderEnv` (the three `packageManager` switches and the emptied config), and `buildVerifiedPnpmBase`, which owns build admission (one per scope, `MAX_CONCURRENT_PNPM_BASE_BUILDS` across scopes) and publishes through `copySnapshotToBase` + `publishBase`. |
| `src/server/shared/deps-hash.ts:21`, `:102` | pnpm's default hash inputs include `pnpm-workspace.yaml`; a custom `installInputs` replaces the list, so `resolveDepsHashInputs` adds it back for a pnpm repo when given the workspace dir. |
| `src/server/orchestrator/overlay-session.ts` | `PNPM_VERIFIED_NAMESPACE`; `sessionPnpmStoreDir` — the per-session private store; `retiredSharedPnpmStoreRoot` — the tree the janitor ages out. |
| `src/server/orchestrator/container-lifecycle.ts` | `PNPM_STORE_CONTAINER_PATH` — `/workspace/.pnpm-store`, the one path every session's own store maps to; `ensurePnpmStoreDir` seals it 0700 to the session uid; `buildEnv` sets both store-path spellings, `npm_config_cache` (section 1), and the import method — the pre-11 spelling always, the pnpm ≥ 11 one only when `config.overlaySpecs` carries the verified namespace, because a mounted base is the one shape where the copy is both needed and free; `prepareOverlayDirs` (`:487`) creates only generation 0's lowerdir; `createContainer` retires the shared npm index. |
| `src/server/session/dep-snapshot.ts`, `src/server/orchestrator/overlay-snapshot.ts` | The merged-tree tar and its pull — unchanged; untrusted, and admission no longer depends on it. |
| `src/server/orchestrator/session-worker-uid.ts:124` | `shareOne` — group write on the shared surfaces (docs/270 req 9). |
| `src/server/orchestrator/session-dir-factory.ts:58` | `createDepCacheDirHelper` — `/dep-cache` keyed per repo; the verifier's self-verifying tarball source. |
| `src/server/shared/npm-cache.ts` | Section 1's whole mechanism: the per-session cache path, the `content-v2` link, and the retirement of the shared index. |
| `src/server/session/session-worker.ts` | Calls `linkSessionNpmCache` before the listener opens, so no install, terminal or service can reach npm through an unlinked cache. |
| `src/server/orchestrator/integration_tests/npm-cache-poisoning.test.ts` | The H1 attack and its control, against real npm and a local registry. |
| `src/server/orchestrator/integration_tests/pnpm-store-isolation.test.ts` | H4 against real pnpm >= 11: the index key rename that survives `strictStorePkgContentCheck`, fired through a shared store (the control) and refused by two `sessionPnpmStoreDir` paths (the fix). Plus the base's mount shape — one shared lowerdir, per-session upper and work dirs, and no bind that exposes the base tree. |
| `src/server/session/install-controller.ts` | The install path; also serves `GET /workspace/dep-snapshot`. |

## Related

- `docs/075-shared-dependency-cache` — why `/dep-cache` exists and is per-repo.
- `docs/183-overlay-dep-store` — the overlay dependency base.
- `docs/198-dep-cache-content-keying-and-pnpm-store` — the pnpm store; its
  "integrity-checked on link" caveat is corrected in this PR.
- `docs/270-per-session-worker-uids` — req 9 (sharing must survive).
- `docs/266-orchestrator-git-trust-boundary` — E4, held by req 8.
