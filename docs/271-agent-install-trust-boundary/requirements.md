---
issue: planning#400
title: agent.install must not be a route out of a plugin container
description: The trust boundary between a contained plugin container that can write the workspace and the agent container that executes shipit.yaml's agent.install.
---

# Requirements — `agent.install` trust boundary

Tracked by planning#400. This is **route 2** of the three routes planning#384
identified; route 1 (`.git`) shipped as
[docs/266](../266-orchestrator-git-trust-boundary/requirements.md) and route 3
(the compose file) closed as planning#386.

This document states **what must be true**. The design is in
[plan.md](./plan.md).

## The boundary, in one sentence

**Code that can write a session's workspace at *less* authority than the agent
container must not thereby reach *unattended* execution *inside* the agent
container.**

Both italics are load-bearing, and each was checked rather than assumed:

- **Less authority.** Only one writer of the workspace qualifies. A plugin CLI
  run and a plugin service each get `<workspaceDir>` bind-mounted read-write at
  `/project` — verified at `plugin-cli-run.ts:444`
  (`addSessionMount(deps.workspaceDir, CONTAINER_PROJECT_DIR, false)`, where the
  third argument is `readOnly`) and `plugin-compose.ts:1131`
  (`{ type: "bind", source: opts.workspaceDir, target: CONTAINER_PROJECT_DIR }`,
  no `read_only`). Those containers are contained: capabilities dropped, no
  credential store, restricted egress. Every *other* writer — the agent itself,
  an `npm postinstall`, a project compose service — is the project's own code at
  the project's own authority, so for those this route is not an escalation and
  closing it is not required (req 4).
- **Unattended.** A plugin causing the *agent* to run something is settled and
  in scope of the grant a declaration makes: docs/262 req 22 says in its own
  words that "instructions the agent follows are the sharpest form of the trust
  a declaration grants", and req 29 says a plugin's companion-CLI output is
  material the agent reads and may act on. What is different about
  `agent.install` is that no agent and no user is in the loop: the commands are
  executed by `spawn(command, { shell: true, cwd: this.workspaceDir })`
  (`install-controller.ts:560`) from a config re-read on a file-watcher event
  (`service-manager-setup.ts:1113-1126`), with nothing written to the transcript
  and nobody asked.
- **Inside the agent container.** Concrete, not abstract: that container mounts
  the credential store at `/credentials` (Claude CLI auth, the GitHub token —
  `session-container.ts:166`), and carries the agent's network posture rather
  than the plugin's.

## Requirements

1. Code running in a contained plugin container MUST NOT be able to cause
   execution inside the agent container by writing the session's workspace.

