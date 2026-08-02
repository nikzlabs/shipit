---
title: Private GitHub issue tracker
description: Use a dedicated private GitHub repository as ShipIt's issue backend without routing writes to the code repository.
---

# 247 — Private GitHub issue tracker

## Status

This is the focused design for the private-GitHub option identified by the
[issue tracker evaluation](../246-native-issue-tracker-evaluation/plan.md).
It is not yet approved for implementation. The capability classifications and
two configuration choices in [requirements.md](./requirements.md) remain open.

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
   rejected with a clear error unless explicit multi-repository behavior is
   selected later. It is never rewritten to the active code repository.
4. Bare issue numbers are accepted only in a context with one unambiguous
   configured tracker repository.
5. Missing configuration or repository access fails closed; there is no code
   repository fallback.

These rules apply equally to reads and mutations, including Undo and delayed
effects after a PR merge. The binding is resolved at the operation boundary and
captured for asynchronous work rather than reread from whichever session later
happens to be active.

## Configuration and authentication

The selected binding stores a GitHub `owner` and `repo`, not a URL inferred
from a coding session. Two scopes are still under consideration:

| Scope | Benefit | Cost |
|---|---|---|
| Deployment-wide | Smallest first release; one global issue workspace | All projects share one tracker and its labels/workflow |
| Per ShipIt Project | Natural isolation and stable project-to-tracker routing | Depends on the Projects configuration model and needs unbound-project UX |

Likewise, selecting an existing repository is the smallest provisioning path.
Creating a repository from ShipIt would add permission scopes, naming and
ownership choices, collision handling, and an externally consequential create
action. It should be added only if selected as a requirement.

The orchestrator uses the existing brokered GitHub identity and verifies that
it can read and write Issues in the selected private repository. Credentials
remain outside session containers. Setup must distinguish repository-not-found
from insufficient access as far as GitHub permits without revealing private
repository existence to an unauthorized identity.

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
- automatic Started depends on the selected workflow convention.

ShipIt-owned capabilities such as session creation, tracker-neutral commands,
provenance cards, Undo, and PR lifecycle automation remain feasible only after
their full repository-routing paths satisfy the core invariant above.

## Data flow and integration points

The anticipated change threads one resolved GitHub tracker target through all
tracker entry points:

- `src/server/shared/issue-ref.ts` preserves qualified GitHub repository data in
  the parsed value rather than only its display form.
- `src/server/shared/pr-issue-refs.ts` preserves the same data for `Refs`,
  `Closes`, `Fixes`, and `Resolves` pointers.
- tracker configuration resolves the selected private repository independently
  of the active session's code remote.
- `src/server/orchestrator/api-routes-issues.ts` uses that binding for list,
  detail, create, edit, comment, label, assignee, and status operations.
- `src/server/orchestrator/ws-handlers/issue-write-handlers.ts` records enough
  target data for Undo to address the original repository.
- `src/server/orchestrator/issue-lifecycle.ts` carries the target through seeded
  Started effects and PR progress/completion effects.
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
- reload or session switching before delayed lifecycle work finishes;
- missing binding, repository mismatch, insufficient permission, and revoked
  access, all failing without fallback;
- every C1–C18 capability ultimately classified Required, with Optional gaps
  represented explicitly.

## Migration and operations

The initial design does not require continuous Linear synchronization. If
migration is selected later, it should be a dry-run-capable, one-way import with
stable source IDs and idempotency. Linear remains unchanged.

GitHub owns storage durability, backups, availability, and API rate limits.
ShipIt owns target configuration, permission diagnostics, pagination, retry
behavior, and inline degraded-state UX. Tracker unavailability must not block
coding sessions, Git operations, or access to locally persisted chat history.

## Non-goals

- Storing issues in ShipIt's public source repository.
- Making GitHub's web UI the primary issue workflow.
- Inferring the tracker repository from the active code remote.
- Silently routing arbitrary cross-repository pointers.
- Depending on paid GitHub plans or paid GitHub features.
- Implementing continuous two-way synchronization with Linear.
- Implementing unresolved Optional capabilities merely for blanket parity.

## Decision boundary

Implementation may begin only after the user classifies C1–C18 and chooses the
binding and provisioning models. The option passes its design gate only if all
Required capabilities can be implemented without weakening the repository
routing invariant. Otherwise the broader evaluation proceeds to the Vikunja
spike rather than accumulating fragile GitHub conventions.
