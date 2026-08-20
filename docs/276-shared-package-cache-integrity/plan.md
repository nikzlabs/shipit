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
> that those questions can be answered; it does not choose for them. Q1 in
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
the whole of the protection that exists (hence req 5, and Q2).

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
product decision (Q2), not a technical one.

**Verdict.** Right for H1, and the cheapest thing on the table for it. For pnpm
it is neither cheap nor sufficient. Its honest description is "stop defeating a
check that already exists" — which turns out to be true of npm only.

## Option B — a writer that is not the session

*Sessions read the caches; only a ShipIt-owned process populates them.*

> **⚠️ Ruled out in this form by requirement 9** (2026-08-20): the agent must be
> able to run `npm install` and equivalent commands, and they must work. This
> option replaced the session's own install with a ShipIt-owned fetching step,
> which is exactly what requirement 9 forbids. The section is kept because the
> measurements below are what produced that requirement, and because a **reshaped**
> variant survives — see [Reshaped B](#reshaped-b--mediate-the-fetch-not-the-write).

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

**Read-only permission bits are not enough — it must be a different owner.**
Measured: with the session owning the store file's inode, `chmod 444` on the
store file stops nothing. The session `chmod`s it back **through its own
`node_modules` path** — the same inode, which it owns — and writes. So the store
files must be owned by a ShipIt identity the session is not, which is the exact
reverse of what docs/270 did when it added group write to keep sharing working
(`shareOne`, `session-worker-uid.ts:381`).

**The direct consequence: `node_modules` becomes read-only to the agent.** The
`node_modules` entry and the store file are one inode, so a store file the
session cannot write is a `node_modules` file the session cannot write or
`chmod`. Editing a dependency in place to debug it, and `patch-package`-style
workflows, both stop working. That collides with docs/270 req 10 — "everything
the agent can do inside its own container today MUST still work" — so option B
has to answer it rather than discover it later. pnpm's own escape hatches are
`pnpm patch` and `package-import-method=copy`; the second is priced below.

**Someone else has to fetch.** Sessions install constantly — `agent.install`, the
agent adding a package mid-turn, the user's terminal. A read-only store means a
package that is not already present cannot be fetched by the session at all.
Pre-fetching from the lockfile covers the common case at no per-install cost, but
`pnpm add <new package>` mid-turn still needs an on-demand call into the broker.
And req 2 forbids a *silent* fallback to a private copy, which is precisely what
pnpm does naturally when it cannot write the store — so the broker has to work,
not degrade.

### Variant — copy instead of hardlink *(now the leading candidate)*

`package-import-method=copy` makes `node_modules` entries copies rather than
hardlinks. That alone kills **H3**: with no shared inode, poisoning the store
cannot reach a session that already installed, and `node_modules` stays writable
by the agent. **H2 survives** — a poisoned store is still copied in — so this is
a partial, not a fix.

Its cost is exactly the thing docs/198 Part 2 was written to remove. That doc
measured pnpm degrading to full copies across the overlay boundary at **464 MB
per session** and moved to the shared store specifically to get hardlinks back.
Choosing copy-mode re-buys that cost deliberately. It is worth stating as an
option because it is the only cheap way to close H3, but it trades directly
against req 7 and against docs/198's whole rationale.

**What it closes.** H1, H2 and H3 — and it is the **only** option that closes
H3, because it is the only one that removes the session's write to the inode.
It is also the only option that closes H2 without ShipIt reimplementing pnpm's
missing verification.

**What it breaks.** It strains req 2 hardest. pnpm falling back to a per-session
store on a read-only shared store is precisely the "silently fall back to a
private copy" that req 2 forbids, so the broker has to actually work rather than
degrade. Whether "shared for reads, not for writes" satisfies
`docs/270-per-session-worker-uids` req 9 is Q3, and is the requester's call.

**Verdict.** The only complete answer, and **not available as written** —
requirement 9 forbids replacing the session's install command. Its value now is
that it defines what a complete answer would have to do, which is what "Reshaped
B" has to reproduce without the session noticing.

### Reshaped B — mediate the fetch, not the write

Requirement 9 constrains what the agent **observes**, not how ShipIt implements
it: if `npm install` runs in the session and works, the requirement is met, even
if ShipIt supplies the bytes underneath. That leaves one route open — mediate at
the **registry/network** layer rather than the **filesystem** layer, so the
session keeps running its own install command and keeps owning its own
`node_modules`, while what enters the shared store is fetched and verified by
ShipIt.

**This has now been priced, as [Option D](#option-d--registry-mediation-priced-and-refuted-for-this-threat),
and it is refuted.** The three questions it needed answering were answered
against it, and a fourth killed it outright: the attacker never uses the network,
so a mediator is never asked. Kept here as the record of what was tried.

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

## Option D — registry mediation *(priced, and refuted for this threat)*

*Point every package manager at a ShipIt-owned registry endpoint, so ShipIt
controls and verifies what enters the shared cache. Sessions keep running their
own `npm install`, satisfying req 9.*

This was priced because it looked strictly better than copies on both axes:
verify on the way in, and keep `npm install` working. **It is not better. It
closes none of the three holes**, and the reason is structural rather than a
matter of implementation quality.

**Why it fails: the attacker never uses the network.** Every hole here is a local
write to a shared path. Mediation defends the path from the registry to the
cache. The attack writes to the cache directly and then lets the package manager
read its own local cache.

Measured, each hole against a mediator that works perfectly:

- **H1** — a poisoned packument in the shared npm cache is served **with the
  network fully available**: the install completed in ~400 ms, ran the
  attacker's `postinstall`, and installed attacker content. npm never asked the
  registry, so it could not have asked a mediator either.
- **H2** — a package already present in the pnpm store is never fetched. A fresh
  online install links the poisoned bytes without a request. Nothing to mediate.
- **H3** — no install occurs at all. Nothing to mediate.

**Forcing revalidation is not a rescue, and this is the sharpest result.**
`--prefer-online` and `--cache-max=0` *do* make the poisoned-packument attack
fail closed (`EINTEGRITY`) when the attacker supplies crafted bytes. But an
attacker who instead repoints `is-odd@3.0.1` at a **genuinely published**
package's real tarball URL and real integrity defeats both flags: measured,
`is-even` installed under the name `is-odd`, online, with `--prefer-online` set.
Publishing a package is trivial, so this raises the bar and does not close it —
and a mediator is in exactly the same position, because it would be asked for a
legitimate package with legitimate integrity.

**What actually closes H1 is the lockfile, not the network.** Measured: with a
valid lockfile present, the same poisoned packument is simply ignored — npm uses
the lockfile's `resolved` and `integrity`, and the correct package installs. That
is Q2, and it costs nothing to build.

**What it would cost anyway**, for the record:

- *Interception point.* `npm_config_registry` for npm and pnpm, `YARN_REGISTRY`
  for yarn — ShipIt already sets cache env vars in `buildEnv`, so the hook exists,
  and env beats a repo's own `.npmrc` in npm's config precedence. It does **not**
  beat an explicit `--registry=` inside `agent.install`.
- *Credentials.* Private registries and scoped packages carry their own
  `_authToken`. A mediator must hold or forward them, concentrating users'
  registry tokens in the orchestrator — a new credential surface this design
  would create in order to solve a problem it does not solve.
- *Availability.* One mediator serving every session is a single point of
  failure: if it is down, no session can install anything.
- *Latency.* An extra hop on cold installs. Warm installs are unaffected
  **because they hit the local cache** — so the fast path is precisely the
  unprotected path.
- *Coverage.* npm-ecosystem only. Git and `file:` dependencies, direct tarball
  URLs, `postinstall` scripts fetching arbitrary URLs, and every non-Node
  ecosystem sharing `/dep-cache` (pip, uv) all bypass it.

**Verdict.** Refuted for this issue. It is real defence against a *different*
threat — a compromised upstream registry or a malicious published package — and
if that threat is ever in scope it should be re-priced on its own terms. It is
not a candidate here, and it is worse than copies: more mechanism, a new
credential concentration, a new single point of failure, and zero holes closed.

## The three options side by side

| | **Copies** (`package-import-method=copy`) | **Registry mediation** | **Narrow the store key** |
|---|---|---|---|
| **H1** npm packument RCE | ✗ | ✗ | ✗ |
| **H2** poisoned store installed | ✗ | ✗ | ✗ (same-repo only) |
| **H3** live hardlink mutation | **✓** | ✗ | ✗ |
| Cross-repo reach | unchanged | unchanged | **✓ closed** |
| Cost | ~464 MB per installing session | proxy + credential store + SPOF | disk; loses cross-repo dedup |
| Compatible with req 9 | ✓ | ✓ | ✓ |
| New failure modes | none | mediator down ⇒ no installs anywhere | none |

**And the row that is not one of the three:** lockfile-pinned installs (Q2) close
**H1** outright, cost nothing to build, and are the only thing here that closes a
demonstrated remote-code-execution path. The three options were framed as the
menu; the cheapest real win is not on it.

## Recommendation

**Do not start with C.** It is the cheapest to write, but it buys the least: it
addresses neither demonstrated hole, and per-repo keying is already disproven by
`/dep-cache`. Sequence by what is actually open instead:

1. **Close H1 first — cheap, and it is a working RCE.** Two parts, neither of
   which is a new integrity subsystem:
   - Make ShipIt's installs lockfile-pinned, so npm trusts the lockfile rather
     than the cached packument (subject to **Q2**).
   - **Stop sharing the npm resolution cache while continuing to share the
     content cache.** These live in one directory today but are not equally
     trustworthy: `content-v2` is self-verifying by construction, whereas
     `index-v5` is pure trusted metadata. Per-session `index-v5` with a shared
     `content-v2` keeps essentially all of the download saving — the bytes are
     in the content half — while removing the only part an attacker can
     usefully forge. *(This is a mechanism proposed here, not a requirement; it
     needs a spike to confirm npm tolerates the split.)*

2. **Close H3 with per-session copies** (`package-import-method=copy`).
   Requirement 9 removed the only other route: the session must keep managing its
   own packages, so the shared files cannot be taken away from it, and once the
   session owns them read-only permissions are worthless (measured — see option
   B). Copying breaks the shared inode instead, which is what H3 actually depends
   on. The cost is real and is the exact cost docs/198 removed: ~464 MB per
   session. **Registry mediation was priced as the alternative and refuted** —
   see option D; it closes nothing here, so copies are not being chosen by
   default for lack of a costed rival.

3. **H2 has no cheap answer, and that must be said plainly.** With copies in
   place a fresh install can still be handed tampered bytes, and pnpm verifies
   nothing. Closing it means either ShipIt verifying store contents itself
   (priced against req 7) or Reshaped B. If neither is taken, record the residual
   in the requirements and in shipit-docs — otherwise "we added integrity
   checking" will read as though the store were covered, which is exactly the
   error `docs/198-dep-cache-content-keying-and-pnpm-store` already made.

4. **Treat C as optional and orthogonal.** Ship it if cross-repo isolation is
   independently wanted (Q1 answered (a)) and the disk cost is acceptable — not
   as this issue's fix. Note it stacks badly with step 2: per-repo keying and
   per-session copies both spend disk, and together they spend it twice.

5. **Hold `docs/266-orchestrator-git-trust-boundary` E4** until at least step 1
   lands and Q1 is answered (req 8, Q4).

The one-line version: **the cheapest answer really is to stop defeating a check
that already exists — but that is true of npm only. pnpm has no check to stop
defeating: it verifies nothing on install, and hardlinks mean there is no read
to check afterwards.** And after requirement 9, the way to deal with those
hardlinks is to stop making them, not to take them away from the session.

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
  pnpm store. **Its Part 2 "Known caveat" (under "Store lifecycle") contained a
  claim that measurement refutes**: "the store is also integrity-checked by pnpm
  on link, so corruption is detected, not silently propagated". pnpm 11.22.0
  detects nothing and propagates silently, on every configuration tested. That
  bullet now carries a dated correction note, **corrected in this same PR** — it
  is a shipped design doc asserting a guarantee the code does not provide, and
  this work initially inherited the error from it.
- `docs/270-per-session-worker-uids` — req 9 (sharing must survive) and req 1
  (the workspace analogue of req 1 here); `plan.md` §4 and `checklist.md` both
  name this residual.
- `docs/266-orchestrator-git-trust-boundary` — E4, the sequencing interaction.
