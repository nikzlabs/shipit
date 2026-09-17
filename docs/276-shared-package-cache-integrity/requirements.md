---
issue: planning#414
title: Shared package cache integrity between sessions
description: What must be true so that a session cannot use a shared package cache to place or change code that another session runs.
---

# Requirements — shared package cache integrity

Scoping doc for planning#414. The design lives in [plan.md](./plan.md).
**No open questions remain** — every one has a dated receipt below.

## Context these requirements are written against

**The problem in one paragraph.** To keep installs fast, sessions share one copy
of downloaded packages on disk — the *actual files*, not copies. So a session that
tampers with a shared file changes what other sessions run, and because the files
are shared rather than copied this also reaches sessions that **already**
installed, without them installing again. Running several sessions on one project
is normal ShipIt use, and those sessions share the most.

**The reach is not the same for every project type.** An npm or yarn project
shares its download cache only with sessions of the *same* project, because the
key already includes the project. A pnpm project shares its package store with
**every pnpm project on the same ShipIt instance**, because the key is the runtime
only. So a private project and an untrusted one, opened in two sessions, share one
store if both use pnpm. A pnpm project gets the shared store only when it is
repository-backed, is not an Ops session, and is detected as pnpm (a
`packageManager` field, a pnpm install command, or a `pnpm-lock.yaml`).

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
   Provenance. When written, the only protection that existed was the protection a
   lockfile provides, so a repo without one had none. **Satisfied** by the
   per-session resolution cache, measured 2026-09-17 — see Resolved questions.)*

