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
global settings, package-manager switching disabled). Only the `.cjs` case was
measured; whether `--ignore-pnpmfile` also suppresses a `.pnpmfile.mjs` and a
`configDependencies` plugin is unmeasured, which is why those two stay
ineligible for a base until it is.

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

## Faithfulness and limits

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
```

Needs only Docker on the host; the node + python toolchain comes from a baked
image. It cleans up its volumes on exit.
