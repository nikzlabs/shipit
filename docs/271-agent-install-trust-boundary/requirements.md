---
issue: planning#400
title: Plugin code is trusted at the package.json dependency level
description: Where plugin-authored code sits in ShipIt's trust model, and what that settles about executing shipit.yaml's agent.install.
---

# Requirements — `agent.install` trust boundary

Tracked by planning#400. This is **route 2** of the three routes planning#384
identified; route 1 (`.git`) shipped as
[docs/266](../266-orchestrator-git-trust-boundary/requirements.md) and route 3
(the compose file) closed as planning#386.

This document states **what must be true**. The design is in
[plan.md](./plan.md).

## The trust position, in one sentence

**Plugin code is trusted at the same level as a `package.json` dependency: it
may reach unattended execution inside the agent container, and that is accepted
rather than defended against.** *(Requester, 2026-08-21 — see requirement 1.)*

This **replaces** the boundary this document was opened to state, which was
*"code that can write a session's workspace at less authority than the agent
container must not thereby reach unattended execution inside the agent
container."* That sentence was the feature's founding premise and it is no longer
the requirement; the reasoning that retired it is in Resolved questions
(2026-08-21).

The verification below is kept because it is still true and still useful — it
describes the mounts, the executor and the credential store as they actually are.
What changed is the conclusion drawn from it, not the readings:

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

1. **Plugin code is considered trusted on the same level as `package.json`
   dependencies.** Reaching execution inside the agent container by writing the
   session's workspace is therefore NOT an escalation and MUST NOT be treated as
   one. *(Stated by the requester, 2026-08-21, in these words. It replaces the
   original requirement 1 — "code running in a contained plugin container MUST
   NOT be able to cause execution inside the agent container by writing the
   session's workspace" — which is retained here only so the reversal is legible.
   The number is kept stable per the requirements discipline; the meaning is
   inverted.)*

   The comparison is exact and is what makes it decidable: an `npm` dependency's
   `postinstall` already runs unattended in the agent container with the
   credential store mounted, and ShipIt does not gate it. A plugin now sits at
   that level — no higher, no lower.

