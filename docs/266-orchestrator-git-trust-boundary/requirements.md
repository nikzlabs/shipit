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

11. Requirement 1 is satisfied when repo-controlled code can only execute at an
    authority its own author already holds. ShipIt is NOT required to prevent
    that execution outright. *(Decided by the requester on 2026-08-16 — see
    Resolved questions, Q2. This is the scoping requirement: it is what makes
    "run git as the session's own user" a compliant answer and not a partial
    one.)*

12. A session whose compose services declare an explicit numeric `user:` MUST
    keep working — the session must start, its services must run, and ShipIt's
    own git operations on that workspace must not fail because a service wrote
    files as a different user. This holds both for this feature and for the
    per-session-uid follow-up (req 13). *(Stated by the requester on
    2026-08-16.)*

    Two facts make this a mandatory path rather than an edge case, both verified
    at `compose-generator.ts`: an egress-**contained** service *must* declare a
    numeric, non-root `user:` that is not one of the two reserved UIDs (`:988-1002`),
    and an explicit `user:` is never overridden by ShipIt (`:1387` only fills one
    in when `svc.user === undefined`).

13. Per-session uids MUST be filed as a follow-up, not built here. Until they
    exist, cross-session workspace access at the shared uid is an accepted,
    recorded residual — it MUST NOT be described as closed. *(Decided by the
    requester on 2026-08-16 — see Resolved questions, Q3.)*

14. A turn whose commit omits workspace content MUST NOT report success
    silently. If ShipIt's own git could not read part of the workspace, the user
    MUST be told which part, and MUST NOT be left with a turn that looks
    complete.

    *Not a duplicate — checked against the three requirements that come closest,
    and none covers it.* Requirement 6 governs a new runtime **dependency**, not
    an incomplete result. Requirement 10 is scoped to **hooks**. Requirement 12
    forbids ShipIt's git **failing** on a foreign-uid workspace — and the
    measured silent path does not fail: `status`, `add -A` and `commit` all
    return success while omitting the unreadable subtree, so requirement 12 is
    satisfied at the same moment the outcome is wrong. That gap is what this
    requirement closes. It is also the shape `CLAUDE.md` invariant 3 exists to
    prevent, and the shape that shipped PR #1890 one commit short.

