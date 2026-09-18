---
issue: planning#414
title: Shared package cache integrity between sessions
description: What must be true so that a session cannot use a shared package cache to place or change code that another session runs.
---

# Requirements — shared package cache integrity

Scoping doc for planning#414. The design lives in [plan.md](./plan.md).

## Context

Sessions share three caches so installs are fast:

| Surface | Key | Container path |
|---|---|---|
| Dependency download cache (docs/075) | per **repo** | `/dep-cache` |
| pnpm content-addressable store (docs/198) | per **runtime** — spans repos | `/workspace/.pnpm-store` |
| Overlay dependency base (docs/183) | per (repo, runtime, dep-dir) | the dep dir's read-only lowerdir |

Only the first two are mounted read-write into a session. The overlay base is
kept outside `dep-cache` so no session mounts it
(`src/server/orchestrator/overlay-volume.ts:5`), so "shared package cache"
below means the first two. Per-session uids
(docs/270) kept all three group-writable on purpose (`shareOne`,
`src/server/orchestrator/session-worker-uid.ts:124`), because
`docs/270-per-session-worker-uids` req 9 requires sessions to keep sharing them.

The pnpm store is the wider surface: an npm project shares its cache only with
sessions of the same repo, while a pnpm project shares its store with every pnpm
project on the instance.

## Requirements

1. A session MUST NOT be able to cause code of its choosing to run in another
   session by writing to a shared package cache.

2. Sessions MUST keep sharing the caches they share today. A session MUST NOT
   fail an install, or silently fall back to a private copy, because a different
   session wrote the shared cache first. *(`docs/270-per-session-worker-uids`
   req 9, human-approved there.)*

3. When content in a shared cache cannot be shown to be the content that was
   asked for, the install MUST fail, or obtain a trustworthy copy. It MUST NOT
   install the untrusted content.

4. The protection MUST cover dependencies a session has **already installed**,
   not only dependencies it installs after the poisoning.

5. Requirement 1 MUST hold for a repo that has no lockfile, or whose lockfile
   does not pin an integrity hash for every dependency. *(Agent-supplied;
   confirmed by the requester 2026-09-18 in answer to Q2 — see Resolved
   questions.)*

6. Requirement 1 MUST hold against writes to cached **resolution data** (what
   version and what bytes a dependency name resolves to), not only against
   writes to cached package content. *(Agent-supplied.)*

7. Whatever ShipIt does MUST NOT make a warm install materially slower than it
   is today. *(Agent-supplied; confirmed by the requester 2026-09-18 — see
   Resolved questions.)*

8. ShipIt MUST NOT let a project's own git hooks fire on the orchestrator-side
   auto-commit path (`docs/266-orchestrator-git-trust-boundary` E4) while a
   session can still place executable content in another session's dependency
   directory. *(Agent-supplied; approved by the requester 2026-09-17, Q4.)*

9. The agent MUST be able to run `npm install` and equivalent package-manager
   commands inside its own session, and they MUST work. *(Requester,
   2026-08-20.)*

10. Requirement 1 MUST be met **without** materially increasing per-session disk
    use. Isolation and the storage savings are both required. *(Requester,
    2026-09-17.)*

11. The agent MUST be able to edit files inside installed packages in its own
    session — a `patch-package`-style fix, or changing a dependency to debug it —
    and the edit MUST NOT be visible to any other session. *(Requester,
    2026-09-17, Q5 — see the receipt for how the answer was read.)*

## Open questions

None.

## Resolved questions

- 2026-08-20 — Q1 option (c), a ShipIt-owned fetch replacing the session's own
  install command, was rejected: *"the agent should be able to run `npm install`
  or similar"*. Recorded as req 9.
- 2026-09-17 — Q1 (project-key the pnpm store, or give each session its own
  copy): both options rejected: *"find a way to keep the space savings but avoid
  sessions to affect each other."* Recorded as req 10. Q3 (does a per-session
  copy conflict with docs/270 req 9) is closed by the same answer, since
  copy-on-write removes the disk cost the conflict was about.
- 2026-09-18 — Q2 (may ShipIt require projects to have a lockfile with
  integrity hashes, as a security measure): **no, do not require one.** The
  agent had withdrawn the question on 2026-09-17 on measurement alone (a
  lockfile does not cover `npm install <new-package>`, and the per-session
  resolution cache covers a repo with no lockfile); the requester confirmed
  that answer. Repos without a lockfile keep working unchanged. Req 5 stands
  and is human-confirmed.
- 2026-09-18 — Req 7 (a warm install must not get materially slower) had been
  supplied by the agent with no provenance recorded. Asked whether to keep or
  strike it, the requester said **keep it**. Req 7 is now human-confirmed.
- 2026-09-18 — The requester ruled that requirements state the final state
  only: explanatory notes about current behaviour or rationale do not belong
  on a requirement. Such notes were removed from reqs 1, 4 and 6; provenance
  tags (who supplied a requirement, and when it was confirmed) stay.
- 2026-09-17 — Q4 (hold `docs/266-orchestrator-git-trust-boundary` E4 until the
  H3 fix ships): **(a) hold**. Approves req 8.
- 2026-09-17 — Q5 (must the agent be able to edit files inside installed
  packages): **(a) yes**, with the words *"yes, the agent should be able to
  call `npm install` or similar"*. The words restate req 9; the option selected
  is the editing capability, and that is what req 11 records. If that reading
  is wrong, req 11 is the thing to strike.
