---
issue: https://linear.app/shipit-ai/issue/SHI-304
title: Private GitHub issue tracker
description: Use a dedicated private GitHub repository as ShipIt's issue backend without routing writes to the code repository.
---

# 247 — Private GitHub issue tracker

## Status

This is the focused design for the private-GitHub option identified by the
[issue tracker evaluation](../246-native-issue-tracker-evaluation/plan.md).
Choosing GitHub Issues means accepting its feature set rather than passing a
separate parity gate. Every product question in
[requirements.md](./requirements.md) is resolved.

**The core is implemented.** Declarations, `--repo`, qualified routing, the extra
Issues tab, and the fail-closed access error all ship; see
[checklist.md](./checklist.md) for what remains (chiefly the session-seeding and
PR-lifecycle branch-naming work in requirement 1). The hard part was never CRUD —
it was preserving the authoritative repository target through every UI, CLI,
Undo, session-start, and PR-lifecycle path, and the section below records how
that ended up being achieved with **one** piece of state rather than a parallel
field threaded through each of them.

### How repository identity is actually carried

The implementation collapsed onto a single idea: **the repository lives in the
tracker id**. `"github"` keeps its old meaning (the session's own code repo) and
`` `github:${owner}/${repo}` `` names one explicitly, so `TrackerId` widened from
a closed union to include that template-literal member.

That one change is what satisfies the core invariant everywhere at once, because
the tracker id was *already* the thing every surface round-trips:

| Surface | Why it now routes correctly |
|---|---|
| `?tracker=` on the routes + `/agent-ops/issue/*` | Already carried the id verbatim; the relay is a pass-through, so no schema change. |
| `IssueWriteCard.tracker`, persisted in chat history | Undo resolves `card.tracker` — so an Undo replays against the repository the write hit, with **no new column and no migration**. |
| `parseIssueRef` dedup key (`tracker:issueId`) | Becomes qualified for free, so `a/x#42` and `b/y#42` stop colliding. |
| PR-body `Closes` / `Refs` pointers | `parsePrBodyIssueRefs` delegates to `parseIssueRef`, so merge effects inherit the qualified destination. |
| The Issues sub-tab | Already keyed by tracker id. |

The alternative — a parallel `repo` field beside a `tracker: "github"` — was
rejected precisely because it re-creates the bug: a display-ish `tracker` sitting
next to the real routing data invites exactly the reduction the invariant
forbids, and it would have needed a persisted-card field, a DB migration, and a
legacy-card fail-closed path. Comparisons therefore use `isGitHubTracker(id)`
from `shared/tracker-id.ts`, never `=== "github"`.

## User experience

The Issues list, issue detail, inline editing, comments, session creation,
agent provenance cards, and `shipit issue` commands remain inside ShipIt.
Users do not need GitHub open to work with issues. GitHub is the private storage
and API provider; its web UI is only an escape hatch for repository
administration or exceptional manual recovery. Missing inline support remains a
ShipIt backlog or degraded-state concern rather than a required GitHub step.

The code repository declares the private planning repository in its
`shipit.yaml`, and ShipIt renders it as an extra Issues tab. Because the
declaration lives in the repository, it is already scoped to it — the
[Projects design](../231-projects/plan.md) inherits that scoping and needs no
tracker work of its own. For ShipIt's own repository, the planning repo is also
named in `CLAUDE.md`, which is how the agent knows what to pass to `--repo`.

The private planning tracker is additional to each code repository's own GitHub
Issues tracker; it does not replace it. ShipIt product bug reports submitted
through the existing in-product flow continue to be created in the public
ShipIt repository. That fixed public destination is specific to ShipIt and is
not a general issue tracker for other code repositories. The code-repository
tracker, private planning tracker, and ShipIt bug-report flow have distinct UI
labels and routing identities.

## Existing foundation

`src/server/orchestrator/trackers/github/adapter.ts` already lists and reads
issues, creates issues and labels, edits titles, bodies and labels, manages
comments and assignees, and changes Open/Closed state. ShipIt's normalized
tracker contract already feeds the Issues UI, `shipit issue`, seeded sessions,
provenance/Undo, and PR `Refs` and `Closes` automation.

The existing implementation assumes that a GitHub tracker is the active
session's code repository. That assumption is unsafe for this design. The
shared pointer parser retains `owner/repo` in a display identifier while
downstream services receive a bare issue number and reconstruct context from
the code remote. A pointer such as `tracker-owner/private-issues#42` can
therefore mutate code-repository issue `#42` or fail, instead of operating on
the private tracker issue.

## Core invariant: repository identity is routing data

Every GitHub operation must carry a structured target containing `owner`,
`repo`, and issue number. Repository identity must never be reduced to display
text and reconstructed later.

```text
configured private repo ─┐
                         ├─ resolve + validate target ─ GitHub adapter ─ private issue
qualified issue pointer ─┘

active code remote ─────────────────────────────── code-repository issue operations
```

The resolver follows these rules:

1. An operation that names a repository — `--repo owner/name`, or a fully
   qualified `owner/repo#number` pointer — uses **that** repository, verbatim.
   ShipIt does not check it against a known set: any repository the GitHub
   credential can reach is reachable, and GitHub authorization is the only gate
   (req 3). A repository the credential cannot see fails closed with an inline
   access error naming both possibilities (missing or inaccessible).
2. An operation that names none keeps its current meaning: the active session's
   code repository. This is what makes the change backward-compatible — no
   existing command changes destination.
3. ShipIt never substitutes one repository for another. A named repository is
   never rewritten to the active code remote or the public bug-report
   destination, and a failure is never retried against a fallback. The separate
   ShipIt bug-report flow accepts only its fixed public ShipIt repository.
4. Bare issue numbers resolve against the repository the operation resolved by
   rules 1–2 — never against a different one.
5. Missing configuration or repository access fails closed; there is no code
   repository fallback. Legacy persisted cards that lack repository identity
   also fail closed when undone; they are never retroactively aimed at the
   active session remote.
6. Every identity key derived from an issue — parser deduplication, persisted
   merge-effect guards, and deterministic card IDs — includes the qualified
   repository as well as the issue number.

These rules apply equally to reads and mutations, including Undo and delayed
effects after a PR merge. The binding is resolved at the operation boundary and
captured for asynchronous work rather than reread from whichever session later
happens to be active.

Public PR bodies use fully qualified private tracker pointers such as
`owner/private-repo#42`. This is unambiguous routing data and works with the
existing qualified-pointer syntax. The user accepts that the public PR exposes
the private repository slug, referenced issue number, and existence of the
planning issue; issue contents remain inaccessible without repository access.
Bare numbers and opaque ShipIt pointer aliases are not part of the initial
design.

Sessions seeded from private planning issues keep the issue title in ShipIt,
but derive pushed branch names and public PR titles from the qualified pointer
alone. This prevents the existing title-based branch and PR naming path from
publishing private content.

## Configuration and authentication

**Trackers are declared, not connected** (req 5). Additional GitHub issue
repositories are listed in the code repository's `shipit.yaml`, alongside the
`agent`, `compose`, and `release` blocks it already carries:

```yaml
issues:
  trackers:
    - kind: github                # which tracker backs this tab
      repo: owner/planning        # GitHub Issues: `owner/name`
      label: Planning             # optional; defaults to the repo name
```

Each entry is a **tagged union discriminated on `kind`** (the same discriminator
name the issue domain types already use for `IssueWriteUndo`), not a bare list of
repositories. The identifying fields belong to the kind — `repo` is GitHub's, and
a tracker identified by something else entirely can be added later without
reshaping the block or migrating existing configs. This feature defines only
`github`; nothing here specifies what any other kind's fields would be. An entry
whose `kind` the running ShipIt does not recognize is skipped with a warning, so
a config written against a newer version degrades instead of failing the session
(the same treatment `shipit-config.ts` already gives unknown keys).

This is the pattern the product already uses for stack shape — declared in the
repo, versioned with it, reconciled by ShipIt — rather than a Settings surface
the user has to operate. It buys three things at once:

- **No configuration subsystem.** No Settings connect flow, no `CredentialStore`
  field, no connection-time validation endpoint, no migration.
- **Project scoping for free.** `shipit.yaml` is per repository, so a Project's
  sessions see exactly the trackers their own repositories declare. The
  [Projects](../231-projects/plan.md) design consequently needs no tracker work
  at phase 1c — there is no deployment-wide binding to scope and no Default
  Project alias.
- **Plural at no extra cost.** A repository may declare several.

**There is no new fixed tracker identity either.** On the CLI the destination is
a *repository*, named on the operation: `shipit issue … --tracker github --repo
owner/name` (req 3). `github` keeps its current meaning, and an operation naming
no repository still resolves the active session's code remote — so neither a
declaration nor a setting can silently change where an existing command writes.
`--repo` accepts any repository the credential can reach, so it is not limited to
what `shipit.yaml` declares; declarations drive the *UI tabs*, not the CLI's
reachable set.

The consequence is that `TrackerId` can no longer be the closed
`"linear" | "github"` union it is today, because declared trackers are open-ended.
Declared trackers take a derived id of the form `github:owner/repo`, which keys
the sub-tab and the `?tracker=` query the same way the fixed ids do.

Persisted issue references and effects carry the qualified `owner/repo#number`,
which is what prevents same-number collisions. The public bug-report flow remains
outside the tracker registry and keeps its fixed ShipIt upstream repository.

The user creates the repository and declares it. ShipIt does not create it, does
not request repository-creation permission, and implements no naming, ownership,
collision, or initialization flow.

Because nothing is "saved", there is no moment at which to validate.
ShipIt does not check that a declared repository exists, is private, or has
Issues enabled; a declared tracker is exercised by ordinary requests and its tab
surfaces an inline error when one fails. Two accepted consequences follow:
declaring a *public* repository is not caught, and on a public code repository
the committed `shipit.yaml` discloses the planning repository's slug — an
extension of the disclosure requirement 7 already accepts for PR bodies.

Private tracker calls use the same contextual GitHub credential as ShipIt's
other GitHub operations: the deployment credential initially and the owning
Project's credential after Projects phase 1c. ShipIt does not introduce a second
tracker credential, a private-tracker ACL, or a per-viewer GitHub-membership
check. GitHub authorizes the credential—not the viewer—against the configured
repository. Anyone with access to the deployment initially, or the Project
after phase 1c, can therefore operate on the tracker through ShipIt regardless
of their personal GitHub membership. For
GitHub App authentication, the App installation must include that repository;
for a user token, that token must grant the required Issues access there.
Credentials remain outside session containers. GitHub may return `404` for a
private repository that the credential cannot see, so ShipIt cannot distinguish
"missing" from "inaccessible" in that case; the inline error must name both
possibilities. Repository-scoped `403` responses are also access/configuration
failures. Neither response invalidates otherwise valid GitHub credentials; only
an authentication failure may do that.

There is no poller and no periodic membership/visibility check; normal GitHub
requests surface authorization and availability failures inline (req 3). The
operator remains responsible for keeping the repository private in GitHub.

Changing a declaration gets no dedicated mechanism (req 3). A target ShipIt
already recorded — an Undo card's stored `owner/repo#number`, a qualified pointer
in an open PR body — is routing data in its own right, so the deferred effect
simply uses it and GitHub authorization decides whether it still succeeds. That
is what the core invariant already produces with no extra code; validating such a
target against the current declarations would mean *adding* a comparison for an
event that happens at most once in a repository's life. Editing `shipit.yaml`
changes which tabs appear and nothing else. No issue migration or synchronization
mechanism is proposed.

## Accepted GitHub feature set

This focused design assumes GitHub Issues has been selected and accepts its
feature set. The broader [evaluation](../246-native-issue-tracker-evaluation/plan.md)
retains its comparison inventory, but that inventory does not gate this design.
Known differences between GitHub and ShipIt's current normalized behavior are:

- workflow beyond Open/Closed needs an explicit status convention;
- priority writes need an agreed label convention;
- parent/sub-issue reads and writes need GitHub API mapping;
- automatic Started cannot be represented by native GitHub Open/Closed state;
  starting from an open issue is otherwise a no-op unless ShipIt later adopts a
  writable status-label/project convention.

**Priority writes are out of scope for this feature** and tracked separately as
[SHI-310](https://linear.app/shipit-ai/issue/SHI-310). They are a property of the
shared GitHub adapter rather than of the private planning binding — the adapter
already *reads* priority from labels but rejects `--priority` on writes for every
GitHub destination — so fixing them here would either leave the two destinations
behaving differently for the same flag, or quietly widen this feature into the
code-repository tracker. This feature inherits whatever the adapter does.

ShipIt-owned capabilities such as session creation, tracker-neutral commands,
provenance cards, Undo, and PR lifecycle automation remain feasible only after
their full repository-routing paths satisfy the core invariant above.

## Data flow and integration points

The anticipated change threads one resolved GitHub tracker target through all
tracker entry points:

- `src/server/shared/issue-ref.ts` preserves qualified GitHub repository data in
  the parsed value rather than only its display form.
- `src/server/shared/pr-issue-refs.ts` preserves the same data for `Refs`,
  `Closes`, `Fixes`, and `Resolves` fully qualified pointers.
- parser deduplication, deterministic lifecycle card IDs, and the persisted
  applied-merge-effect keys qualify issue numbers with `owner/repo`; migration
  handling for existing bare-number keys must prevent duplicate effects without
  making a wrong-repository assumption.
- `src/server/shared/shipit-config.ts` parses the new `issues.trackers` block as
  a `kind`-discriminated list, with the same unknown-key warning treatment the
  other blocks get. A malformed entry, a missing `repo` on a `github` entry, and
  an unrecognized `kind` all warn and skip that entry rather than failing the
  session — the forward-compatibility path req 5 requires.
- `src/server/orchestrator/trackers/registry.ts` builds one `GitHubTracker` per
  declared repository in addition to the session-derived one, giving each a
  derived `github:owner/repo` id. `TrackerId` widens from a closed union
  accordingly, and `GitHubTracker`'s hardcoded `id`/`label` become configuration.
  The public ShipIt bug-report service stays outside this registry and keeps its
  fixed upstream repository.
- `src/server/orchestrator/api-routes-issues.ts` resolves the operation's
  repository for list, detail, create, edit, comment, label, assignee, and status
  operations, from `--repo`/the tab's tracker id, falling back to the session's
  code remote.
- `src/server/orchestrator/ws-handlers/issue-write-handlers.ts` records enough
  target data for Undo to address the original repository. Because issue-write
  cards persist in chat history, the repository target must round-trip through
  the typed persisted message, database row/migration, history rehydration, and
  optional-field guard fixtures; old cards without a target fail closed.
- `src/server/orchestrator/issue-lifecycle.ts` carries the target through seeded
  Started effects and PR progress/completion effects; the session manager's
  applied-effect store and card IDs use qualified identity keys.
- `src/server/session/agent-shim/shipit-issue.ts`, the `/agent-ops/issue/*`
  request schema, and orchestrator validation preserve a qualified pointer
  rather than reducing it to a bare ID, and carry the new `--repo owner/name`
  argument. `--tracker github` with no `--repo` continues to mean the active
  code repository (req 3).
- the Issues UI represents unavailable GitHub operations honestly and shows
  setup failures inline, without directing normal work to GitHub.

### Key files (as built)

- `src/server/shared/tracker-id.ts` — the qualified-id vocabulary:
  `githubTrackerId`, `parseGitHubTrackerId`, `isGitHubTracker`, `parseOwnerRepo`.
  Every comparison goes through it so nothing reduces an id back to `"github"`.
- `src/server/shared/shipit-config.ts` — `parseIssuesConfig` / the
  `DeclaredTracker` union. Nothing here throws: unlike the other blocks, which
  gate the container, a tracker declaration gates one tab, so a malformed entry
  or an unrecognized `kind` warns and skips.
- `src/server/shared/issue-ref.ts` — `ParsedIssueRef.tracker` is a `TrackerId`,
  so a GitHub pointer resolves to its own repository.
- `src/server/orchestrator/trackers/registry.ts` — declared trackers registered
  per declaration; `get()` synthesizes any well-formed qualified id (the
  `list()`/`get()` asymmetry documented in that file).
- `src/server/orchestrator/trackers/github/adapter.ts` — configurable `id`/`label`;
  `accessError()` names both "missing" and "inaccessible" for the 403/404 pair.
- `src/server/orchestrator/api-routes-issues.ts` — `resolveGitHubTrackerContext`
  reads the session workspace's `shipit.yaml` per request (uncached: editing the
  file must change the tabs on the next request; a parse failure degrades to no
  declarations rather than breaking the tab).
- `src/server/session/agent-shim/shipit-issue.ts` — `--repo` on every verb, via
  `resolveTrackerFlag` / `resolveIssuePointer`.
- Agent-facing docs: `src/server/shipit-docs/issues.md` (repository-resolution
  rules; supersedes the old "no cross-repo access" claim) and
  `shipit-docs/shipit-yaml.md` (the `issues:` block).

## Validation

The safety test fixture contains two repositories, each with issue `#42`. Every
operation names the private tracker issue and asserts that the code-repository
issue is unchanged. Coverage includes:

- list, detail, create, edit, status, labels, assignees, and comments;
- agent writes and their provenance Undo operation;
- starting a session from an issue and any automatic Started transition;
- pointer-only pushed branch and public PR names for private issue sessions,
  with no private title disclosure;
- PR `Refs` comments and merged `Closes` completion/comment effects;
- a PR body containing tracker and code-repository issues with the same number,
  including deduplication, persisted effect-guard keys, and card IDs;
- reload or session switching before delayed lifecycle work finishes;
- Undo of a legacy persisted card created before repository targets were stored;
- an unreachable repository, insufficient permission, and revoked access, all
  failing without fallback and naming both "missing" and "inaccessible";
- a malformed or absent `issues.trackers` block, a `github` entry missing `repo`,
  and an entry with an unrecognized `kind`, each warning and skipping rather than
  failing the session; declaring the session's own code repo being harmless;
- public bug reports continuing to target the public ShipIt repository before
  and after trackers are declared;
- code-repository GitHub Issues continuing to target each active code
  repository before and after trackers are declared;
- editing `shipit.yaml` changing which tabs appear and nothing else — recorded
  Undo targets and open-PR pointers still resolve to what they recorded;
- no proactive access or privacy polling, with GitHub request failures
  represented inline;
- an operation naming `--repo`, and one naming none, each reaching the repository
  req 3 says they should;
- the accepted GitHub feature differences represented honestly rather than
  failing silently.

## Migration and operations

Linear migration is owned by the
[broader evaluation](../246-native-issue-tracker-evaluation/plan.md); continuous
two-way synchronization is not part of this option.

GitHub owns storage durability, backups, availability, and API rate limits.
ShipIt owns target configuration, permission diagnostics, pagination, retry
behavior, and inline degraded-state UX. Tracker unavailability must not block
coding sessions, Git operations, or access to locally persisted chat history.

## Non-goals

- Storing issues in ShipIt's public source repository.
- Making GitHub's web UI the primary issue workflow.
- Inferring the private planning repository from the active code remote; the
  separate code-repository issue tracker still uses that remote.
- Redirecting Shipit's public user bug-report flow into the private planning
  repository.
- Silently routing arbitrary cross-repository pointers.
- Implementing continuous two-way synchronization with Linear.
- Emulating non-GitHub capabilities merely to preserve blanket wrapper parity.

## Decision boundary

All product decisions are resolved. GitHub authorizes the same contextual
credential used for other GitHub operations, not each ShipIt viewer.
Each code repository keeps its own GitHub Issues tracker, private owner planning
uses the configured private destination, and the fixed public bug-report flow is
specific to ShipIt. Public PR bodies use fully qualified private-repository
pointers without private titles. GitHub's feature set is accepted;
implementation must represent unavailable normalized operations honestly and
must not weaken the repository-routing invariant to simulate parity.
