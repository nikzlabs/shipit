---
issue: planning#414
title: Shared package cache integrity between sessions
description: What must be true so that a session cannot use a shared package cache to place or change code that another session runs.
---

# Requirements — shared package cache integrity

Scoping doc for planning#414. The design lives in [plan.md](./plan.md) and is
**not settled**: every open question below has to be answered first.

## Context these requirements are written against

Sessions of the same repo share three caches so installs are fast:

| Surface | Key | Container path |
|---|---|---|
| Dependency download cache (docs/075) | per **repo** | `/dep-cache` |
| pnpm content-addressable store (docs/198) | per **runtime** — spans repos | `/workspace/.pnpm-store` |
| Overlay dependency base (docs/183) | per (repo, runtime, dep-dir) | the dep dir's read-only lowerdir |

`shareOne` (`src/server/orchestrator/session-worker-uid.ts:381`) sets the shared
gid and calls `addGroupWrite` (line 395) on all three, with setgid on
directories — `docs/270-per-session-worker-uids` req 9 being honoured. So
per-session uids did **not** close this, and were never meant to.

**The three are not equally exposed, and the issue's framing flattens them.**
Only the first two are mounted read-write into a session, so only they can be
written directly from inside one. The overlay base subtree is **never mounted
into a session container at all** — deliberately, and the reason given is this
exact hazard (`src/server/orchestrator/overlay-volume.ts:38-43`: a base under
`dep-cache/` "would be writable from inside any session and could mutate the
immutable lowerdir under other sessions' live overlay mounts"). Its group-write
bit is there so overlayfs copy-up yields a writable file, not to grant sessions
access. A session therefore reaches the base only through the **publish** path,
which is a different channel with its own compare-and-swap and is not what these
requirements are about. Requirements below say "shared package cache" meaning
the two directly-writable surfaces unless they name the base.

## Requirements

1. A session MUST NOT be able to cause code of its choosing to run in another
   session by writing to a shared package cache. *(This is the whole point of
   the issue, and the cache-shaped analogue of
   `docs/270-per-session-worker-uids` req 1, which covers workspaces.)*

2. Sessions MUST keep sharing the caches they share today. A session MUST NOT
   fail an install, or silently fall back to a private copy, because a different
   session wrote the shared cache first. *(Inherited verbatim from
   `docs/270-per-session-worker-uids` req 9 — human-approved there, so it binds
   here. It is what rules out "make the caches per-session".)*

3. When content in a shared cache cannot be shown to be the content that was
   asked for, the install MUST fail, or obtain a trustworthy copy. It MUST NOT
   install the untrusted content. Failing closed is acceptable; installing
   anyway is not.

4. The protection MUST cover dependencies a session has **already installed**,
   not only dependencies it installs after the poisoning. *(Observable
   difference, and not a restatement of req 1: a pnpm store file is hardlinked
   into `node_modules`, so changing the store file changes the victim's
   installed file with no second install taking place. Verified — see
   Provenance.)*

5. Requirement 1 MUST hold for a repo that has no lockfile, or whose lockfile
   does not pin an integrity hash for every dependency. *(Supplied — see
   Provenance and Q2. Today the protection that exists is exactly the protection
   a lockfile provides, so a repo without one has none.)*

6. Requirement 1 MUST hold against writes to cached **resolution data** (what
   version and what bytes a dependency name resolves to), not only against
   writes to cached package content. *(Supplied — see Provenance and Q2. Stated
   separately because the content half is already safe and the resolution half
   is the demonstrated hole; a requirement naming only "the cache" would be read
   as satisfied by the half that already works.)*

7. Whatever ShipIt does MUST NOT make a warm install materially slower than it
   is today. *(The caches exist for install speed — docs/075, docs/198. A fix
   that costs the speed the caches were built for fails the feature it is
   protecting.)*

8. ShipIt MUST NOT let a project's own git hooks fire on the orchestrator-side
   auto-commit path (`docs/266-orchestrator-git-trust-boundary` E4) while a
   session can still place executable content in another session's dependency
   directory. *(Supplied — see Provenance and Q4. This is a sequencing
   constraint between two open items, not a requirement to build E4 or to change
   it.)*

9. The agent MUST be able to run `npm install` and equivalent package-manager
   commands inside its own session, and they MUST work. *(Stated by the
   requester, 2026-08-20 — see Resolved questions. This rules out any design in
   which the session cannot manage its own installed packages.)*

## Open questions

Four decisions, and they are yours. The reasoning and the costs are in
[plan.md](./plan.md); this section keeps only what you need in order to choose.
Each blocks implementation. None may be answered by inference.

**The problem in one paragraph.** To keep installs fast, sessions share one copy
of downloaded packages on disk. They share the *actual files*, not copies. So a
session that tampers with a shared file changes what other sessions run — and
because the files are shared rather than copied, this also hits sessions that
**already** installed, without them installing again. Running several sessions
on one project is normal ShipIt use, and those sessions share the most.

**How far does it reach today?** Not equally, and the difference matters for Q1:

| Project type | What it shares | Who can affect it |
|---|---|---|
| npm / yarn | the download cache | **Only sessions of the same project.** The key already includes the project. |
| pnpm | the package store | **Every pnpm project on the same ShipIt instance.** The key is the runtime only — there is no project in it. |

So a private project and an untrusted one opened in another session share one
store, if both use pnpm. A pnpm project gets the shared store only when it is
repository-backed, is not an Ops session, and is detected as pnpm (a
`packageManager` field, a pnpm install command, or a `pnpm-lock.yaml`).

**Q1 — How much protection do you want?**

- **(a) Contain it.** Give the pnpm store a project key, so it matches what npm
  already does. A bad session then reaches only sessions of the *same project*,
  instead of every project on the machine. Cheapest to build, uses more disk, and
  it is **not a fix** — npm is already per-project and is still fully
  exploitable. It leaves the common case open, since several sessions on one
  project is normal use.
- **(b) Give each session its own copy of installed packages.** Today sessions
  share the actual files; this would copy them instead. Tampering then cannot
  reach a session that already installed, and the agent keeps full control of its
  own packages. **← recommended.** Costs roughly 464 MB per session — a cost
  docs/198 was made specifically to remove — and it does not stop a session
  installing *fresh* from being handed a tampered package.

Both are compatible with requirement 9. Neither closes everything; what each does
and does not close is the table in [plan.md](./plan.md).

**Two other approaches were considered and are closed** — kept out of the choice
above because they are no longer live, with the full reasoning in plan.md:
"verify the packages at install time" (a check is only worth its expected value,
and that value sits in the same writable place as the bytes), and "stop sessions
writing the shared copy" (ruled out by requirement 9; its reshaped form was
priced and refuted).

