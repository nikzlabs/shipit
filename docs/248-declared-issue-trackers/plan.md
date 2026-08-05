---
issue: https://linear.app/shipit-ai/issue/SHI-318
title: Declared issue trackers
description: Declare additional issue trackers in shipit.yaml, route every operation to a named repository, and reference issues through rename-proof aliases.
---

# 248 — Declared issue trackers

Implements [requirements.md](./requirements.md). Supersedes
`247-private-github-issue-tracker`, which held both this mechanism and ShipIt's
own private-planning policy; that policy now lives in
[247](../247-shipit-private-planning/plan.md). The tracker comparison that led
here is the [evaluation](../246-native-issue-tracker-evaluation/plan.md).

## Status

**Requirements 1–5 and 7–10 ship.** Declarations, `--repo`, qualified routing,
the extra Issues tab, the fail-closed access error, and pointer-only branch names
are all built. **Requirement 6 (aliases) is designed but not implemented**, and it
changes two shipped behaviors — see [Aliases](#aliases-requirement-6).

The hard part was never CRUD — it was preserving the authoritative repository
target through every UI, CLI, Undo, session-start, and PR-lifecycle path, with
**one** piece of state rather than a parallel field threaded through each of them.

## How repository identity is carried

The implementation collapsed onto a single idea: **the repository lives in the
tracker id**. `"github"` keeps its old meaning (the session's own code repo) and
`` `github:${owner}/${repo}` `` names one explicitly, so `TrackerId` widened from
a closed union to include that template-literal member.

That one change satisfies the core invariant everywhere at once, because the
tracker id was *already* the thing every surface round-trips:

| Surface | Why it routes correctly |
|---|---|
| `?tracker=` on the routes + `/agent-ops/issue/*` | Already carried the id verbatim; the relay is a pass-through, so no schema change. |
| `IssueWriteCard.tracker`, persisted in chat history | Undo resolves `card.tracker` — so an Undo replays against the repository the write hit, with **no new column and no migration**. |
| `parseIssueRef` dedup key (`tracker:issueId`) | Becomes qualified for free, so `a/x#42` and `b/y#42` stop colliding. |
| PR-body `Closes` / `Refs` pointers | `parsePrBodyIssueRefs` delegates to `parseIssueRef`, so merge effects inherit the qualified destination. |
| The Issues sub-tab | Already keyed by tracker id. |

The alternative — a parallel `repo` field beside a `tracker: "github"` — was
rejected precisely because it re-creates the bug it was meant to fix: a
display-ish `tracker` sitting next to the real routing data invites exactly the
reduction the invariant forbids, and it would have needed a persisted-card field,
a DB migration, and a legacy-card fail-closed path. Comparisons therefore use
`isGitHubTracker(id)` from `shared/tracker-id.ts`, never `=== "github"`.

## Core invariant: repository identity is routing data

Every GitHub operation carries a structured target of `owner`, `repo`, and issue
number. Repository identity is never reduced to display text and reconstructed
later. The resolver's rules:

1. An operation that names a repository — `--repo owner/name`, or a qualified
   `owner/repo#number` pointer — uses **that** repository, verbatim. ShipIt does
   not check it against a known set: any repository the credential can reach is
   reachable, and GitHub authorization is the only gate (req 1). A repository the
   credential cannot see fails closed with an inline access error naming both
   possibilities (missing or inaccessible).
2. An operation that names none keeps its current meaning: the active session's
   code repository. This is what makes the feature backward-compatible — no
   existing command changes destination.
3. ShipIt never substitutes one repository for another. A named repository is
   never rewritten to the active code remote, and a failure is never retried
   against a fallback.
4. Bare issue numbers resolve against the repository the operation resolved by
   rules 1–2 — never against a different one.
5. Missing configuration or repository access fails closed; there is no code
   repository fallback.
6. Every identity key derived from an issue — parser deduplication, persisted
   merge-effect guards, and deterministic card IDs — includes the qualified
   repository as well as the issue number.

These rules apply equally to reads and mutations, including Undo and delayed
effects after a PR merge. The binding is resolved at the operation boundary and
captured for asynchronous work rather than reread from whichever session later
happens to be active.

The prior behavior this fixes: the shared pointer parser retained `owner/repo` in
a display identifier while downstream services received a bare issue number and
reconstructed context from the code remote — so a pointer such as
`other-owner/other-repo#42` could mutate code-repository issue `#42`.

### Branch names (req 5)

Sessions seeded from an issue keep the title in ShipIt — it is still the session
title and still opens the seed prompt — but the **pushed branch name is the
pointer alone** (`seedFromIssueRef`). A branch reaches a public remote, so a title
from a private issue would be published there.

The rule is **unconditional**, not scoped to declared trackers. There is no
connect step (req 3), and therefore nothing that could tell ShipIt which
repositories are private: a declared repo may be public and a session's own code
repo may be private, so any narrower rule would be a guess dressed as a policy.
The cost — `shi-67` instead of `shi-67-inline-tracker-issues-tab`, for every
tracker — was accepted explicitly. Determinism is unchanged: the branch was
already a pure function of the issue. Public PR **titles** are outside this: the
agent writes them with `gh pr create -t`, so ShipIt generates no PR title to
derive from a pointer.

## Configuration

**Trackers are declared, not connected** (req 3). Additional trackers are listed
in the repository's `shipit.yaml`, alongside the `agent`, `compose`, and `release`
blocks it already carries. Each entry is a **tagged union discriminated on
`kind`** (the same discriminator the issue domain types already use for
`IssueWriteUndo`), not a bare list of repositories. The identifying fields belong
to the kind — `repo` is GitHub's — so a tracker identified by something else can
be added later without reshaping the block or migrating existing configs. An
entry whose `kind` the running ShipIt does not recognize is skipped with a
warning, so a config written against a newer version degrades instead of failing
the session.

This is the pattern the product already uses for stack shape — declared in the
repo, versioned with it, reconciled by ShipIt — rather than a Settings surface the
user operates. It buys three things at once:

- **No configuration subsystem.** No Settings connect flow, no `CredentialStore`
  field, no connection-time validation endpoint, no migration.
- **Project scoping for free.** `shipit.yaml` is per repository, so a Project's
  sessions see exactly the trackers their own repositories declare. The
  [Projects](../231-projects/plan.md) design consequently needs no tracker work at
  phase 1c — there is no deployment-wide binding to scope.
- **Plural at no extra cost.** A repository may declare several.

**There is no new fixed tracker identity either.** On the CLI the destination is a
*repository*, named on the operation: `shipit issue … --tracker github --repo
owner/name` (req 1). An operation naming no repository still resolves the active
session's code remote, so neither a declaration nor a setting can silently change
where an existing command writes. `--repo` accepts any repository the credential
can reach, so it is not limited to what `shipit.yaml` declares; declarations drive
the *UI tabs*, not the CLI's reachable set. That asymmetry is why `registry.get()`
synthesizes any well-formed qualified id while `registry.list()` returns only
declared ones.

Because nothing is "saved", there is no moment at which to validate. ShipIt does
not check that a declared repository exists, is private, or has Issues enabled; a
declared tracker is exercised by ordinary requests and its tab surfaces an inline
error when one fails. Two accepted consequences: declaring a *public* repository
is not caught, and on a public code repository the committed `shipit.yaml`
discloses the declared repository's slug.

## Authentication

Tracker calls use the same contextual GitHub credential as ShipIt's other GitHub
operations: the deployment credential initially, the owning Project's credential
after Projects phase 1c. There is no second tracker credential, no tracker ACL,
and no per-viewer GitHub-membership check — GitHub authorizes the credential, not
the viewer (req 9). For GitHub App authentication the installation must include
the repository; for a user token, that token must grant Issues access there.

Note the credential is the **account-wide** token (`githubAuthManager.getToken()`),
not the repo-scoped installation token — a fine-grained PAT scoped to one
repository will fail on every other one.

Credentials remain outside session containers. GitHub returns `404` for a private
repository the credential cannot see, so ShipIt cannot distinguish "missing" from
"inaccessible"; the inline error names both. Repository-scoped `403` responses are
also access failures. Neither invalidates otherwise valid credentials; only an
authentication failure may do that. There is no poller and no periodic
membership/visibility check.

## Aliases (requirement 6)

**Not implemented.** A declaration may carry an `alias`, and `planning#123` then
resolves through it. Two things make this cheap and one makes it invasive.

**Cheap:** `alias#123` is a free slot in the pointer grammar. `parseIssueRef`
matches `owner/repo#N` (`GITHUB_SHORT_RE` requires the slash), bare Linear keys,
and full URLs, and deliberately rejects bare `#42` as tracker-ambiguous — so a
single bare token before `#` matches nothing today. And the resolution target is
an existing qualified id, so everything downstream of the parser is unchanged.

**Invasive:** `parseIssueRef` is currently **pure and context-free** — it takes a
string and nothing else, which is why the client chip and the server shim can
share it. An alias cannot be resolved without the declarations, so either the
function grows a context parameter threaded through every call site, or alias
resolution happens in a thin layer above it that both consumers call. The second
keeps the parser pure and is the shape to prefer; the call-site audit is the real
work.

Three consequences to design against, each following from a requirement:

- **ShipIt emits the alias everywhere** (req 6, req 7). Every site that today
  formats a qualified pointer — the PR-body `Closes`/`Refs` writer, provenance and
  read cards, `shipit issue` output, doc `issue:` frontmatter written by the agent
  — must render the alias when the target tracker has one. This is the bulk of the
  work and it is spread across surfaces that currently format independently, so it
  wants a single formatter rather than N call sites learning about aliases.
- **A self-declaration must be honored** (req 6). `buildTrackerRegistry` currently
  *skips* a declaration whose `owner/repo` case-insensitively matches the
  session's own repo, on the reasoning that it duplicates the bare `github`
  tracker. That skip has to go: a self-declaration is how a code repository gets
  an alias. The resulting entry must not produce a duplicate tab.
- **Resolution happens at use, not at write** (req 2). Nothing pins an alias to
  the repository it resolved to when written — including persisted Undo card
  targets. Re-pointing an alias re-targets history written against it, and the UI
  shows the repository it now resolves to. This *removes* a guarantee the shipped
  code currently provides, so the audit is for places that assume a recorded
  target is immutable.

Open design points (not requirements questions — these are mechanism choices):
duplicate/conflicting aliases across declarations, whether an alias may collide
with a GitHub owner name, and what an unresolvable alias renders as (it must fail
closed and stay legible, not silently degrade to a broken link).

## Key files (as built)

- `src/server/shared/tracker-id.ts` — the qualified-id vocabulary:
  `githubTrackerId`, `parseGitHubTrackerId`, `isGitHubTracker`, `parseOwnerRepo`.
  Every comparison goes through it so nothing reduces an id back to `"github"`.
- `src/server/shared/shipit-config.ts` — `parseIssuesConfig` / the
  `DeclaredTracker` union. Nothing here throws: unlike the other blocks, which gate
  the container, a tracker declaration gates one tab, so a malformed entry or an
  unrecognized `kind` warns and skips.
- `src/server/shared/issue-ref.ts` — `ParsedIssueRef.tracker` is a `TrackerId`, so
  a GitHub pointer resolves to its own repository. Pure and context-free; see
  [Aliases](#aliases-requirement-6).
- `src/server/shared/pr-issue-refs.ts` — `Refs`/`Closes`/`Fixes`/`Resolves`
  pointers inherit the qualified destination via `parseIssueRef`.
- `src/server/orchestrator/trackers/registry.ts` — one tracker per declaration;
  `get()` synthesizes any well-formed qualified id (the `list()`/`get()` asymmetry
  documented in that file).
- `src/server/orchestrator/trackers/github/adapter.ts` — configurable `id`/`label`;
  `accessError()` names both "missing" and "inaccessible" for the 403/404 pair.
- `src/server/orchestrator/api-routes-issues.ts` — `resolveGitHubTrackerContext`
  reads the session workspace's `shipit.yaml` per request (uncached: editing the
  file must change the tabs on the next request; a parse failure degrades to no
  declarations rather than breaking the tab).
- `src/server/orchestrator/issue-lifecycle.ts` — carries the target through seeded
  Started effects and merged-PR completion effects. Note the merge path resolves
  the destination from the *pointer*, which is what makes a `Closes` line target a
  different repository than the PR's own — GitHub's own keyword handling never
  closes cross-repository.
- `src/server/session/agent-shim/shipit-issue.ts` — `--repo` on every verb, via
  `resolveTrackerFlag` / `resolveIssuePointer`.
- `src/server/orchestrator/services/headless-sessions.ts` — `seedFromIssueRef`
  builds the branch from the identifier alone (req 5).
- Agent-facing docs: `src/server/shipit-docs/issues.md` (repository-resolution
  rules) and `shipit-docs/shipit-yaml.md` (the `issues:` block).

## Validation

The safety fixture contains two repositories, each with issue `#42`. Every
operation names one and asserts the other is unchanged. Coverage includes list,
detail, create, edit, status, labels, assignees, comments; agent writes and their
Undo; starting a session from an issue; PR `Refs` comments and merged `Closes`
effects, including a PR body containing same-numbered issues in both repositories
(deduplication, effect-guard keys, card IDs); reload or session switching before
delayed lifecycle work finishes; unreachable repository, insufficient permission,
and revoked access all failing without fallback and naming both "missing" and
"inaccessible"; a malformed or absent `issues.trackers` block, a `github` entry
missing `repo`, and an unrecognized `kind`, each warning and skipping; and an
operation naming `--repo` versus one naming none each reaching the repository
req 1 says it should.

Alias coverage is not written yet. It needs, at minimum: an alias pointer
resolving to its declared repository; an alias re-pointed to a second repository
re-targeting an existing recorded card (req 2); a self-declaration producing an
alias without a duplicate tab; ShipIt-generated PR bodies containing the alias
form rather than the qualified slug (req 7); and an unresolvable alias failing
closed.

## Known GitHub feature differences

Accepted without a parity gate (req 10), represented honestly rather than
emulated:

- workflow beyond Open/Closed needs an explicit status convention;
- priority writes need an agreed label convention — **out of scope here**, tracked
  as [SHI-310](https://linear.app/shipit-ai/issue/SHI-310), because the adapter
  already reads priority from labels but rejects `--priority` on writes for every
  GitHub destination, so fixing it in one place would leave the two destinations
  behaving differently for the same flag;
- parent/sub-issue reads and writes need GitHub API mapping;
- automatic Started cannot be represented by native Open/Closed state.

## Non-goals

- Making GitHub's web UI the primary issue workflow.
- Inferring a declared repository from the active code remote.
- Silently routing arbitrary cross-repository pointers.
- Emulating non-GitHub capabilities merely to preserve wrapper parity.
- Any issue migration or synchronization between trackers.
