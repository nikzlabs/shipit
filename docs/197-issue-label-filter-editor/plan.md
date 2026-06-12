---
issue: https://linear.app/shipit-ai/issue/SHI-121
description: Filter the Issues list by label, and edit an issue's labels inline on its detail page.
---

# Issue label filter + on-page label editor

Builds on the label-colors foundation (the PR that enriched `TrackerIssue.labels`
to `IssueLabel[]` — name + tracker color — and added the read-only
available-labels endpoint). This feature adds the two user-facing surfaces that
foundation was for:

1. **A Labels filter facet** in the Issues list filter bar, beside Priority /
   Status / Assignee.
2. **An on-page label editor** on the inline issue detail view — add/remove an
   issue's labels by picking from the tracker's existing label set.

Visual reference: the throwaway mockup that drove the design lived in the Present
tab during design; the two surfaces reuse existing components verbatim (the facet
`Popover` + `OptionRow`, the per-label dot color), so there's no new visual
language to commit.

## Design decisions

- **Reuse, don't reinvent.** Both surfaces lean on components that already ship:
  the facet `Popover` + `OptionRow` checkbox rows (Priority/Status/Assignee), and
  the `label.color ?? labelDotColor(name)` dot from the foundation. The only
  structural novelty is that labels are **multi-select** where the existing
  inline status/priority editors are single-select — which is why the editor uses
  a `Popover` (stays open across clicks) rather than the `DropdownMenu`-based
  `IssueFieldControls` editors (which close on select).
- **Filter facet options are runtime-derived from the loaded rows**
  (`distinctLabels`), exactly like Status/Assignee — *not* the tracker's full
  label set. The full set drives only the editor.
- **Editor is "pick from existing" only** — no create-new-label affordance. Adding
  an unknown label is out of scope; it avoids label sprawl and keeps the editor a
  pure membership toggle. (GitHub would silently create unknown labels; the
  server validates names against the repo set and 422s an unknown one.)
- **User-direct write, no provenance card.** Edits go through a new
  `POST /api/issue/labels` that patches the issue in place and returns it —
  mirroring the inline status/priority editors (docs/191), not the agent write
  path (docs/177). No chat card / undo: it's the user's own immediate action.
- **Wholesale replace.** The editor commits the issue's COMPLETE desired
  label-name set on each toggle/removal; the server replaces the full set (both
  trackers' `updateIssue({ labels })` is already a replace). `[]` clears all.
- **Both trackers editable.** Unlike priority (Linear-only), labels are native to
  Linear and GitHub, so `canEditLabels` is true for both.

## Key files

### Filter facet
- `src/client/components/issues-filter.ts` — `IssueFilters.labels: Set<string>`;
  `filterIssues` label clause (OR within facet); `LabelOption` + `distinctLabels`.
- `src/client/utils/local-storage.ts` — `labels` added to the persisted filter
  serialization (rehydrated as a `Set`, pruned to the loaded list after fetch).
- `src/client/stores/issues-store.ts` — `toggleLabel` action; `labels` in
  `emptyFilters`/`pruneFilters`.
- `src/client/components/IssuesFilterBar.tsx` — the `Labels` facet popover
  (mirrors the Status facet; `OptionRow` colored by `label.color ?? labelDotColor`).
- `src/client/components/IssuesViewer.tsx`, `IssuesPanel.tsx` — thread
  `labelOptions` + `onToggleLabel` through.

### On-page editor
- `src/client/components/IssueLabelsEditor.tsx` — **new.** The multi-select
  `Popover` editor: a filter box + checkbox rows over the tracker's pickable set,
  each toggle commits the full new set. Pick-from-existing only.
- `src/client/components/IssueDetail.tsx` — editable labels meta row: chips gain a
  remove ✕, the row shows even with no labels (so you can add), the editor trigger
  sits after the chips. New props: `availableLabels`, `canEditLabels`,
  `onFetchLabels` (lazy fetch on editor open), `onSetLabels`.
- `src/client/stores/issues-store.ts` — `setIssueLabels` action via the shared
  `applyIssueMutation` (payload widened to `string | string[]`).

### Server
- `src/server/orchestrator/services/issues.ts` — `userSetIssueLabels`
  (wholesale replace via `tracker.updateIssue(id, { labels })`; 422 on an unknown
  name, no undo).
- `src/server/orchestrator/api-routes-issues.ts` — `POST /api/issue/labels`
  (distinct from the foundation's `GET` on the same path, which lists the
  pickable set).

## Tests

- `issues-filter.test.ts` — label filter clause, `distinctLabels`, active-count.
- `IssueDetail.test.tsx` — remove via chip ✕, open editor (lazy fetch) + add,
  Add-label affordance when empty, hidden when `canEditLabels` is false.
- `IssuesViewer.test.tsx` / `IssuesPanel.test.tsx` — facet wiring + filter
  persistence round-trip including labels.
- `services/issues.test.ts` — `userSetIssueLabels` wholesale replace, clear-all,
  unknown-name 422, blank-id 400.
