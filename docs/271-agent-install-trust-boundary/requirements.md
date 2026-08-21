---
issue: planning#400
title: Plugin code is trusted at the package.json dependency level
description: Where plugin-authored code sits in ShipIt's trust model, and what that settles about executing shipit.yaml's agent.install.
---

# Requirements — `agent.install` and the plugin trust level

Tracked by planning#400. This was opened as **route 2** of the three routes
planning#384 identified — route 1 (`.git`) shipped as
[docs/266](../266-orchestrator-git-trust-boundary/requirements.md), route 3 (the
compose file) closed as planning#386. Route 2 turned out not to be a boundary at
all: see requirement 1.

This document states **what must be true**. The design is in
[plan.md](./plan.md).

## The trust position, in one sentence

**Plugin code is trusted at the same level as a `package.json` dependency: it may
reach unattended execution inside the agent container, and that is accepted
rather than defended against.**

This replaced the boundary the document was opened to state. See requirement 1,
[Requirement history](#requirement-history), and the 2026-08-21 receipt under
Resolved questions.

## Requirements

1. Plugin code is trusted at the same level as a `package.json` dependency.
2. (empty)
3. (empty)
4. (empty)
5. (empty)
6. A plugin MUST be able to write the consuming project's files, including
   `shipit.yaml` itself.
7. (empty)
8. (empty)
9. (empty)
10. (empty)
11. (empty)
12. (empty)

Numbers are stable and never reused. `(empty)` marks a retired requirement —
what it said and why it went is in [Requirement history](#requirement-history).

**Two requirements remain, and both are about plugins:** 1 places plugin code in
the trust model, 6 says what a plugin may write. Neither asks ShipIt to withhold
anything, so `agent.install` runs as it did before this feature.

## Open questions

None.

## Resolved questions

- **2026-08-21 — Does req 3 still have a reason to exist?** Raised by the
  requester reading reqs 3 and 7: *"I don't get it"* and *"why would it not
  execute some changes?"*

  The plain answer to "why" was: **because a plugin might have written them.**
  Req 3 was never about install commands in general — it was old req 1 applied to
  the one file that reaches unattended execution, and the requester's sentence for
  it, *"The user accepted the commands the repo had **then**, not the ones it has
  now"*, was said about a repo a plugin can edit. With req 1 reversed that reason
  was gone, so the question being unanswerable from the document was the finding
  rather than a gap in the writing.

  The one residual argument — a changed list is something the user has not seen,
  so running it is a surprise — does not survive contact with docs/178: ShipIt
  already runs whatever the repo says, and the agent edits `shipit.yaml` on
  request all the time.

  **Answer: retire req 3**, with 7, 8 and 11 following it. `agent.install` runs
  as it did before this feature. This also dissolves the ops incident that opened
  the branch — a withheld install is precisely what stranded that session — and
  retires the acceptance-record mechanism rather than continuing to harden it.

- **2026-08-21 — Where does plugin code sit in the trust model?** Requester:
  *"The plugin could change `package.json`, for example, which would be allowed
  by ShipIt but potentially install malicious packages... For now only I used
  them and only for my own repos."*

  Checked and correct — and a defect in req 4's reasoning rather than in the
  design. A plugin may write any project file (req 6), `package.json` is one, and
  the already-accepted `npm ci` executes what it says. So a plugin reached
  unattended execution in the credential-bearing container **without changing
  `agent.install` at all**, and the gate never fired. It generalises to every
  accepted command that interprets workspace content (`make`, `pip install -r`, a
  repo script); closing those would treat the project's own files as a
  containment boundary, which req 6 forbids in the requester's own words. Old
  reqs 1 and 6 were in direct tension, and old req 1 was not achievable.

  **Answer: replace req 1** — *"the plugin code is considered trusted on the same
  level as `package.json` dependencies."* Reqs 2, 4, 5 and 12 retired with it.

- **2026-08-17 — May a plugin ever change what `agent.install` runs?** Three
  shapes were put; two (excluding control files from the plugin mount, narrowing
  what `/project` contains) take away a write req 6 grants in plain words.
  Answer: **re-gate the execution** — let a plugin write `shipit.yaml` like any
  other project file, and stop ShipIt running a changed list unattended.
  **Overtaken on 2026-08-21:** the question presupposed that a plugin changing
  `agent.install` was a problem to solve. Req 1 now says it is not.

- **2026-08-17 — When ShipIt withholds a change, what does the user see?** A
  prompt to accept (docs/178's shape, needing a new per-session acceptance store
  and client UI) or a **transcript card**. Answer: the transcript card — reqs 7
  and 8. What made it sufficient rather than merely cheaper: the agent runs
  commands in that container anyway, so "ask the agent" is the same authority,
  exercised where a human can see it. **Overtaken on 2026-08-21** — reqs 7 and 8
  retired with req 3; nothing is withheld, so there is nothing to show.

- **2026-08-17 — Which sessions pay for it?** Every session (uniform, but costs a
  message on the common "the agent edited `shipit.yaml` because I asked it to"
  path) or only plugin-bearing ones. Answer: **only plugin-bearing sessions** —
  req 11. **Overtaken on 2026-08-21** — with no gate, the answer is "no session
  pays for it".

## Requirement history

Where each requirement came from, and what the retired ones said. Numbers are
stable and never reused.

The retired entries below **summarise** each requirement rather than reproducing
it in full — enough to see what was asked and why it went. The verbatim text of
every one is in git history (`git log -p -- docs/271-agent-install-trust-boundary/requirements.md`);
an earlier revision of this section claimed the full text was preserved here,
which was not true.

| # | Source |
|---|---|
| 1 | Requester, 2026-08-21, in these words. **Replaced** the original req 1 (below). |
| 6 | docs/262 req 29, settled 2026-08-15: *"plugins should be able to write to the user repo, that is their purpose"* — with its consequence that the project's own files are NOT a containment boundary. Reaffirmed here 2026-08-17. |

### Retired (2026-08-21) — because req 1 was reversed

- **1 (old)** — *"Code running in a contained plugin container MUST NOT be able
  to cause execution inside the agent container by writing the session's
  workspace."* The feature's founding premise. Withdrawn: see the 2026-08-21
  receipt.

  Its "unattended" clause is worth keeping in view even now. A plugin causing the
  *agent* to run something was always in scope of what declaring a plugin grants
  (docs/262 req 22 — "instructions the agent follows are the sharpest form of the
  trust a declaration grants"). What was different about `agent.install` is that
  no agent and no user is in the loop.

- **2** — *"Requirement 1 MUST hold for a plugin service as well as a plugin CLI
  run, including a write made when no agent turn is in flight."* Requester's
  words: a service "is the sharper case, because it is long-running and can write
  the file at any time". The observation stands; there is nothing left for it to
  hold against.

- **4** — *"Requirement 1 is NOT required to hold against an ordinary `npm
  postinstall`, the agent itself, or the project's own compose services."*
  Requester: *"For an npm `postinstall` this is not an escalation — the writer and
  the executor are the same uid in the same container."* A carve-out from req 1;
  req 1 has moved to where the carve-out was. **Its reasoning is also what broke
  the old req 1** — a plugin can *author* a postinstall, and `npm ci` runs it.

- **5** — *"Requirement 1 MUST hold on every path that reads a changed
  `agent.install`."* Inferred. The second path it found (the restart path) is
  real and still documented under What was verified; it is simply no longer a
  path something must hold on.

- **12** — *"A plugin MUST NOT be able to escape requirement 1 by removing its
  own declaration in the same write that changes `agent.install`."* Inferred from
  req 11. With nothing to evade, that is an ordinary project write under req 6.

**Both inferences this document made — 5 and 12 — were retired by the same
answer.** Neither was wrong given its premise; each existed only to close a gap
in a premise since withdrawn. That is the point of recording an inference as a
numbered requirement rather than burying it in the design: when the premise
moves, the inference is visible and goes with it.

Nothing here promotes a mechanism into a requirement. "Read the install marker"
and "check for the session's plugin data directory" are how requirements get
satisfied, and they live in `plan.md`.


### Retired (2026-08-21) — because they were never about plugins

Both were documentation conventions carried from docs/266, which set them for the
**three-route set** planning#384 identified. They constrained how this feature's
design doc had to be written, not what ShipIt had to do — so they sat in a list
of plugin requirements without being about plugins. The requester asked exactly
that: *"how is this related to plugins?"*

- **9** — *"The design MUST state this route as closed, partly closed, or left
  open, and any remainder MUST have a named owner."* The framing it depends on is
  gone: with req 1 reversed there is no boundary here to be closed or open, so
  "which is it" became a category error rather than a question with an answer.
  What survives is recorded plainly instead — `plan.md` says the gate was removed
  and why, and there are no remainders left to own.

- **10** — *"The design MUST record what could not be verified, distinguishing
  code read at the source from claims inherited from a doc."* Good discipline,
  and still followed — see [What was verified, and what was
  not](#what-was-verified-and-what-was-not), which is kept because its readings
  are still true. But it is a repo-wide writing rule (`CLAUDE.md`, *Verify an
  inherited guarantee at the source*), not something this feature must do.

### Retired (2026-08-21) — because req 3 went

Req 3 was the only requirement asking ShipIt to withhold anything. These three
described what happened when it did, so none of them has a subject any more.

- **3** — *"`agent.install` MUST NOT be executed on the strength of an acceptance
  the user gave for a different command list."* Requester's words: *"The user
  accepted the commands the repo had **then**, not the ones it has now."* Retired
  because its justification was old req 1; see the 2026-08-21 receipt.

- **7** — *"A change to `agent.install` that ShipIt does not execute MUST appear
  in the chat transcript, naming both lists, and MUST still be there after a
  reload."* Transcript half: requester, 2026-08-17. "Does not break the session"
  half: inferred from docs/178's shape (`service-manager-setup.ts:388-398`).
  Nothing is withheld now, so there is nothing to narrate.

- **8** — *"Whatever ShipIt withholds, the user MUST have a way to get it — by
  asking the agent."* Requester, 2026-08-17. The reasoning that made it
  sufficient rather than merely cheaper is still worth keeping: the agent runs
  commands in that container anyway, so "ask the agent" was never a weaker
  acceptance than a button — it is the same authority, exercised where a human
  can see it. Retired because nothing is withheld.

- **11** — *"A session that has never had a plugin MUST be unaffected."*
  Requester, 2026-08-17. It scoped the gate to plugin-bearing sessions. With no
  gate, every session is unaffected and the requirement is vacuous rather than
  wrong.

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
