---
title: Private GitHub issue tracker
description: Use a dedicated private GitHub repository as ShipIt's issue backend without routing writes to the code repository.
---

# 247 — Private GitHub issue tracker

## Status

This is the focused design for the private-GitHub option identified by the
[issue tracker evaluation](../246-native-issue-tracker-evaluation/plan.md).
It is not yet approved for implementation. The parent capability classification
and the configuration/privacy choices in [requirements.md](./requirements.md)
remain open.

The likely first increment is small: reuse ShipIt's existing GitHub adapter and
bind it to a dedicated private repository. The hard part is not CRUD; it is
preserving the authoritative repository target through every UI, CLI, Undo,
session-start, and PR-lifecycle path.

## User experience

The Issues list, issue detail, inline editing, comments, session creation,
agent provenance cards, and `shipit issue` commands remain inside ShipIt.
Users do not need GitHub open to work with issues. GitHub is the private storage
and API provider; its web UI is only an escape hatch for repository
administration or unsupported edge cases.

An operator connects a private repository that is distinct from the public
ShipIt code repository. Whether that connection is deployment-wide or belongs
to each ShipIt Project is an unresolved product decision. The first release
should not offer both models unless the user selects both: one authoritative
binding is easier to explain and safer to route.

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
3. A tracker pointer whose repository conflicts with the configured binding is
   routed only when its tracker destination explicitly permits that repository;
   otherwise it is rejected with a clear error. It is never rewritten to the
   active code repository or the other tracker destination.
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

Public PR bodies need a separate pointer rule. A fully qualified private tracker
pointer in a public code-repository PR discloses the private repository slug and
issue number. If that disclosure is not acceptable, PR lifecycle syntax must
use a bare issue number that `parsePrBodyIssueRefs` resolves only through the
single configured private binding. Today's parser deliberately rejects bare
`#42`, so this is a real parser and ambiguity change, not merely documentation.
The choice remains open in requirements.

## Configuration and authentication

The selected binding stores a GitHub `owner` and `repo`, not a URL inferred
from a coding session. Two scopes are still under consideration:

| Scope | Benefit | Cost |
|---|---|---|
| Deployment-wide | Smallest first release; one global issue workspace | All projects share one tracker and its labels/workflow |
| Per ShipIt Project | Natural isolation and stable project-to-tracker routing | Depends on the Projects configuration model and needs unbound-project UX |

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

Likewise, selecting an existing repository is the recommended provisioning
path for the first release. Creating a private repository manually is a small
one-time administrative action, while creation from ShipIt adds permission
scopes, naming and ownership choices, collision handling, and an externally
consequential create action. It should be added only if the user explicitly
selects it as a requirement.

The orchestrator acquires a token explicitly scoped for the selected tracker
repository. For GitHub App authentication, the App must be installed on that
repository and ShipIt must mint a repository-scoped token for it; a code-repo
token is not reused. For a user token, the token must grant Issues read/write
access to the tracker repository. Credentials remain outside session
containers. A repository-scope `403` is reported as an access/configuration
failure and must not invalidate otherwise valid GitHub credentials; only an
authentication failure may do that. Every ShipIt user who performs attributed
tracker writes needs repository access, which also constrains available
assignees.

GitHub Free currently advertises unlimited private repositories and Issues, so
this option meets the free/no-subscription constraint today. Pricing and
feature availability must be revalidated before implementation because they
are upstream service terms, not a ShipIt guarantee.

## Capability fit

The canonical C1–C18 inventory and current feasibility analysis remain in the
[evaluation requirements](../246-native-issue-tracker-evaluation/requirements.md)
and [GitHub feasibility table](../246-native-issue-tracker-evaluation/plan.md#github-capability-feasibility-pending-user-classification).
This document deliberately does not duplicate or pre-classify that table.

Known adapter gaps that matter only if their capabilities are marked Required:

- workflow beyond Open/Closed needs an explicit status convention;
- priority writes need an agreed label convention;
- parent/sub-issue reads and writes need GitHub API mapping;
- automatic Started cannot be represented by native GitHub Open/Closed state:
  starting from an open issue is otherwise a no-op. Therefore C15 can be
  Required only together with the writable C6 status-label/project convention.

ShipIt-owned capabilities such as session creation, tracker-neutral commands,
provenance cards, Undo, and PR lifecycle automation remain feasible only after
their full repository-routing paths satisfy the core invariant above.

## Data flow and integration points

The anticipated change threads one resolved GitHub tracker target through all
tracker entry points:

- `src/server/shared/issue-ref.ts` preserves qualified GitHub repository data in
  the parsed value rather than only its display form.
- `src/server/shared/pr-issue-refs.ts` preserves the same data for `Refs`,
  `Closes`, `Fixes`, and `Resolves` pointers, and implements the selected safe
  public-PR pointer syntax.
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
- the Issues UI displays unavailable Optional capabilities honestly and setup
  failures inline, without directing normal work to GitHub.

Exact files and types remain planning targets until the open requirements are
resolved and the current call graph is retraced at implementation time.

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
- every C1–C18 capability ultimately classified Required, with Optional gaps
  represented explicitly.

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
- Depending on paid GitHub plans or paid GitHub features.
- Implementing continuous two-way synchronization with Linear.
- Implementing unresolved Optional capabilities merely for blanket parity.

## Decision boundary

Implementation may begin only after the user classifies C1–C18 and chooses the
binding, provisioning, and public-PR disclosure models. Public user bug reports
and private owner planning issues are required to coexist as distinct tracker
destinations.
If C15 is Required, the C6 writable workflow convention is necessarily part of
the implementation. The option passes its design gate only if all Required
capabilities can be implemented without weakening the repository routing
invariant. Otherwise the broader evaluation proceeds to the Vikunja spike
rather than accumulating fragile GitHub conventions.
