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

   4a. Session identities MUST come from a range ShipIt reserves for itself, and
   a compose `user:` inside that range MUST be refused during validation with a
   message that says why and what to use instead. No session identity may ever
   equal a `user:` a project could reasonably declare. *(Decided by the
   requester on 2026-08-16 — see Resolved questions, Q1.)*

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

   8a. Sessions that already exist MUST NOT be migrated to a distinct identity.
   They keep the shared one, and keep reaching each other, until they are
   archived. *(Decided by the requester on 2026-08-16 — see Resolved questions,
   Q2.)*

   8b. A session that keeps the shared identity MUST still be sealed against
   sessions that hold a distinct one, in both directions: a new session's
   payload MUST NOT be able to read an old session's workspace, and an old
   session's payload MUST NOT be able to read a new one's. *(Supplied — see
   Provenance. Without it, answering Q2 with "new sessions only" would leave
   requirement 1 unmet for every new session too, because a workspace that is
   merely differently-owned is still world-readable.)*

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
| 4a | ✅ decided 2026-08-16 (Q1 → a) | — |
| 5 | — | supplied; a per-session identity that did not survive a restart would orphan the session's own files |
| 6 | — | supplied; it is what "per-session" means, stated so it can be tested |
| 7 | — | supplied; reuse is the obvious way to bound the identity space, and it is the obvious way to re-open req 1 |
| 8 | — | supplied; every session in the fleet already has files owned by the shared uid |
| 8a | ✅ decided 2026-08-16 (Q2 → b) | — |
| 8b | — | supplied; the consequence of Q2 → b that the answer itself does not state |
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

*(none — Q1 and Q2 are both answered; see below. Implementation is unblocked,
subject to the independent review this repo's requirements discipline
requires.)*

## Resolved questions

**2026-08-16 — Q1: what happens when an allocated session identity collides
with a numeric `user:` a project's compose file already declares? → (a), a
reserved range plus a validation refusal.** Recorded as **requirement 4a**.

The alternatives were (b) allocate from the ordinary range and accept
collisions — contained inside the one session, since a compose service reaches
only its own session's mounts, but undiagnosable from the outside — and (c) read
the project's compose file at allocation time and avoid the uids it names,
rejected as fragile because the compose file changes after allocation and an
identity cannot.

The consequence the answer creates, and which is **not** referred back as a new
question: a project that deliberately declares a `user:` inside ShipIt's range
now gets a validation error it would not get today. Requirement 4 says a
declared `user:` must keep working, and this is the one class of declaration
that stops working — but the range is chosen so that no `user:` a real image or
project uses can fall inside it, so the requirement is satisfied for every
project the constraint was raised about. If a project legitimately needs a uid
in that range, that is a change to requirement 4a.

**2026-08-16 — Q2: do sessions that already exist get migrated to their own
identity? → (b), new sessions only.** Recorded as **requirement 8a**.

The alternatives were (a) migrate every existing session on its next container
create, using the entrypoint's uid-stamped chown sentinel — one slower boot per
session, and the residual closed fleet-wide — and (c) an explicit per-session
user action, rejected because it makes a security property something the user
has to opt into with no basis for judging when.

One consequence the answer creates, **derived rather than asked**, and recorded
as **requirement 8b**: "new sessions only" does not by itself give a new session
requirement 1. A workspace whose files merely have a *different* owner is still
readable by any other uid, because directories are created world-traversable and
files world-readable by default. So a new session's payload would still read
every old session's workspace, and every old session's payload would still read
the new one's. Both directions have to be sealed for the answer to mean what it
says. That is a permission change, not an identity migration, so it is
compatible with the answer rather than a re-litigation of it. Requirement 12 is
what obliges the write-up to state that pre-existing sessions still reach **each
other**, which this feature deliberately does not fix.

## Not closed by this work

planning#384 (docs/266) is **not** closed by this feature, and this document does
not describe it as closed. This feature addresses one of its four outstanding
pieces: the cross-session residual (docs/266 req 13). `safe.directory` is still
`*` (planning#403), the dropped git still reaches the PAT (planning#404), and a
project's own hooks still do not fire on ShipIt's auto-commit (docs/266 E4).
