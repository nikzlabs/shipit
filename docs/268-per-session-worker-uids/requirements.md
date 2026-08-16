---
issue: planning#405
title: Per-session worker identities, so one session's payload cannot reach another's workspace
description: What must be true once a session's uid stops being the same uid every other session has.
---

# Requirements — per-session worker identities

Tracked by planning#405. Required by
[docs/266 requirement 13](../266-orchestrator-git-trust-boundary/requirements.md);
constrained by docs/266 requirement 12. This document states **what must be
true**. The design is in [plan.md](./plan.md).

## The residual this closes, in one sentence

docs/266 E1 made orchestrator-side git run as the uid that owns the tree instead
of as root — but **every session's tree is owned by the same uid**, and the
orchestrator container mounts every session's tree, so a payload that executes
during session A's git operation can still read and write session B's workspace.

## Requirements

1. Code that executes during an orchestrator-side git operation on one session's
   workspace MUST NOT be able to read or write any other session's workspace.
   Read matters as much as write: a competitor's source, a `.env` a user pasted
   in, and an agent transcript are all disclosed by a read alone.

2. ShipIt's own git operations on a session's workspace MUST run as that
   session's identity **even when the workspace's file ownership has been
   changed from inside the session**. The identity is ShipIt's own record of the
   session; it MUST NOT be a fact read from somewhere the session can write.
   *(Supplied by this document — see Provenance. It is not pedantry: today the
   drop uid is read by `stat`ing the tree, and the tree is writable by the
   untrusted side, so once uids differ per session the predicate becomes
   attacker-chosen.)*

3. ShipIt MUST NOT give any session the identity `911` or `912`. A configuration
   or an allocation that would produce one MUST be refused at boot, with one
   clear message, rather than at the first operation that happens to use it.
   *(Carried in from planning#405, verified at `session-worker-uid.ts:33-60`:
   the netns firewall exempts both uids by owner-match, so a workload holding
   either escapes egress containment.)*

4. A session whose compose services declare an explicit numeric `user:` MUST
   keep working: the session starts, its services run, the declared `user:` is
   still honoured, and ShipIt's own git on that workspace does not fail because
   of it. *(docs/266 requirement 12, stated by the requester on 2026-08-16 and
   explicitly inherited by this follow-up.)*

5. A session's identity MUST be stable for the whole life of the session —
   across container restart, container recreation after idle disposal,
   orchestrator restart, and host reboot. The files a session left on disk still
   belong to it when it comes back.

6. Two sessions that exist at the same time MUST NOT hold the same identity.

7. If an identity is ever reused after a session is deleted, the new holder MUST
   NOT gain access to anything the previous holder left on disk.

8. Sessions that already exist when this ships MUST keep working. Upgrading MUST
   NOT lose a session's work, make its workspace unreadable to its own agent, or
   require the user to do anything.

9. Sessions MUST keep sharing the caches they share today — the per-repo
   dependency cache, the pnpm store, and the overlay dependency base. A session
   MUST NOT fail an install, or silently fall back to a private copy, because a
   different session wrote the shared cache first.

10. Everything the agent can do inside its own container today MUST still work
    after the change. This explicitly includes the ops-session host journal read,
    which works only because the worker holds a supplementary group whose id is
    read off the host mount at boot.

11. Running out of identities MUST be impossible in normal operation. If it can
    happen at all, session creation MUST fail loudly and say so, and MUST NOT
    fall back to sharing an identity that is already in use.

12. The write-up of this work MUST state which sessions actually carry a distinct
    identity. Any session that does not still carries the docs/266 residual and
    MUST be counted and named as such, not folded into a claim that the residual
    is closed.

## Requirement provenance

Separating what was handed to this feature from what it supplied, per `CLAUDE.md`
("don't promote your mechanism into a requirement").

