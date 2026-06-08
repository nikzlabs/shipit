# Checklist — Tracker-backed priorities (TRACKER-28)

> The inline Issues-tab work that used to live in this checklist's "Issues side"
> moved to `docs/170-inline-tracker-issues` (TRACKER-67). This checklist now tracks
> the decoupling migration only — which has shipped.

## Decisions (settled in design)
- [x] Priority removed from docs
- [x] Status also removed from docs (tracker owns work-state)
- [x] Checklist UI kept and promoted to docs grouping key
- [x] Doc↔issue link via `issue:` frontmatter pointer
- [x] Docs list grouped by checklist state (Active vs Done-collapsed)
- [x] Linear `issue:` pointer: always a full Linear URL
- [x] Overturn docs/156's rejection of the in-ShipIt issue picker — confirmed by the user; docs/156 amended to cross-reference the pull surface (now `docs/170`)

## Migration (doc side — shipped)
- [x] Create a Linear issue per open doc, mirroring priority; wire each via `issue:`; doc 168 → TRACKER-28
- [x] `markdown.ts`: stop parsing/validating `status` & `priority`
- [x] `markdown.ts`: parse `issue:` pointer; keep checklist aggregation
- [x] `domain-types.ts`: drop priority/status from doc surface, add `issue`
- [x] DocsViewer: remove priority/status UI + sort
- [x] DocsViewer: checklist-state grouping (Active / Done-collapsed)
- [x] DocsViewer: linked-issue chip (identifier) + jump-to-issue _(live priority/status on the chip needs the tracker adapters — see docs/170)_
- [x] doc-paths.ts: re-base isTracked/hasTrackedSibling/hasTrackedPlanSibling off doc structure, not status (+ update doc-paths.test.ts)
- [x] Audit all DocStatus/DocPriority/customStatus importers so the client compiles
- [x] Delete parseStatusFromFrontmatter + customStatus concept (markdown.ts, domain-types.ts)
- [x] Migration: parser/type change + field-stripping land together; add `issue:` where applicable
- [x] Update `CLAUDE.md` design-docs/frontmatter sections
- [x] Update `src/server/shipit-docs/design-docs.md` frontmatter schema
- [x] Add `issue-ref.ts` pointer parser (Linear URL / GitHub `owner/repo#N`)

## Tests (doc side — shipped)
- [x] `markdown.test.ts`: new frontmatter parsing (issue:, no status/priority)
- [x] `issue-ref.test.ts`: Linear/GitHub pointer parsing
- [x] `doc-paths.test.ts`: structural tracking (plan/issue/checklist sibling)
- [x] Client: DocsViewer checklist-state grouping + issue chip
- [x] Integration: `docs.test.ts` returns `issue` pointer

## Follow-on (tracked elsewhere)
- The inline Issues tab that closes the resulting §1/§2 gap — `docs/170-inline-tracker-issues` (TRACKER-67).
- The inbound push trigger — `docs/156-issue-to-session` (TRACKER-43).
