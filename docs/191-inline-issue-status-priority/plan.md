---
issue: https://linear.app/shipit-ai/issue/SHI-106
description: Set an issue's status (both trackers) and priority (Linear) inline from the issue list and the detail view.
---

# Inline issue status & priority editing (docs/191)

Set an issue's **status** and **priority** directly from ShipIt — on the issue
**list rows** and on the inline **detail view** — without leaving the tab or
asking the agent. This closes the read/write gap left by docs/170 (read-only
list), docs/189 (inline detail + user comments), and docs/177 (the *agent's*
write surface): a user could already read an issue and post a comment inline,
but had to bounce to Linear/GitHub to triage status/priority.

## Scope decision: priority is Linear-only

- **Status** is editable for **both** trackers. The `Tracker.setStatus()` method
  already exists (docs/177): Linear resolves a team workflow state, GitHub maps
  to open/closed (+ `state_reason`).
- **Priority** is editable for **Linear only**. Linear has a native numeric
  priority field; GitHub has none (it's label-derived) and its adapter
  deliberately *rejects* priority writes (SHI-92). Rather than fake it via label
  manipulation, the UI gates the priority editor on the tracker — GitHub rows
  keep a read-only priority badge. The server still backstops this: a GitHub
  priority write returns 422.

## User action, not agent provenance

These are the **user's own direct manipulation**, so — exactly like the
user-posted comment (docs/189) — they go through **public `/api/issue/...`
routes** and emit **no chat provenance card and no undo**. That's the dividing
line from the agent's do-then-surface writes (docs/177), which return an
`IssueWriteOutcome` and leave an undoable card in the transcript. The user sees
the change reflected in the UI immediately; there's nothing to surface in chat.

## Data flow

```
list row / detail editor
  → issues-store.setIssueStatus / setIssuePriority (POST /api/issue/{status,priority})
  → userSetIssueStatus / userSetIssuePriority (service)
  → Tracker.setStatus / Tracker.updateIssue({ priority })
  → returns the updated TrackerIssue
  → store patches the list row + open detail in place (matched by issue.id)
```

The list's status editor needs the tracker's **full** set of assignable
statuses (list rows, unlike `getIssue`, don't carry `availableStatuses`). So
`listIssuesForTracker` now also calls the new `Tracker.listStatuses()` and
returns them as `ListIssuesResult.availableStatuses` (best-effort: a failed
states lookup degrades to "no inline editor", not a 502). The detail view
prefers the hydrated issue's own `availableStatuses` and falls back to this set.

## Key files

**Server**
- `trackers/tracker.ts` — `Tracker.listStatuses()` added to the interface.
- `trackers/linear/adapter.ts` — `listStatuses()` queries the bound team's
  workflow states (board order). Priority writes reuse `updateIssue({ priority })`
  → `resolveLinearPriority`.
- `trackers/github/adapter.ts` — `listStatuses()` returns the fixed Open/Closed
  pair (no request). Priority still rejected via `rejectPriority`.
- `services/issues.ts` — `listIssuesForTracker` attaches `availableStatuses`;
  new `userSetIssueStatus` / `userSetIssuePriority` (return `{ issue }`, no card).
- `api-routes-issues.ts` — public `POST /api/issue/status` and
  `POST /api/issue/priority` (mirror `POST /api/issue/comments`).
- `shared/types/domain-types.ts` — `ListIssuesResult.availableStatuses`,
  `MutateIssueResult`.

**Client**
- `components/IssueFieldControls.tsx` — the reusable `IssueStatusEditor` /
  `IssuePriorityEditor` (Radix `DropdownMenu` single-select). Triggers stop
  click/keydown propagation; the **menu content** also stops propagation because
  it's a React descendant of the clickable row and React bubbles portal events
  to ancestors — without this, selecting an option would also open the row's
  detail view.
- `stores/issues-store.ts` — `statusesByTracker` cache, `setIssueStatus` /
  `setIssuePriority` actions, `applyIssueMutation` (patch list + detail by id).
- `components/IssueDetail.tsx`, `components/IssuesViewer.tsx`,
  `components/IssuesPanel.tsx` — wire the editors in.

## Tests

- Adapters: `listStatuses` (Linear board order, GitHub fixed pair, unconfigured throw).
- Service: `availableStatuses` on the list (incl. best-effort degrade), the two
  user writes (status set, priority set + GitHub 422, validation/connect errors).
- Integration: `GET /api/issues` carries statuses; `POST /api/issue/status` &
  `/priority` happy path, validation, GitHub-priority 422.
- Store: status/priority patch list+detail in place; error passthrough.
- Components: editor open/select, no-op on re-pick, read-only fallback, and the
  critical "editing a row doesn't open the detail view" propagation guard.
