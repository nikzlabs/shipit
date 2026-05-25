# react-markdown migration — checklist

## Decision

- [ ] Confirm migration direction (Phase 1 = chat).
- [ ] Decide between `react-markdown` and `markdown-to-jsx` based on bundle-size budget.

## Phase 1 — Chat

- [ ] Add `react-markdown` and `remark-gfm` to `dependencies` at pinned versions.
- [ ] Rewrite `MarkdownContent` in `message-markdown.tsx` using `<ReactMarkdown>` with `components` overrides for `a` (target=_blank) and `code` (keep `CodeBlock`).
- [ ] Rewrite `MarkdownTooltip` to share the same component set.
- [ ] Add a streaming-selection test in `MessageList.test.tsx` that mounts a message, simulates a `selectionchange`, appends text, and asserts the Selection Range is preserved.
- [ ] Delete the freeze hack in `MessageList.tsx` (`frozenMessages` state + `selectionchange` effect) once the test passes without it.
- [ ] Measure gzipped bundle delta; record in PR description.

## Phase 2 — Docs viewer

- [ ] Replace `parseMarkdownToBlocks` in `MarkdownSelectionComments.tsx` with `components` overrides that capture refs to top-level block wrappers.
- [ ] Verify selection-anchor comments still resolve correctly (port `locateInBlock` to the new block source).
- [ ] Add `rehype-slug` for heading anchors.
- [ ] Decide on `rehype-autolink-headings` (deep-link UX).
- [ ] Drop the `MarkdownBlock` memo workaround now that React reconciles individual nodes.

## Phase 3 — Remaining surfaces

- [ ] PR description and conversation (`pr-detail/*`) — consume the new `MarkdownContent`.
- [ ] PR lifecycle card — same.
- [ ] Plan approval modal — same.
- [ ] Remove `marked` from `dependencies` once no surface imports it.

## Quality gates

- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npm run test:dev` covers the new component overrides.
- [ ] Manual: drag-select across streaming tokens; confirm selection holds without the freeze hack.
- [ ] Manual: open a docs `plan.md` with a table, task list, fenced code block, and headings; confirm rendering matches design intent.