| Req | Handed to this feature | Supplied by this document |
|---|---|---|
| 1 | ✅ planning#405 and docs/266 req 13, near-verbatim | the explicit "read matters as much as write" clause |
| 2 | — | supplied; see the note on the requirement and §"What is already true" |
| 3 | ✅ planning#405, with the source cited | — |
| 4 | ✅ docs/266 req 12 (requester, 2026-08-16), inherited by name | — |
| 5 | — | supplied; a per-session identity that did not survive a restart would orphan the session's own files |
| 6 | — | supplied; it is what "per-session" means, stated so it can be tested |
| 7 | — | supplied; reuse is the obvious way to bound the identity space, and it is the obvious way to re-open req 1 |
| 8 | — | supplied; every session in the fleet already has files owned by the shared uid |
| 9 | — | supplied, from reading the three shared surfaces (see below). This is the requirement most likely to be missed, because nothing fails until an install runs |
| 10 | — | supplied, from the entrypoint's own journal-group block |
| 11 | — | supplied |
| 12 | ✅ docs/266 req 13's "MUST NOT be described as closed" applied to this feature's own outcome | the "count and name them" wording |

Requirements 2 and 9 are the two places this document went beyond what it was
handed, and both are load-bearing: 2 is what stops the new uid from being chosen
by the attacker, and 9 is what stops the change from silently breaking every
`npm install` that relies on a shared cache.

## What is already true (verified here, not inherited)

Read in this repository at the lines cited; nothing in this section is taken on
a doc's word.

- **Every session's workspace is owned by one uid.** `sessionWorkerUid()`
  (`session-worker-uid.ts:98`) parses a single global `SHIPIT_SESSION_WORKER_UID`;
  the container entrypoint reads the same variable
  (`docker/session-worker/entrypoint.sh:23`) and `gosu`es to it; compose fills in
  `user: ${workerUid}:${workerUid}` for a service that declares none
  (`compose-generator.ts:1728-1740`). One value, every session.

- **The orchestrator mounts every session's tree.** `workspace:/workspace` at
  `deployment/vps/docker-compose.yml:30-34`, with each session at
  `<sessionsRoot>/<sessionId>/workspace` (`session-dir-factory.ts:30-31`).

- **The drop uid is currently read off the tree.** `resolveGitTreeUid`
  (`shared/git-tree-uid.ts:106-121`) `stat`s the directory git is about to run
  in and returns its owner. The workspace is bind-mounted read-write into
  compose services, and an **Open** session's service may run as root — the
  numeric-non-root `user:` rule is enforced for *contained* services only
  (`compose-generator.ts:1338-1353`). A root service can therefore `chown` its
  own session's workspace to any uid. Today that is meaningless because there is
  only one session uid; the moment uids differ it lets session A name the uid
  ShipIt's own git will run as. This is what requirement 2 exists for.

- **`.git/objects` files are hardlinked across every session of a repo, and into
  the shared bare cache.** `RepoGit.cloneFromCache` runs
  `git clone --local <bareCache> <sessionDir>` (`repo-git.ts:384`) and its own
  comment says hardlinks are the point; `session-fork-merge.ts:54` does the same
  from one session clone to another. An inode has exactly one owner across all
  its links — the property docs/232 already relies on for the LFS store — so
  *any* recursive chown that touches those files re-owns them for every other
  clone and for the cache. `chownWorkspaceGitToSessionWorker` deliberately does
  not (`session-worker-uid.ts:388-408`), but the container entrypoint's
  `chown -R "$UID_GID:$UID_GID" /workspace` does
  (`docker/session-worker/entrypoint.sh`, the mount loop). Under one shared uid
  that is invisible. Under per-session uids it hands one session ownership — and
  therefore `chmod` and rewrite rights — over object files every other session
  reads. Requirement 1 covers it; the design has to say so explicitly.