**One thing requirement 9 did not settle.** You rejected "stop sessions writing"
in response to a consequence about **editing files inside installed packages**,
but stated the requirement as **running install commands**. Those are different
capabilities. If the agent must also be able to edit a dependency in place — to
debug it, or for `patch-package`-style fixes — say so, because it further
constrains the answer. I have not assumed it.

**Q2 — May we require projects to pin their dependency versions?**
A "lockfile" records exactly which package versions a project uses. Most projects
have one, and it is standard practice.

Worth having, but **defence in depth, not the fix** — an earlier draft of this
doc overstated it. Measured: a lockfile protects the packages it already pins,
and nothing it has to resolve. `npm install <new-package>` ran the attacker's
code anyway, and so did a plain `npm install` when `package.json` had drifted
ahead of the lockfile. The real fix for that path costs nothing to decide and is
not a question for you — it is step 1 of the plan.

- **(a) Yes, require it.** A project without one installs without the shared copy,
  or gets a warning. **← recommended** — the protection is then maintained by the
  package manager rather than by us.
- **(b) No.** We build and maintain the protection for those projects. More work,
  ongoing.

**Q3 — Does per-session copying conflict with the sharing rule you approved?**
You approved a rule that sessions must keep sharing these copies so installs stay
fast (`docs/270-per-session-worker-uids` req 9). My reading is that Q1 option (b)
**does not break it literally** — the shared download store stays shared; what
stops being shared is the installed files inside each project. But it spends the
disk that rule's rationale was protecting, so the call is yours.