2. Requirement 1 MUST hold for a plugin **service** as well as for a plugin
   **CLI run**, including a write made at a moment when no agent turn is in
   flight. *(Stated by the requester: a service "is the sharper case, because it
   is long-running and can write the file at any time rather than only while a
   companion CLI runs".)*

3. `agent.install` commands MUST NOT be executed on the strength of an
   acceptance the user gave for a **different** command list. *(Stated by the
   requester: "The user accepted the commands the repo had **then**, not the
   ones it has now.")*

4. Requirement 1 is NOT required to hold against an ordinary `npm postinstall`,
   the agent itself, or the project's own compose services. Those write the
   workspace at the authority they already hold, so the route gives them
   nothing. A design that closes only the plugin path satisfies this feature —
   which is the opposite of docs/266 req 2, deliberately, because the executor
   here is the session worker rather than the orchestrator. *(Stated by the
   requester: "For an npm `postinstall` this is not an escalation — the writer
   and the executor are the same uid in the same container.")*

5. Requirement 1 MUST hold on **every** path that reads a changed
   `agent.install`, not only the live watcher delta the issue names. The
   requester read one path; a second one exists and is not covered by it — see
   [Verified](#what-was-verified-and-what-was-not), *the restart path*.
   *(Inferred, not stated — see Provenance.)*

6. A plugin MUST still be able to write the consuming project's files. This is
   not a new requirement; it is docs/262 req 29, settled by the requester on
   2026-08-15 in their own words — *"plugins should be able to write to the user
   repo, that is their purpose"* — together with its consequence, that "the
   project's own files are NOT a containment boundary and must never be
   described as one". A design that removes a plugin's ability to write some
   part of the project is therefore a **change to req 29**, and belongs to the
   requester rather than to this feature. *(Carried in from docs/262; see Open
   question Q1.)*

7. A change to `agent.install` that ShipIt does not execute MUST be **visible**
   and MUST NOT break the session. The session's clone, file tree, agent chat,
   and previously-working dependencies keep working; only the un-accepted
   execution is withheld, and the user is told it was. *(Inferred from the shape
   docs/178 already chose for the same class of decision — "The clone, file
   tree, diffs, and agent chat still work while untrusted; only foreign-code
   execution is gated" (`service-manager-setup.ts:388-398`) — not from a
   separate answer. See Provenance.)*

8. Whatever ShipIt withholds, the user MUST have a way to get it. A user who
   *wants* the new install command MUST be able to have it run without editing
   ShipIt's configuration or restarting the session. *(Inferred — see
   Provenance.)*

9. The design MUST state this route as **closed**, **partly closed**, or **left
   open**, and an open remainder MUST have a named owner (an issue), not a
   silence. *(Carried over from docs/266 req 4, which set this convention for
   the three routes as a set.)*

10. The design MUST record what could not be verified, distinguishing "read the
    code that would have to hold" from "inherited the claim from a doc".
    *(Carried over from docs/266 req 8.)*

## Open questions

Three, and they are the requester's rather than mine because each turns on a
product tradeoff — what a plugin is allowed to be, and how often a user is
interrupted — not on a fact about the code. The mechanism itself is not among
them: requirement 6 already rules out the mount-narrowing shapes unless the
requester reopens req 29, which is what Q1 asks.

- **Q1 — May a plugin ever change what `agent.install` runs?** The issue lists
  three shapes and decides none. Requirement 6 answers two of them for me:
  excluding the control files from the plugin `/project` mount, and narrowing
  what `/project` contains, both take away a write docs/262 req 29 grants in
  plain words. My recommendation is to leave the mount alone and **re-gate the
  execution** — a plugin may write `shipit.yaml` like any other project file,
  and what changes is that ShipIt stops running the result unattended. But
  requirement 6 is the requester's requirement, so overriding it is theirs too.

- **Q2 — When ShipIt withholds a changed `agent.install`, what does the user
  see?** A prompt to accept (the shape docs/178 uses for the repo trust gate) is
  one answer; a transcript card that says it was not run, leaving the user to
  ask the agent for it, is a much smaller one and reaches the same place —
  because the agent running a command in its own container is exactly the
  authority the user already granted it. This is the "how often is the user
  re-prompted" tradeoff.

- **Q3 — Which sessions pay for it?** The escalation exists only where a plugin
  container has the mount (req 4), so the gate can be scoped to
  plugin-bearing sessions and cost nothing anywhere else — at the price of a
  rule whose behaviour depends on something the user may not have in mind.
  Applying it to every session is uniform and explainable, and re-prompts users
  who have no plugin and no exposure.

## Provenance

Requirements 1–4 and 6 are the requester's, in the sense that each traces to a
sentence in planning#400 or to a resolved question in docs/262; the quoted words
are shown at each. Requirements 9 and 10 are conventions docs/266 set for this
set of three routes and are carried over unchanged.

Requirements 5, 7 and 8 are **inferred**, and are recorded as requirements
rather than left implicit because each would otherwise be decided silently
inside the design:

- **5** is inferred from requirement 3 rather than from a new answer: an
  acceptance that binds on Tuesday's file-watcher event and not on Wednesday's
  container restart is not an acceptance of a command list at all.
- **7** and **8** are inferred from docs/178's existing shape for the same class
  of decision. If the requester wants a withheld install to be silent, or wants
  it to be unrecoverable without an edit, those are changes to these two.

Nothing here promotes a mechanism into a requirement. "Re-gate rather than
narrow the mount" is a design position and lives in Q1 and in `plan.md`, not in
the numbered list.

## What was verified, and what was not

Read at the source in this workspace, at the commit this branch starts from:

| Claim | Verified at |
|---|---|
| `agent.install` runs through a shell in the session worker | `install-controller.ts:558-566` — `spawn(command, { shell: true, cwd: this.workspaceDir, … })` |
| The watcher re-runs it unconditionally on a change | `service-manager-setup.ts:1113-1126` — `if (!sameCommands(runner.appliedInstallCommands, nextCommands)) { … runner.requestDepReinstall(); }`, with no trust check on the path |
| The trust gate is at setup only | `service-manager-setup.ts:397-401` returns early for an untrusted remote; `applyShipitConfigChange:1075-1079` re-enters `setupServiceManager` **only when no ServiceManager exists**, so a live session reaches the install delta without passing the gate again |
| A plugin CLI run gets the workspace read-write at `/project` | `plugin-cli-run.ts:444` |
| A plugin service gets the same | `plugin-compose.ts:1131` |
| The agent container holds the credential store | `session-container.ts:166` (`credentialsDir` → `/credentials`) |
| A plugin container runs as the **same uid** as the session worker | `plugin-cli-run.ts:799` (`User: ${identity.uid}:${identity.gid}`) with `identityForSession` (`session-worker-uid.ts:173`) resolving the session's own identity. **Consequence:** file ownership cannot attribute a workspace write to the plugin rather than to the agent, so no design may rest on telling the two apart after the fact. |
| The install marker persists the exact command list outside the workspace | `install-marker.ts` — `installCommands` in the stamp, stored in `<sessionDir>/state/shared/` (docs/246 moved it out of the clone), which no plugin container mounts |

**The restart path** (requirement 5) was found while verifying the above and is
not in the issue. `appliedInstallCommands` lives on the runner
(`container-session-runner.ts:1898`), so it does not survive a container
recreate. A plugin's write to `shipit.yaml` is auto-committed by the post-turn
flow like any other workspace change, so on the next session start
`setupServiceManager` reads the plugin's command list from a repo whose remote
the user trusted once, and the docs/178 gate — which asks only whether the
*remote* is trusted — passes it. Closing only the live delta would leave this
open.

**Not verified — no working proof was built.** Like the issue's author, I read
the route rather than exercising it. Specifically: I did not write a
`shipit.yaml` from inside a plugin container and observe the install re-run, so
the claim that the in-container file watcher raises an event for a write made
through a *different* bind mount of the same host directory is reasoned from how
inotify watches inodes, not measured. It does not change the conclusion —
requirement 5's restart path reaches the same execution without any watcher at
all — but it is the difference between "read" and "proved", and the difference
is the point.