15. A turn whose work was **not committed at all** MUST be reported to the user
    as a failure, naming what blocked it. A log line is not a report. The user
    MUST NOT be left with a turn that visibly did work and a branch that has
    none of it.

    *Added rather than folded into requirement 14, because 14 does not reach
    this case and stretching it would hide the difference.* Requirement 14 is
    about a commit that **exists and is short**; this is about a commit that
    **does not exist**. They also want opposite words to the user — "this commit
    is missing some paths" versus "this commit did not happen" — so one
    requirement covering both would license a single vague notice that serves
    neither. Measured trigger: an unreadable **file** (not directory) makes
    `git add -A` exit 128 with nothing staged, including every unrelated file
    the turn changed.

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
| 11 | ✅ decided 2026-08-16 (Q2 → a, "agree") | — |
| 12 | ✅ "we need to make sure that explicit UIDs in Docker Compose services would not be broken" | the two verified facts under it, which show it is a mandatory path rather than an edge case |
| 13 | ✅ decided 2026-08-16 (Q3 → a, "Let's do that") | — |
| 14 | ✅ requested 2026-08-16, after the requester **measured** the silent-omission behaviour this document had asserted was visible | — |
| 15 | ✅ requested 2026-08-16, after the requester measured the unreadable-**file** case and asked whether req 14 covered it | the finding that it does **not**, so this is a new requirement rather than a widened one |

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
  `git-config.ts` sets `safe.directory=*` globally, with the rationale in
  the comment: without it, root-orchestrator git on a worker-owned tree fails
  CVE-2022-24765's ownership check. The property the design depends on is that
  a **repo-local** `safe.directory` is not honoured, so the untrusted side
  cannot grant itself trust. Measured against git 2.39.5 with
  `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` (2026-08-16, while building E2): it holds.

  **Corrected in the same measurement.** This document previously added "and
  never from `-c`", inherited from `git-config.ts`'s comment and docs/150. That
  half is **wrong**. The rule, stated as a rule rather than as a list: git
  honours `safe.directory` from its **protected configuration** — the system and
  global files, the command line, **and the config environment protocols** — so
  *anything ShipIt itself puts in a git process's argv or environment can
  re-grant trust; only the repository's own config cannot.*

  It changes no requirement and opens no hole: argv and environment come from
  ShipIt, never from the repository, so the untrusted side still cannot grant
  itself trust. It is recorded here because the design cites the claim, and
  because the maintenance rule it implies is the opposite of the one the wrong
  version implies — a refusal must not be silenceable by a future ShipIt call
  site. Enforced as a lint rather than left as prose
  (`git-hooks-guard-coverage.test.ts`; planning#409 owns the rule).

  **Written as a rule on purpose**, per requirement 3's "without ShipIt
  enumerating the set". The enumeration here has been falsified twice — first
  `-c`, then `GIT_CONFIG_PARAMETERS` beside the `GIT_CONFIG_COUNT` that the
  first correction named — and a third vector will not announce itself either.
- **An unreadable workspace FILE costs the whole turn's commit.** Measured here
  against git 2.39.5, and independently by the requester. With one tracked file
  at mode 000 in an otherwise readable directory: `git status` exits **0** and
  lists *both* that file and the turn's unrelated edits as modified — so every
  `autoCommit` refusal check passes — and then `git add -A` exits **128**
  (`error: open(...): Permission denied` / `unable to index file` / `fatal:
  updating files failed`) with **nothing staged at all**, including the
  unrelated work. Exercised through this repo's own `simple-git`: `status()`
  resolves, `add("-A")` **rejects** with a `GitError` built by
  `errorDetectionPlugin` (`simple-git/dist/cjs/index.js:1364-1374`), and
  `err.exitCode` is `undefined` — so any detector must match message text, not
  an exit code.
- **An unreadable workspace directory makes a turn commit silently short.**
  Measured here against git 2.39.5, and independently by the requester. With a
  new, non-gitignored directory the git uid cannot open, `git status` and
  `git add -A` both exit 0, `git commit` exits 0 and reports the *other* changes,
  and the subtree is absent from HEAD — the only trace is a `warning: could not
  open directory` line on stderr, which simple-git discards on a zero exit. When
  the unreadable directory holds **tracked** content, git stages no deletion and
  HEAD is preserved, so this can omit new work but never destroy committed work.
  Worktree-mutating ops behave oppositely and fail loudly (`checkout` exit 255,
  `reset --hard` exit 128). Full table in `plan.md` §2 (E5).
- **Every orchestrator-side git op on a session workspace flows through one
  factory.** `app-di.ts:437` — `createGitManager = (dir) => new GitManager(dir)`,
  used at 189 call sites across 42 files. There are a small number of raw
  sites beside it (`install-session.ts:103`, `claim-session.ts:423`,
  `headless-sessions.ts:180`, `github-auth.ts:393`, `git-lfs-blob.ts:151`).

## Open questions

*(none — Q1–Q4 are all answered; see below. Implementation is unblocked, subject
to the independent review this repo's requirements discipline requires.)*

## Resolved questions

**2026-08-16 — Q2: is it good enough to run git as the session's own user
instead of as root? → (a), yes.** Requester: *"agree"*. Recorded as
**requirement 11**, which states the scoping consequence: requirement 1 is met
when repo-controlled code can only execute at an authority its author already
holds, and ShipIt is not obliged to prevent the execution outright. This is the
answer the whole design rests on — option (b) would have required running git in
its own container, which conflicts with requirement 6.

**2026-08-16 — Q3: per-session uids now, or accept the residual? → (a), accept
now and file the follow-up.** Requester: *"Let's do that. Also, we need to make
sure that explicit UIDs in Docker Compose services would not be broken."*
Recorded as **requirement 13** (file the follow-up; the residual stays named,
never described as closed) and **requirement 12** (the compose-uid constraint).

The compose-uid constraint turned out to be sharper than a follow-up concern,
and checking it changed the design rather than only the follow-up. Verified at
`compose-generator.ts`: an egress-contained service is *required* to declare a
numeric non-root `user:` (`:988-1002`), and ShipIt never overrides an explicit
one (`:1387`). So a workspace can legitimately contain files owned by a uid that
is neither root nor the session's. Today root-side git ignores that; unprivileged
git will not. The analysis and the chosen handling are in `plan.md` §2 (E5) —
the short version is that this is the *pre-existing* limit the agent already
lives under, and the design surfaces it rather than restoring root to paper over
it. No new question was raised, because requirement 12 plus `CLAUDE.md` invariant
2 already decide it.

**Correction, same day.** E5's original justification claimed the collision "now
fails visibly instead of silently". The requester **measured** that and it is
only half true: worktree-mutating ops fail loudly, but the `status` / `add -A`
path — the one `autoCommit` runs every turn — fails **silently**, committing
with exit 0 and omitting the unreadable subtree. The decision stands; the
justification was wrong and is corrected in `plan.md` §2 with the measurement
cited. Two consequences: **requirement 14** now covers the silent case, which no
existing requirement did, and the detection is promoted from an optional
compose-time warning to a required check on the git side — compose-time
validation cannot see a mode the running service sets at runtime.

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
