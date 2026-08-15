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
   silence.

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

## Requirement provenance

Separating what was asked for from what the design supplied, per `CLAUDE.md`
("Requirements are usually stated at the UX level — don't promote your mechanism
into one").

| Req | Stated by the requester | Supplied by this document |
|---|---|---|
| 1 | ✅ verbatim, as a boundary | — |
| 2 | ✅ "NONE of this needs a plugin… do not re-frame it that way" | — |
| 3 | ✅ "the set can be neither enumerated nor overridden away" | — |
| 4 | ✅ "say plainly which one you would choose and what each one breaks" | — |
| 5 | ✅ "check your choice against all four and say so" (there are five) | the correction from four to five |
| 6 | — | inferred from invariant 2 |
| 7 | — | inferred from the requester's warning not to read PR #2301's green tests as more than they are |
| 8 | ✅ "say what you could NOT verify" | — |

Requirement 6 and 7 are the two places this document went beyond what it was
handed. Both are load-bearing for the recommendation in `plan.md` — 6 rules out
the container option, 7 selects the ownership-check mechanism over a denylist —
so they are called out rather than folded in.

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

**Q1 — Should a project's own git hooks ever run on ShipIt's auto-commit?**
planning#384 deliberately left this open, and it decides whether the answer is
"never execute repo config" or "execute it somewhere that is not root in the
orchestrator".

- **(a) Never.** Auto-commit is ShipIt's action, not the project's; a formatter
  that must run belongs in the agent's own commit or in CI. Status quo since
  PR #2301.
- **(b) Run them, but only in the session container**, at the session's own uid,
  as a separate step before the orchestrator commits.
- **(c) Run them wherever the orchestrator's git runs**, once that is no longer
  root.

*Recommendation: (a) for now, (c) as the free consequence of the design.* Under
the recommended option in `plan.md` the orchestrator's git runs at the session's
own uid, so (c) becomes a one-line change (stop passing `core.hooksPath`)
whenever the product wants it. Nothing in the security fix depends on the
answer.

**Q2 — Is "the uid that already owns the session's workspace" an acceptable
trust level for orchestrator-side git?**
This is the pivot of the recommended design. That uid can already write every
file in the session, run arbitrary code in the session container, and push to
the session's repo. Running git *as that uid* means repo-controlled config
executes with exactly the authority its author already had — no escalation —
rather than being blocked.

- **(a) Yes.** Equal-authority execution is not an escalation; this is the
  cheapest complete answer and it makes git's own ownership check the guard.
- **(b) No — orchestrator-side git must execute nothing repo-controlled at all**,
  even at the workspace's own uid. Requires isolating execution (a container)
  *and* neutering config, and costs requirement 6.

*Recommendation: (a).*

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

**Q4 — Do routes 2 (`agent.install`) and 3 (the compose file) belong to this
feature?**
They are the requester's routes 2 and 3, they are real, and they are not git.

- **(a) This feature covers the git route; route 3 stays on planning#386; route
  2 gets its own issue.** Route 3's fix is *validation* of a file the product
  deliberately executes, not relocation of execution — a different shape of
  work with a different owner. Route 2's escalation is plugin-container →
  agent-container, a smaller blast radius that does not reach the orchestrator.
- **(b) One feature covering all three.** Honest about the class, but couples a
  security fix that can ship now to a compose-validation design that cannot.

*Recommendation: (a), and `plan.md` states the per-route disposition either way
so requirement 4 is satisfied under both.*

## Resolved questions

*(none yet)*
