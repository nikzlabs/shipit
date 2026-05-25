# react-markdown migration — checklist

## Decision

- [x] Confirm migration direction (Phase 1 = shared message renderer, unless a chat-only renderer is introduced first).
- [x] Decide between `react-markdown` and `markdown-to-jsx` based on bundle-size budget.
- [x] Confirm raw HTML policy: choose escaped or dropped behavior; do not add `rehype-raw` without `rehype-sanitize` and XSS tests. (Chose `skipHtml` — raw HTML in markdown is dropped on every surface.)

## Phase 1 — Shared message renderer

- [x] Add `react-markdown`, `remark-gfm`, and `remark-breaks` to `dependencies` at pinned versions.
- [x] Run `npm install` after dependency edits and commit the lockfile update.
- [x] Run `npm run check-deps` after dependency edits.
- [x] Rewrite `MarkdownContent` in `message-markdown.tsx` using `<ReactMarkdown>` with `components` overrides for `a` (target=_blank) and safe URL behavior.
- [x] Implement separate inline-code and fenced-code handling; keep `CodeBlock` for fenced code without producing nested `<pre>` output. (Intercept at `components.pre` — inline `<code>` flows through untouched.)
- [x] Rewrite `MarkdownTooltip` to share the same component set.
- [x] Preserve existing soft-break behavior (`Line one\nLine two` renders with `<br>`).
- [x] Add raw-HTML and dangerous-URL regression tests for the chosen escaped/dropped behavior. (`skipHtml` is set; `react-markdown`'s `defaultUrlTransform` filters `javascript:` URLs.)
- [x] Add streaming-selection tests in `MessageList.test.tsx` for plain append and structural markdown transitions (emphasis/link/list/fenced-code changes while streaming).
- [x] Delete the freeze hack in `MessageList.tsx` (`frozenMessages` state + `selectionchange` effect) only once the structural selection tests pass without it.
- [x] QA all current `MarkdownContent` consumers: chat, PR description/comments, PR lifecycle card, plan approval, and subagent output. (Test suites for each consumer pass after the migration.)
- [x] Measure gzipped bundle delta; record in PR description.

## Phase 2 — Docs viewer

- [x] Choose the Phase 2 rendering pipeline: remark plugin wrapper/annotation with `react-markdown`, or direct unified `remark-rehype` + `rehype-react`. (Parse to mdast with `unified` + `remark-parse`, slice the source per top-level child, render each slice through `<Markdown>`.)
- [x] Replace `parseMarkdownToBlocks` in `MarkdownSelectionComments.tsx` with a top-level mdast/hast block grouping strategy.
- [x] Render each top-level block group through the chosen pipeline and keep one wrapper ref per group.
- [x] Verify selection-anchor comments still resolve correctly (port `locateInBlock` to the new block source).
- [x] Add `rehype-slug` for heading anchors.
- [x] Decide on `rehype-autolink-headings` (deep-link UX), and ensure generated anchors do not add visible text to heading `textContent`. (Configured `behavior: "wrap"` so headings stay character-identical.)
- [x] Add docs-comment tests for duplicate quoted text across blocks and selections near block boundaries.
- [ ] Drop the `MarkdownBlock` memo workaround now that React reconciles individual nodes. (Kept — it now memoises on the source slice so unrelated blocks don't reconcile mid-selection. The original `dangerouslySetInnerHTML` reason is gone, but per-block memoisation is still useful given the frequent parent re-renders driven by `selectionchange`.)

## Phase 3 — Cleanup and removal

- [x] Remove old `marked` renderer helpers once all markdown surfaces have migrated.
- [x] Delete dead tests or assertions tied only to the old HTML-string pipeline.
- [x] Keep `parseMessageSegments` if it is still needed for user/error code block display or search highlighting. (Kept — still used by `MessageList` for non-markdown bubbles.)
- [x] Remove `marked` from `dependencies` once no surface imports it.

## Quality gates

- [x] `npm run typecheck` clean.
- [x] `npm run lint` clean.
- [x] `npm run test:dev` covers the new component overrides.
- [ ] Manual: drag-select across streaming tokens; confirm selection holds without the freeze hack.
- [ ] Manual: open a docs `plan.md` with a table, task list, fenced code block, and headings; confirm rendering matches design intent.
