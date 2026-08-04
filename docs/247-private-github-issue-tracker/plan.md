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
separate parity gate. The product decisions in
[requirements.md](./requirements.md) are resolved, so implementation is no
longer blocked on a privacy-authorization choice.

The likely first increment is small: reuse ShipIt's existing GitHub adapter and
bind it to a dedicated private repository. The hard part is not CRUD; it is
preserving the authoritative repository target through every UI, CLI, Undo,
session-start, and PR-lifecycle path.

## User experience

The Issues list, issue detail, inline editing, comments, session creation,
agent provenance cards, and `shipit issue` commands remain inside ShipIt.
Users do not need GitHub open to work with issues. GitHub is the private storage
and API provider; its web UI is only an escape hatch for repository
administration or exceptional manual recovery. Missing inline support remains a
ShipIt backlog or degraded-state concern rather than a required GitHub step.

An operator connects a private repository that is distinct from the public
ShipIt code repository. The binding is deployment-wide initially, so sessions
for the owner's ShipIt-related private code repositories share it. When the
[Projects design](../231-projects/plan.md) is implemented, the binding follows
that feature's established model and becomes per Project.

The private planning tracker coexists with ShipIt's public issue tracker. User
bug reports — including reports submitted through ShipIt's existing bug-report
flow — continue to be created in the public ShipIt repository. Owner planning
issues use the private binding. These are distinct tracker destinations with
distinct UI labels and routing identities; configuring the private tracker must
not redirect, hide, or change the privacy of public bug reports.

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

active code remote ──────────────────────────────────── code/PR operations only
```

The resolver follows these rules:

1. List and create operations use the configured private tracker binding.
2. A fully qualified `owner/repo#number` pointer retains that repository as
   authoritative routing data.
3. A private-planning pointer whose repository conflicts with the configured
   binding is rejected before a GitHub request. It is never rewritten to the
   active code repository or the public tracker destination. The separate public
   bug tracker accepts only its fixed public ShipIt repository.
4. Bare issue numbers are accepted only in a context with one unambiguous
   configured tracker repository.
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

## Configuration and authentication

The selected binding stores a GitHub `owner` and `repo`, not a URL inferred
from a coding session. It is stored deployment-wide before Projects and in the
owning Project's configuration after Projects lands.

Binding scope is independent from tracker purpose. The private binding selects
the owner's planning repository. The public bug-report destination remains the
public ShipIt repository and is selected by the bug-report workflow, not by the
private planning setting.

The two destinations require separate stable tracker identities in ShipIt's
domain model and registry rather than overloading the single `github` key. Each
issue reference, persisted card, agent request, and lifecycle effect carries
which destination it belongs to as well as `owner/repo#number`. Public bug
reports and private planning issues can therefore share the same issue number
without colliding or being displayed as interchangeable records.

The user creates the private repository and ShipIt connects it. ShipIt does not
request repository-creation permission or implement naming, ownership,
collision, or initialization flows.

Private tracker calls use the same contextual GitHub credential as ShipIt's
other GitHub operations: the deployment credential initially and the owning
Project's credential after Projects ships. ShipIt does not introduce a second
tracker credential, a private-tracker ACL, or a per-viewer GitHub-membership
check. GitHub authorizes the credential against the configured repository. For
GitHub App authentication, the App installation must include that repository;
for a user token, that token must grant the required Issues access there.
Credentials remain outside session containers. A repository-scope `403` is
reported as an access/configuration failure and must not invalidate otherwise
valid GitHub credentials; only an authentication failure may do that.

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
- tracker configuration resolves the selected private repository independently
  of the active session's code remote.
- the tracker domain model and registry distinguish the public ShipIt bug
  tracker from the private planning tracker instead of constructing one
  session-derived `github` adapter for both purposes.
- `src/server/orchestrator/api-routes-issues.ts` uses that binding for list,
  detail, create, edit, comment, label, assignee, and status operations.
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
  rather than reducing it to a bare ID. `--tracker github 42` remains legal only
  when one configured binding makes it unambiguous.
- the Issues UI represents unavailable GitHub operations honestly and shows
  setup failures inline, without directing normal work to GitHub.

Exact files and types remain planning targets until the current call graph is
retraced at implementation time.

## Validation

The safety test fixture contains two repositories, each with issue `#42`. Every
operation names the private tracker issue and asserts that the code-repository
issue is unchanged. Coverage includes:

- list, detail, create, edit, status, labels, assignees, and comments;
- agent writes and their provenance Undo operation;
- starting a session from an issue and any automatic Started transition;
- PR `Refs` comments and merged `Closes` completion/comment effects;
- a PR body containing tracker and code-repository issues with the same number,
  including deduplication, persisted effect-guard keys, and card IDs;
- reload or session switching before delayed lifecycle work finishes;
- Undo of a legacy persisted card created before repository targets were stored;
- missing binding, repository mismatch, insufficient permission, and revoked
  access, all failing without fallback;
- public bug reports continuing to target the public ShipIt repository before
  and after private planning tracker configuration;
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
- Inferring the tracker repository from the active code remote.
- Redirecting Shipit's public user bug-report flow into the private planning
  repository.
- Silently routing arbitrary cross-repository pointers.
- Implementing continuous two-way synchronization with Linear.
- Emulating non-GitHub capabilities merely to preserve blanket wrapper parity.

## Decision boundary

The product decisions in requirements are resolved. Public user bug reports and
private owner planning issues coexist as distinct tracker destinations, public
PR bodies use fully qualified private-repository pointers, and GitHub authorizes
the same contextual credential used for other GitHub operations. GitHub's
feature set is accepted; implementation must represent unavailable normalized
operations honestly and must not weaken the repository-routing invariant to
simulate parity.
