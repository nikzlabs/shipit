---
title: Store-in-overlay measurements (docs/276)
description: Docker-mounted measurements that gate the pnpm store-in-overlay fix — attack isolation, copy-up disk, install time, store lock.
---

# Findings — pnpm store inside an overlay

The Docker-mounted measurements that [plan.md](./plan.md) section 5 and the
[checklist](./checklist.md) leave open, run by
[`store-overlay-spike.sh`](./store-overlay-spike.sh). They cannot run in a
session container (no Docker socket); these were run on the **services** host.

**Host:** Docker 29.7.2, `overlayfs` storage driver, Ubuntu 24.04, ext4 root,
4 vCPU / 8 GB. pnpm 12.4.2 (store layout `v11`), from a baked image so no
container re-downloads pnpm. Date 2026-09-18.

## Result: the overlay isolates the store-index attack

The verified base = a warmed pnpm store, used as the overlay **lowerdir**. Each
session mounts base + its own **upper/work**. Attacker session A runs both store
attacks; victim session B has the same base and its own upper.

| Cell | Result |
|---|---|
| H4 via A — rewrite `index.db` manifest to a poison blob at a valid hash | 1 manifest row rewritten |
| H2 via A — poison the probe blob's bytes in place, mtime preserved | bytes poisoned, mtime kept |
| Base `index.db` after both attacks | **byte-unchanged** (copy-up hit A's upper) |
| A's `index.db` write | landed in A's **private upper** |
| Victim B installs the package offline, `verify-store-integrity=true` | **clean bytes** |
| **Control** — same H4 with **no overlay** (shared bind), B installs | **poison bytes** |

The control is the load-bearing half: the same attack **poisons B on a shared
bind**, so the attack is real and the overlay copy-up is what stops it. This is
the mechanism plan.md section 5 depends on, measured rather than asserted.

The topology gate this sits on — a `type=overlay` volume mounting cleanly at a
subpath, copy-up isolation, shared base without EBUSY, concurrent mounts — is
green on this host too (`docs/183-overlay-dep-store/prototype/nested-overlay-spike.sh`,
14/14 PASS).

## Result: disk and time are within req 7 and req 10

| Measurement | Value |
|---|---|
| base store (2 packages) | 1,117,294 B |
| `index.db` on that store | 8,192 B (0.7%) |
| `index.db` at scale (8 top-level deps, 2,168 files, 51 MB store) | 659,456 B (**1.3%**) |
| A's upper after the H4+H2 attack | 29,758 B |
| B's upper after a **base-hit** install | 49,152 B |
| Fresh upper after a **new-package** install | 116,352 B |
| Base-hit install, store on overlay | 0.35 s |
| Base-hit install, plain store (control) | 0.36 s |

Reading the numbers:

- **`index.db` copy-up is bounded.** It is a whole-file copy-up on a session's
  first store write, and it is ~1.3% of the store at a realistic scale (well
  under the plan's earlier ~2% estimate). A session that only *reads* the base
  pays the `index.db` copy-up plus ~40 KB; a session that *adds* a package pays
  for that package's blobs in its own upper (~114 KB here) and no one else does.
  That is req 10: only the session that changes its dependencies pays.
- **No material slowdown (req 7).** A base-hit install with the store on an
  overlay matched the plain-store control within noise (0.35 s vs 0.36 s,
  single-shot, container spawn included).
- **The store lock holds.** Two installs over one base into two uppers ran
  concurrently, both `rc=0`, no lock error.

## Finding: offline install needs the metadata cache or a lockfile, not the store alone

pnpm keeps **resolution metadata** (`<name>.jsonl`) in `XDG_CACHE_HOME/pnpm`,
**separate** from the `--store-dir`. A fresh session has an empty metadata
cache, so an offline install fails to *resolve* a name even when the store holds
its content — the error is `Failed to resolve <pkg> in package mirror`, not a
missing-content error. Two ways it works in practice, and the design must pick
one deliberately:

- the repo has a committed lockfile (pnpm resolves from it, `--frozen-lockfile`), or
- the metadata cache is shared across sessions (as the store is).

The harness shares the metadata cache on the volume (`XDG_CACHE_HOME=/mp/cache`).
The metadata cache is a **separate surface** from the store and is **not** what
the overlay protects; if it is shared writable it is its own integrity question
(what version a name resolves to — the same class as req 6). Note it when wiring
the store-in-overlay: the store overlay alone does not make offline installs
work cross-session.

## Faithfulness and limits

- **The install copies, it does not hardlink.** `node_modules` (container fs)
  and the store (volume) are different filesystems here, so pnpm copies. That is
  the same crossing the real design forces — store inside an overlay,
  `node_modules` outside it — which is exactly why `package-import-method=copy`
  is a prerequisite (plan.md section 2). The disk rows measure store copy-up,
  not `node_modules`, so they are unaffected by the link method.
- **This measures the kernel mechanism, not the orchestrator.** It proves a
  store write in one session's upper cannot reach the base or another session.
  It does **not** implement or test the verify-and-admit publish step (the
  orchestrator fetching a tarball by key, matching the hash, re-deriving the
  manifest, admitting to a new generation). That spike is still open in the
  checklist.
- **Wall times include container spawn** and are single-shot — order of
  magnitude, not a benchmark.

## Reproduce

```
scp docs/276-shared-package-cache-integrity/store-overlay-spike.sh <docker-host>:/tmp/
ssh <docker-host> bash /tmp/store-overlay-spike.sh
```

Needs only Docker on the host; the node + python toolchain comes from a baked
image. It cleans up its volumes on exit.
