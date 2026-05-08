---
status: in-progress
priority: medium
---

# Tracked doc — easily view the checklist

ShipIt's Docs panel surfaces feature docs from `docs/NNN-feature/`. Each
feature dir typically pairs `plan.md` (with `status:` frontmatter — what
makes it "tracked") with a sibling `checklist.md` (no frontmatter; plain
checkbox list).

Before this change, those two files were listed as independent rows in the
DocsViewer (`Tracked` for the plan, `Other` for the checklist). To read the
checklist after viewing the plan a user had to close the modal, switch tabs,
find and re-open the checklist. Roughly a third of features (38 / 116) had
this pairing, so the friction was not rare.

## What changed

- **Sibling tabs in `FilePreviewModal`** — when a doc has at least one
  sibling `.md` file in the same directory, the modal renders a tab strip in
  the header. Tabs are ordered `Plan → Checklist → alphabetical`, with the
  active tab highlighted. Clicking a tab swaps the visible doc in place
  (parent re-runs `openPreview` with the new path); the modal stays open.
- **Standalone checklist filter in `DocsViewer`** — untracked entries whose
  directory contains a tracked plan are no longer listed in the `Other` tab.
  They're reachable from the plan's sibling tabs, so the separate row was
  redundant. Untracked checklists with no plan sibling (e.g. a top-level
  `README.md`) still show normally.
- **Checklist progress badge** — when a tracked plan has a sibling
  `checklist.md`, `findMarkdownFiles` parses `- [ ]` / `- [x]` items from
  the checklist and attaches `{ total, done }` to the plan's `DocEntry`.
  The DocsViewer renders a small `done/total` badge alongside the status
  badge so the user gets an at-a-glance progress signal without opening
  the doc. The badge flips to the `success` variant once `done === total`.
  Empty checklists (no checkboxes) are suppressed so we never show `0/0`.

## Key files

- `src/client/utils/doc-paths.ts` — `dirOf`, `siblingsOf`,
  `orderSiblingsForTabs`, `siblingTabLabel`, `hasTrackedSibling`. Pure
  helpers used by the modal wiring and the viewer filter.
- `src/client/utils/doc-paths.test.ts` — unit coverage for the helpers.
- `src/client/components/FilePreviewModal.tsx` — accepts optional
  `siblings` + `onSwitchSibling` props. Renders the tab strip when
  `siblings.length > 1`. Discards an empty review draft on the outgoing tab
  before switching, mirroring close-without-comments behavior.
- `src/client/App.tsx` — computes `previewSiblings` from
  `useFileStore.docFiles` filtered to the open doc's directory; wires
  `handleSwitchSibling` to reuse the existing `handleOpenDoc` so the
  "Start Session" action attaches when switching back to a tracked plan.
- `src/client/components/DocsViewer.tsx` — filters the untracked list via
  `hasTrackedSibling`; renders `ChecklistProgressBadge` next to the status
  badge for any tracked row whose `DocEntry.checklist` is populated.
- `src/server/orchestrator/markdown.ts` — `parseChecklistProgress(content)`
  counts `- [ ]` / `- [x]` items at any indent level. `findMarkdownFiles`
  reads `checklist.md` files in full, runs the parser, and propagates the
  result onto the sibling `plan.md`'s `DocEntry`.
- `src/server/shared/types/domain-types.ts` — `DocEntry.checklist`:
  `{ total: number; done: number } | undefined`.

## Notes

- The sibling-tab work didn't need backend changes (`findMarkdownFiles`
  already discovered `checklist.md` for free via `GENERIC_FILENAMES`); the
  progress-badge follow-up *did* — checklists were previously sniffed at
  512 bytes for frontmatter only, which would undercount checkboxes that
  appear later in the file. They're now read in full.
- Sibling tabs render only for markdown previews; arbitrary code/binary
  previews ignore `siblings` entirely.
- Drafts are keyed `${sessionId}::${filePath}` in `file-review-store`, so
  each sibling has its own draft and switching tabs does not cross-pollute
  comments.