6. Requirement 1 MUST hold against writes to cached **resolution data** (what
   version and what bytes a dependency name resolves to), not only against
   writes to cached package content. *(Supplied — see Provenance. Stated
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
   directory. *(Supplied by the agent, and **approved by the requester
   2026-09-17** in answer to Q4 — see Resolved questions. A sequencing constraint,
   not a requirement to build E4 or to change it.)*

9. The agent MUST be able to run `npm install` and equivalent package-manager
   commands inside its own session, and they MUST work. *(Stated by the
   requester, 2026-08-20 — see Resolved questions. This rules out any design in
   which the session cannot manage its own installed packages.)*

10. Requirement 1 MUST be met **without** materially increasing per-session disk
    use. Isolating sessions from each other and keeping the storage savings are
    both required; a design that buys one with the other does not satisfy this.
    *(Stated by the requester, 2026-09-17, rejecting both options offered for Q1
    — see Resolved questions. "Materially" is the requester's standard to set;
    the measured cost of the recommended design is ~1%.)*

11. The agent MUST be able to edit files inside installed packages in its own
    session — a `patch-package`-style fix, or changing a dependency to debug it —
    and the edit MUST NOT be visible to any other session. *(Stated by the
    requester, 2026-09-17, answering Q5 — see Resolved questions for their exact
    words and how I read them.)*

## Open questions

**None.** Every question this doc raised has been answered or withdrawn, each with
a dated receipt under [Resolved questions](#resolved-questions). Requirements
discipline no longer blocks implementation of this feature.

That is a statement about *questions*, not about certainty. Two measured gaps are
recorded in [plan.md](./plan.md) and on the checklist, and neither is a decision
for the requester: the pnpm store sits outside any overlay as deployed, so option F
does not cover it yet; and the H1 spike has not measured warm-install time against
req 7, nor whether a symlinked `content-v2` survives `npm cache verify`.

## Provenance

Requirements 1–4 and 7 restate the problem or an already-approved requirement.
Requirements 9 and 10 are the requester's, each with a dated receipt.

Requirements **5, 6 and 8 were supplied by the agent**, and are marked so a
reviewer can see what a human did not say. Two of the three have since been
settled by the requester rather than by me: req 5 raised Q2, which measurement
answered and which I then **withdrew myself** — the one place in this doc where a
question for the requester was closed without the requester closing it — and req 8
raised Q4, which the requester has now **approved**. Req 6 remains agent-supplied
and unexamined by anyone but me.

An agent-supplied requirement that generates a question for the requester deserves
the most scepticism in review: it is the shape most likely to be a mechanism I
chose wearing a requirement's clothes. Requirements 9, 10 and 11 are the
requester's own words, each with a dated receipt; **requirement 11 carries a
reading I had to make**, which its receipt states explicitly.

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
4. **pnpm DOES verify store content when it installs — but nothing is installed
   in case 3.** Measured 2026-09-17 with a controlled harness
   ([`verify-h2.sh`](./verify-h2.sh), 24 cells per version, each with a clean
   negative control, identical on pnpm 11.22.0 and 12.4.2): a fresh install from
   a poisoned store evicts the bad entry and re-downloads it online, and **fails
   closed** offline. The check is on the content hash. Its one off switch is
   `verify-store-integrity=false`, which disables it completely.

   This is what makes **req 4 the requirement that matters**: the protection is
   real on the install path and irrelevant on the path in case 3, where no
   install happens at all and so no check can fire.

   *This point has been stated three ways in three weeks — "verified on link",
   then "not verified at all", now the above. The first two were each measured
   without a negative control, so a run that failed for an unrelated reason read
   as confirmation; the "not verified" version was additionally agreed with by an
   independent reviewer working from the same uncontrolled evidence. The harness
   is committed beside this doc so the claim need not be taken on trust.*
   `docs/198-dep-cache-content-keying-and-pnpm-store` *carried the first two
   versions and is corrected in the same PR as this one.*

## Resolved questions

**2026-09-17 — Q4 answered: hold E4.** Asked whether to hold
`docs/266-orchestrator-git-trust-boundary` E4 — which would let a project's own git
hooks run on every ShipIt auto-commit — until the H3 fix ships, the requester chose
**(a) Hold it**.

This does not add a requirement. It **approves requirement 8**, which the agent had
supplied and which had been carrying a caveat that it was unapproved. Req 8 is now
human-approved and binds the sequencing: E4 stays unshipped until a session can no
longer place executable content in another session's dependency directory.

**2026-09-17 — Q5 answered: yes, and a note on how I read it.** Asked whether the
agent must be able to edit files inside installed packages, the requester selected
**(a) Yes**, writing: *"yes, the agent should be able to call `npm install` or
similar"*.

Recorded as **requirement 11**. The reading needs stating, because their words and
the option they chose are not word-for-word the same thing, and this exact
distinction was preserved deliberately on 2026-08-20:

- The **option selected** is the editing capability — that is what Q5 asked and
  what (a) says.
- The **words** restate requirement 9, the install-command capability.
- I read the selection as controlling. Under the other reading the answer would be
  vacuous: it would restate a requirement recorded a month ago and leave Q5
  unanswered, which is not what selecting (a) means. "Or similar" also reads
  naturally as covering ordinary package workflows, of which `patch-package` is
  one.

**If that reading is wrong, requirement 11 is the thing to strike** — it is the
only place the editing capability is recorded, and it costs little to drop: under
the recommended design the property comes free (a measured 64 KB copy-up), so
removing the requirement changes what we must *preserve*, not what we build.

**2026-09-17 — Q2 withdrawn: the lockfile question was never load-bearing.**
Asked whether Q2 was relevant at all, the answer is no, and it is withdrawn rather
than left for the requester to answer.

Q2 asked whether ShipIt may require projects to pin dependency versions. It existed
because requirement 5 demands that requirement 1 hold for a repo with **no
lockfile**, and at the time a lockfile looked like the only available protection.
Two measurements removed its reason to exist:

- A lockfile **does not** close the hole: it covers `npm ci` and an in-sync
  `npm install`, but not `npm install <new-package>` nor an out-of-sync lockfile.
- The per-session npm **resolution cache** does close it, including for a repo with
  no lockfile at all. Measured: with a private `index-v5` and a shared, symlinked
  `content-v2`, an offline install succeeds, and an attacker's write to the shared
  `index-v5` has **no effect** on the victim — where the same write against today's
  shared cache breaks the victim's install outright. The private half is **64 KB**
  against **688 KB** shared, so it costs almost nothing.

Requiring a lockfile would therefore have been a user-facing policy change that
bought nothing the fix does not already provide. Requirement 5 stands and is
satisfied; no requirement is added.

**2026-09-17 — both Q1 options rejected; the requirement is to have both.**
Presented with Q1's two options — project-key the store, or give each session its
own copy — the requester rejected both and restated the requirement: *"find a way
to keep the space savings but avoid sessions to affect each other. Both options you
presented are not good."*

This is a rejection of the **trade-off**, not a choice within it, and it was
correct: the trade-off was an artefact of the storage, not of the problem. Measured
the same day on a loopback XFS (`reflink=1`) image — see [plan.md](./plan.md)
option E:

- Copy-on-write imports give each session its **own inode** with **shared
  extents**. Poisoning the store no longer reaches a session that already
  installed, and the data is still stored once.
- Cost: **92 MB vs 91 MB** for a 3 353-file, 86 MB `node_modules` — about **1%**,
  being per-inode metadata. Not the ~1.8× a real copy costs.
- The store stays shared and `pnpm install` is untouched, so **req 2 and req 9
  both hold**.

**Q3 is closed by the same finding.** It asked whether giving each session its own
copy conflicts with the sharing rule the requester approved
(`docs/270-per-session-worker-uids` req 9), since that rule exists to protect the
disk. Copy-on-write removes the disk cost, so there is no conflict left to rule on.

Recorded as **requirement 10**. What follows from it is design, not further
questions for the requester, and is worked out in plan.md:

- The setting is `package-import-method=copy`. It reflinks automatically where the
  filesystem allows and never fails where it does not, so it is correct on every
  host and needs no second change later.
- Reflink cannot cross a filesystem boundary, so where it is the mechanism, the
  store and the workspaces must sit on one reflink-capable filesystem.
- On a filesystem without reflink — ext4, which is what most laptop installs have —
  **overlayfs** supplies the same property with no help from the filesystem at all
  (plan.md option F). A loopback image was considered for this and **withdrawn**:
  it needs privileges the orchestrator does not take, and ShipIt installs on
  laptops.

**2026-08-20 — the agent must keep being able to install packages.**
Shown the measured consequences of Q1 option (c) ("stop sessions writing the
shared copy at all"), the requester rejected them, stating: *"the agent should be
able to run `npm install` or similar"*. Recorded as **requirement 9**.

What this settles, and what it does not:

- Option (c) **as originally written** is dead. It required a ShipIt-owned
  fetching step in place of the session's own install command.
- It did **not** settle Q1, which stayed open until 2026-09-17 (see the receipt
  above). The reshaped form of option (c) — ShipIt mediating *fetching* invisibly
  so `npm install` still works from the agent's point of view — was later priced
  as plan.md option D and **refuted**: the attacker writes the shared files
  directly and never asks the registry.
- The requester's words are about **running install commands**. They were said in
  response to a consequence about **editing files inside installed packages**,
  which is a related but distinct capability. Requirement 9 is written to what was
  actually said; the editing capability is asked separately as **Q5** and is still
  not assumed.
