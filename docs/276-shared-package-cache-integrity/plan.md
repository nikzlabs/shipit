---
issue: planning#414
title: Shared package cache integrity — priced options
description: Prices the three directions planning#414 sketches, against measured behaviour of npm's and pnpm's own integrity checks, and recommends a sequence.
---

# Shared package cache integrity — priced options

Implements [requirements.md](./requirements.md). Read it first.

> **⚠️ The design is NOT settled.** Every question under
> [Open questions](./requirements.md#open-questions) has to be answered by the
> requester before implementation starts. This document prices the options so
> that those questions can be answered; it does not choose for them. Q2 in
> particular decides which option is even viable.

## What changed after measuring

planning#414 says plainly that none of its three sketches were evaluated. They
were evaluated here, against this container's npm 11.12.1 and pnpm 11.22.0. Two
results reframe the problem, and both contradict the natural reading of the
issue.

**The issue's premise is half wrong: most of the integrity checking it proposes
to add already exists and already works.**

- npm's content cache is self-verifying — the cache path *is* the content hash,
  and cacache checks it on read. A poisoned tarball is detected, discarded, and
  an offline install fails closed.

**But it is only the npm half.** pnpm's store has **no** integrity check at all:
a fresh `pnpm install` from a poisoned store silently hardlinks the attacker's
bytes — online, offline, with `verify-store-integrity=true`, and with
`package-import-method=copy`. There is no knob that turns this on.

**And the issue understates the pnpm channel.** It describes the risk as content
"that another session of the same repo/runtime later installs". Because store
entries are **hardlinked** into `node_modules`, no later install is needed:
writing to the store file changes the victim session's *already-installed* file
immediately, and that code then runs. Verified by inode and link count; the
poisoned function executed. Requirement 4 exists for this.

So the real, unprotected surface is not "cache content" uniformly — npm's
content cache is genuinely safe. It is these three:

| Hole | Surface | Protected today? |
|---|---|---|
| **H1** — cached *resolution data* (packument) rewritten to point at attacker content | `/dep-cache` npm `_cacache/index-v5` | **No.** Demonstrated install-time RCE, offline, no warning. |
| **H2** — poisoned store content installed by a normal `pnpm install` | `/workspace/.pnpm-store` | **No.** pnpm performs no store-content verification, and no setting enables one. |
| **H3** — store file mutated in place, changing already-linked `node_modules` files | `/workspace/.pnpm-store` | **No**, and unfixable by verification: there is no install event to check at. |

**The overlay dependency base is not a third hole.** It is never mounted into a
session container (`src/server/orchestrator/overlay-volume.ts:38-43`), so no
session can write it directly; a session reaches it only by *publishing*, which
is gated by the existing commit-ancestry CAS. The issue lists it alongside the
other two, but it does not carry the write this work is about. Ruling it out
here so no option below is priced for a surface that does not need one.

H1 is protected *incidentally* when the repo has a lockfile pinning `integrity`,
because then npm trusts the lockfile rather than the cached packument. That is
the whole of the protection that exists (hence req 5, and Q1).

## Option A — integrity rather than isolation

*Verify a cache entry against its lockfile hash on read, so a poisoned entry
fails closed.*

**What it costs — and the cost is split sharply by ecosystem.**

- *npm:* very little. The check already exists and works; the genuine remainder
  is to make installs lockfile-pinned (`npm ci` semantics) and stop sharing the
  one part of the npm cache that is not self-verifying.
- *pnpm:* a great deal. There is no existing check to lean on — ShipIt would
  have to verify store contents itself, on every install, for every linked file.
  That is a hash of the whole store's working set on a path whose entire purpose
  is to be fast (req 7), and it means reimplementing what the package manager
  was assumed to be doing.

**What it closes.** H1, completely and cheaply. H2 only by ShipIt building the
verification pnpm does not provide.

**What it does not close.** H3, at all, and this is not a matter of degree. The
victim is a process opening `node_modules/foo/index.js`; the kernel serves the
poisoned inode. There is no read ShipIt mediates, no install to hook, and no
hash to compare against at the moment it matters. **Any design whose answer is
"check integrity on read" is silently a design that leaves H3 open.**

**What it breaks.** Lockfile-pinned installs break repos with no committed
lockfile — they would install without the shared cache, or warn. That is a
product decision (Q1), not a technical one.

**Verdict.** Right for H1, and the cheapest thing on the table for it. For pnpm
it is neither cheap nor sufficient. Its honest description is "stop defeating a
check that already exists" — which turns out to be true of npm only.

## Option B — a writer that is not the session

*Sessions read the caches; only a ShipIt-owned process populates them.*

**What it costs.** The most of the three, and the cost is concentrated in one
place: `pnpm install` writes to the store as a matter of course, so making the
store read-only to sessions means brokering the populate step through a process
running as a cache-owning identity. docs/270 req 10 ("everything the agent can
do inside its own container today MUST still work") means the agent's own ad-hoc
`npm install` in the terminal has to keep working through that broker too — not
just the `agent.install` path.

**One tempting variant does not work.** "Run the install command as the
cache-owning uid" closes nothing against the threat in scope: `agent.install` is
arbitrary repo-controlled code (the codegen hazard docs/198 documents), so
running it as the cache owner hands the attacker exactly the write it wanted. It
defends only against a compromised agent turn, not against a malicious repo.

**What it closes.** H1, H2 and H3 — and it is the **only** option that closes
H3, because it is the only one that removes the session's write to the inode.
It is also the only option that closes H2 without ShipIt reimplementing pnpm's
missing verification.

**What it breaks.** It strains req 2 hardest. pnpm falling back to a per-session
store on a read-only shared store is precisely the "silently fall back to a
private copy" that req 2 forbids, so the broker has to actually work rather than
degrade. Whether "shared for reads, not for writes" satisfies
`docs/270-per-session-worker-uids` req 9 is Q4, and is the requester's call.

**Verdict.** The only complete answer, and expensive. Worth it only if Q2 is
answered (a).

## Option C — narrow the blast radius (pnpm store key)

*Add the repo to the pnpm store key, matching `/dep-cache` and the overlay base.*

**What it costs.** Genuinely small in code: `pnpmStoreDirForRuntime`
(`src/server/orchestrator/overlay-session.ts:607`) keys on
`pnpmStoreHash(overlayRuntimeKey(env))` alone; adding the repo hash is a
one-function change plus a janitor sweep that now reaps more directories.

**The real cost is disk, and it is the thing the store is for.** pnpm's store
dedupes content across **versions and repos** — docs/198 Part 2 chose it over
the overlay for exactly that. Keying per repo throws the cross-repo half away: N
repos on a host now hold N copies of every shared dependency. docs/198 measured
464 MB per session for the overlay's per-session copies; this is the same
category of regression, at per-repo granularity rather than per-session. It also
brushes req 7 — a new repo no longer starts warm from another repo's store.

**What it closes.** Cross-**repo** reach only.

**What it does not close — and this is the decisive measurement.** `/dep-cache`
is **already** keyed per repo, and the working install-time RCE was demonstrated
against it. Per-repo keying is therefore *shown*, not argued, to be
insufficient: it closes none of H1, H2 or H3. Sessions of the same repo still
share one store and still poison each other, including the live hardlink path —
and several sessions on one repo is ShipIt's ordinary workflow, so C leaves the
common case untouched.

**Verdict.** A real reduction in blast radius, and **not a fix**. The issue
proposes pricing it first as the cheapest partial step; priced honestly, it is
cheap in code, not free in disk, and it removes none of the three holes. It
should be described to users as narrowing reach, never as closing the issue.

## Recommendation

**Do not start with C.** It is the cheapest to write, but it buys the least: it
addresses neither demonstrated hole, and per-repo keying is already disproven by
`/dep-cache`. Sequence by what is actually open instead:

1. **Close H1 first — cheap, and it is a working RCE.** Two parts, neither of
   which is a new integrity subsystem:
   - Make ShipIt's installs lockfile-pinned, so npm trusts the lockfile rather
     than the cached packument (subject to **Q1**).
   - **Stop sharing the npm resolution cache while continuing to share the
     content cache.** These live in one directory today but are not equally
     trustworthy: `content-v2` is self-verifying by construction, whereas
     `index-v5` is pure trusted metadata. Per-session `index-v5` with a shared
     `content-v2` keeps essentially all of the download saving — the bytes are
     in the content half — while removing the only part an attacker can
     usefully forge. *(This is a mechanism proposed here, not a requirement; it
     needs a spike to confirm npm tolerates the split.)*

2. **Treat the pnpm store as the serious half, and take Q2 to the requester
   before designing for it.** H2 and H3 are both open, nothing in pnpm helps,
   and option B is the only answer that closes them without ShipIt writing a
   verifier pnpm does not have. If Q2 comes back (b) or (c), say so explicitly
   in the requirements and document the residual — otherwise "we added integrity
   checking" will read as though the store were covered, which is exactly the
   error `docs/198-dep-cache-content-keying-and-pnpm-store` already made.

3. **Treat C as optional and orthogonal.** Ship it if cross-repo isolation is
   independently wanted (Q3) and the disk cost is acceptable — not as this
   issue's fix.

4. **Hold `docs/266-orchestrator-git-trust-boundary` E4** until at least step 1
   lands and Q2 is answered (req 8, Q5).

The one-line version: **the cheapest answer really is to stop defeating a check
that already exists — but that is true of npm only. pnpm has no check to stop
defeating: it verifies nothing on install, and hardlinks mean there is no read
to check afterwards.**

## Key files

| File | Why it matters |
|---|---|
| `src/server/orchestrator/overlay-session.ts:607` | `pnpmStoreDirForRuntime` — the runtime-only store key that option C would change. |
| `src/server/orchestrator/session-worker-uid.ts:381` | `shareOne` — where group write is added to all three shared surfaces (docs/270 req 9). |
| `src/server/orchestrator/container-lifecycle.ts:242` | `PNPM_STORE_CONTAINER_PATH` — `/workspace/.pnpm-store`, and the store-ownership handoff. |
| `src/server/orchestrator/session-dir-factory.ts:102` | `createDepCacheDirHelper` — `/dep-cache` keyed per repo, at `{stateDir}/dep-cache/{hash}`. |
| `src/server/session/install-controller.ts` | The install path any brokered-writer design (option B) has to go through. |

## Related

- `docs/075-shared-dependency-cache` — why `/dep-cache` exists and is per-repo.
- `docs/183-overlay-dep-store` — the overlay dependency base.
- `docs/198-dep-cache-content-keying-and-pnpm-store` — content keying and the
  pnpm store. **Its Part 2 "Known caveat" (`plan.md:176-179`) contains a claim
  that measurement refutes**: "the store is also integrity-checked by pnpm on
  link, so corruption is detected, not silently propagated". pnpm 11.22.0
  detects nothing and propagates silently, on every configuration tested. The
  claim should be corrected there as well as noted here — it is a shipped design
  doc asserting a guarantee the code does not provide, and this work initially
  inherited the error from it.
- `docs/270-per-session-worker-uids` — req 9 (sharing must survive) and req 1
  (the workspace analogue of req 1 here); `plan.md` §4 and `checklist.md` both
  name this residual.
- `docs/266-orchestrator-git-trust-boundary` — E4, the sequencing interaction.
