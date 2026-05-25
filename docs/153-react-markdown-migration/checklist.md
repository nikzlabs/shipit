# react-markdown migration — checklist

## Decision

- [ ] Confirm migration direction (Phase 1 = shared message renderer, unless a chat-only renderer is introduced first).
- [ ] Decide between `react-markdown` and `markdown-to-jsx` based on bundle-size budget.
- [ ] Confirm raw HTML policy: user-authored markdown HTML remains escaped/dropped; do not add `rehype-raw` without `rehype-sanitize` and XSS tests.

## Phase 1 — Shared message renderer

- [ ] Add `react-markdown`, `remark-gfm`, and `remark-breaks` to `dependencies` at pinned versions.
- [ ] Rewrite `MarkdownContent` in `message-markdown.tsx` using `<ReactMarkdown>` with `components` overrides for `a` (target=_blank) and `code` (keep `CodeBlock`).
- [ ] Rewrite `MarkdownTooltip` to share the same component set.
- [ ] Preserve existing soft-break behavior (`Line one\nLine two` renders with `<br>`).
- [ ] Add streaming-selection tests in `MessageList.test.tsx` for plain append and structural markdown transitions (emphasis/link/list/fenced-code changes while streaming).
- [ ] Delete the freeze hack in `MessageList.tsx` (`frozenMessages` state + `selectionchange` effect) only once the structural selection tests pass without it.
- [ ] QA all current `MarkdownContent` consumers: chat, PR description/comments, PR lifecycle card, plan approval, and subagent output.
- [ ] Measure gzipped bundle delta; record in PR description.

## Phase 2 — Docs viewer

- [ ] Replace `parseMarkdownToBlocks` in `MarkdownSelectionComments.tsx` with a top-level mdast block grouping strategy.
- [ ] Render each top-level block group through `react-markdown` and keep one wrapper ref per group.
- [ ] Verify selection-anchor comments still resolve correctly (port `locateInBlock` to the new block source).
- [ ] Add `rehype-slug` for heading anchors.
- [ ] Decide on `rehype-autolink-headings` (deep-link UX).
- [ ] Drop the `MarkdownBlock` memo workaround now that React reconciles individual nodes.

## Phase 3 — Cleanup and removal

- [ ] Remove old `marked` renderer helpers once all markdown surfaces have migrated.
- [ ] Delete dead tests or assertions tied only to the old HTML-string pipeline.
- [ ] Remove `marked` from `dependencies` once no surface imports it.

## Quality gates

- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npm run test:dev` covers the new component overrides.
- [ ] Manual: drag-select across streaming tokens; confirm selection holds without the freeze hack.
- [ ] Manual: open a docs `plan.md` with a table, task list, fenced code block, and headings; confirm rendering matches design intent.
