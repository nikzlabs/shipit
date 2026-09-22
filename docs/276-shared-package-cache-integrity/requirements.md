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
the read-only lowerdir of an overlay volume, kept outside `dep-cache` so no
session can name its path (`src/server/orchestrator/overlay-volume.ts:5`); a
session changes it only through the publish path. "Shared package cache" below
means the first two. Per-session uids
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

12. These requirements MUST be met on ext4. Optimisations that exist only on
    other filesystems (reflink on btrfs / XFS) are out of scope. *(Requester,
    2026-09-18.)*

13. Package sharing between sessions MUST hold within a repo. Sharing across
    repos is not required. A repository the verified base cannot serve, for a
    reason stated in plan.md and cited at the source, installs privately and is
    outside this requirement; this requirement binds only the classes the design
    can reach. Those outside it are a repo with a `git:`/URL dependency, a
    `file:` dependency, a pnpm ≤ 10 pin, a `configDependencies` declaration, a
    scoped private registry with no operator-authorized scope→registry mapping,
    an unsupported `lockfileVersion` or a registry entry with no integrity hash,
    an escaping dependency layout (`modulesDir`, `virtualStoreDir`, or a
    non-isolated `nodeLinker`), no lockfile at the publisher or at the consumer,
    and an input the builder caps or refuses (too many manifests, an unreadable
    input, a dependency directory that is not `node_modules`). *(Requester,
    2026-09-18; the first three private classes, 2026-09-21; the next three,
    and the final three with the general principle, 2026-09-22.)*

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
- 2026-09-18 — Asked to decide storage after the ext4 measurements showed the
  store-in-overlay fix needs reflink to meet req 7 / req 10, the requester
  said: *"We need to support ext4: users run ShipIt on their machines or hosts
  most likely have ext4. If there are optimizations for other file systems,
  they are out of scope of this effort."* Recorded as req 12. Consequence: the
  store-in-overlay design is not viable as written (plan.md section 5).
- 2026-09-18 — Asked whether losing the pnpm store's cross-repo dedup is
  acceptable (the ext4 redesign makes the store private per session, so sharing
  becomes per-repo as npm's is): **"Yes, per-repo sharing is fine."** Recorded
  as req 13; it qualifies req 2's "what they share today" for the pnpm store.
- 2026-09-21 — Asked which classes of repo may stay **permanently** private
  under req 13, since a repo that gets no verified base leaves reqs 2, 10 and 13
  unmet for it and only the requester can rule a class outside a requirement.
  The options offered were "all three", "`git:`/URL and pnpm ≤ 10 only", and
  "none"; the answer was **"All three (Recommended)"**. The three, with the
  reason each: a **`git:`/URL source**, which carries no registry integrity to
  verify the fetched content against; a **`file:` dependency**, which pnpm
  copies rather than links, so a manifests-only builder publishes a truncated
  package at rc=0 (PR #2963); and a repo **pinning pnpm ≤ 10**, a legacy line
  whose store version this design does not target. Each installs privately,
  exactly as it did before this work. Recorded in req 13.
- 2026-09-22 — Asked which of the three remaining classes may stay
  **permanently** private under req 13. The options offered were "all three",
  "(a) and (c), wire the registry mapping first", and "none"; the answer was
  **"Rule all three permanently private and close planning#414"**. The three,
  with the reason each: **(a) a repo declaring `configDependencies`** — the
  builder neither parses nor stages a config dependency's resolution, so
  admitting it would have the builder fetch plugin packages off a footing no
  digest of ShipIt's covers (`pnpm-base-inputs.ts:519`; the hook itself is
  suppressed, confirmed in PR #2957); **(b) a repo on a scoped private registry
  with no operator-authorized scope→registry mapping** — the builder accepts
  such a map (`pnpm-base-builder.ts:106`, `pnpm-base-registry.ts:158`,
  `pnpm-base-inputs.ts:454`) but no orchestrator setting supplies one, the only
  production construction of those deps passing no such field
  (`bootstrap-managers.ts:520`); and **(c) a repo with an unsupported
  `lockfileVersion`, or a registry entry with no integrity hash** — the parser
  covers the v9/v10 shapes (`pnpm-base-inputs.ts:109`) and an entry carrying no
  digest cannot be verified against the registry at all. Each installs
  privately, exactly as it did before this work. Recorded in req 13.
- 2026-09-22 (the second ruling that day) — Asked whether the three rows that
  still had no ruling may stay **permanently** private under req 13, and whether
  a general principle should be recorded so no further row needs one. The
  options offered were that, "rule only the three rows private (no general
  principle)", and keeping them as work; the answer was **"Rule the three rows
  private, record the general principle, and close planning#414."** The three,
  with the reason each: an **escaping layout** — `modulesDir`,
  `virtualStoreDir` or a non-isolated `nodeLinker` places the tree where no
  single `node_modules` base can be mounted (the one permitted value per setting
  is `pnpm-base-inputs.ts:166`, refused in `decidePnpmBaseEligibility` at
  `pnpm-base-inputs.ts:582` and `:601`); **no lockfile at either end** —
  refusing a base there is reqs 1 and 3 working as designed, since a session
  without its own lockfile would adopt the base's graph (publisher side
  `pnpm-base-inputs.ts:262`, consumer side
  `container-overlay-provisioner.ts:113`), and the requester rules that reqs 1
  and 3 take precedence over req 13 for this class and that the mechanism must
  not change; and **the builder's caps and refusals** — too many manifests
  (`pnpm-base-inputs.ts:272`), an input past a size cap (`:282`) or one it
  cannot parse (`:315`, `:364`), and a dep dir that is not `node_modules`
  (`overlay-publish.ts:261`), bounded inputs being part of the verification
  contract. The **general principle**,
  recorded as an amendment to req 13: a repository the verified base cannot
  serve, for a reason stated in plan.md and cited at the source, installs
  privately and is outside req 13; req 13 binds only the classes the design can
  reach. Recorded in req 13.
