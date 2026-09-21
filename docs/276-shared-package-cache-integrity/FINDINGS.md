---
title: Store-in-overlay measurements (docs/276)
description: Docker-mounted measurements that gate the pnpm store-in-overlay fix — attack isolation (H4 and H2, each with a control), copy-up disk, install time, and their limits.
---

# Findings — pnpm store inside an overlay

The Docker-mounted measurements that [plan.md](./plan.md) section 5 and the
[checklist](./checklist.md) leave open, run by
[`store-overlay-spike.sh`](./store-overlay-spike.sh). They cannot run in a
session container (no Docker socket); these were run on the **services** host.

**Host:** Docker 29.7.2, `overlayfs` storage driver, Ubuntu 24.04, ext4 root,
4 vCPU / 8 GB. pnpm 12.4.2 (store layout `v11`), from a baked image so no
container re-downloads pnpm. Date 2026-09-18.

The harness **hard-asserts** the facts each cell depends on and exits non-zero on
any failure, so a silently no-op attack, a failed control, or a failed install
cannot read as a pass. "Clean" means the installed file's sha512 **equals** the
original blob's digest — not merely readable and lacking a marker; "poison" means
the marker is present **and** the digest differs; the no-overlay control **must**
poison the victim. It reported **PASS=14 FAIL=0**.

## What this proves, and what it does not

- It proves the **kernel copy-up mechanism**: a store write in one session's
  overlay upper cannot reach the shared base or another session.
- It does **not** implement or test the orchestrator **verify-and-admit** step
  (fetch a tarball by key, match the hash, re-derive the manifest, admit to a
  new base generation). The base here is a **warmed fixture** — a normal pnpm
  install — standing in for where the verified base would sit; it is not the
  proposed independent verification.
- Sessions mount only their own `/store` overlay plus a shared metadata-cache
  dir, not the backing directory, so a session cannot reach the base or other
  uppers by path. Production **mount confinement, immutable generations, and
  admission remain separate obligations** this harness does not discharge.

## Result: the overlay isolates the store-index attack (H4 and H2)

Verified base = a warmed store as the overlay **lowerdir**; attacker A and
victim B each mount base + their own **upper/work**. Each attack has its own
cell and its own no-overlay control.

| Cell | Overlay (A attacks, B installs) | No-overlay control (shared bind) |
|---|---|---|
| **H4** — rewrite `index.db` manifest to a poison blob at a valid hash | base `index.db` byte-unchanged; A's rewrite in A's upper; **B clean (digest matches original)** | **B poisoned** (`PWNED`, digest differs) |
| **H2** — poison the blob's bytes in place, **mtime preserved** (asserted `MT_OLD==MT_NEW`) | base unchanged; **B clean (digest matches)** | **B poisoned** (`POISON`, digest differs) |

The control is the load-bearing half: the same attack **poisons B on a shared
bind**, so the attack is real and the overlay copy-up is what stops it. Both
attacks succeed (H4 rewrote 1 manifest row; H2's `MT_OLD==MT_NEW` shows
deliberate mtime preservation, not timing luck), so the isolation is not a
false positive from an attack that quietly did nothing.

The topology this sits on — a `type=overlay` volume mounting at a subpath,
copy-up isolation, a shared base without EBUSY — is green on this host
(`docs/183-overlay-dep-store/prototype/nested-overlay-spike.sh`, 14/14).

## Measured disk — with the copied node_modules, which the store does NOT share

`du -sb` reports **apparent** bytes, not allocated blocks. `node_modules` is
**copied per session** (`package-import-method=copy`, a prerequisite for the
store-in-overlay move) and is **not** shared by the store lowerdir.

| Measurement | Value |
|---|---|
| base store (2 packages) | 1,117,294 B; `index.db` 8,192 B (0.7%) |
| `index.db` at scale (8 deps, 2,168 files, 51 MB store) | 659,456 B (1.3% **for this workload**) |
| A store-upper after the H4 attack | 25,119 B |
| B store-upper after a base-hit install | 49,152 B |
| B **node_modules** (base-hit, copied per session) | 54,457 B |
| new-package store-upper | 116,352 B |
| new-package node_modules | 36,096 B |

## Req 7 and req 10, measured against today's hardlink baseline

Measured on the **scale set** (8 top-level deps, 2,168 files, 58 MB store),
which is where copy and hardlink diverge, on **ext4** (no reflink). Install time
was measured **inside** the container (no spawn), five reps, best of five. Disk
is `du -sB1` = allocated bytes; the hardlink marginal uses a combined `du` so a
shared inode counts once.

| | today (hardlink) | design (overlay copy) | ratio |
|---|---|---|---|
| warm install time (best of 5) | 0.060 s | 0.088 s | **1.47×** |
| per-session marginal disk | **0 B** | **59.3 MB** (upper 0.7 MB + node_modules 58.6 MB) | — |
| shared base store (amortized) | 57.9 MB | 57.9 MB | — |

Both regressions are **the copy**, and both are the section-3 ext4 gate,
now quantified:

- **Req 7 — a measurable slowdown on ext4, small in absolute terms for this
  workload.** The overlay-copy install is 1.47× the hardlink install (28 ms
  more on a 58 MB tree). It scales with the file count, so a large repo pays
  more. Whether 1.47× is "materially slower" (req 7) is the requester's call,
  but the cause is the copy import, not the overlay itself.
- **Req 10 — NOT met on ext4 by copy alone.** Today a session's `node_modules`
  hardlinks the shared store, so the per-session marginal disk is **0**. The
  design copies the tree into the session's own filesystem — **58.6 MB per
  session** for this 8-dep set — which the store lowerdir does not share. This
  is exactly the docs/198 "per-session copy" objection, quantified.

**Both are removed by a reflink filesystem** (btrfs / XFS): there
`package-import-method=copy` becomes a reflink, so the install is near-free in
both time and space. `du` cannot see reflink sharing, so re-measure req 10 there
with a `df` used-space delta. **The store-in-overlay fix therefore depends on
reflink storage to satisfy req 7 and req 10** — on ext4 it trades the hardlink's
zero marginal for a full per-session copy. **The requester then ruled (req 12)
that ext4 must be supported and reflink-only optimisations are out of scope, so
this shape is not viable.** plan.md section 5 records why it cannot be rescued
on ext4 (`fs.protected_hardlinks=1` denies a session a hardlink to any file it
cannot write; a hardlink to an overlay lower copies the data up — both verified
on this host) and the candidate redesign. The store-upper copy-up itself
(`index.db`, ~0.7 MB here / ~48 KB for a tiny repo, 1.3% of the store for this
workload) is bounded and not the issue; the `node_modules` copy is.

