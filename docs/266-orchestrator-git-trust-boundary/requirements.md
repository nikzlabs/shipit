---
issue: planning#384
title: Orchestrator-side git must not execute repo-controlled code
description: The trust boundary between a session's writable workspace and the root orchestrator process that runs git in it.
---

# Requirements — orchestrator-side git trust boundary

Tracked by planning#384. This document states **what must be true**. The design
and the options are in [plan.md](./plan.md).

## The boundary, in one sentence

**Orchestrator-side git must not operate on a tree that untrusted code can
write** — or, if it does, nothing that tree contains may become execution inside
the orchestrator's trust context.

"The orchestrator's trust context" is concrete, not abstract. Verified at
`deployment/vps/docker-compose.yml:30-34`: the orchestrator container runs as
root and mounts `credentials:/credentials`, `/var/run/docker.sock`,
`workspace:/workspace` (**every** session, not just one) and `/opt/shipit`.

## Requirements

1. Code that can write a session's workspace MUST NOT be able to cause code
   execution in the orchestrator's trust context.

2. Requirement 1 MUST hold for an ordinary `npm install` running a dependency's
   `postinstall` inside the session worker container. It is not a
   plugin-specific requirement, and a design that closes only the plugin path
   does not satisfy it.

3. Requirement 1 MUST hold without ShipIt enumerating the set of git
   configuration keys that name an executable. A future git release that adds a
   new such key must not silently re-open the route.

4. The design MUST state, per route, whether it is closed, partly closed, or
   left open — and an open route MUST have a named owner (an issue), not a
   silence. This feature covers **route 1 only** (the `.git` route). Route 3
   (the compose file) stays with planning#386. Route 2 (`agent.install`) MUST
   get its own issue. *(Scope decided by the requester on 2026-08-16 — see
   Resolved questions, Q4.)*

5. All five post-turn invariants in `CLAUDE.md` ("Post-turn flow") MUST still
   hold after the change. The design MUST check itself against each of the five
   by name and say so.

6. The post-turn auto-commit MUST NOT acquire a new runtime dependency that can
   be unavailable at the moment it needs to run. Uncommitted agent work has no
   reflog entry and no recovery, so a commit path that can fail for an
   *environmental* reason is a worse outcome than the one being fixed.
   *(Inferred from invariant 2, not stated by the requester — see Provenance.)*

7. A missed or newly-added orchestrator-side git call site MUST fail closed —
   refuse loudly — rather than silently execute repo-controlled code.
   *(Inferred — see Provenance.)*

8. The design MUST record what could not be verified, distinguishing "read the
   code that would have to hold" from "inherited the claim from a doc".

9. Once orchestrator-side git no longer runs in the orchestrator's trust
   context (req 1), a project's own git hooks MUST fire on ShipIt's auto-commit.
   This is conditional on costing nothing beyond removing the current hook
   suppression: if it turns out to need more mechanism than that, it comes back
   to the requester as a question instead of being built.

10. A project's git hook MUST NOT be able to stop the turn's work from being
    committed. A hook that fails, or that never returns, MUST be surfaced to the
    user, and the commit MUST still land.
    *(Derived from `CLAUDE.md` invariant 2 — uncommitted agent work has no
    reflog entry and no recovery — not from a separate answer. If the requester
    wants a hook to be able to block a commit, that is a change to this
    requirement.)*

## Requirement provenance

