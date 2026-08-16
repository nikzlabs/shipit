---
issue: planning#405
title: Design — per-session worker identities
description: A reserved uid range, a shared gid, and a 0700 session directory — plus the four shared surfaces that stop working if you only do the first.
---

# Design — per-session worker identities

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`. Both open questions were answered on 2026-08-16 (Q1 → a reserved
range, Q2 → new sessions only), so this design is live.

## 1. The shape of the problem

The naive reading of planning#405 is "allocate a uid per session". That part is
half a day's work. The reason this feature is not half a day is that **one uid
is load-bearing in four places that are shared between sessions on purpose**,
and none of them fails until something real runs:

| Shared surface | Why one uid works today | What breaks with N uids |
|---|---|---|
| `/dep-cache` (per-repo npm cache) | every session writes it as 1000 | session B cannot write what session A created |
| `/workspace/.pnpm-store` (per-runtime store) | same | same, and `pnpm install` dead-ends with no in-session recovery |
| overlay dependency base (docs/183) | base chowned to 1000; overlayfs copy-up **preserves the lower file's owner**, so the copy is writable | a base owned by anyone else copies up unwritable — the exact bug docs/183's chown exists to fix |
| `/credentials/.gitconfig` | 0600, owned by 1000 — the identity and push credential for dropped-uid git | readable by one session; every other session's git loses its identity and its credential |

A design that changes only the uid passes every test in the suite and then
breaks `npm install` in production. Requirement 9 exists for this.

There is also a fifth thing, which is not a *shared surface* but a shared
**inode**, and it is the one that would have made the whole feature decorative.

### `.git/objects` is hardlinked across every clone of a repo — measured

`RepoGit.cloneFromCache` runs `git clone --local <bareCache> <sessionDir>`
(`repo-git.ts:384`) and `session-fork-merge.ts:54` does the same clone from one
session's workspace into another. Measured here against git 2.39.5 — a bare repo
and two `--local` clones report the **same inode** for the same object file:

```
38039617 bare.git/objects/4d/085326e34d11fd815fd1d514c3066acb4477da
38039617 c1/.git/objects/4d/0853…
38039617 c2/.git/objects/4d/0853…
```

An inode has exactly one owner across all its links. The orchestrator's own
`chownWorkspaceGitToSessionWorker` never touches object *files*
(`session-worker-uid.ts:388-408`) — but the container entrypoint's
`chown -R "$UID_GID:$UID_GID" /workspace` does. Under one shared uid that is
invisible. Under per-session uids, the first boot of a new session hands **that
session** ownership of object files that the bare cache and every sibling clone
— including old, shared-uid sessions — read. Ownership is `chmod` and rewrite
rights, so the payload could corrupt or lock the repository content of every
other session of that repo. That is precisely the cross-session write requirement
1 forbids, arriving through the mechanism that was supposed to close it.

### The drop uid is currently attacker-choosable, once uids differ

`resolveGitTreeUid` (`shared/git-tree-uid.ts:106-121`) `stat`s the directory git
is about to run in and drops to its owner. The workspace is bind-mounted
read-write into compose services, and an **Open** session's service may run as
root — the numeric-non-root `user:` rule is enforced for *contained* services
only (`compose-generator.ts:1338-1353`). So a root service in session A can
`chown` A's own workspace to any uid it likes, and ShipIt's next git operation in
session A runs as that uid. Today that is meaningless: there is one session uid.
The moment uids differ, it is session A naming the identity ShipIt's own git
process will hold — and the payload that then executes through `.git/config`
lands there. Requirement 2 is what forbids it.

## 2. The design

Five parts. Parts A and B are the feature; C, D and E are what keeps
requirements 4, 9 and 10 true while it lands.

### A. A reserved range, allocated once, never reused (reqs 3, 4a, 6, 7, 11)

`SESSION_UID_MIN = 2_000_000`, `SESSION_UID_MAX = 2_999_999` — one million
identities in a band nothing else uses. The range is chosen against the numbers
that actually occur: distro system accounts stop at 999, conventional user
accounts and every image account a project might name (`33`, `101`, `999`,
`1000`, `1001`) sit in the low thousands, `nobody` is 65534, and the rootless /
userns `subuid` convention starts at 100000 and runs to ~165536. 2 000 000 is
clear of all of them and far below the 32-bit `uid_t` ceiling.

Two properties fall out for free rather than being enforced:

- **911 and 912 can never be allocated** (req 3), because the range does not
  contain them. That is not an argument to skip the check: `assertSessionUidRange`
  runs at boot next to the existing `assertWorkerUidNotReserved` and refuses to
  start if the constants are ever edited into overlapping
  `RESERVED_EGRESS_UIDS`. The existing refusal is a runtime parse of an operator
  variable; this one is a compile-time-shaped invariant, and it fails at boot
  because that is where the existing pattern puts it.
- **Reuse never happens** (req 7). Allocation is a monotonic counter, so a
  retired identity is never handed out again and "a recycled uid must not reach
  the previous holder's leftovers" is satisfied vacuously rather than by a
  cleanup path that has to be correct. One million identities at, say, 200 new
  sessions a day is 13 years; exhaustion fails session creation loudly with the
  number and the range (req 11), and never falls back to sharing.

The ledger persists only the NEXT uid to hand out, in its own one-row table.
Deliberately **not** a column on `sessions`: the record of a session's identity is
the owner of its session directory (§2B), and a second copy on the row would be a
thing that can drift from it. A `MAX(uid) + 1` over `sessions` could not have
served either — deleting the highest row lowers the maximum and re-issues its
uid, which is exactly the reuse requirement 7 forbids.

"Created before this shipped" therefore reads off the filesystem too: a session
directory whose owner is outside the reserved range is a pre-docs/270 session,
which is requirement 8a's population.

### B. The session directory is the record, and the seal (reqs 1, 2, 5, 8b)

`<sessionsRoot>/<sessionId>` becomes **owned by the session's identity and mode
0700**. Two functions create one — `createSessionDirFactory` and `forkSession`,
which builds the path itself — so both go through a single
`allocateAndSealSessionDir`, and a guard test asserts they do: a creator that
skipped it would leave exactly one kind of session with no identity and no
boundary, which is the shape of gap nobody notices. It does two jobs at once:

- **It is the trusted record of the identity (req 2).** `buildMounts` mounts
  `<sessionDir>/workspace`, the per-session credentials subtree, uploads,
  scratch, session state, the plugin store, the dep cache and the pnpm store —
  it never mounts the session directory itself. Nothing inside a session can
  write it, so its owner cannot be forged from inside the session the way the
  workspace's owner can. `resolveGitTreeUid` therefore stops asking "who owns
  this tree" and asks "which session directory is this path inside, and who owns
  *that*". Requirement 5 comes with it: the record is a file-system fact that
  survives every restart, with no cache to go stale.
- **It is the seal (req 1).** 0700 denies traversal to every other uid, so no
  inner file's mode matters — a session's workspace, its state dir and its
  scratch are all behind one directory bit, and no writer downstream has to
  remember a mode. `sessionsRoot` itself stays root-owned 0755 so each session
  can traverse to its own.

  The per-session **credentials** subtree is sealed the same way, and it is worth
  saying it is not part of requirement 1 — that requirement is scoped to another
  session's *workspace*. It is included because it is the same directory bit on a
  directory the same code already hands to the same identity, and leaving the
  agent's provider credentials cross-readable while sealing source trees would be
  an odd place to stop.

**Old sessions are sealed too, without being migrated (req 8b).** At boot, every
session directory that is still **root-owned** — the state a pre-docs/270 session
directory is in, since nothing ever chowned it — is chowned to the *global*
worker uid and chmod'ed 0700. That is one non-recursive `lchown` + `chmod` per session — no
tree walk, no first-boot cost, no identity change — and it is what makes Q2's
answer mean what it says: a new session's payload cannot read an old session's
workspace, and an old session's payload cannot read a new one's. Old sessions
still reach **each other**, which is the residual requirement 12 obliges the
write-up to name.

### C. One shared gid, and why the group is not the isolation (req 9)

Every session keeps **gid = the global `SHIPIT_SESSION_WORKER_UID` value**
(1000 in the deployment files) as its primary group. Only the uid is per-session.
That is what keeps all four shared surfaces of §1 working: they become
`root:<sharedGid>` with the group bit set (`2775` on directories, so new entries
inherit the group), and `/credentials/.gitconfig` becomes `0640 root:<sharedGid>`
— reachable by every session's git for its identity and its push credential,
which is the same reach it has today and no wider.

The obvious objection is that a shared group re-opens what the uid just closed.
It does not, because **the isolation is the 0700 session directory, not the
group**. Group-readability of a file inside a session's tree is unreachable: the
other session cannot traverse the directory that contains it.

The shared group has to be the **primary** gid, not a supplementary one, for a
reason that is easy to get wrong: Node's `spawn({uid, gid})` maps to libuv's
`setgid`/`setuid` with no `setgroups`/`initgroups`, so a dropped orchestrator-side
git has whatever supplementary set the root parent had — never one we chose. Any
design that reached the shared surfaces through a supplementary group would work
in the container and silently fail in the orchestrator.

### D. The entrypoint stops re-owning hardlinked objects (req 1)

The `/workspace` arm of the entrypoint's chown loop becomes a `find` that chowns
every directory and every non-object file, and **prunes regular files under
`.git/objects/` and `.git/lfs/objects/`**. The object *directories* are still
chowned — the worker must be able to create a new object in a fanout dir — which
is the same split `chownGitMetadataRecursive` already makes on the orchestrator
side, now applied on the container side for the reason §1 measured. Every other
mount keeps its plain `chown -R`.

### E. Compose, plugins, and the supplementary groups (reqs 4, 4a, 10)

- **Fill-in** (`compose-generator.ts:1728-1740`) becomes
  `user: <sessionUid>:<sharedGid>` — still only when `svc.user === undefined`,
  so req 4's "we never override a deliberate choice" is untouched.
- **Refusal** (req 4a): a declared `user:` whose uid falls in
  `[SESSION_UID_MIN, SESSION_UID_MAX]` is refused during validation, in the shape
  of the existing reserved-UID error (`compose-generator.ts:1338-1353`) and with
  the same explain-why phrasing. This is the one class of declaration that stops
  working, and the range is chosen so no real project is in it.
- **Plugin containers** (`plugin-cli-run.ts:784`, `plugin-install.ts:529`) take
  the session's identity, not the global one — they write that session's
  workspace and overlay.
- **Supplementary groups (req 10).** The entrypoint's privilege drop prefers
  `gosu <uid>` (which initializes supplementary groups from `/etc/group`) and
  falls back to `gosu <uid>:<gid>` (which calls `setgroups()` with an empty list)
  when no passwd entry matches. An allocated uid has no passwd entry, so the
  fallback would be taken on every boot and ops sessions would lose the host
  journal. The fix is one command before the drop: `usermod -u <sessionUid> shipit`,
  which moves the image's existing account to the allocated uid and keeps its
  primary gid and its whole supplementary set. The existing fallback and its
  stderr warning stay for the case where `/etc` is not writable
  (`SESSION_READONLY_ROOTFS=1`) — best-effort, exactly like the journal block
  above it.

## 3. Options not taken

- **Per-session gid as well as per-session uid.** Rejected: it breaks all four
  shared surfaces of §1 with nothing to replace them, and the supplementary-group
  route back is unavailable in the orchestrator (§2C).
- **A mount namespace per git operation** instead of a uid — `unshare -m` so the
  process sees only its own session's tree. Strictly better isolation, and unlike
  docs/266 option C it is a syscall rather than a container, so it does not
  acquire a Docker dependency on the commit path (docs/266 req 6). Rejected here
  because it needs `CAP_SYS_ADMIN` in the orchestrator container, which is not in
  Docker's default capability set — a deploy change that trades a broad new
  capability for the isolation, and one this feature was not asked to make. Worth
  revisiting if the uid approach ever needs a second layer.
- **Deriving the uid by hashing the session id**, avoiding allocation state
  entirely. Rejected on arithmetic: at 10⁶ identities and ~1000 live sessions the
  birthday collision probability is around 40%, and a collision silently returns
  two sessions to today's shared-uid behaviour — the failure mode requirement 6
  exists to prevent, arriving invisibly.

## 4. What this does NOT close

Named, per requirement 12 and docs/266's habit of naming residuals rather than
rounding them off.

- **Pre-existing sessions still reach each other.** Requirement 8a, decided. They
  keep the shared identity and are sealed only against sessions that hold a
  distinct one. The residual shrinks as they are archived and never grows.
- **Shared package caches remain mutually writable between sessions of the same
  repo/runtime.** `/dep-cache` and the pnpm store are shared by design (req 9)
  and group-writable by construction (§2C), so a payload in one session can
  poison a cached tarball or a content-addressed store entry that another session
  of the same repo later installs — and a pnpm store entry is hardlinked into the
  consumer's `node_modules`, so that is code execution in the other session's
  container. **This is pre-existing** — every session shares uid 1000 today, so
  the same write is available now — and this feature neither widens nor narrows
  it. It is not in requirement 1's scope ("another session's workspace"), it is
  the largest remaining cross-session channel, and it is filed as
  **planning#414** rather than left as a sentence.
- **planning#384 is not closed.** `safe.directory` is still `*` (planning#403),
  the dropped git still reaches the PAT (planning#404), and a project's hooks
  still do not fire on ShipIt's auto-commit (docs/266 E4).

## 5. What I could not verify

Per req 8 of docs/266 and `CLAUDE.md` ("verify an inherited guarantee at the
source"), separating what was read, what was measured, and what is inferred.

- **Measured here:** `git clone --local` shares object inodes across the bare
  cache and sibling clones (§1, output quoted).
- **Read at the line, not exercised:** every code citation in §1 and §2.
- **Inferred, not measured:** that libuv's `uv__process_child_init` performs no
  `setgroups`, so `spawn({uid, gid})` leaves the parent's supplementary set in
  place. This is the premise under §2C's "primary, not supplementary" rule. If it
  is wrong, the rule is merely unnecessary, not unsafe.
- **Not exercisable in a session container:** the uid drop itself, a
  foreign-owned tree, and the 0700 seal against a *different* uid. There is no
  root here and `unshare -r` is refused, which is the same limit docs/266
  recorded. Everything uid-dependent is therefore behind an injection seam and
  tested through it; the seal is tested as "the mode and owner we set", not as
  "another uid was denied".
- **Not measured:** the boot-time seal's cost on a fleet with many sessions. It
  is one `lchown` + one `chmod` per session directory with no recursion, so it
  should be milliseconds, but no fleet-sized run was done.

## Key files

- `src/server/orchestrator/session-worker-uid.ts` — the uid gate, the reserved-uid
  refusal, and every chown helper.
- `src/server/orchestrator/session-uid-allocator.ts` — **new**: the range, the
  monotonic allocation, the boot-time range assertion.
- `src/server/shared/git-tree-uid.ts` — the drop decision; becomes session-dir
  based (req 2).
- `src/server/orchestrator/session-dir-factory.ts:30` — where a session directory
  is created, and now owned and sealed.
- `docker/session-worker/entrypoint.sh` — the chown loop (§2D) and the privilege
  drop (§2E).
- `src/server/orchestrator/compose-generator.ts:1338,1728` — the `user:` refusal
  and the fill-in.
- `src/server/orchestrator/git-config.ts:236` — the global gitconfig's mode and
  owner.
- `src/server/orchestrator/container-lifecycle.ts:573` — the env forward.