## Result: share the tree, not the store — works on ext4

After req 12 (ext4 must be supported) ruled the store-in-overlay shape out, the
candidate redesign in plan.md section 5 was spiked by
[`tree-overlay-spike.sh`](./tree-overlay-spike.sh) on the same host (ext4): a
`node_modules` produced by one trusted install is the overlay **lowerdir**
mounted at each session's `<project>/node_modules` (the docs/183 topology);
each session has its own package.json + lockfile and a **private, empty pnpm
store** at the same container path the base was built with. **PASS=12
FAIL=0**, hard-asserted, on a base of 7,395 files / 78.6 MB (8 top-level deps,
no install scripts — see below).

| Cell | Result |
|---|---|
| base-hit `pnpm install --offline --frozen-lockfile` over the lower, empty private store | **rc=0** ("resolution step is skipped"); private store untouched (0 files); upper **8 KB** |
| `pnpm add left-pad` against the empty private store, copy import | rc=0; package real in the session; went through the private store (32 files); upper +229 KB (the package plus pnpm's rewritten lock/modules metadata); **base byte-unchanged** |
| edit a file inside a base package (req 11) | only that file copies up (+569 KB for a 544 KB file); base byte-unchanged |
| second session over the same base | rc=0; sees neither the added package nor the edit; upper 8 KB |

Read against the requirements, on ext4 with no reflink:

- **Req 10:** a base-hit session pays **8 KB**, not the 58.6 MB copy of the
  store-in-overlay shape. Not today's 0 B hardlink either, but the same order.
  Only a session that adds a package pays, and only for that package.
- **Req 1 / 4 / 6 / 11:** there is no shared writable store, so H2/H3/H4 have no
  cross-session path; a session's add or edit is real for it and invisible to
  the next session; the base is never written.
- **Req 9:** the agent runs `pnpm install` / `pnpm add` itself, against its
  private store.
- **Req 7:** a base-hit install imports nothing (pnpm reports the tree up to
  date in a few milliseconds), so it is faster than today's hardlink install,
  not slower. Not separately timed.

Two details the wiring must respect, both found here:

- **The private store must sit at the same container path the base was built
  with.** pnpm records `storeDir` in `node_modules/.modules.yaml` and refuses
  another (`ERR_PNPM_UNEXPECTED_STORE`). ShipIt already fixes that path
  (`/workspace/.pnpm-store`); each session's container maps it to its own host
  directory. Verified: an empty private store at the recorded path is accepted.
- **Packages with install scripts make pnpm 12 exit 1 even on a no-op install**
  — `Ignored build scripts: esbuild@0.21.5`, `help: Run "pnpm approve-builds"`.
  Measured on a vite-carrying base: the base build itself exits 1, and so does
  the no-op install over the lower. This is pnpm's default, independent of the
  overlay; the project's `pnpm approve-builds` / `onlyBuiltDependencies`
  settles it. The spike uses a scriptless dependency set so rc is a clean
  signal. Note for verify-and-admit: `pendingBuilds` / `ignoredBuilds` in
  `.modules.yaml` are part of the base's state.

What it does **not** establish: the base here is a fixture from one pnpm
install, not the content-verified base. Verify-and-admit applied to the tree
(every file under `node_modules/.pnpm/<pkg>/` hashing to its manifest digest)
and the publish of a session's verified additions into a new base generation
are the remaining orchestrator-side steps, shared with planning#599.

## Result: what pnpm does with a base it did not build (tree-state-spike.sh)

Three facts the first lifecycle draft leaned on, measured on the services host
([`tree-state-spike.sh`](./tree-state-spike.sh), PASS=9, hard-asserted). One
caveat first, verified at the source: in docs/183's flow **a base-hit session
never runs the package manager** — ShipIt pre-stamps the install marker
(`overlay-session.ts:preStampInstallMarker`) and the worker skips the install
(`install-controller.ts:96`, `skipped: "marker"`). pnpm is excluded from that
flow today (`container-overlay-provisioner.ts:79`), so this describes what
extending it to pnpm unchanged would do; cells A and B describe what an install
*would* do over such a base.

| Cell | Result |
|---|---|
| A. Base with every `.bin` dir removed; genuine no-op install (rc=0, "resolution step is skipped") | shims **not** regenerated; upper 8 KB |
| B. Base whose `.pnpm/lock.yaml` lists a package whose directory is absent; install with the correct workspace lockfile | pnpm **reinstalls** it into the upper (a base miss) |
| C1. Base `.modules.yaml` carries `allowBuilds` + `pendingBuilds` for a package; the session does not approve | script **not** run (`ERR_PNPM_IGNORED_BUILDS`); pnpm resets `allowBuilds` from the workspace file |
| C2. Same base; the session approves in `pnpm-workspace.yaml` (`allowBuilds: {"<id>": true}`, pnpm 12's form) | script runs — the positive control, so C1 is a real negative |
| C3. Package already linked, nothing pending; the session approves | script runs on a plain install and on `pnpm rebuild` |

Consequences: `.bin` shims are part of the base; carried approvals cannot
trigger a script, because pnpm 12 reads approvals only from
`pnpm-workspace.yaml`, keyed by package id (`"pwn@file:pwn"` for a `file:`
dependency); and since the base-hit path skips the install, nothing carried
can be validated later — which is why the revised lifecycle has the
orchestrator generate the tree, shims and state from verified inputs instead of
carrying any of them. A first draft of cell A used a base containing an
ignored-script package and reported shims *regenerated*; that was the
ignored-script notice forcing a relink, not a no-op, which is why the cell
asserts rc=0 and "resolution step is skipped".

**A no-lockfile session inherits the base's graph** (measured after the second
review). With the base's `node_modules/.pnpm/lock.yaml` present but **no**
workspace `pnpm-lock.yaml`, `pnpm install --offline` (non-frozen, empty private
store) failed trying to fetch `is-number@6.0.0` — the exact transitive version
the base's `.pnpm/lock.yaml` records — "snapshot not present in local store".
So pnpm reconstructed the dependency graph from the carried `.pnpm/lock.yaml`
without re-resolving, and (online) would fetch and install those versions. A
no-lockfile session therefore inherits the publisher's **version selection**
(authentic packages, attacker-chosen versions), which is why such a repo's base
must come from the orchestrator's own resolution or not at all, not from a
carried session graph.

## Finding: a pnpm hook runs under `--ignore-scripts`

Measured on the services host after the third review. With a `.pnpmfile.cjs`
whose `readPackage` hook writes a marker file, `pnpm install --ignore-scripts`
**ran the hook** (marker written, rc=0); adding `--ignore-pnpmfile` suppressed
it (no marker). So a pnpm **hook is not a script**, and `--ignore-scripts` does
not stop it. Consequence for the base rebuild: a hook source — a committed
`.pnpmfile.cjs`/`.mjs`, or a `configDependencies` plugin a registry-authentic
package supplies — executes code in the builder that can rewrite the "canonical"
output the orchestrator then publishes. The sandbox protects the host but does
not make the output trustworthy after attacker code has run. The fix is to
build with `--ignore-pnpmfile` under an explicit known config (no inherited
global settings, package-manager switching disabled).

**The two cases that were left unmeasured are now measured** (2026-09-21, in a
session container on the builder's pinned **pnpm 12.4.1**, marker-file hooks, a
fresh project per cell). Both behave exactly as the `.cjs` case:

| Hook source | `--ignore-scripts` alone | `+ --ignore-pnpmfile` |
|---|---|---|
| `.pnpmfile.cjs` | ran (module body **and** `readPackage`) | suppressed |
| `.pnpmfile.mjs` | ran (module body **and** `readPackage`) | suppressed |
| `configDependencies` package supplying `pnpmfile:` | ran | suppressed |

The `configDependencies` cell installs a config package from a local registry by
`<version>+<integrity>` and points `pnpm-workspace.yaml`'s `pnpmfile:` at the file it
unpacks; `--ignore-pnpmfile` stops the hook from loading even though the config
dependency itself is still resolved. Two consequences, and neither changes this PR.
`--ignore-pnpmfile` is now measured to cover **every** hook source the eligibility rule
names. `.pnpmfile.mjs` was admitted on that basis (2026-09-21, `decidePnpmBaseEligibility`);
`configDependencies` was not, because its reason survives the measurement — a config dependency
does carry its own digest, but pnpm resolves it through a path this builder neither parses
(`pnpm-lockfile.ts` reads one document) nor stages (`pnpm-base-builder.ts` stages
`decision.packages` alone), so it is the input surface rather than the execution that is still
open. The builder's belt-and-braces refusal of the `pnpmfile`/`globalPnpmfile` keys closes the
route this cell measured — the one where the key points at the unpacked file. It should **not**
be credited with closing every plugin-loading route: pnpm 12 is reported to auto-discover a
config dependency named `pnpm-plugin-*` and load its pnpmfile with no key at all, which is not
measured here. Nothing turns on which is true, because the presence of `configDependencies` is
refused outright and the flag is on both phases.

## Finding: relocating the store does not break an existing `node_modules`

Measured 2026-09-20 on pnpm 12.5.1, because moving pnpm >= 11 off its in-container default
onto a per-session host directory changes the `storeDir` recorded in
`node_modules/.modules.yaml`, and `ERR_PNPM_UNEXPECTED_STORE` is documented for that
mismatch. It does not fire on this version:

| Cell | Result |
|---|---|
| install against store A, then `pnpm install` with `PNPM_CONFIG_STORE_DIR` pointing at store B | rc=0, "Already up to date" |
| then `pnpm add left-pad` against store B | rc=0; re-fetched the 3 packages, rewrote `.modules.yaml` to store B |
| `pnpm install --frozen-lockfile` against an empty store D, online | rc=0 |
| `pnpm install --frozen-lockfile --offline` against an empty store C | rc=1, "snapshot not present in local store" — the ordinary cold-store failure, not a store mismatch |

So the relocation costs a re-fetch of what the new store lacks, and nothing else. That cost
was already paid on every cold container by these sessions, whose in-container store did not
survive a restart. pnpm <= 10 is unaffected either way: its recorded `storeDir` is the same
`/workspace/.pnpm-store` string before and after — only the host directory behind it changed.
The `ERR_PNPM_UNEXPECTED_STORE` seen in the tree spike came from a lowerdir base built at a
different container path, which is why the private store must keep that path.

## Finding: H4 still fires on pnpm 12.5.1, and how it has to be written now

Measured 2026-09-21 in a session container (no Docker needed — two projects, one local
registry, one store), because the H4 cells above ran on an older pnpm and the regression
test that now guards this had to attack the version sessions actually run.

- **A whole-row swap in `index.db` is caught.** Writing package X's manifest row under
  package Y's key makes pnpm 12.5.1 refuse the entry and name
  `strictStorePkgContentCheck` — the store entry's own name/version no longer match the
  key, and pnpm checks exactly that.
- **A key RENAME is not caught, and installs the attacker's code.** Let pnpm's own writer
  produce the row for an EVIL tarball of `pkg@1.0.0`, then rename that row's key from the
  EVIL tarball's integrity to the LEGIT one's. Name and version still match, every blob
  still hashes to its own digest, and the tarball itself is long gone — so nothing pnpm
  checks is inconsistent. A second session sharing the store asked the registry for the
  legitimate package, hit the renamed row and installed `module.exports = 'EVIL!'`, rc=0.

That is the H4 class intact on a current pnpm: the index decides which bytes an integrity
names, and content verification cannot see a lie about *which* content was asked for. Both
cells are committed as `integration_tests/pnpm-store-isolation.test.ts` — the second one is
the control, and the fix cell is the same attack against two per-session store paths taken
from `sessionPnpmStoreDir`.

## Finding: in the standard container layout pnpm cannot hardlink from its store — with two exceptions

Measured 2026-09-21 **inside a ShipIt session container**, which is what makes it new: every
earlier import-method measurement put the store and `node_modules` on one mount, and a
container never does. This container's `/workspace`, `/dep-cache`, `/session-state`,
`/persist` and `/credentials` are five **separate bind mounts of one ext4 device** (`2049`,
`/dev/sda1`), which is the same shape as `/workspace` and `/workspace/.pnpm-store`.

| Cell | Result |
|---|---|
| `os.link("/dep-cache/f", "/workspace/f")`, same device | **EXDEV** |
| real pnpm 12.5.1, default `auto` import, store on the `/dep-cache` bind, project on the `/workspace` bind | installed file `nlink=1`, store blob `nlink=1` — **copied** |

`link(2)` compares **mounts**, not superblocks: "Linux permits a filesystem to be mounted at
multiple points, but `link()` does not work across different mount points, even if the same
filesystem is mounted on both." So in the layout every ordinary session runs, the store and the
dep dirs are on different mounts and pnpm's `auto` has already been resolving to **copy**, with
or without an overlay base. Both `buildMounts` layouts have this shape: binds
(`/workspace`, `/workspace/.pnpm-store`) and the workspace volume with two different
`Subpath`s are two mounts either way.

**Two layouts escape it, both found by an independent review and both then measured here.**
Neither is reachable for a repo that has a base, and in both the store is session-private, so
neither is a cross-session exposure — what they are is a real ext4 disk cost if a copy is forced.

| Escaping layout | Measured |
|---|---|
| `virtualStoreDir` pointed at a directory on the **store's** mount (e.g. `.pnpm-store/virtual` when the store is mounted at `/workspace/.pnpm-store`): the installed package files then sit beside the content store, and `node_modules` reaches them by symlink | pnpm 12.5.1, default `auto`: `nlink=2`. Same install with `PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy`: `nlink=1` — the copy is a real extra cost here |
| The store mount **dropped** (the `ensurePnpmStoreDir` handoff failure, or a session with no `pnpmStoreDir`): no store env is set, and pnpm does not simply fall back to `HOME` | pnpm 10.28.2 `store path` from a project on the workspace mount, HOME on the container rootfs: **`/workspace/.pnpm-store/v10`** — the workspace's own mount, so hardlinks work |

Three consequences, correcting earlier entries rather than adding to them.

- **`package-import-method=copy` costs nothing in the standard layout**, and costs ~1.8× in the
  two above. The ext4 figure in plan.md section 2 is copy-vs-hardlink *on one mount*, which is
  what those two layouts recreate. That is why the pnpm ≥ 11 setting is applied **only where a
  verified base is mounted**: a base implies the standard layout (the builder refuses a
  non-default `virtualStoreDir`, and a base needs the store mount), so the copy is free exactly
  where it is set and the escaping layouts keep their free hardlinks into a private store.
- **H3's reach inside a ShipIt container was already nil in the standard layout.** H3 needs an
  installed file to be a hardlink into a *shared* store; the mount layout forbids the hardlink,
  and in both escaping layouts the store is the session's own. The hole is real in pnpm — the
  guard tests measure it — but no production session's `node_modules` was linked to a shared one.
- **There is nothing to migrate.** The stores that were ever *shared* were always separate
  mounts, so trees installed from them are trees of copies. A tree that IS hardlinked, in an
  escaping layout, is linked only into that session's own store.

## Finding: the pnpm >= 11 import-method spelling works, and switching it recreates nothing

Measured 2026-09-21 in a session container on **pnpm 11.22.0 and 12.5.1**, one scriptless
registry dependency, a store on the same filesystem as `node_modules`:

| Cell | 11.22.0 | 12.5.1 |
|---|---|---|
| default (`auto`), same filesystem | `nlink` 2 (hardlink) | `nlink` 2 |
| fresh install with `PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy` | `nlink` 1 | `nlink` 1 |
| `pnpm config get package-import-method` under `PNPM_CONFIG_*` / `npm_config_*` | `copy` / `undefined` | `copy` / `undefined` |
| re-run an existing hardlinked tree with the copy setting | "Already up to date", `nlink` stays 2 | same |

Two things follow. The `PNPM_CONFIG_*` spelling is the one that reaches pnpm >= 11, which
re-confirms the 2026-09-20 split. And **changing the import method does not make pnpm
recreate `node_modules`** — `packageImportMethod` is not recorded in `.modules.yaml` and is
not part of what pnpm re-validates, so adding the setting cannot whiteout a mounted base the
way a store-version mismatch does (`MIN_VERIFIED_BASE_PNPM_MAJOR`). Note these cells put the
store and the project on ONE mount, which is why `auto` hardlinks here and does not in a
container (previous finding); what they establish is that the spelling is honoured and that
the switch is not a recreate.

## Result: an approved build does NOT run over a base hit (build-cost-spike.sh)

The checklist's build-inclusive measurement, run on the services host 2026-09-21
([`build-cost-spike.sh`](./build-cost-spike.sh), PASS=14 FAIL=1 — the failure IS this finding).
Host: Docker 29.7.2, Ubuntu 24.04, ext4. **Builder pnpm 12.4.1** (the pinned one) building the
base with the real flags `--frozen-lockfile --ignore-scripts --ignore-pnpmfile`; **consumer pnpm
12.5.1** (the image's corepack default). Every session container runs as its **own non-root uid**
over a base owned by another uid with group write — the `shareOne` shape
(`session-worker-uid.ts:124`) the earlier tree spikes never exercised, because they ran as root.

The project is 6 846 files / 57 MiB: `better-sqlite3@11.5.0`, whose `install` script produces
`build/Release/better_sqlite3.node`, plus five scriptless packages.

| Arm | upper | time (best of 3) | build ran? |
|---|---|---|---|
| base hit, build not approved | 8 192 B | 319 ms | no (expected) |
| base hit, build **approved** (`allowBuilds: {better-sqlite3@11.5.0: true}`) | 8 192 B | 286 ms | **no — rc=0, silently unbuilt** |
| **no base**, same project, same approval file | 59 MiB tree + 52 MiB store | 1 043 ms | **yes** |

**So there is no build-inclusive base-hit cost to report: the build never runs.** The session's
own `pnpm install` prints "Lockfile is up to date, resolution step is skipped", exits 0, and
leaves `pendingBuilds` unprocessed. The no-base arm is the control that makes this a finding
rather than a broken fixture: the same project, the same `pnpm-workspace.yaml`, keyed by the id
pnpm itself recorded in `pendingBuilds`, **does** build when no base is mounted.

Two earlier harness errors are worth recording, because each would have reported a false pass:
`esbuild` is unusable as the probe (its binary ships in an **optional dependency**, so it runs
with scripts suppressed), and `better-sqlite3`'s `require()` succeeds with no binding at all —
the probe has to construct a `Database`. A third, in an ad-hoc run only: `printf %s` does not
expand `\n`, which silently produced an invalid approval file.

**And the two repairs a user would reach for both fail**, as the session's own uid over the base:

| Command | Result |
|---|---|
| `pnpm rebuild` | rc=1, `Failed to chmod ".../semver/bin/semver.js": Operation not permitted` |
| `pnpm install --force` | rc=1, same EPERM |

That is the ownership shape, not a fluke: overlayfs copy-up preserves the lower's owner, so a
copied-up base file belongs to the orchestrator's uid, and group write lets a session rewrite
its **contents** but not `chmod` it. Verified at the source — `shareOne` keeps `stat.uid` and
only adds the shared gid plus group write.

Isolation is unaffected and was re-asserted here under distinct uids: the base stayed
byte-unchanged throughout, and a second session inherited nothing of the first's upper.

**What this contradicts.** plan.md section 5 says every session "runs its own install over it
(**no pnpm pre-stamp**) … That install is where builds run and the session's own graph
reconciles." The first half holds; the second does not for a script-bearing repo. The C2/C3
cells that the design leaned on used a base produced by an **ordinary install**, which this
file's own limits section already flagged — they did not cover the builder's `--ignore-scripts`
output, and that is exactly the gap. A repo with an approved native build gets a working tree
from its first, private install (the one that triggers the publish) and a silently unbuilt one
from every container start after the base is published. Recorded as an open checklist item; the
fix is a design decision, not part of this slice.

## Finding: how the builder's sandbox store gets built, and that `--offline` then holds

Measured 2026-09-21 **in a session container** (no Docker host needed: the sandbox the cells
exercise is process-level, not the production container). pnpm 12.4.1 and 12.5.1, ext4.

The design says the builder's private store is built "inside the sandbox by unpacking the
staged, integrity-checked tarballs". Writing pnpm's store by hand is not a viable reading of
that: `v11/index.db` is a **SQLite** database (`SQLite format 3` header, measured), so
producing one is a second implementation of pnpm's store, coupled to a store version, and it
is exactly the "canonical by construction" principle the same section rejects elsewhere. What
works instead — and keeps pnpm the only writer of its own store:

| Cell | Result |
|---|---|
| `pnpm fetch --ignore-scripts --store-dir <sandbox> --registry <loopback>` over the verified tarballs | rc=0; store populated; 3/3 packages |
| then `rm -rf node_modules`, `pnpm install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry http://127.0.0.1:1/` (no registry reachable) | rc=0; full tree including the transitive |
| the same fetch with one tarball's bytes corrupted (a trailing byte appended) | rc=1, `ERR_PNPM_TARBALL_INTEGRITY`, naming expected vs actual sha512 |
| the staged tarball's sha512 vs the lockfile's `resolution.integrity` for 3 real packages | identical, all three |

So the loopback registry exists only for the fetch phase; the phase that produces the
published tree runs with `--offline` against a dead port, which is what makes an accidental
network dependency fail loudly rather than pass quietly. pnpm re-verifies each tarball against
the lockfile as it imports, which is a second, independent check on top of the orchestrator's
own. The committed harness is
`src/server/orchestrator/integration_tests/pnpm-verified-base-build.test.ts`; its control
drops the transitive from the staged set and asserts the build then fails.

**Consequence for the archive-to-manifest derivation.** It is no longer on the path. It
existed to let the orchestrator admit *store entries*, which the ext4 redesign replaced with a
tree the orchestrator has pnpm build. What is still load-bearing is the half above — tarball
sha512 == lockfile integrity == packument `dist.integrity` — and that is scripted, in
`pnpm-base-registry.test.ts` and the harness named above.

## Finding: a base-hit consumer still contacts the registry, for pnpm 12's policy check

Measured 2026-09-21 on pnpm 12.4.1 while writing the consumption cell of
`integration_tests/pnpm-verified-base-build.test.ts`. A second session handed the builder's
tree, with its own committed inputs and an **empty** private store at the path the base
records:

| Cell | Result |
|---|---|
| `pnpm install --frozen-lockfile`, registry reachable | **rc=0**, "Lockfile is up to date, resolution step is skipped"; store still **empty**; tree intact |
| the same install with `--offline` and no registry | rc=1, `ERR_PNPM_NO_OFFLINE_META` — `Failed to resolve <pkg> in package mirror <cache>/pnpm/v11/metadata-full/…` |

The failure is **not** the tree or the store. pnpm 12 runs "Verifying lockfile against
supply-chain policies" *before* anything else, and that needs registry metadata the consumer's
cold cache does not have. A session's registry is reachable, so the first row is the production
shape; the builder is unaffected because its fetch phase warms that cache in the builder's own
HOME before the offline phase runs.

Two things this settles, and one it opens. It settles that the **store path is load-bearing
and now correct**: the consumer accepts the tree as up to date only because `.modules.yaml`
records the path it was given. It settles that a base hit **imports nothing** — the store stays
empty, which is the req 10 claim. What it opens is for the consumer slice: a base-hit install
is not free of the network on pnpm 12, so req 7's warm-install measurement must include that
round trip rather than assume an offline no-op. Related: the metadata cache stays private per
session (`XDG_CACHE_HOME/pnpm`), which is unchanged — this finding is about a call it makes,
not about sharing it.

## Finding: `--ignore-scripts` is also what keeps `strictDepBuilds` quiet

Measured 2026-09-21 on pnpm 12.4.1, after an independent review asked for an executable
control on script suppression. plan.md section 5 says `--ignore-scripts` is required because
an **unapproved** build exits non-zero under pnpm 12's `strictDepBuilds`; the fuller picture
is that `--ignore-scripts` is what makes *both* cases pass:

| Approval | `--ignore-scripts` | Result |
|---|---|---|
| none | yes | rc=0, script not run |
| none | no | **rc=1**, `Ignored build scripts` |
| `allowBuilds: {"<id>": true}` | yes | rc=0, script **not run** — the builder's case |
| `allowBuilds: {"<id>": true}` | no | rc=0, script **runs** — the positive control |

So a script-bearing repo builds fine either way as long as the flag is on, and an approved
build is genuinely suppressed rather than merely refused. Two details the harness depends on:
**`onlyBuiltDependencies` does not approve on 12.4.1** (the install still fails
`ERR_PNPM_IGNORED_BUILDS`) — pnpm 12's form is `allowBuilds` keyed by package id, as cell C2
already found; and the **fetch** phase must keep `--ignore-scripts` too, because without it
pnpm refuses to fetch at all, which would fail a control for the wrong reason.

## Finding: a repo's `packageManager` reaches the builder by three routes

Measured 2026-09-21 with a repo pinning `packageManager: pnpm@10.28.2`, against a pnpm 12
invoked three ways. Each route needs its own switch, and the first two are easy to mistake for
the whole answer:

| Invocation | Default | With the switch |
|---|---|---|
| corepack's `pnpm` shim | **10.28.2** | `COREPACK_ENABLE_PROJECT_SPEC=0` → 12.5.1 |
| `corepack pnpm@12.4.1` (explicit spec) | 12.4.1 | unchanged |
| the pinned binary directly (`/opt/pnpm/bin/pnpm`) | **10.28.2** — it self-switches | `PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false` → 12.4.1 |

Baking a pinned pnpm and calling it by path is therefore **not sufficient**: pnpm's own
version management downgrades it to whatever the repo asks for, which is a repo-controlled
choice of the binary that produces the published base. `builderEnv()` sets all three switches
and `pnpm-base-builder.test.ts` pins them.

**Version pinned: 12.4.1, not the 12.4.2 plan.md names.** 12.4.2 was published 2026-09-15 and
was 6 days old on 2026-09-21, inside the dependency policy's 7-day minimum; 12.4.1
(2026-09-10) is the newest 12.x outside it. Re-measured: 12.4.1 runs the two phases above with
the same results.

## Finding: a pnpm ≤ 10 consumer RECREATES a base the pinned pnpm 12 builder produced

Measured 2026-09-21, prompted by an independent review of the trigger. pnpm resolves its store as
`<storeDir>/v<N>` and records that **resolved** path in `node_modules/.modules.yaml`; a consumer
whose `N` differs re-creates the tree rather than reading it.

| pnpm | `store path` under one `--store-dir` | consuming a 12.4.1-built tree, empty store at the recorded path |
|---|---|---|
| 10.28.2 | `…/v10` | **`Recreating node_modules`**, `downloaded 1` |
| 11.22.0 | `…/v11` | no recreate, no download — a base hit |
| 12.5.1 (the session image's corepack default, no repo pin) | `…/v11` | no recreate, no download — 20 ms |

Three things this settles. It is **rc=0 on every row**, so it is not a req 9 failure — it is a
req 7 and req 10 failure: over an overlay, "recreating" the tree whiteouts every base file into the
session's upper and installs privately on top, so the base costs disk instead of saving it, on
every container start. Nothing else in the eligibility decision would have caught such a repo:
measured in the same run, pnpm 12.4.1 accepts a pnpm-10 `lockfileVersion: '9.0'` under
`--frozen-lockfile` (rc=0, "Lockfile is up to date"), so a pnpm-10 repo is otherwise fully eligible.
And an earlier probe that showed pnpm 11 recreating was a **confound** — its consumer store was at a
different path from the recorded one; with the path matched, pnpm 11 hits the base.

Hence two gates, `MIN_VERIFIED_BASE_PNPM_MAJOR = 11` (`src/server/shared/pnpm-repo.ts`): the
publisher refuses a repo whose committed manifest declares an older major
(`incompatible-package-manager`), so no container is spent on a base every session would throw
away; and `prepareOverlaySpecs` mounts no base for a **checkout** that declares one, which covers a
branch that downgrades pnpm under a repo whose default branch did not.

**The declaration is two fields.** Measured on **corepack 0.34.6**, prompted by a second review that
found reading `packageManager` alone leaves the gap open:

| manifest | corepack selects |
|---|---|
| `devEngines.packageManager: {name: pnpm, version: 10.28.2}`, no top-level pin | **pnpm 10.28.2** — the missed route |
| both fields, disagreeing | refuses to run any pnpm at all |
| `devEngines` with a **range** (`^10.0.0`) | refused: "expected a semver version" |

So the pin is `packageManager` if present, else an exact-version `devEngines.packageManager` naming
pnpm; the other two shapes need no handling because they select nothing. One limit is left standing
rather than engineered away: a manifest declaring neither is taken as the image's corepack default,
so an `agent.install` command naming a version (`npx pnpm@10 install`) still recreates the tree.

## Finding: offline resolution needs metadata separate from the store

pnpm keeps **resolution metadata** (`<name>.jsonl`) in `XDG_CACHE_HOME/pnpm`,
**separate** from the `--store-dir`. A fresh session with an empty metadata
cache fails to *resolve* a name (`Failed to resolve <pkg> in package mirror`)
even when the store holds the content. Ways it works, and the design must pick
deliberately: a lockfile carrying the applicable resolution (need not be
committed, only present); a metadata cache the session can read — shared, or
privately seeded/copied from a trusted source; or a normal online fetch. The
harness shares the metadata cache; it does not run the empty-cache or
lockfile-only comparisons. The integrity implication stands: session-writable
resolution metadata is its own surface — verifying store *content* does not
authenticate which content a name should *select* (the req 6 class).

## Finding: pnpm chmods bin targets unconditionally, so any install that does work over a base EPERMs

Measured 2026-09-21, both halves. The in-container half
([`ineligible-sharing-spike.sh`](./ineligible-sharing-spike.sh), PASS=26 FAIL=0, pnpm 12.5.1)
names **which** files pnpm chmods; the host half
([`ineligible-sharing-host-spike.sh`](./ineligible-sharing-host-spike.sh), PASS=13 FAIL=0,
services host, Docker 29.7.2, ext4, builder pnpm 12.4.1 / consumer 12.5.1, base owned by another
uid with group write) asks whether those chmods **fail** on a real overlay. pnpm 12's installer is
a native binary, so the calls are captured with an `LD_PRELOAD` interposer rather than read.

| Session action over a verified base | chmod calls | on base (lower) files | over a real overlay as the session uid |
|---|---|---|---|
| base hit | **0** | — | rc=0, upper 8 192 B |
| edit inside a base package, then install (req 11) | **0** | — | — |
| **`pnpm add left-pad`** | **8** | **8 of 8** | **rc=1, `ERR_PNPM_CMD_SHIM_CHMOD` … `Operation not permitted`** |

The eight are four `.bin` shims — which pnpm rewrites, so they whiteout into the upper — and four
package files it does **not** rewrite: `semver/bin/semver.js`, `rimraf/dist/esm/bin.mjs`,
`glob/dist/esm/bin.mjs`, `which/bin/node-which`. And the chmod is **unconditional**: 10 calls in
the in-container harness set a mode the file already had. That is what rules out the repair that
looks obvious — making the base's modes already correct. Ownership is not available either
(per-session uids), and group write does not grant `chmod`.

**This is not a property of ineligible repos. It is a live req 9 defect for ELIGIBLE ones**, since
the trigger merged in shipit#2941: a session can install and can edit its dependencies, but
`pnpm add <pkg>` fails. It is the same root cause planning#604 hit from the other side —
`build-cost-spike.sh` recorded the identical EPERM on the identical file from `pnpm rebuild` and
`pnpm install --force`, and read it as a property of those two commands. It is a property of any
install that relinks bins. It escaped the tree spikes because they run as **root**
(the limits section below says so), and `build-cost-spike.sh`, which introduced distinct uids,
never ran an add.

## Result: seeding the bin targets into the upper repairs it, and unlocks the pruned base

Same host harness, cells 4 and 5. Two shapes, each measured unseeded and seeded.

**The repair:** before the container starts, copy every executable target of every package in the
tree into the session's **upper**, owned by the session uid. pnpm's unconditional chmod then lands on
a file the session owns.

**The set is `bin`, and `directories.bin` when `bin` is absent** — the second form was missed in the
first cut, found by an independent review, and then measured (cell J): a package declaring only
`directories: {bin: "tools"}` gets a shim, and pnpm **chmods its package file**, so a list keyed on
`bin` alone leaves exactly those packages unseeded. The set is small either way:

| Tree | executable targets | bytes |
|---|---|---|
| the harness base (2 001 files, 23 MiB) | 6 files | 28 KiB |
| ShipIt's own `node_modules` (609 packages) | 28 files | 204 KiB |

**The pruned base** is the shape for a repo whose packages build at install time. The builder builds
the whole tree with `--ignore-scripts` as it does now; the build-bearing packages are then removed
from the tree **and from the carried `node_modules/.pnpm/lock.yaml`**. Pruning the carried lockfile
is the load-bearing half: a hole in the tree alone is repaired only under `--frozen-lockfile`, and a
bare `pnpm install` short-circuits on "Already up to date" and leaves it (measured in-container,
cell E). ShipIt cannot assume the flag: `agent.install` is repo-authored with no default, and
`tuneNpmInstall` rewrites npm commands only, so the cells below use the weaker bare command.

| Cell | unseeded | seeded |
|---|---|---|
| `pnpm add` over a base hit | rc=1, EPERM | **rc=0**, package present, upper 2.5 MB |
| pruned base, **bare** `pnpm install`, `better-sqlite3` approved | rc=1, EPERM, unbuilt | **rc=0**, re-imported, **BUILT**, `new Database(':memory:')` loads; upper 12.6 MB |

So a build-bearing repo gets the whole scriptless tree shared and pays, per session, only the
packages that build. Measured within this harness: a base hit is **8 192 B of upper + 4 096 B of
store**, the pruned arm is **12 MiB of upper + 12 MiB of private store**, and the shared base is
23 MiB. (`build-cost-spike.sh`'s no-base arm was 59 MiB + 52 MiB, but on a different scriptless
dependency set — indicative, not the same workload.) The build runs as the session's **own** uid,
into its own upper, which is what the base's no-script posture requires.

**A retained package depending on a pruned one is the case most likely to break, and it holds.**
Measured in-container: `vite` retained, `esbuild` pruned, with **47** incoming edges still naming
`esbuild` in the carried lockfile. A bare `pnpm install` re-imported `esbuild`, relinked `vite`'s
edge to it, and `require("vite")` loads — so pnpm treats a missing `packages`/`snapshots` record as
work to do and repairs the incoming edges, and the prune need not be transitively complete.
`esbuild` is the graph probe only here; this file already records that its binary ships in an
optional dependency, which makes it useless as a *build* probe.

Isolation is unaffected and re-asserted under distinct uids: both bases stayed byte-unchanged, and
a second session inherited neither the add nor the build.

## Finding: three refused classes behave under the builder's own flags

Measured in-container ([`ineligible-sharing-spike.sh`](./ineligible-sharing-spike.sh), cells G–I,
pnpm 12.5.1). Each was refused by `decidePnpmBaseEligibility` when measured; none needs a sharing
shape, because the builder already handles it — and the first row has since been admitted on
exactly that ground.

| Class | Result |
|---|---|
| `.pnpmfile.mjs` | `--ignore-pnpmfile` suppresses **both** the module body and `readPackage`, with a positive control showing both run without the flag. **Admitted 2026-09-21** — the `hook-source` refusal of `.mjs` is gone, and a `.pnpmfile` was never staged in the first place |
| `workspace:` / `link:` to an in-repo path | `pnpm install --frozen-lockfile --offline` against a dead registry succeeds with **only the manifests staged** — no member source needed — and the link pnpm writes is **relative** (`../../../lib`), so it resolves against the consuming session's own checkout rather than the builder's |
| `patchedDependencies` | The committed patch is applied under `--ignore-scripts --ignore-pnpmfile`, and an unparseable patch **fails the install closed** rather than installing unpatched. **Admitted 2026-09-21** — re-measured on the real pipeline; see below |

## Finding: what `patchedDependencies` costs, and the one rule it broke

Measured 2026-09-21 in this container, pnpm **12.5.1** and the pinned **12.4.1** where noted. The
class is now admitted; these are the measurements the admission rests on.

| Question | Answer |
|---|---|
| Which config does pnpm 12 read patch paths from? | **`pnpm-workspace.yaml` only.** `package.json#pnpm` is not read at all — pnpm warns "The \"pnpm\" field in package.json is no longer read by pnpm ... keys were ignored" and installs the package **unpatched**. Confirmed on 12.4.1, the version the builder pins |
| What is the lockfile's patch hash? | The **sha256 of the patch file's UTF-8 text with CRLF normalized to LF**, hex — not of its raw bytes: a CRLF copy of a patch satisfies the LF hash its lockfile pins, so hashing bytes would take a base off every repo with a CRLF-committed patch (found by independent review, then measured). pnpm records it as the `patchedDependencies` value and appends it to the importer and snapshot keys as `(patch_hash=<sha256>)`; the `packages:` entry stays the plain published version, so tarball verification is untouched. Matched byte-for-byte, and independently confirmed by the integration cell, whose hand-written lockfile hash 12.4.1 accepts under `--frozen-lockfile` |
| Can a patch write outside the package it patches? | **No.** A diff naming `../../../../../../tmp/ESCAPED` is refused by pnpm's own applier — "patch path escapes target dir" — and the install fails closed, so the build yields no base. Independent review confirmed at pnpm 12.4.1's source that the applier also rejects absolute paths, creates regular files only (a diff mode header does not become a symlink or a setuid file), and preserves existing permissions on modification |
| Does patch application run anything? | **No.** The same frozen offline install with `PATH=/nonexistent` and an empty environment still applies the patch, so it is an in-process diff apply, not `git apply`/`patch(1)` |
| What does a frozen install do when the inputs disagree? | All four fail closed, rc=1: lockfile-without-workspace, workspace-without-lockfile and an **edited patch file** are `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`; a **missing patch file** is "Failed to read patch file". Each is a failure the repo's own install hits, which is why eligibility refuses the same four |

**The rule it broke: a patch can add a build script the tarball scan cannot see.** A patch adding
`scripts.postinstall` to the package it patches leaves the builder-equivalent install
(`--frozen-lockfile --offline --ignore-scripts --ignore-pnpmfile`) at **rc=0** — `strictDepBuilds`
does not fire — with the package unbuilt and named in `node_modules/.modules.yaml`'s
`pendingBuilds`, while a clean build records `[]`. So the planning#604 refusal, which reads the
staged **tarballs**, is blind to patched content. The builder now reads `pendingBuilds` off the
built tree before publishing and refuses a non-empty or unreadable one — pnpm's own answer, rather
than a diff parser that would have to decide what a hunk means.

**`pendingBuilds` is not only dependencies.** pnpm defers the PROJECT's own lifecycle scripts there
too, as bare importer ids: a repo with scriptless dependencies and a root `postinstall` records
`["."]` after the same install. Those are the session's to run and the builder's to ignore, so the
gate filters the lockfile's importer directories out — a dependency id is always `name@version`,
never a bare directory. Found by independent review before the gate shipped; without the filter it
would have taken the base off every repo with a root install script.

## Faithfulness and limits

- **The executable-target list is derived from `bin` plus `directories.bin`, and matched against the
  chmod set observed for two tree shapes.** It covered every package file pnpm chmodded there, and
  the seeded cells pass, which is the end-to-end check. It is not a proof that pnpm chmods nothing
  else on a tree neither harness built — the first cut of this list missed `directories.bin`, which
  is the reason to state the bound rather than assume it.
- **The host harness deletes each upper before seeding**, so it measures the seeding mechanism and
  not the rule the design states for an upper that already exists (seed once at creation, never
  overwrite an existing entry, resolve inside the upper without following symlinks). That rule is
  argued from `prepareOverlayDirs`, which resets an upper only on generation supersession, and is
  not measured here.
- **The prune's graph contract is measured for two shapes only** — a top-level package and a
  retained dependent — and the prune leaves `.modules.yaml` naming the removed package in
  `pendingBuilds`, which was harmless in both and is not established as harmless. Peer-qualified
  duplicates, `npm:` aliases, optional/platform-skipped packages and a consumer lockfile differing
  from the publisher's commit are untested.
- **The patch cell did not run the production pipeline; that gap is closed.** The original cell
  used pnpm 12.5.1 online with `--no-frozen-lockfile`. The admission below re-measured the class on
  the pinned 12.4.1 with verified tarballs, the loopback fetch phase and a frozen offline install
  (`integration_tests/pnpm-verified-base-build.test.ts`).
- **The pruned base is pruned by the harness, not by the orchestrator.** Removing a package from
  the carried `lock.yaml` is done with a line-oriented edit keyed on the package name; a real
  implementation reads and rewrites the YAML. The cell asserts the name no longer appears.
- **The design copies, not hardlinks**, because `node_modules` (container fs)
  and the store (volume) are different filesystems — the same crossing the real
  design forces (store in an overlay, `node_modules` outside it), which is why
  `package-import-method=copy` is a prerequisite (plan.md section 2). The req 7
  and req 10 cells now measure that copy against a genuine hardlink baseline
  (link counts asserted: baseline > 1, design == 1), so they do capture the
  hardlink→copy transition, on ext4.
- **Concurrency is not a lock-correctness test.** Two installs into two separate
  uppers over one base both succeed, but each session writes its **own**
  `index.db` in its **own** upper — there is no shared writable index to lock.
  This shows separate-upper installs do not error; it does not establish lock
  correctness over a shared critical section.
- **Wall times include container spawn** and are single-shot.
- **PASS counts exclude warn-only cells.** `tree-overlay-spike.sh` only warns
  when the private store is touched on a base hit or left empty after an add;
  `store-overlay-spike.sh` only warns on unexpected link counts, and its timing
  cells tolerate an install failure (`|| true`). Read those lines as observed,
  not asserted.
- **C2/C3 use a `file:` package and a base built by an ordinary install**, not
  the proposed `--ignore-scripts` builder, and C3 reports without asserting. They
  establish pnpm 12's approval behaviour, not the build-inclusive lifecycle.
- **The archive-to-manifest derivation** (tarball sha512 == `index.db` key;
  per-file digests reproduced) was verified interactively on 2026-09-18, not by
  a committed harness; `verify-h4.sh` rewrites manifest bytes and does not
  perform it.
- **The tree spikes run as root** (no `--user`), so they do not exercise
  distinct session uids over the group-writable base (docs/270).

## Reproduce

```
scp docs/276-shared-package-cache-integrity/store-overlay-spike.sh <docker-host>:/tmp/
ssh <docker-host> bash /tmp/store-overlay-spike.sh   # PASS=14 FAIL=0, exit 0

scp docs/276-shared-package-cache-integrity/ineligible-sharing-host-spike.sh <docker-host>:/tmp/
ssh <docker-host> bash /tmp/ineligible-sharing-host-spike.sh   # PASS=13 FAIL=0, exit 0
```

Both need only Docker on the host; the node + python toolchain comes from a baked
image. They clean up their volumes on exit.

The in-container half runs where the agent already is, and needs no Docker — only
`gcc`, for the chmod interposer:

```
bash docs/276-shared-package-cache-integrity/ineligible-sharing-spike.sh   # PASS=26 FAIL=0
```
