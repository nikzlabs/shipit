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

## Reproduce

```
scp docs/276-shared-package-cache-integrity/store-overlay-spike.sh <docker-host>:/tmp/
ssh <docker-host> bash /tmp/store-overlay-spike.sh   # PASS=14 FAIL=0, exit 0
```

Needs only Docker on the host; the node + python toolchain comes from a baked
image. It cleans up its volumes on exit.