Separating what was asked for from what the design supplied, per `CLAUDE.md`
("Requirements are usually stated at the UX level — don't promote your mechanism
into one").

| Req | Stated by the requester | Supplied by this document |
|---|---|---|
| 1 | ✅ verbatim, as a boundary | — |
| 2 | ✅ "NONE of this needs a plugin… do not re-frame it that way" | — |
| 3 | ✅ "the set can be neither enumerated nor overridden away" | — |
| 4 | ✅ "say plainly which one you would choose and what each one breaks"; scope decided 2026-08-16 (Q4 → a) | — |
| 5 | ✅ "check your choice against all four and say so" (there are five) | the correction from four to five |
| 6 | — | inferred from invariant 2 |
| 7 | — | inferred from the requester's warning not to read PR #2301's green tests as more than they are |
| 8 | ✅ "say what you could NOT verify" | — |
| 9 | ✅ decided 2026-08-16 (Q1 → c, "if 'c' is easy, let's do that") | the "costing nothing beyond removing the suppression" condition, which is the requester's "if it's easy" made testable |
| 10 | — | derived from invariant 2 (see the note on the requirement) |

Requirements 6, 7 and 10 are the three places this document went beyond what it
was handed. All three are load-bearing — 6 rules out the container option, 7
selects the ownership-check mechanism over a denylist, and 10 is the constraint
that keeps requirement 9 from being able to lose a turn's work — so they are
called out rather than folded in.

## What is already true (verified here, not inherited)

- **The `.git` route is open and PR #2301 does not close it.** Reproduced in
  this container against git 2.39.5: with `core.hooksPath=/dev/null` in force
  exactly as `safeSimpleGit` applies it, a repo-local `filter.<name>.clean`
  plus `.git/info/attributes` — both inside `.git`, no tracked file touched —
  executed during `git add`/`git commit`. `core.fsmonitor` executed during a
  plain `git status`, which is the **first** thing `GitManager.autoCommit` does
  (`src/server/shared/git.ts:282`), before any refusal check. A `!`-prefixed
  `alias.*` executed too. PR #2301 says this itself; the reproduction confirms
  it rather than discovering it.
- **`.git` is writable by the untrusted side.**
  `chownWorkspaceGitToSessionWorker` (`session-worker-uid.ts:188`) chowns
  everything outside `.git/objects/` to the session-worker uid — its own
  docstring says so — and that includes `config` and `info/`.
- **Git's own mitigation exists and ShipIt disabled it.**
  `git-config.ts:60-66` sets `safe.directory=*` globally, with the rationale in
  the comment: without it, root-orchestrator git on a worker-owned tree fails
  CVE-2022-24765's ownership check. The same comment records the property the
  design depends on — `safe.directory` is honoured **only** from system/global
  config, never from a repo-local one and never from `-c`.
- **Every orchestrator-side git op on a session workspace flows through one
  factory.** `app-di.ts:437` — `createGitManager = (dir) => new GitManager(dir)`,
  used at 189 call sites across 42 files. There are a small number of raw
  sites beside it (`install-session.ts:103`, `claim-session.ts:423`,
  `headless-sessions.ts:180`, `github-auth.ts:393`, `git-lfs-blob.ts:151`).

## Open questions

**Q2 — Is it good enough to run git as the session's own user, instead of as
root?**

In plain terms. Today, two different users touch the same folder:

- **The session's user.** This is who the agent runs as inside its container. It
  can already do anything it likes in that folder, and it can already run any
  program it wants there. Nothing is protected from it.
- **root, in the orchestrator.** This is a *much* more powerful user. It holds
  the GitHub token, the Docker socket (which is control of the whole machine),
  and every other session's folder.

The bug is that root goes into that folder and runs `git` there — and the
session's user can leave a booby trap in the folder that `git` picks up. So the
weak user gets the powerful user to act for it.

The proposed fix is not to disarm the booby trap. It is to send the *weak* user
in to run `git` instead of root. The trap still goes off — but it goes off as
the user who set it, who could already do all of those things. So it gains
nothing. Nobody is escalated.

The question is whether that is an acceptable answer, or whether ShipIt should
insist that the trap never goes off at all.

- **(a) Yes — running as the session's own user is good enough.** The trap gains
  its author no new power. This is the cheapest complete answer, and it lets git
  itself do the checking: git already refuses to touch a folder owned by someone
  else, so any place we forget to fix fails loudly instead of quietly running
  the trap.
- **(b) No — orchestrator-side git must never run anything the repo controls**,
  not even as the session's own user. That means running git inside its own
  container. It is stronger, but it puts Docker on the path of the auto-commit,
  and if Docker is unhealthy at that moment the turn's work is never committed
  and cannot be recovered. That conflicts with requirement 6.

*Recommendation: (a).*

A useful cross-check: this is already how the agent's own commits work. When the
agent runs `git commit` inside its container, a booby-trapped config runs there
too, at the same user — and that has never been considered a security problem,
because it is the user's own container. The fix makes ShipIt's commit behave the
same way.

**Q3 — Per-session uids: now, or accept the residual?**
Today every session's workspace is owned by the same uid (1000,
`SHIPIT_SESSION_WORKER_UID`). Under the recommended design a payload that
executes during an orchestrator git op runs at that uid inside the orchestrator
container, where **every** session's workspace is mounted at `/workspace`. So
host root and the credential store are closed, but cross-session workspace
read/write is not.

- **(a) Accept the residual now, file per-session uids as follow-up.** The
  change is a strict, large improvement (host root + Docker socket + credential
  store → one shared unprivileged uid), and per-session uids touch the session
  image entrypoint, every chown helper, and the plugin/compose uid checks.
- **(b) Do both together.** Complete, but roughly triples the change and delays
  closing the root path.

*Recommendation: (a), with the follow-up filed in the same turn the first half
merges.*

## Resolved questions

**2026-08-16 — Q1: should a project's own git hooks ever run on ShipIt's
auto-commit? → (c), run them wherever the orchestrator's git runs, once that is
no longer root.** Requester: *"if 'c' is easy, let's do that"*. Recorded as
**requirement 9**, with the "if it's easy" made testable as a condition: it must
cost nothing beyond removing the current hook suppression, and if it turns out
to need more it comes back as a question. Under the recommended option in
`plan.md` it does meet that condition — orchestrator git runs at the session's
own uid, so enabling hooks is dropping the `core.hooksPath` override on the
session-workspace path. Under any option where orchestrator git stays root, the
condition fails and requirement 9 must not be built.

One consequence the answer creates, and which was **not** referred back as a new
question: a `pre-commit` hook that exits non-zero makes `git commit` fail, and a
hook that hangs makes it never return — either way the turn's work stays
uncommitted, which `CLAUDE.md` invariant 2 says is unrecoverable. That invariant
already classifies this case, so the answer is derived rather than asked, and is
recorded as **requirement 10**: a hook may not stop the commit; a failing or
hanging hook is surfaced and the commit still lands. If the intent was that a
hook *should* be able to block a commit, that is a change to requirement 10 and
worth saying so.

**2026-08-16 — Q4: do routes 2 (`agent.install`) and 3 (the compose file) belong
to this feature? → (a), this feature covers the git route only.** Requester:
*"a"*. Route 3 stays with planning#386; route 2 is now **planning#400**, filed in the
same turn as this receipt rather than left as an intention. Folded into
**requirement 4**, which now names the disposition instead of only demanding
that one be stated.