2. **SUPERSEDED by requirement 1 (2026-08-21).** Was: requirement 1 must hold
   for a plugin **service** as well as a plugin **CLI run**, including a write
   made when no agent turn is in flight. *(Stated by the requester: a service
   "is the sharper case, because it is long-running and can write the file at any
   time rather than only while a companion CLI runs".)* The observation stands —
   a service can write at any time — but with plugin code trusted at the
   dependency level there is nothing for it to have to hold against. Recorded
   rather than deleted, because it is the requester's own sentence and a future
   reader needs to see that it was answered, not overlooked.

3. `agent.install` commands MUST NOT be executed on the strength of an
   acceptance the user gave for a **different** command list. *(Stated by the
   requester: "The user accepted the commands the repo had **then**, not the
   ones it has now.")*

4. **SUBSUMED by requirement 1 (2026-08-21).** Was: requirement 1 is not
   required to hold against an ordinary `npm postinstall`, the agent itself, or
   the project's own compose services, because those write the workspace at the
   authority they already hold. *(Stated by the requester: "For an npm
   `postinstall` this is not an escalation — the writer and the executor are the
   same uid in the same container.")*

   This was a carve-out from requirement 1; requirement 1 has now moved to where
   the carve-out was, so there is nothing left to carve out of. **Its reasoning
   also turned out to be the thing that broke the old requirement 1**: "an
   ordinary `npm postinstall`" is a project-authority writer, but a plugin can
   *author* one, and the accepted command `npm ci` executes it. See Resolved
   questions (2026-08-21).

5. **SUPERSEDED by requirement 1 (2026-08-21).** Was: requirement 1 must hold on
   **every** path that reads a changed `agent.install`, not only the live watcher
   delta the issue names. *(Inferred, not stated — see Provenance.)* The second
   path it names — the restart path — is real and is still documented under
   [Verified](#what-was-verified-and-what-was-not); it is no longer a path that
   something has to hold on.

6. A plugin MUST still be able to write the consuming project's files —
   **including `shipit.yaml` itself**. This is not a new requirement; it is
   docs/262 req 29, settled by the requester on 2026-08-15 in their own words —
   *"plugins should be able to write to the user repo, that is their purpose"* —
   together with its consequence, that "the project's own files are NOT a
   containment boundary and must never be described as one". Reaffirmed for this
   feature on 2026-08-17: what changes is that ShipIt stops *executing* a changed
   `agent.install` unattended, not what a plugin may *write*. *(Carried in from
   docs/262; reaffirmed — see Resolved questions, Q1.)* **That last sentence
   describes the 2026-08-17 design and does not settle whether the gate survives
   requirement 1's reversal — see Open questions.** The requirement itself is
   unaffected either way: it constrains what a plugin may WRITE, and the answer
   is still "anything in the project".

7. A change to `agent.install` that ShipIt does not execute MUST appear in the
   **chat transcript**, naming both the command list that is in force and the
   one that was withheld, and MUST still be there after a reload. It MUST NOT
   break the session: the clone, file tree, agent chat, and
   previously-installed dependencies keep working; only the un-accepted
   execution is withheld. *(The transcript answer was given by the requester on
   2026-08-17 — see Resolved questions, Q2. The rest is inferred from the shape
   docs/178 already chose for the same class of decision — "The clone, file
   tree, diffs, and agent chat still work while untrusted; only foreign-code
   execution is gated" (`service-manager-setup.ts:388-398`). See Provenance.)*

8. Whatever ShipIt withholds, the user MUST have a way to get it. A user who
   *wants* the new install command MUST be able to have it run **by asking the
   agent**, without editing ShipIt's configuration, accepting a prompt, or
   restarting the session — the agent runs commands in that container already,
   so this is authority the user has already granted it. *(Answered by the
   requester on 2026-08-17 — see Resolved questions, Q2.)*

9. The design MUST state this route as **closed**, **partly closed**, or **left
   open**, and an open remainder MUST have a named owner (an issue), not a
   silence. *(Carried over from docs/266-orchestrator-git-trust-boundary req 4, which set this convention for
   the three routes as a set.)*

10. The design MUST record what could not be verified, distinguishing "read the
    code that would have to hold" from "inherited the claim from a doc".
    *(Carried over from docs/266-orchestrator-git-trust-boundary req 8.)*

11. A session that has never had a plugin MUST be unaffected — same install
    behaviour as today, and no new message in its transcript. *(Answered by the
    requester on 2026-08-17 — see Resolved questions, Q3.)*

12. **SUPERSEDED by requirement 1 (2026-08-21).** Was: a plugin must not be able
    to escape requirement 1 by **removing its own declaration** from
    `shipit.yaml` in the same write that changes `agent.install`. *(Inferred
    while designing req 11 — see Provenance.)* It existed only to stop a plugin
    evading the old requirement 1; with nothing to evade, a plugin editing its
    own declaration is an ordinary project write under requirement 6.

## Open questions

- **With requirement 1 reversed, does the `agent.install` gate still have a
  reason to exist — and do requirements 3, 7, 8 and 11 survive it?** Requirement
  1 was the gate's whole justification. Requirement 3 is the one that might stand
  on its own: the requester stated it in their own words, and its rationale is
  about the *user's* acceptance rather than about plugins — *"The user accepted
  the commands the repo had **then**, not the ones it has now."* Requirements 7
  and 8 describe what the user sees and how they get the withheld commands, so
  they are meaningful exactly as long as something is withheld; requirement 11
  becomes trivially true.

  So the choice is roughly: **(a)** requirement 3 survives on user-acceptance
  grounds, the gate stays, and it simply stops being a security boundary — the
  transcript notice becomes "your install command changed, confirm it" rather
  than "a plugin may have written this"; or **(b)** requirement 3 falls with
  requirement 1, the gate is removed, and `agent.install` is re-run unattended
  the way it was before this feature — which also dissolves the incident that
  opened this branch, since a withheld install is what stranded that session.

  Not answered here because it is a product decision and the feedback that
  reversed requirement 1 did not reach it. It governs how much of the shipped
  code stays — see plan.md.

## Resolved questions

- **2026-08-21 — Where does plugin code sit in the trust model?** Raised after
  three review rounds had each hardened the `agent.install` path further, by the
  requester: *"The plugin could change `package.json`, for example, which would
  be allowed by ShipIt but potentially install malicious packages. I think we
  need to take a step back and think of what is an accepted risk with plugins.
  For now only I used them and only for my own repos."*

  The observation was checked and is correct, and it is a defect in requirement
  4's reasoning rather than in the design. Requirement 4 excused "an ordinary
  `npm postinstall`" on the grounds that "the writer and the executor are the
  same uid in the same container" — true of the *project's* postinstall, **not**
  of one a plugin wrote. A plugin may write any project file (req 6),
  `package.json` is a project file, and the already-accepted command `npm ci`
  executes what it says. So a plugin reached unattended execution in the
  credential-bearing container **without changing `agent.install` at all**, which
  means the gate never fired. That generalises to every accepted command that
  interprets workspace content — `make`, `pip install -r`, a repo script — and
  closing those would mean treating the project's own files as a containment
  boundary, which requirement 6 forbids in the requester's own words. The old
  requirements 1 and 6 were therefore in direct tension and the old requirement 1
  was not achievable.

  The requester answered by **replacing requirement 1**: *"the plugin code is
  considered trusted on the same level as `package.json` dependencies."* That
  resolves the tension in favour of requirement 6 and makes the residual an
  accepted risk rather than an open hole. Requirement 1 now says so; requirements
  2, 4, 5 and 12 are marked superseded or subsumed in place, keeping their
  numbers.

- **2026-08-17 — May a plugin ever change what `agent.install` runs?** The issue
  listed three shapes and decided none. Requirement 6 already answered two of
  them: excluding the control files from the plugin `/project` mount, and
  narrowing what `/project` contains, both take away a write docs/262 req 29
  grants in plain words. The requester answered **re-gate the execution**: leave
  the mount alone, let a plugin write `shipit.yaml` like any other project file,
  and stop ShipIt running a changed `agent.install` unattended. Requirement 6
  now says so, and requirement 29 of docs/262 stands unchanged.

- **2026-08-17 — When ShipIt withholds a changed `agent.install`, what does the
  user see?** Two shapes were put: a prompt to accept (what docs/178 uses for
  the repo trust gate, needing a new per-session, per-command-list acceptance
  store and new client UI, since the existing trust store is keyed by remote URL
  globally), or a **transcript card** naming what was withheld, leaving the user
  to ask the agent for it. The requester chose the **transcript card**.
  Requirements 7 and 8 now say so. The reasoning that made it sufficient rather
  than merely cheaper: the agent runs commands in that container anyway, so
  "ask the agent to run it" is not a weaker acceptance than a button — it is the
  same authority, exercised where a human can see it.

- **2026-08-17 — Which sessions pay for it?** Applying the gate to every session
  is uniform, and costs a message on the very common "the agent edited
  `shipit.yaml` because I asked it to" path. Scoping it to plugin-bearing
  sessions costs nothing where no plugin container holds the mount, which
  requirement 4 says is everywhere else. The requester chose **only
  plugin-bearing sessions**; requirement 11 states it, and requirement 12
  records the bypass that the obvious reading of it would leave open.

## Provenance

Requirements 1–4 and 6 are the requester's, in the sense that each traces to a
sentence in planning#400 or to a resolved question in docs/262; the quoted words
are shown at each. Requirements 9 and 10 are conventions docs/266 set for this
set of three routes and are carried over unchanged.

**Requirement 1 was replaced by the requester on 2026-08-21** and is still
theirs, in their own words. Requirements 2, 5 and 12 were written to make the
*previous* requirement 1 airtight, so they are marked superseded in place rather
than deleted — the numbers stay stable, and a reader can see they were answered
rather than dropped. Requirement 4 is marked subsumed for the same reason, with
the extra note that its own reasoning is what exposed the flaw. Nothing was
renumbered.

Note what this does to the "inferred" requirements below: **5 and 12 were the two
inferences, and both are now retired by the requester's answer.** Neither was
wrong given the premise it was drawn from; both existed only to close gaps in a
premise that has since been withdrawn. That is the intended failure mode of
recording an inference as a numbered requirement rather than burying it in the
design — when the premise moves, the inference is visible and can be retired with
it.

Requirements 5 and 12, and the second half of 7, are **inferred**, and are
recorded as requirements rather than left implicit because each would otherwise
be decided silently inside the design:

- **5** is inferred from requirement 3 rather than from a new answer: an
  acceptance that binds on Tuesday's file-watcher event and not on Wednesday's
  container restart is not an acceptance of a command list at all.
- **7**'s "does not break the session" half is inferred from docs/178's existing
  shape for the same class of decision; its "appears in the chat transcript"
  half is the requester's, answered on 2026-08-17.
- **12** is inferred from requirement 11, and is the one place where taking the
  requester's answer at its plain word would have left the route open. The
  answer chosen was "only plugin-bearing sessions"; a plugin that deletes its own
  `plugins.use` entry in the same write makes the session look plugin-free at
  exactly the moment the check runs. The requirement records the property so the
  design cannot quietly satisfy req 11 and miss it.

Requirements 6, 7 and 8 changed in the same diff as the receipts above, per the
requirements discipline. Nothing here promotes a mechanism into a requirement:
"read the install marker" and "check for the session's plugin data directory"
are how requirements 3 and 12 get satisfied, and they live in `plan.md`.

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