- **(a) It is compatible; proceed.** **← recommended**, on the reading above.
- **(b) It conflicts — do not spend that disk.** This leaves Q1 with only "contain
  it", and the problem substantially open.

**Q4 — Should we hold the other planned change?**
A separate planned change (`docs/266-orchestrator-git-trust-boundary` E4) would
let a project's own scripts run automatically each time ShipIt saves your work.
Those scripts run programs out of the project's installed packages — exactly the
files this problem lets another session tamper with. So that change would turn
"bad code sits on disk" into "bad code runs on a schedule ShipIt chose".

- **(a) Hold it** until this is fixed. **← recommended.**
- **(b) Ship it with a safeguard** that keeps those programs out of reach. I have
  not verified this is possible, and common tools depend on that reach.
- **(c) Ship it unchanged.** Not recommended.

## Provenance

Requirements 1–4 and 7 restate the problem or an already-approved requirement.
Requirements 5, 6 and 8 were **supplied by the agent** and are the reason Q2 and
Q4 exist — they are marked so a reviewer can see what a human did not say.

Requirements 4, 5 and 6 exist because of tests run against this
container's own npm 11.12.1 / pnpm 11.22.0, not because a document claimed it:

1. **npm content cache is already safe.** Overwriting a cached tarball under
   `_cacache/content-v2` is detected (`seems to be corrupted`), the entry is
   discarded, and an offline install fails closed. The content path is
   self-verifying because the path *is* the hash.
2. **npm resolution cache is not.** Rewriting the cached packument's
   `dist.integrity` to point at attacker content placed at its own correct hash
   — plus `hasInstallScript: true` — installs the attacker's package and **runs
   its `postinstall`**, offline, with no warning. This is the demonstrated RCE,
   and `/dep-cache` is already per-repo, which is why req 6 is separate from req 1.
3. **pnpm store files are hardlinked into `node_modules`** (link count 2,
   confirmed by inode). Writing to the store file changed the already-installed
   victim file immediately, and the poisoned code then executed — no reinstall.
4. **pnpm does not verify store content on install either.** A *fresh* install
   (`node_modules` deleted entirely) from a poisoned store silently hardlinks
   the poisoned bytes: online, offline, with `verify-store-integrity=true`, and
   with `package-import-method=copy`. All four installed the attacker's content
   with no warning and no re-download. So the pnpm store has **no** integrity
   check on either path — req 3 is unmet there today, and req 4 is not merely
   "the case without an install".

   *An earlier draft of this doc claimed the opposite, on the strength of one
   offline run that failed with `ERR_PNPM_NO_OFFLINE_TARBALL`. That was a
   package-**presence** failure in a store that had never held the metadata, not
   an integrity check. The independent reviewer caught it; it is recorded rather
   than quietly fixed because* `docs/198-dep-cache-content-keying-and-pnpm-store`
   *carried the same wrong claim and the design leaned on it. That doc's "Known
   caveat" bullet is corrected in the same PR as this one.*

## Resolved questions

**2026-08-20 — the agent must keep being able to install packages.**
Shown the measured consequences of Q1 option (c) ("stop sessions writing the
shared copy at all"), the requester rejected them, stating: *"the agent should be
able to run `npm install` or similar"*. Recorded as **requirement 9**.

What this settles, and what it does not:

- Option (c) **as originally written** is dead. It required a ShipIt-owned
  fetching step in place of the session's own install command.
- It does **not** settle Q1. Three options remain, and (c) survives only in a
  reshaped form where ShipIt mediates *fetching* invisibly and `npm install`
  still works from the agent's point of view. That reshaping is unpriced.
- The requester's words are about **running install commands**. They were said in
  response to a consequence about **editing files inside installed packages**,
  which is a related but distinct capability. Requirement 9 is written to what
  was actually said; the editing capability is asked about separately in Q1, and
  is not assumed.