- **Three surfaces are shared between sessions and are written, not just read.**
  The per-repo dependency cache mounted at `/dep-cache`
  (`container-lifecycle.ts`, "share downloaded packages across all sessions for
  the same repository"), the shared pnpm store at `/workspace/.pnpm-store`
  (`ensurePnpmStoreDir`, `container-lifecycle.ts:280-296`), and the overlay
  dependency base, which is materialized once per scope and chowned to the
  worker uid precisely because overlayfs copy-up **preserves the lower file's
  owner** (`overlay-base.ts:490-499`). All three assume one uid today.

- **The orchestrator's global gitconfig is a single file owned by the worker uid
  at 0600** (`git-config.ts:236-248`), in a `/credentials` at 0711. It is what
  gives dropped-uid git its identity and its push credential. One uid can read
  it; N uids cannot.

- **The entrypoint's privilege drop already has a no-passwd-entry fallback, and
  it is lossy.** `gosu <uid>` (the user form, which initializes supplementary
  groups from `/etc/group`) is used only when a passwd entry exists whose primary
  gid equals the uid; otherwise it warns and falls back to `gosu <uid>:<gid>`,
  which calls `setgroups()` with an empty list. An allocated uid has no passwd
  entry in the image, so it takes the lossy path by default — and the host
  journal becomes unreadable for ops sessions. Requirement 10 is what forbids
  leaving it there.

- **Node's uid drop does not touch supplementary groups.** `child_process`
  `spawn({uid, gid})` maps to libuv's `setgid`/`setuid`; there is no
  `setgroups`/`initgroups`, so a dropped orchestrator-side git keeps the parent
  root process's supplementary set. Any design that gives the dropped git access
  through a *supplementary* group therefore does not work. (Read in libuv's
  `uv__process_child_init`; not measured here — see plan.md §"What I could not
  verify".)

- **A session identity has an obvious authoritative home already.** The session
  directory `<sessionsRoot>/<sessionId>` is the parent of the workspace and is
  **not** mounted into any container (`buildMounts` mounts
  `<sessionDir>/workspace`, the per-session credentials subtree, uploads,
  scratch, session state, the plugin store, the dep cache and the pnpm store —
  never the session dir itself). Nothing inside a session can write it.

## Open questions

Two, batched. Implementation is blocked until both are answered; requirements
and design work continue.

- **Q1 — What happens when an allocated session identity collides with a
  numeric `user:` a project's compose file already declares?** (Named as the
  open question in planning#405.) Requirement 4 says the declared `user:` keeps
  working; it does not say what "keeps working" means when the number is also
  some session's identity.

  - **(a) Allocate from a high reserved range, and refuse a compose `user:`
    inside that range.** *(Recommended.)* Every realistic explicit `user:` — 33,
    101, 999, 1000, 1001, an image's own account — is far below it and is
    untouched, so requirement 4 is satisfied for every project that exists
    today. A collision becomes impossible by construction rather than unlikely,
    and the refusal reuses the reserved-UID validation ShipIt already has
    (`compose-generator.ts:1338-1353`), including its explain-why error. Cost: a
    project that deliberately picks a uid in ShipIt's range gets a validation
    error it would not get today.
  - **(b) Allocate from the ordinary range and let collisions happen.** A
    compose service reaches only its own session's mounts, so a service that
    happens to run as another session's uid gains nothing across sessions — the
    cost is confined to that one session, and is the same foreign-uid breakage
    docs/266 §2 (E5) already documents and detects. Nothing new to build. Cost:
    "your session broke because we picked the number your compose file uses" is
    a support problem nobody can diagnose from the outside.
  - **(c) Avoid per session** — read the project's compose file when allocating
    and pick a uid it does not name. Rejected in the write-up as fragile: the
    compose file changes after allocation and an identity cannot.

- **Q2 — Do sessions that already exist get migrated to their own identity?**
  Requirement 8 says they must keep working; requirement 12 says the write-up
  must be honest about who still carries the residual. Both are satisfiable
  either way.

  - **(a) Migrate every existing session on its next container create.**
    *(Recommended.)* The mechanism already exists and is one-time per session:
    the entrypoint's chown sentinel is uid-stamped, so a changed uid rotates it
    and the boot re-runs the handoff exactly once. The residual is then closed
    for the whole fleet. Cost: the first boot after the upgrade is slower for a
    session with a large dependency tree, and every session pays it once.
  - **(b) New sessions only.** No migration, no first-boot cost, no chance of a
    half-migrated tree. Existing sessions keep the shared identity — and keep
    reaching each other — until they are archived. Requirement 12 then obliges
    the write-up to say "closed for sessions created after `<version>`; open for
    the rest", which is an honest but long-lived caveat.
  - **(c) Migrate on demand**, as an explicit per-session action. Rejected in
    the write-up: it makes a security property a thing the user has to opt into
    per session, and the user has no way to judge when to.

## Resolved questions

*(none yet — Q1 and Q2 are open.)*

## Not closed by this work

planning#384 (docs/266) is **not** closed by this feature, and this document does
not describe it as closed. This feature addresses one of its four outstanding
pieces: the cross-session residual (docs/266 req 13). `safe.directory` is still
`*` (planning#403), the dropped git still reaches the PAT (planning#404), and a
project's own hooks still do not fire on ShipIt's auto-commit (docs/266 E4).
